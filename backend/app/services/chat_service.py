import os
import io
import base64
import re
import json
from datetime import date, timedelta
from langchain_core.messages import HumanMessage
# pyrefly: ignore [missing-import]
from sqlalchemy import create_engine, select
# pyrefly: ignore [missing-import]
from langchain_community.utilities import SQLDatabase
# pyrefly: ignore [missing-import]
from langchain_groq import ChatGroq
# pyrefly: ignore [missing-import]
from langchain.chains import create_sql_query_chain

# pyrefly: ignore [missing-import]
from langchain_core.prompts import PromptTemplate
# pyrefly: ignore [missing-import]
from langchain_core.output_parsers import StrOutputParser
# pyrefly: ignore [missing-import]
from langchain_core.runnables import RunnablePassthrough, RunnableLambda
from operator import itemgetter
from app.core.config import settings

import logging

logger = logging.getLogger(__name__)

def get_sync_db_url(async_url: str) -> str:
    if async_url.startswith("sqlite+aiosqlite:///"):
        return async_url.replace("sqlite+aiosqlite:///", "sqlite:///")
    if async_url.startswith("postgresql+asyncpg://"):
        return async_url.replace("postgresql+asyncpg://", "postgresql://")
    return async_url

def parse_clean_workers(val) -> list[str]:
    """Estrae una lista pulita di nomi/username degli addetti dal campo workers (escludendo parentesi quadre e virgolette JSON)."""
    if not val:
        return []
    if isinstance(val, list):
        out = []
        for x in val:
            c = str(x).strip(" '\"[]\t\r\n")
            if c:
                out.append(c)
        return out
    s = str(val).strip()
    if (s.startswith("[") and s.endswith("]")) or (s.startswith('"') and s.endswith('"')):
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list):
                return [str(x).strip(" '\"[]\t\r\n") for x in parsed if str(x).strip(" '\"[]\t\r\n")]
            elif isinstance(parsed, str):
                s = parsed
        except Exception:
            pass
    # Rimuovi parentesi quadre residue
    s = s.strip("[]")
    parts = re.split(r"[,;]+", s)
    return [p.strip(" '\"[]\t\r\n") for p in parts if p.strip(" '\"[]\t\r\n")]

def format_clean_workers(val) -> str:
    """Restituisce una stringa leggibile (es. 'mario, luigi') o '-' se vuoto."""
    workers = parse_clean_workers(val)
    return ", ".join(workers) if workers else "-"

def normalize_progress(raw_progress) -> int:
    """
    Converte progress (salvato nel DB come float 0.0-1.0 o come percentuale 0-100) in un intero 0-100.
    Esempi: 0.7 -> 70, 0.97 -> 97, 0.17 -> 17, 1.0 -> 100, 70 -> 70.
    """
    if raw_progress is None:
        return 0
    try:
        val = float(raw_progress)
        if 0 < val <= 1.0:
            return round(val * 100)
        return round(val)
    except (ValueError, TypeError):
        return 0

def get_task_total_actual_hours(t) -> float:
    """Estrae e calcola il totale delle ore consuntivate reali dal campo actual_hours (JSON dict)."""
    val = getattr(t, 'actual_hours', None)
    if not val:
        return 0.0
    try:
        data = json.loads(val) if isinstance(val, str) else val
        if not isinstance(data, dict):
            return 0.0
        tot = 0.0
        for worker, dates_map in data.items():
            if isinstance(dates_map, dict):
                for d, h in dates_map.items():
                    try:
                        tot += float(h or 0)
                    except (ValueError, TypeError):
                        pass
        return round(tot, 1)
    except Exception:
        return 0.0

class ChatService:
    def __init__(self):
        self.sync_db_url = get_sync_db_url(settings.DATABASE_URL)
        self.engine = create_engine(self.sync_db_url)
        self._db = None
        
        # Temperatura differenziata:
        # sql_llm (0.0): massima precisione e rigore deterministico per query SQL
        # chat_llm (0.3): tono naturale, analisi strategica, fluidità e raccomandazioni
        self.sql_llm = self._build_llm(temperature=0.0)
        self.chat_llm = self._build_llm(temperature=0.3)
        self.llm = self.chat_llm

    def _build_llm(self, temperature: float = 0.0):
        primary_llm = None
        if settings.GROQ_API_KEY:
            primary_llm = ChatGroq(
                model="openai/gpt-oss-120b", 
                groq_api_key=settings.GROQ_API_KEY,
                temperature=temperature
            )

        fallbacks: list = []
        if settings.GEMINI_API_KEY:
            from langchain_google_genai import ChatGoogleGenerativeAI
            fallbacks.append(ChatGoogleGenerativeAI(
                model="gemini-3.6-flash",
                google_api_key=settings.GEMINI_API_KEY,
                temperature=temperature,
                max_retries=1
            ))
            
        if settings.COHERE_API_KEY:
            from langchain_cohere import ChatCohere
            fallbacks.append(ChatCohere(
                model="command-r-plus",
                cohere_api_key=settings.COHERE_API_KEY,
                temperature=temperature
            ))
            
        if primary_llm and fallbacks:
            return primary_llm.with_fallbacks(fallbacks)
        elif primary_llm:
            return primary_llm
        elif fallbacks:
            return fallbacks[0].with_fallbacks(fallbacks[1:]) if len(fallbacks) > 1 else fallbacks[0]
        return None

    def _build_vision_llm(self):
        if settings.GEMINI_API_KEY:
            from langchain_google_genai import ChatGoogleGenerativeAI
            return ChatGoogleGenerativeAI(
                model="gemini-3.6-flash",
                google_api_key=settings.GEMINI_API_KEY,
                temperature=0.2,
                max_retries=1
            )
        return None

    def _parse_attachments(self, attachments: list) -> tuple[list, str]:
        """
        Elabora gli allegati (immagini e documenti) mantenendo un utilizzo 100% gratuito:
        - Immagini: preservate come base64 data URL per il modello multimodale gratuito (Gemini Flash).
        - Documenti (PDF, DOCX, XLSX, TXT, CSV): testo estratto localmente con librerie open-source.
        Ritorna: (images, docs_text)
        """
        if not attachments:
            return [], ""

        images = []
        doc_texts = []

        for att in attachments:
            name = str(att.get("name", "allegato"))
            raw_data = str(att.get("data", ""))
            mime = str(att.get("type", "")).lower()

            if not raw_data:
                continue

            b64_str = raw_data
            if raw_data.startswith("data:"):
                try:
                    header, b64_str = raw_data.split(",", 1)
                    if ";" in header:
                        inferred_mime = header.split(";")[0].replace("data:", "").lower()
                        if inferred_mime:
                            mime = inferred_mime
                except Exception:
                    b64_str = raw_data

            name_lower = name.lower()
            is_image = (
                mime.startswith("image/") or
                name_lower.endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"))
            )

            if is_image:
                img_mime = mime if mime.startswith("image/") else "image/jpeg"
                if name_lower.endswith(".png"):
                    img_mime = "image/png"
                elif name_lower.endswith(".webp"):
                    img_mime = "image/webp"
                data_url = f"data:{img_mime};base64,{b64_str}"
                images.append({"name": name, "data_url": data_url})
                continue

            # Decodifica bytes per documenti
            try:
                file_bytes = base64.b64decode(b64_str)
            except Exception as e:
                logger.error(f"Errore decodifica base64 file '{name}': {e}")
                continue

            # 1. PDF
            if name_lower.endswith(".pdf") or "pdf" in mime:
                try:
                    # pyrefly: ignore [missing-import]
                    import pypdf  # type: ignore
                    reader = pypdf.PdfReader(io.BytesIO(file_bytes))
                    pdf_lines = []
                    max_pages = min(len(reader.pages), 30)
                    for p_idx in range(max_pages):
                        page_text = reader.pages[p_idx].extract_text() or ""
                        if page_text.strip():
                            pdf_lines.append(f"[Pagina {p_idx + 1}]\n{page_text.strip()}")
                    full_pdf_text = "\n\n".join(pdf_lines)
                    if len(full_pdf_text) > 35000:
                        full_pdf_text = full_pdf_text[:35000] + "\n... [testo restante omesso per limiti di lunghezza]"
                    doc_texts.append(f"=== DOCUMENTO PDF ALLEGATO: {name} ({len(reader.pages)} pagine) ===\n{full_pdf_text}\n")
                except Exception as e:
                    logger.error(f"Errore estrazione PDF '{name}': {e}")
                    doc_texts.append(f"=== DOCUMENTO PDF ALLEGATO: {name} ===\n(Errore estrazione testo: {e})\n")
                continue

            # 2. DOCX (Word)
            if name_lower.endswith((".docx", ".doc")) or "wordprocessingml" in mime or "msword" in mime:
                try:
                    # pyrefly: ignore [missing-import]
                    import docx  # type: ignore
                    doc = docx.Document(io.BytesIO(file_bytes))
                    doc_lines = []
                    for p in doc.paragraphs:
                        if p.text.strip():
                            doc_lines.append(p.text.strip())
                    for tbl in doc.tables:
                        for row in tbl.rows:
                            row_cells = [c.text.strip() for c in row.cells]
                            doc_lines.append(" | ".join(row_cells))
                    full_doc_text = "\n".join(doc_lines)
                    if len(full_doc_text) > 35000:
                        full_doc_text = full_doc_text[:35000] + "\n... [testo restante omesso]"
                    doc_texts.append(f"=== DOCUMENTO WORD ALLEGATO: {name} ===\n{full_doc_text}\n")
                except Exception as e:
                    logger.error(f"Errore estrazione DOCX '{name}': {e}")
                    doc_texts.append(f"=== DOCUMENTO WORD ALLEGATO: {name} ===\n(Errore estrazione testo: {e})\n")
                continue

            # 3. EXCEL (.xlsx, .xls)
            if name_lower.endswith((".xlsx", ".xls")) or "spreadsheetml" in mime or "excel" in mime:
                try:
                    # pyrefly: ignore [missing-import]
                    import openpyxl  # type: ignore
                    wb = openpyxl.load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
                    xl_lines = []
                    for sheet_name in wb.sheetnames[:5]:
                        ws = wb[sheet_name]
                        xl_lines.append(f"[Foglio: {sheet_name}]")
                        row_count = 0
                        for row in ws.iter_rows(values_only=True):
                            if row_count > 100:
                                xl_lines.append("... [ulteriori righe omesse per brevità]")
                                break
                            cells = [str(c) if c is not None else "" for c in row]
                            if any(cells):
                                xl_lines.append(" | ".join(cells))
                                row_count += 1
                    full_xl_text = "\n".join(xl_lines)
                    doc_texts.append(f"=== FOGLIO EXCEL ALLEGATO: {name} ===\n{full_xl_text}\n")
                except Exception as e:
                    logger.error(f"Errore estrazione Excel '{name}': {e}")
                    doc_texts.append(f"=== FOGLIO EXCEL ALLEGATO: {name} ===\n(Errore estrazione testo: {e})\n")
                continue

            # 4. TESTO / CSV / JSON / LOG
            try:
                try:
                    text_content = file_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    text_content = file_bytes.decode("latin-1", errors="replace")
                if len(text_content) > 35000:
                    text_content = text_content[:35000] + "\n... [testo restante omesso]"
                doc_texts.append(f"=== FILE TESTUALE ALLEGATO: {name} ===\n{text_content}\n")
            except Exception as e:
                logger.error(f"Errore lettura testo '{name}': {e}")

        return images, "\n\n".join(doc_texts)

    async def _handle_vision_query(self, images: list, docs_text: str, user_message: str, current_user, history=None) -> str:
        """
        Gestisce le richieste con immagini/foto tramite il modello multimodale Gemini 3.6 Flash.
        """
        username = str(getattr(current_user, 'username', '') or '')
        full_name = str(getattr(current_user, 'full_name', '') or username or 'Utente')
        user_role = str(getattr(current_user.role, 'value', current_user.role)).upper() if (current_user and hasattr(current_user, 'role')) else "VIEWER"
        user_dept = str(getattr(current_user, 'department', 'generale') or 'generale')
        today_str = date.today().strftime('%d/%m/%Y (%Y-%m-%d)')

        prompt_text = (
            "Sei l'assistente virtuale ufficiale di HiPlan, la piattaforma aziendale di project management, diagrammi di Gantt e gestione commesse.\n"
            f"Data odierna: {today_str}\n"
            f"Utente collegato: **{full_name}** (@{username}), Ruolo: {user_role}, Reparto: {user_dept}.\n\n"
        )

        if docs_text:
            prompt_text += f"CONTENUTO DEI DOCUMENTI ALLEGATI AL MESSAGGIO:\n{docs_text}\n\n"

        clean_query = (user_message or '').strip()
        if not clean_query:
            clean_query = "Esamina l'immagine o foto allegata e descrivi dettagliatamente cosa contiene, estraendo codici, date, nomi, quantità o riferimenti utili per la gestione commesse e attività in HiPlan."

        prompt_text += (
            f"RICHIESTA DELL'UTENTE SULL'ALLEGATO:\n{clean_query}\n\n"
            "Istruzioni per la risposta:\n"
            "1. Analizza attentamente tutti gli elementi visivi dell'immagine o foto (testi, tabelle, numeri di commessa, schemi tecnici, date, cartellini o documenti fotografati).\n"
            "2. Rispondi in italiano in modo chiaro, professionale ed esaustivo, formattando con markdown ed elenchi puntati.\n"
            "3. Se l'immagine contiene riferimenti a commesse, articoli, codici, date di scadenza o ore, evidenziali chiaramente.\n"
            "4. Se l'utente fa domande specifiche, rispondi puntualmente a quanto richiesto basandoti su ciò che è visibile nell'immagine."
        )

        content_parts = [{"type": "text", "text": prompt_text}]
        for img in images:
            content_parts.append({
                "type": "image_url",
                "image_url": img["data_url"]
            })

        vision_llm = self._build_vision_llm()
        if not vision_llm:
            return "Errore: Modello multimodale per l'analisi immagini non disponibile o chiave API GEMINI_API_KEY non configurata."

        try:
            message = HumanMessage(content=content_parts)
            response = await vision_llm.ainvoke([message])
            raw_content = response.content
            if isinstance(raw_content, str):
                return raw_content
            elif isinstance(raw_content, list):
                blocks = []
                for b in raw_content:
                    if isinstance(b, str):
                        blocks.append(b)
                    elif isinstance(b, dict) and "text" in b:
                        blocks.append(str(b["text"]))
                    else:
                        blocks.append(str(b))
                return "\n".join(blocks)
            return str(raw_content)
        except Exception as e:
            logger.error(f"Errore durante l'analisi visiva multimodale: {e}", exc_info=True)
            return f"Si è verificato un errore durante l'analisi dell'immagine: {e}"


    @property
    def db(self):
        if self._db is None:
            from sqlalchemy import inspect
            inspector = inspect(self.engine)
            existing_tables = set(inspector.get_table_names())
            
            to_ignore = [
                "activity_logs", "agent_logs", "email_logs", "replan_logs", "planning_runs",
                "notes", "todos", "calendar_events", "tickets", "ticket_replies",
                "richieste_commerciali", "articoli_richiesta"
            ]
            ignore_existing = [t for t in to_ignore if t in existing_tables]

            self._db = SQLDatabase(
                self.engine, 
                sample_rows_in_table_info=0,
                ignore_tables=ignore_existing
            )
        return self._db

    # =========================================================================
    # TOOL DEDICATI (AGENTIC TOOLS - Zero errori SQL, massima accuratezza)
    # =========================================================================
    async def _tool_get_user_tasks(self, current_user) -> str:
        """Estrae le attività assegnate all'utente connesso con stato, scadenze e consigli pratici."""
        if not current_user:
            return "Per vedere le tue attività personali è necessario essere autenticati."
            
        username = str(getattr(current_user, 'username', '')).strip()
        full_name = str(getattr(current_user, 'full_name', '')).strip()
        user_id = getattr(current_user, 'id', None)
        display_name = full_name or username
        
        from app.models.base import AsyncSessionLocal
        from app.models.task import Task
        from app.models.project import Project
        
        async with AsyncSessionLocal() as session:
            stmt = (
                select(Task, Project.name.label("proj_name"), Project.code.label("proj_code"), Project.id.label("proj_id"))
                .join(Project, Task.project_id == Project.id)
                .where(Project.deleted_at.is_(None))
            )
            res = await session.execute(stmt)
            all_rows = res.all()
            
            user_tasks: list = []
            for t, p_name, p_code, p_id in all_rows:
                workers_list = [w.lower() for w in parse_clean_workers(getattr(t, 'workers', None))]
                assigned_str = str(t.assigned_to) if t.assigned_to else ""
                
                matched = False
                if username and username.lower() in workers_list:
                    matched = True
                elif full_name and full_name.lower() in workers_list:
                    matched = True
                elif user_id and str(user_id) == assigned_str:
                    matched = True
                    
                if matched:
                    user_tasks.append((t, str(p_code or ""), str(p_name or "Senza nome"), str(p_id)))
                    
            if not user_tasks:
                return (
                    f"### 📋 Nessuna attività assegnata a **{display_name}**\n\n"
                    f"Al momento non risultano fasi o compiti operativi assegnati direttamente al tuo profilo nelle commesse attive.\n\n"
                    f"---\n"
                    f"💡 **Azione consigliata:** Verifica con il responsabile di commessa o consulta l'elenco generale per visualizzare le fasi di reparto aperte."
                )
                
            today = date.today()
            overdue_count = 0
            upcoming_count = 0
            
            lines = [
                f"Ecco il riepilogo aggiornato delle tue attività operative, **{display_name}** ({len(user_tasks)} fasi totali):\n",
                "| Stato | Fase / Attività | Commessa | Scadenza | Avanzamento | Ore Previste |",
                "| :---: | :--- | :--- | :---: | :---: | :---: |"
            ]
            
            def get_sort_key(item_tuple):
                raw_d = getattr(item_tuple[0], 'end_date', None)
                if raw_d and hasattr(raw_d, 'date'):
                    return raw_d.date()
                return raw_d or date.max
                
            for task_obj, p_code, p_name, p_id in sorted(user_tasks, key=get_sort_key):
                p_label = f"[**{p_code}**](/projects/{p_id})" if p_code else f"[**{p_name}**](/projects/{p_id})"
                raw_end = getattr(task_obj, 'end_date', None)
                end_d: date | None = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                end_str = end_d.strftime("%d/%m/%Y") if end_d else "N/D"
                prog_val = normalize_progress(getattr(task_obj, 'progress', 0))
                prog = f"{prog_val}%"
                planned_h = getattr(task_obj, 'planned_hours', None)
                hours = f"{planned_h}h" if planned_h else "-"
                
                is_completed = bool(getattr(task_obj, 'completed', False)) or prog_val >= 100
                if is_completed:
                    status_badge = "🟢 Completata"
                elif end_d and end_d < today:
                    status_badge = "🔴 In ritardo"
                    overdue_count += 1
                elif end_d and (end_d - today).days <= 7:
                    status_badge = "🟡 In scadenza"
                    upcoming_count += 1
                else:
                    status_badge = "🔵 In corso"
                    
                task_title = str(getattr(task_obj, 'text', 'Attività'))
                lines.append(f"| {status_badge} | **{task_title}** | {p_label} | {end_str} | {prog} | {hours} |")
                
            lines.append("\n---")
            if overdue_count > 0:
                lines.append(f"💡 **Azione consigliata:** Rilevate **{overdue_count} fasi in ritardo**. Ti suggerisco di aggiornare lo stato di avanzamento o segnalare una data di ripianificazione al tuo responsabile di commessa.")
            elif upcoming_count > 0:
                lines.append(f"💡 **Azione consigliata:** Hai **{upcoming_count} fasi in scadenza nei prossimi 7 giorni**. Ti raccomando di verificare la disponibilità dei materiali e l'avanzamento per completarle nei tempi previsti.")
            else:
                lines.append("💡 **Azione consigliata:** Tutte le attività risultano regolari e in linea con le tempistiche stimate.")
                
            return "\n".join(lines)

    async def _tool_get_projects_overview(self) -> str:
        """Estrae la panoramica delle commesse attive e in pianificazione formattata con tabella ricca."""
        from app.models.base import AsyncSessionLocal
        from app.models.project import Project, ProjectStatus
        from app.models.task import Task, TaskType
        
        async with AsyncSessionLocal() as session:
            p_res = await session.execute(
                select(Project).where(Project.deleted_at.is_(None)).order_by(Project.end_date.asc())
            )
            projects = p_res.scalars().all()
            
            if not projects:
                return "Attualmente non ci sono commesse registrate nel sistema."
                
            t_res = await session.execute(select(Task))
            all_tasks = t_res.scalars().all()
            
            # Mappa task per commessa
            tasks_by_proj: dict = {}
            for t in all_tasks:
                tasks_by_proj.setdefault(str(t.project_id), []).append(t)
                
            today = date.today()
            lines = [
                f"Ecco la panoramica aggiornata dello stato delle commesse aziendali ({len(projects)} commesse registrate):\n",
                "| Stato | Tipologia | Codice | Commessa | Cliente | Scadenza | Avanzamento | Fasi (Compl./Tot) |",
                "| :---: | :---: | :--- | :--- | :--- | :---: | :---: | :---: |"
            ]
            
            overdue_p = 0
            for p in projects:
                p_tasks = tasks_by_proj.get(str(p.id), [])
                # Escludiamo milestone per perfetta coerenza con il calcolo del frontend e di project_service
                progress_tasks = [
                    t for t in p_tasks 
                    if getattr(t, 'type', None) != TaskType.MILESTONE and 'milestone' not in str(getattr(t, 'type', '')).lower()
                ]
                tot_t = len(progress_tasks)
                compl_t = sum(1 for t in progress_tasks if getattr(t, 'completed', 0) == 1 or normalize_progress(getattr(t, 'progress', 0)) >= 100)
                
                tot_prog = sum(normalize_progress(getattr(t, 'progress', 0)) for t in progress_tasks)
                avg_prog = round(tot_prog / tot_t) if tot_t > 0 else 0
                raw_end = getattr(p, 'end_date', None)
                end_d: date | None = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                end_str = end_d.strftime("%d/%m/%Y") if end_d else "N/D"
                
                st_val = getattr(p.status, 'value', p.status)
                if st_val == ProjectStatus.COMPLETED or st_val == "COMPLETED":
                    st_badge = "🟢 Completata"
                elif st_val == ProjectStatus.ARCHIVED or st_val == "ARCHIVED":
                    st_badge = "⚪ Archiviata"
                elif end_d and end_d < today and st_val == "ACTIVE":
                    st_badge = "🔴 In ritardo"
                    overdue_p += 1
                elif st_val == ProjectStatus.ACTIVE or st_val == "ACTIVE":
                    st_badge = "🔵 Attiva"
                else:
                    st_badge = "🟡 Pianificazione"
                    
                # Tipologia commessa: Standard, ATEX, Alimentare (o entrambe)
                tipi = []
                if getattr(p, 'is_atex', False):
                    tipi.append("⚡ ATEX")
                if getattr(p, 'is_alimentare', False):
                    tipi.append("🌾 Alimentare")
                tipo_str = " + ".join(tipi) if tipi else "Standard"
                
                client_str = str(p.client or "-")
                p_code_link = f"[**{p.code or '-'}**](/projects/{p.id})"
                lines.append(f"| {st_badge} | {tipo_str} | {p_code_link} | {p.name} | {client_str} | {end_str} | {avg_prog}% | {compl_t}/{tot_t} |")
                
            lines.append("\n---")
            if overdue_p > 0:
                lines.append(f"💡 **Azione consigliata:** Ci sono **{overdue_p} commesse con scadenza superata**. Si consiglia di concordare con la direzione una ripianificazione o verificare gli stati di avanzamento lavori (SAL).")
            else:
                lines.append("💡 **Azione consigliata:** Il programma complessivo delle commesse rispetta le date di consegna pattuite con i clienti.")
                
            return "\n".join(lines)

    async def _tool_get_team_workload(self) -> str:
        """Calcola e restituisce la graduatoria dei carichi di lavoro degli addetti."""
        from app.models.base import AsyncSessionLocal
        from app.models.task import Task
        from app.models.project import Project
        
        async with AsyncSessionLocal() as session:
            stmt = (
                select(Task)
                .join(Project, Task.project_id == Project.id)
                .where(Project.deleted_at.is_(None))
            )
            res = await session.execute(stmt)
            tasks = res.scalars().all()
            
            worker_stats: dict = {}
            today = date.today()
            
            for t in tasks:
                workers = parse_clean_workers(getattr(t, 'workers', None))
                prog_val = normalize_progress(getattr(t, 'progress', 0))
                is_done = bool(getattr(t, 'completed', False)) or prog_val >= 100
                raw_end = getattr(t, 'end_date', None)
                end_d: date | None = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                t_hours = float(getattr(t, 'planned_hours', 0) or 0)
                
                for w in workers:
                    if w not in worker_stats:
                        worker_stats[w] = {"active": 0, "completed": 0, "overdue": 0, "hours": 0.0}
                        
                    if is_done:
                        worker_stats[w]["completed"] += 1
                    else:
                        worker_stats[w]["active"] += 1
                        if end_d and end_d < today:
                            worker_stats[w]["overdue"] += 1
                    worker_stats[w]["hours"] += t_hours
                        
            if not worker_stats:
                return "Attualmente non ci sono addetti associati a fasi di commessa aperte."
                
            sorted_workers = sorted(worker_stats.items(), key=lambda x: (x[1]["active"], x[1]["overdue"]), reverse=True)
            
            lines = [
                "Ecco l'analisi dettagliata del carico operativo del team ordinata per volume di lavoro attivo:\n",
                "| Addetto | Fasi Attive | Fasi Completate | In Ritardo | Ore Totali Stimate | Stato Carico |",
                "| :--- | :---: | :---: | :---: | :---: | :---: |"
            ]
            
            for w, s in sorted_workers:
                tot_hours = round(float(s["hours"]), 1)
                if s["overdue"] > 0:
                    load_status = "🔴 Sovraccarico / Ritardi"
                elif s["active"] >= 4:
                    load_status = "🟡 Carico Elevato"
                else:
                    load_status = "🟢 Bilanciato"
                    
                lines.append(f"| **{w}** | {s['active']} | {s['completed']} | {s['overdue']} | {tot_hours}h | {load_status} |")
                
            lines.append("\n---")
            busiest = sorted_workers[0][0] if sorted_workers else None
            if busiest:
                lines.append(f"💡 **Azione consigliata:** L'addetto con il maggior volume operativo è **{busiest}** ({sorted_workers[0][1]['active']} fasi aperte). Valuta la redistribuzione delle attività meno urgenti per prevenire colli di bottiglia.")
            else:
                lines.append("💡 **Azione consigliata:** I carichi di lavoro risultano equamente distribuiti tra i membri dei reparti.")
                
            return "\n".join(lines)

    async def _tool_get_deadlines(self, days: int = 30) -> str:
        """Estrae le attività con scadenza nei prossimi giorni."""
        from app.models.base import AsyncSessionLocal
        from app.models.task import Task
        from app.models.project import Project
        from datetime import date, timedelta
        
        today = date.today()
        cutoff = today + timedelta(days=days)
        
        async with AsyncSessionLocal() as session:
            stmt = (
                select(
                    Task,
                    Project.name.label("proj_name"),
                    Project.code.label("proj_code"),
                    Project.id.label("proj_id"),
                    Project.is_atex,
                    Project.is_alimentare
                )
                .join(Project, Task.project_id == Project.id)
                .where(
                    Project.deleted_at.is_(None),
                    Task.completed.is_(False),
                    Task.end_date.is_not(None)
                )
            )
            res = await session.execute(stmt)
            rows = res.all()
            
            upcoming = []
            for t, p_name, p_code, p_id, p_atex, p_alim in rows:
                raw_end = getattr(t, 'end_date', None)
                end_d: date | None = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                if end_d and today <= end_d <= cutoff:
                    tipi = []
                    if p_atex:
                        tipi.append("ATEX")
                    if p_alim:
                        tipi.append("Alimentare")
                    tipo_str = " + ".join(tipi) if tipi else "Standard"
                    upcoming.append((t, str(p_name or ""), str(p_code or ""), str(p_id), (end_d - today).days, tipo_str))
                    
            if not upcoming:
                return f"Non risultano fasi in scadenza nei prossimi {days} giorni nelle commesse attive."
                
            upcoming.sort(key=lambda x: x[4])
            
            lines = [
                f"Ecco le attività con consegna o scadenza programmata nei prossimi **{days} giorni** ({len(upcoming)} fasi individuate):\n",
                "| Scadenza | Tra (gg) | Tipologia | Fase / Attività | Commessa | Addetti | Avanzamento |",
                "| :---: | :---: | :---: | :--- | :--- | :--- | :---: |"
            ]
            
            for t_obj, p_name_str, p_code_str, p_id_str, days_left, tipo_str in upcoming:
                p_label = f"[**{p_code_str}**](/projects/{p_id_str}) - {p_name_str}" if p_code_str else f"[**{p_name_str}**](/projects/{p_id_str})"
                raw_end = getattr(t_obj, 'end_date', None)
                end_d_val = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                d_str = end_d_val.strftime("%d/%m/%Y") if end_d_val else "N/D"
                w_str = format_clean_workers(getattr(t_obj, 'workers', None))
                prog_val = normalize_progress(getattr(t_obj, 'progress', 0))
                prog = f"{prog_val}%"
                
                days_badge = "🔴 Oggi" if days_left == 0 else f"🟡 {days_left} gg" if days_left <= 3 else f"{days_left} gg"
                
                task_text = str(getattr(t_obj, 'text', 'Attività'))
                lines.append(f"| {d_str} | {days_badge} | {tipo_str} | **{task_text}** | {p_label} | {w_str} | {prog} |")
                
            lines.append("\n---")
            if upcoming:
                first_t = upcoming[0]
                first_end = first_t[0].end_date.strftime('%d/%m/%Y') if first_t[0].end_date else 'a breve'
                lines.append(f"💡 **Azione consigliata:** Presidiare con priorità la fase **{first_t[3]}** ({first_t[1] or first_t[2]}), in consegna il {first_end} (assegnata a: {first_t[5]}).")
            else:
                lines.append("💡 **Azione consigliata:** Nessuna scadenza critica immediata; il cronoprogramma è regolare.")
            return "\n".join(lines)

    async def _tool_get_budget_and_hours(self) -> str:
        """Analisi economica e controllo di gestione: ore previste a budget vs ore consuntivate reali."""
        from app.models.base import AsyncSessionLocal
        from app.models.project import Project, ProjectStatus
        from app.models.task import Task, TaskType
        
        async with AsyncSessionLocal() as session:
            p_res = await session.execute(
                select(Project).where(Project.deleted_at.is_(None)).order_by(Project.end_date.asc())
            )
            projects = p_res.scalars().all()
            if not projects:
                return "Non ci sono commesse registrate nel sistema."
                
            t_res = await session.execute(select(Task))
            all_tasks = t_res.scalars().all()
            
            tasks_by_proj: dict = {}
            for t in all_tasks:
                tasks_by_proj.setdefault(str(t.project_id), []).append(t)
                
            lines = [
                "Ecco l'analisi dettagliata di controllo gestione: **Ore Previste a Budget vs Ore Consuntivate Reali**:\n",
                "| Stato Budget | Commessa | Cliente | Ore Previste | Ore Consuntivate | Scostamento | Avanzamento SAL |",
                "| :---: | :--- | :--- | :---: | :---: | :---: | :---: |"
            ]
            
            extra_budget_count = 0
            at_risk_count = 0
            
            for p in projects:
                p_tasks = tasks_by_proj.get(str(p.id), [])
                prog_tasks = [
                    t for t in p_tasks 
                    if getattr(t, 'type', None) != TaskType.MILESTONE and 'milestone' not in str(getattr(t, 'type', '')).lower()
                ]
                
                tot_planned = sum(float(getattr(t, 'planned_hours', 0) or 0) for t in prog_tasks)
                tot_actual = sum(get_task_total_actual_hours(t) for t in prog_tasks)
                delta = round(tot_actual - tot_planned, 1)
                
                tot_t = len(prog_tasks)
                avg_prog = round(sum(normalize_progress(getattr(t, 'progress', 0)) for t in prog_tasks) / tot_t) if tot_t > 0 else 0
                
                # Calcolo alert budget
                if tot_planned > 0 and tot_actual > tot_planned:
                    status_badge = "🔴 Extra Budget"
                    extra_budget_count += 1
                elif tot_planned > 0 and (tot_actual / tot_planned >= 0.85) and avg_prog < 70:
                    status_badge = "🟡 A Rischio"
                    at_risk_count += 1
                else:
                    status_badge = "🟢 In Budget"
                    
                delta_str = f"+{delta}h" if delta > 0 else f"{delta}h"
                p_link = f"[**{p.code or p.name}**](/projects/{p.id})"
                lines.append(
                    f"| {status_badge} | {p_link} - {p.name} | {p.client or '-'} | {round(tot_planned, 1)}h | {round(tot_actual, 1)}h | {delta_str} | {avg_prog}% |"
                )
                
            lines.append("\n---")
            if extra_budget_count > 0:
                lines.append(f"💡 **Azione consigliata:** Rilevate **{extra_budget_count} commesse con ore consuntivate superiori alle stime**. Si raccomanda un incontro di controllo con i responsabili per verificare varianti d'opera o consuntivazioni errate.")
            elif at_risk_count > 0:
                lines.append(f"💡 **Azione consigliata:** Ci sono **{at_risk_count} commesse con consumo ore avanzato (>85%) a fronte di un SAL ancora parziale**. Monitorare attentamente le prossime lavorazioni.")
            else:
                lines.append("💡 **Azione consigliata:** Tutte le commesse attive presentano un consumo di ore proporzionato all'avanzamento dei lavori.")
                
            return "\n".join(lines)

    async def _tool_get_morning_briefing(self, current_user) -> str:
        """Genera il digest esecutivo del buongiorno personalizzato per l'utente connesso."""
        if not current_user:
            return "Per accedere al Briefing del giorno personalizzato è necessario essere autenticati."
            
        username = str(getattr(current_user, 'username', '')).strip()
        full_name = str(getattr(current_user, 'full_name', '')).strip()
        user_id = getattr(current_user, 'id', None)
        display_name = full_name or username or "Collega"
        
        today = date.today()
        cutoff_48h = today + timedelta(days=2)
        
        from app.models.base import AsyncSessionLocal
        from app.models.task import Task
        from app.models.project import Project
        from app.models.vacation import Vacation
        
        async with AsyncSessionLocal() as session:
            # 1. Attività personali
            stmt = (
                select(
                    Task,
                    Project.name.label("proj_name"),
                    Project.code.label("proj_code"),
                    Project.id.label("proj_id"),
                    Project.is_atex,
                    Project.is_alimentare
                )
                .join(Project, Task.project_id == Project.id)
                .where(Project.deleted_at.is_(None))
            )
            res = await session.execute(stmt)
            all_tasks = res.all()
            
            my_urgent_tasks = []
            my_overdue = 0
            
            for t, p_name, p_code, p_id, p_atex, p_alim in all_tasks:
                workers_list = [w.lower() for w in parse_clean_workers(getattr(t, 'workers', None))]
                is_my = (
                    (username and username.lower() in workers_list)
                    or (full_name and full_name.lower() in workers_list)
                    or (user_id and str(user_id) == str(t.assigned_to))
                )
                if is_my and getattr(t, 'completed', 0) != 1 and normalize_progress(getattr(t, 'progress', 0)) < 100:
                    raw_end = getattr(t, 'end_date', None)
                    end_d = raw_end.date() if (raw_end and hasattr(raw_end, 'date')) else raw_end
                    if end_d:
                        if end_d < today:
                            my_overdue += 1
                        elif end_d <= cutoff_48h:
                            tipi = []
                            if p_atex:
                                tipi.append("ATEX")
                            if p_alim:
                                tipi.append("Alimentare")
                            tipo_tag = f" [{ ' + '.join(tipi) }]" if tipi else ""
                            my_urgent_tasks.append((t, p_code, p_name, str(p_id), (end_d - today).days, tipo_tag))
                            
            # 2. Ferie del personale
            from app.models.user import User
            v_stmt = select(Vacation, User.full_name, User.username).join(User, Vacation.user_id == User.id)
            v_res = await session.execute(v_stmt)
            vacations = v_res.all()
            today_vacation_workers = []
            for v, u_full, u_uname in vacations:
                st = v.start_date.date() if hasattr(v.start_date, 'date') else v.start_date
                en = v.end_date.date() if hasattr(v.end_date, 'date') else v.end_date
                if st and en and st <= today <= en:
                    today_vacation_workers.append(u_full or u_uname or "Addetto")
                    
            lines = [
                f"### ☀️ Buongiorno, **{display_name}**! Ecco il tuo Briefing Operativo del giorno ({today.strftime('%d/%m/%Y')}):\n"
            ]
            
            if my_overdue > 0:
                lines.append(f"⚠️ **Attenzione:** Hai **{my_overdue} attività in ritardo** sulle scadenze programmate.")
            else:
                lines.append("✅ **Tempistiche:** Nessuna delle tue attività risulta attualmente in ritardo.")
                
            if my_urgent_tasks:
                lines.append(f"\n🎯 **Priorità a brevissimo termine (prossime 48 ore):**")
                for t, p_code, p_name, p_id, days_left, tipo_tag in my_urgent_tasks:
                    badge = "🔴 Scade OGGI" if days_left == 0 else f"🟡 Scade tra {days_left} gg"
                    lines.append(f"- {badge}: **{t.text}**{tipo_tag} su [**{p_code or p_name}**](/projects/{p_id}) ({normalize_progress(t.progress)}% completato)")
            else:
                lines.append("\n🎯 **Priorità:** Nessuna scadenza personale imminente nelle prossime 48 ore.")
                
            if today_vacation_workers:
                v_str = ", ".join(sorted(list(set(today_vacation_workers))))
                lines.append(f"\n🏖️ **Assenze e Ferie registrate per oggi:** {v_str}")
            else:
                lines.append("\n🏖️ **Assenze:** Nessuna risorsa in ferie programmata per oggi.")
                
            lines.append("\n---")
            if my_overdue > 0:
                lines.append(f"💡 **Azione consigliata:** Dedica la prima parte della mattinata a sbloccare le attività in ritardo o concorda un rinvio con il capocommessa.")
            elif my_urgent_tasks:
                lines.append(f"💡 **Azione consigliata:** Concentrati sul completamento delle fasi a scadenza 48h per garantire il rispetto dei SAL settimanali.")
            else:
                lines.append(f"💡 **Azione consigliata:** Giornata regolare. Puoi avanzare sulla pianificazione ordinaria o revisionare lo stato di avanzamento commesse.")
                
            return "\n".join(lines)

    async def _tool_simulate_scenario(self, user_message: str) -> str:
        """Simula scenari predittivi 'What-If': impatto di slittamenti, assenze o nuove commesse."""
        from app.models.base import AsyncSessionLocal
        from app.models.project import Project
        from app.models.vacation import Vacation
        from app.models.user import User
        
        async with AsyncSessionLocal() as session:
            p_res = await session.execute(select(Project).where(Project.deleted_at.is_(None)))
            projects = p_res.scalars().all()
            
            proj_summary = []
            for p in projects:
                end_str = p.end_date.strftime("%d/%m/%Y") if p.end_date else "N/D"
                proj_summary.append(f"- Commessa: {p.code or p.name} (ID: {p.id}, Scadenza Commessa: {end_str}, Stato: {getattr(p.status, 'value', p.status)})")
                
            v_stmt = select(Vacation, User.full_name, User.username).join(User, Vacation.user_id == User.id)
            v_res = await session.execute(v_stmt)
            vacations = v_res.all()
            v_summary = []
            for v, u_full, u_uname in vacations[:20]:
                st = v.start_date.strftime("%d/%m/%Y") if v.start_date else ""
                en = v.end_date.strftime("%d/%m/%Y") if v.end_date else ""
                v_summary.append(f"- {u_full or u_uname}: dal {st} al {en}")
                
            prompt = PromptTemplate.from_template(
                "Sei il motore di simulazione predittiva 'What-If' di HiPlan per diagrammi di Gantt e gestione commesse.\n"
                "Data odierna: {today_str}\n\n"
                "COMMESSE ATTIVE E SCADENZE CONTRATTUALI:\n{proj_context}\n\n"
                "FERIE PROGRAMMATE DEGLI ADDETTI:\n{vacation_context}\n\n"
                "RICHIESTA SCENARIO IPOTETICO DELL'UTENTE:\n\"{message}\"\n\n"
                "ISTRUZIONI PER L'ANALISI PREDITTIVA:\n"
                "1. Analizza l'impatto potenziale dello scenario descritto:\n"
                "   - C'è rischio di superare la data di consegna finale pattuita con il cliente?\n"
                "   - C'è conflitto con ferie già approvate degli addetti menzionati?\n"
                "   - Quali fasi a valle (dipendenti) o commesse parallele potrebbero subire colli di bottiglia?\n"
                "2. Struttura la risposta con:\n"
                "   - **Esito della simulazione**: [Fattibile / Critico / Richiede Ripianificazione]\n"
                "   - **Tabella dell'impatto stimato**: | Elemento | Stato Attuale | Impatto Simulato | Valutazione Rischio |\n"
                "   - **Strategia di mitigazione consigliata** (es. assegnare un secondo addetto, comprimere un'altra fase).\n"
                "3. Concludi sempre con:\n"
                "   ---\n"
                "   💡 **Azione consigliata:** [consiglio operativo chiaro]\n\n"
                "Risposta della simulazione:"
            )
            chain = prompt | self.chat_llm | StrOutputParser()
            res = await chain.ainvoke({
                "today_str": date.today().strftime("%d/%m/%Y"),
                "proj_context": "\n".join(proj_summary),
                "vacation_context": "\n".join(v_summary) if v_summary else "Nessuna ferie registrata",
                "message": user_message
            })
            return res.strip()

    def _classify_intent(self, user_message: str) -> str:
        m = user_message.strip().lower()
        
        # 0. Esclusioni tassative: Preventivazione e Note Personali
        preventivazione_keys = [
            "preventiv", "richieste commercial", "richiesta commercial",
            "articoli richiest", "articolo richiest", "offerte commercial",
            "offerta commercial", "prezzi fornitore", "prezzo fornitore",
            "costi fornitore", "costo fornitore", "prezzi d'acquisto",
            "prezzo d'acquisto", "margine preventiv", "margini preventiv"
        ]
        if any(k in m for k in preventivazione_keys):
            return "preventivazione_restricted"

        # Esclusione tassativa: TODO & Checklist (privacy e gestione separata)
        todo_restricted_keys = [
            "todo", "todos", "to-do", "to-dos", "to do", "checklist", "check-list", "check list",
            "miei todo", "i miei todo", "lista todo", "miei task todo", "promemoria todo",
            "mostrami i todo", "elenco todo", "trova i todo", "cerca nei todo", "cerca nel todo",
            "cosa c'è nel todo", "cosa ho nei todo", "sezione todo", "modulo todo", "pagina todo",
            "tabella todo", "tabella todos", "attività del todo", "cose da fare nel todo",
            "mie checklist", "le mie checklist", "mia checklist", "le checklist", "i to do"
        ]
        if any(re.search(r'\b' + re.escape(k) + r'\b', m) for k in ["todo", "todos", "to-do", "to-dos", "checklist"]) or any(k in m for k in todo_restricted_keys):
            return "todo_restricted"

        # Esclusione tassativa: Ticket di Assistenza e Supporto (gestione separata)
        ticket_restricted_keys = [
            "ticket", "tickets", "assistenza ticket", "ticket assistenza",
            "supporto ticket", "ticket supporto", "ticket cliente", "ticket clienti",
            "miei ticket", "i miei ticket", "elenco ticket", "mostrami i ticket",
            "cerca nei ticket", "trova i ticket", "apri ticket", "risolvi ticket",
            "ticket aperti", "ticket chiusi", "ticket in attesa", "stato dei ticket",
            "modulo ticket", "pagina ticket", "sezione ticket", "tabella ticket", "tabella tickets"
        ]
        if any(re.search(r'\b' + re.escape(k) + r'\b', m) for k in ["ticket", "tickets"]) or any(k in m for k in ticket_restricted_keys):
            return "ticket_restricted"

        # Esclusione tassativa: Calendario Personale ed Eventi (privacy assoluta)
        is_project_calendar = any(k in m for k in [
            "calendario commessa", "calendario della commessa", "calendario delle commesse",
            "calendario progetto", "calendario del progetto", "calendario dei progetti"
        ])
        if not is_project_calendar:
            calendar_restricted_keys = [
                "calendario", "calendar", "eventi calendario", "evento calendario",
                "mio calendario", "il mio calendario", "calendario personale", "eventi personali",
                "evento personale", "agenda personale", "mia agenda", "la mia agenda",
                "appuntamenti", "appuntamento", "miei appuntamenti", "i miei appuntamenti",
                "impegni personali", "miei impegni", "i miei impegni", "impegni di oggi",
                "cosa ho in calendario", "cosa c'è in calendario", "cosa ho oggi in calendario",
                "eventi in calendario", "riunioni in calendario", "appuntamenti di oggi",
                "modulo calendario", "pagina calendario", "sezione calendario",
                "tabella calendar", "tabella calendar_events"
            ]
            if any(re.search(r'\b' + re.escape(k) + r'\b', m) for k in ["calendario", "calendar", "appuntamenti", "appuntamento", "agenda"]) or any(k in m for k in calendar_restricted_keys):
                return "calendar_restricted"

        # Esclusione tassativa: Note Personali e Verbali (privacy assoluta)
        is_project_note = any(k in m for k in [
            "note commessa", "note della commessa", "note delle commesse",
            "note progetto", "note del progetto", "note dei progetti"
        ])
        if not is_project_note:
            notes_restricted_keys = [
                "mie note", "miei appunti", "mia nota", "mio appunto",
                "le mie note", "i miei appunti", "cerca nelle mie note",
                "cerca nei miei appunti", "cercami nelle note", "trova nelle mie note",
                "cosa ho scritto nelle mie note", "cosa ho annotato", "cosa c'è scritto nella mia nota",
                "cosa c'è scritto nelle mie note", "cosa dicono le mie note", "riassumi le mie note",
                "riassunto delle mie note", "elenco delle mie note", "mostrami le mie note",
                "appunti personali", "note personali", "taccuino", "promemoria personali",
                "note salvate", "le note che ho salvato", "le mie annotazioni", "verbale", "verbali",
                "verbale riunione", "verbali riunione", "mie riunioni", "note di ", "note dell'",
                "note degli altri", "note altrui", "tutte le note", "note di tutti", "note dei colleghi",
                "note degli addetti", "note degli utenti", "note aziendali", "note globali",
                "modulo note", "pagina note", "sezione note", "tabella note", "tabella notes", "appunti"
            ]
            if any(re.search(r'\b' + re.escape(k) + r'\b', m) for k in ["nota", "note", "appunti", "appunto", "verbale", "verbali", "taccuino"]) or any(k in m for k in notes_restricted_keys):
                return "notes_restricted"

        # 1. Chat generica / Saluti / Aiuto / Ringraziamenti
        greetings = ["ciao", "salve", "buongiorno", "buonasera", "buondi", "buondì", "hey", "hello", "buon pomeriggio"]
        if m in greetings or (any(m.startswith(g) for g in greetings) and len(m.split()) <= 4):
            return "chat"
        if any(k in m for k in ["chi sei", "cosa puoi fare", "cosa sai fare", "come ti chiami", "come funzioni", "come puoi aiutarmi", "istruzioni"]):
            return "chat"
        if m in ["grazie", "grazie mille", "ok grazie", "perfetto", "ottimo", "grazie!", "ricevuto", "chiudi", "basta"]:
            return "chat"

        # 2. Tool dedicato: Morning Briefing
        briefing_keys = [
            "briefing", "sommario oggi", "riassunto del giorno", "cosa devo sapere oggi",
            "cosa c'è oggi", "aggiornamento del giorno", "briefing del giorno", "briefing di oggi",
            "buongiorno briefing", "start day"
        ]
        if any(k in m for k in briefing_keys):
            return "briefing"

        # 3. Tool dedicato: mie attività / compiti personali
        my_tasks_keys = [
            "mie attività", "miei compiti", "miei task", "mie fasi",
            "cosa devo fare", "cosa ho da fare", "miei incarichi",
            "assegnate a me", "miei lavori", "a cosa devo lavorare",
            "a cosa sto lavorando", "quali sono le mie"
        ]
        if any(k in m for k in my_tasks_keys) and not any(k in m for k in ["note", "appunt", "todo", "ticket", "calendar", "calendari"]):
            return "my_tasks"

        # 4. Tool dedicato: Budget / Ore consuntivate vs Stimate
        budget_keys = [
            "budget", "ore consuntivate", "scostamento ore", "scostamento", "ore lavorate",
            "extra budget", "ore spese", "chi consuma più ore", "consuntivi", "costo ore",
            "consumo ore", "ore stimate", "controllo gestione", "differenza ore"
        ]
        if any(k in m for k in budget_keys) and not any(k in m for k in ["mail", "email"]):
            return "budget"

        # 5. Tool dedicato: What-If / Simulazione predittiva
        what_if_keys = [
            "cosa succede se", "se slitta", "se posticipo", "se mario va in ferie",
            "se va in ferie", "impatta la data", "possiamo prendere una nuova",
            "simula", "simulazione", "se spostiamo", "se ritardo"
        ]
        if any(k in m for k in what_if_keys):
            return "what_if"

        # 6. Tool dedicato: panoramica commesse
        proj_overview_keys = [
            "stato commesse", "panoramica commesse", "elenco commesse",
            "commesse attive", "avanzamento commesse", "stato dei progetti",
            "panoramica progetti", "elenco delle commesse", "tutte le commesse"
        ]
        if any(k in m for k in proj_overview_keys) and not any(k in m for k in ["mail", "email", "scrivi"]):
            return "projects_overview"

        # 7. Tool dedicato: carico addetti
        workload_keys = [
            "carico addetti", "carico di lavoro", "chi ha più carico",
            "chi lavora di più", "distribuzione carichi", "carichi di lavoro",
            "sovraccarichi addetti", "chi è più carico"
        ]
        if any(k in m for k in workload_keys) and not any(k in m for k in ["mail", "email", "scrivi"]):
            return "team_workload"

        # 8. Tool dedicato: scadenze del mese o prossimi giorni
        deadlines_keys = [
            "scadenza questo mese", "scadenze questo mese", "scadenze del mese",
            "scadono questo mese", "scadenze a breve", "prossime scadenze",
            "fasi in scadenza", "commesse in scadenza questo mese"
        ]
        if any(k in m for k in deadlines_keys) and not any(k in m for k in ["mail", "email", "scrivi"]):
            return "deadlines"

        # 9. Conflitti, allarmi, sovraccarichi, ritardi, replanning o email di avviso anomalie
        alarm_keywords = [
            "conflitt", "allarm", "ritard", "mancat",
            "riprogramm", "replan", "segnalazion", "alert", "problemi di carico",
            "criticit", "sovrapposiz"
        ]
        is_alarm = any(k in m for k in alarm_keywords)
        is_email = any(k in m for k in ["mail", "email", "bozza", "scrivi", "comunica", "avvisa", "avvisalo", "avvisare"])

        if is_alarm or (is_email and any(k in m for k in ["responsabile", "problem", "avvis", "programmazion", "commess"])):
            return "alarms"

        # 10. Default: interrogazione database via SQL guidato
        return "sql"

    async def get_response(self, user_message: str, current_user=None, history=None, attachments=None, db=None) -> str:
        # Se ci sono allegati, elaborali preventivamente in modo gratuito
        images, docs_text = self._parse_attachments(attachments) if attachments else ([], "")

        # Se sono presenti immagini/foto, attiva direttamente il modello multimodale gratuito (Gemini Flash)
        if images:
            return await self._handle_vision_query(images, docs_text, user_message, current_user, history)

        # Se sono presenti documenti testuali (PDF, Word, Excel, CSV), inietta il testo estratto nel messaggio
        if docs_text:
            if user_message and user_message.strip():
                user_message = f"{user_message.strip()}\n\n[DOCUMENTI ALLEGATI DALL'UTENTE]:\n{docs_text}"
            else:
                user_message = f"Ho allegato questi documenti. Esaminali attentamente ed estrai le informazioni principali:\n\n{docs_text}"

        intent = self._classify_intent(user_message)
        logger.info(f"Chatbot Router: messaggio '{user_message[:60]}...' classificato come INTENT '{intent}'")

        # Esclusione prioritaria: Preventivazione / Richieste Commerciali (non richiede LLM)
        if intent == "preventivazione_restricted":
            return (
                "🔒 **Sezione Riservata: Preventivazione**\n\n"
                "Tutti i dati e i contenuti della pagina **Preventivazione** (richieste commerciali, articoli, specifiche tecniche d'acquisto, prezzi fornitore e margini) "
                "sono strettamente riservati e sono stati **esclusi** dall'assistente virtuale.\n\n"
                "---\n"
                "💡 **Azione consigliata:** Per visualizzare, inserire o gestire i preventivi e le richieste commerciali, "
                "accedi direttamente alla sezione dedicata nel menu laterale (**Coordinamento ➔ Preventivazione**)."
            )

        # Esclusione prioritaria: Note Personali e Verbali (privacy assoluta)
        if intent == "notes_restricted":
            return (
                "🔒 **Sezione Riservata: Note Personali**\n\n"
                "Per garantire la massima tutela della riservatezza e della privacy aziendale, "
                "tutti i contenuti, gli appunti e i verbali della sezione **Note** sono strettamente confidenziali e sono stati **completamente esclusi** dall'assistente virtuale.\n\n"
                "Nessun utente (inclusi gli amministratori) può accedere, consultare o ricercare le note tramite il chatbot.\n\n"
                "---\n"
                "💡 **Azione consigliata:** Per visualizzare, inserire o gestire le tue note personali e i tuoi verbali, "
                "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ Note](/notes)**)."
            )

        # Esclusione prioritaria: TODO & Checklist (privacy e gestione separata)
        if intent == "todo_restricted":
            return (
                "🔒 **Sezione Riservata: TODO & Checklist**\n\n"
                "Per garantire la riservatezza delle attività interne e delle checklist personali, "
                "tutti gli elementi e le attività della sezione **TODO** sono strettamente riservati e sono stati **completamente esclusi** dall'assistente virtuale.\n\n"
                "Nessun utente (inclusi gli amministratori) può consultare o ricercare i TODO tramite il chatbot.\n\n"
                "---\n"
                "💡 **Azione consigliata:** Per visualizzare, inserire o gestire le tue checklist e i tuoi TODO personali o condivisi, "
                "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ TODO](/todo)**)."
            )

        # Esclusione prioritaria: Ticket di Assistenza (riservatezza e gestione separata)
        if intent == "ticket_restricted":
            return (
                "🔒 **Sezione Riservata: Ticket di Assistenza**\n\n"
                "Tutti i ticket di assistenza, supporto tecnico e richieste clienti sono gestiti separatamente e sono stati **completamente esclusi** dall'assistente virtuale "
                "per motivi di riservatezza e conformità operativa.\n\n"
                "Nessun utente può consultare o ricercare i ticket tramite il chatbot.\n\n"
                "---\n"
                "💡 **Azione consigliata:** Per visualizzare, gestire o aprire i ticket di supporto e assistenza, "
                "accedi direttamente alla sezione dedicata nel menu laterale (**[Coordinamento ➔ Ticket](/tickets)**)."
            )

        # Esclusione prioritaria: Calendario Personale (privacy assoluta)
        if intent == "calendar_restricted":
            return (
                "🔒 **Sezione Riservata: Calendario Personale**\n\n"
                "Per tutelare la riservatezza di impegni, appuntamenti ed eventi personali, "
                "la sezione **Calendario** è strettamente riservata ed è stata **completamente esclusa** dall'assistente virtuale.\n\n"
                "Nessun utente può accedere o consultare gli eventi del calendario personale tramite il chatbot.\n\n"
                "---\n"
                "💡 **Azione consigliata:** Per visualizzare, programmare o consultare i tuoi impegni e appuntamenti personali, "
                "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ Calendario](/calendar)**).\n\n"
                "*(Nota: per verificare l'avanzamento, le scadenze e le milestone di commessa, puoi invece richiedere direttamente le \"scadenze commesse\" o \"avanzamento progetti\").*"
            )

        # Contesto utente
        username = str(getattr(current_user, 'username', '') or '')
        full_name = str(getattr(current_user, 'full_name', '') or username or 'Utente')
        user_role = str(getattr(current_user.role, 'value', current_user.role)).upper() if (current_user and hasattr(current_user, 'role')) else "VIEWER"
        user_id = str(getattr(current_user, 'id', '') or '')
        user_dept = str(getattr(current_user, 'department', 'generale') or 'generale')

        # Tool deterministici che interrogano il DB senza richiedere necessariamente LLM
        if intent == "briefing":
            return await self._tool_get_morning_briefing(current_user)

        if intent == "my_tasks":
            return await self._tool_get_user_tasks(current_user)

        if intent == "budget":
            return await self._tool_get_budget_and_hours()

        if intent == "projects_overview":
            return await self._tool_get_projects_overview()

        if intent == "team_workload":
            return await self._tool_get_team_workload()

        if intent == "deadlines":
            return await self._tool_get_deadlines(days=30)

        # Per le risposte che richiedono inferenza AI generativa o Text-to-SQL:
        if not self.llm:
            return "Errore: Chiave API AI non configurata nel backend."

        today_str = date.today().strftime('%d/%m/%Y (%Y-%m-%d)')

        # Formatta cronologia recente
        history_context = ""
        if history:
            h_lines = []
            for h in history[-4:]:
                s = "Utente" if h.get("sender") == "user" else "Assistente"
                t = (h.get("text") or "").strip()
                if len(t) > 280:
                    t = t[:280] + "..."
                h_lines.append(f"{s}: {t}")
            if h_lines:
                history_context = "CRONOLOGIA RECENTE DELLA CHAT:\n" + "\n".join(h_lines) + "\n\n"

        try:
            # ==========================================
            # INTENT 0: ESCLUSIONE PREVENTIVAZIONE / RICHIESTE COMMERCIALI & NOTE
            # ==========================================
            if intent == "preventivazione_restricted":
                return (
                    "🔒 **Sezione Riservata: Preventivazione**\n\n"
                    "Tutti i dati e i contenuti della pagina **Preventivazione** (richieste commerciali, articoli, specifiche tecniche d'acquisto, prezzi fornitore e margini) "
                    "sono strettamente riservati e sono stati **esclusi** dall'assistente virtuale.\n\n"
                    "---\n"
                    "💡 **Azione consigliata:** Per visualizzare, inserire o gestire i preventivi e le richieste commerciali, "
                    "accedi direttamente alla sezione dedicata nel menu laterale (**Coordinamento ➔ Preventivazione**)."
                )

            if intent == "notes_restricted":
                return (
                    "🔒 **Sezione Riservata: Note Personali**\n\n"
                    "Per garantire la massima tutela della riservatezza e della privacy aziendale, "
                    "tutti i contenuti, gli appunti e i verbali della sezione **Note** sono strettamente confidenziali e sono stati **completamente esclusi** dall'assistente virtuale.\n\n"
                    "Nessun utente (inclusi gli amministratori) può accedere, consultare o ricercare le note tramite il chatbot.\n\n"
                    "---\n"
                    "💡 **Azione consigliata:** Per visualizzare, inserire o gestire le tue note personali e i tuoi verbali, "
                    "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ Note](/notes)**)."
                )

            if intent == "todo_restricted":
                return (
                    "🔒 **Sezione Riservata: TODO & Checklist**\n\n"
                    "Per garantire la riservatezza delle attività interne e delle checklist personali, "
                    "tutti gli elementi e le attività della sezione **TODO** sono strettamente riservati e sono stati **completamente esclusi** dall'assistente virtuale.\n\n"
                    "Nessun utente (inclusi gli amministratori) può consultare o ricercare i TODO tramite il chatbot.\n\n"
                    "---\n"
                    "💡 **Azione consigliata:** Per visualizzare, inserire o gestire le tue checklist e i tuoi TODO personali o condivisi, "
                    "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ TODO](/todo)**)."
                )

            if intent == "ticket_restricted":
                return (
                    "🔒 **Sezione Riservata: Ticket di Assistenza**\n\n"
                    "Tutti i ticket di assistenza, supporto tecnico e richieste clienti sono gestiti separatamente e sono stati **completamente esclusi** dall'assistente virtuale "
                    "per motivi di riservatezza e conformità operativa.\n\n"
                    "Nessun utente può consultare o ricercare i ticket tramite il chatbot.\n\n"
                    "---\n"
                    "💡 **Azione consigliata:** Per visualizzare, gestire o aprire i ticket di supporto e assistenza, "
                    "accedi direttamente alla sezione dedicata nel menu laterale (**[Coordinamento ➔ Ticket](/tickets)**)."
                )

            if intent == "calendar_restricted":
                return (
                    "🔒 **Sezione Riservata: Calendario Personale**\n\n"
                    "Per tutelare la riservatezza di impegni, appuntamenti ed eventi personali, "
                    "la sezione **Calendario** è strettamente riservata ed è stata **completamente esclusa** dall'assistente virtuale.\n\n"
                    "Nessun utente può accedere o consultare gli eventi del calendario personale tramite il chatbot.\n\n"
                    "---\n"
                    "💡 **Azione consigliata:** Per visualizzare, programmare o consultare i tuoi impegni e appuntamenti personali, "
                    "accedi direttamente alla sezione dedicata nel menu laterale (**[Personale ➔ Calendario](/calendar)**).\n\n"
                    "*(Nota: per verificare l'avanzamento, le scadenze e le milestone di commessa, puoi invece richiedere direttamente le \"scadenze commesse\" o \"avanzamento progetti\").*"
                )

            # ==========================================
            # INTENT 1: STRUMENTI DETERMINISTICI (AGENTIC TOOLS)
            # ==========================================
            if intent == "briefing":
                return await self._tool_get_morning_briefing(current_user)

            if intent == "my_tasks":
                return await self._tool_get_user_tasks(current_user)

            if intent == "budget":
                return await self._tool_get_budget_and_hours()

            if intent == "what_if":
                return await self._tool_simulate_scenario(user_message)

            if intent == "projects_overview":
                return await self._tool_get_projects_overview()

            if intent == "team_workload":
                return await self._tool_get_team_workload()

            if intent == "deadlines":
                return await self._tool_get_deadlines(days=30)

            # ==========================================
            # INTENT 2: CHAT GENERICA / SALUTI
            # ==========================================
            if intent == "chat":
                chat_prompt = PromptTemplate.from_template(
                    "Sei l'assistente virtuale ufficiale di HiPlan, la piattaforma aziendale di gestione commesse, pianificazione Gantt e controllo carichi di lavoro.\n"
                    "Data di oggi: {today_str}\n"
                    "Stai parlando con: **{full_name}** (@{username}), Ruolo: {user_role}, Reparto: {user_dept}.\n\n"
                    "Rispondi in modo cordiale, professionale ed accogliente in italiano.\n"
                    "Se l'utente saluta o chiede chi sei/cosa puoi fare, presenta brevemente i tuoi compiti:\n"
                    "- Consultare e riepilogare commesse, fasi e stati di avanzamento Gantt\n"
                    "- Mostrare le attività personali assegnate al profilo utente\n"
                    "- Rilevare sovrapposizioni temporali di commessa, ferie concomitanti, ritardi e carichi addetti\n"
                    "- Controllare ore a budget vs consuntivate e scostamenti\n"
                    "- Effettuare simulazioni predittive 'What-If' e redigere bozze di email formali\n\n"
                    "Messaggio dell'utente: {message}\n\n"
                    "Risposta:"
                )
                chat_chain = chat_prompt | self.chat_llm | StrOutputParser()
                res = await chat_chain.ainvoke({
                    "today_str": today_str,
                    "full_name": full_name,
                    "username": username,
                    "user_role": user_role,
                    "user_dept": user_dept,
                    "message": user_message
                })
                return res.strip()

            # ==========================================
            # INTENT 3: ALLARMI, CONFLITTI, REPLANNING & BOZZE EMAIL
            # ==========================================
            if intent == "alarms":
                suggestions_text = "Nessuna anomalia o conflitto rilevato al momento."
                users_list_str = ""
                try:
                    from app.models.base import AsyncSessionLocal
                    from app.services.replanning_service import get_replanning_suggestions
                    from app.models.user import User

                    async with AsyncSessionLocal() as session:
                        suggs = await get_replanning_suggestions(session, current_user)
                        if suggs:
                            clean_suggs = []
                            for s in suggs[:15]:
                                clean_s = dict(s)
                                if "worker" in clean_s:
                                    clean_s["worker"] = format_clean_workers(clean_s["worker"])
                                clean_suggs.append(clean_s)
                            suggestions_text = json.dumps(clean_suggs, ensure_ascii=False, indent=2)

                        u_res = await session.execute(select(User.username, User.full_name, User.department).where(User.is_active == True))
                        users_list = u_res.all()
                        users_list_str = ", ".join([f"{u.full_name or u.username} ({u.department or 'generale'})" for u in users_list])
                except Exception as ex:
                    logger.error(f"Errore caricamento suggerimenti replanning: {ex}")

                alarms_prompt = PromptTemplate.from_template(
                    "Sei l'assistente esperto di coordinamento operativo di HiPlan.\n"
                    "Data odierna: {today_str}\n"
                    "Utente: {full_name} (@{username}) | Ruolo: {user_role}\n\n"
                    "Ecco la lista dei conflitti, colli di bottiglia e ritardi attuali rilevati dal sistema Gantt:\n"
                    "{suggestions_text}\n\n"
                    "Personale aziendale attivo: {users_list_str}\n\n"
                    "COMPITO:\n"
                    "1. Se l'utente chiede lo stato di ritardi, anomalie o sovraccarichi, analizza la lista sopra e fornisci un riassunto chiaro e professionale evidenziando le criticità maggiori.\n"
                    "2. Se l'utente chiede esplicitamente di **scrivere o preparare una mail / email di sollecito o rinvio**, redigi una bozza di email formale ed impeccabile pronta per essere inviata al cliente o al capocommessa, con Oggetto, Saluti formali, dettaglio della commessa e proposta di nuova data concordata.\n"
                    "3. Concludi sempre con una raccomandazione operativa pratica in questo formato:\n"
                    "   ---\n"
                    "   💡 **Azione consigliata:** [consiglio operativo chiaro]\n\n"
                    "Richiesta dell'utente: {message}\n\n"
                    "{history_context}"
                    "Risposta:"
                )

                alarms_chain = alarms_prompt | self.chat_llm | StrOutputParser()
                res = await alarms_chain.ainvoke({
                    "today_str": today_str,
                    "full_name": full_name,
                    "username": username,
                    "user_role": user_role,
                    "suggestions_text": suggestions_text,
                    "users_list_str": users_list_str,
                    "message": user_message,
                    "history_context": history_context
                })
                return res.strip()

            # ==========================================
            # INTENT 4: SQL GUIDATO + SELF-CORRECTION RETRY LOOP
            # ==========================================
            sql_query_template = """Sei un data analyst esperto di database SQLite e PostgreSQL per HiPlan.
Data odierna di riferimento: {today_str}
UTENTE CONNESSO: {full_name} (username: '{username}', ID: '{user_id}', Ruolo: {user_role}, Reparto: {user_dept})

Genera SOLO ed ESCLUSIVAMENTE la query SQL SQLite corretta per rispondere alla domanda dell'utente (massimo {top_k} risultati).
Non aggiungere commenti, spiegazioni o testo oltre alla query SQL.

DIZIONARIO DEL DOMINIO E REGOLE CRITICHE SULLE TABELLE:
1. Tabella 'projects' (Commesse):
   * REGOLA FONDAMENTALE: Le commesse eliminate sono soft-deleted. DEVI SEMPRE INCLUDERE `WHERE projects.deleted_at IS NULL` (o `AND projects.deleted_at IS NULL`).
   * 'status' ha valori: 'PLANNING' (in pianificazione), 'ACTIVE' (attiva/in corso), 'COMPLETED' (completata), 'ARCHIVED' (archiviata).
   * TIPOLOGIA COMMESSA: I campi booleani `is_atex` (1 se atex, 0 altrimenti) e `is_alimentare` (1 se alimentare, 0 altrimenti) definiscono la tipologia della commessa.
     Se `is_atex = 0 AND is_alimentare = 0`, la commessa è 'Standard'.
     Una commessa può essere sia 'ATEX' (`is_atex = 1`) che 'Alimentare' (`is_alimentare = 1`), oppure entrambe contemporaneamente.
     Per cercare commesse ATEX usa `WHERE is_atex = 1`.
     Per cercare commesse Alimentare usa `WHERE is_alimentare = 1`.
     Per cercare commesse Standard usa `WHERE (is_atex = 0 OR is_atex IS NULL) AND (is_alimentare = 0 OR is_alimentare IS NULL)`.
2. Tabella 'tasks' (Fasi / Attività delle commesse):
   * 'project_id' collega la fase a 'projects.id'.
   * 'workers' è un campo testo contenente i nomi o username degli addetti (es. 'mario, luigi'). Per cercare per addetto usa `t.workers LIKE '%{username}%'`.
   * 'completed' è 1 per completata, 0 per in corso. 'progress' è memorizzato come decimale da 0.0 a 1.0 (es. 0.70 è 70%, 0.97 è 97%, 1.0 è 100%). Per la percentuale calcola `ROUND(t.progress * 100)`.
   * 'type' identifica le milestone ('milestone') che non hanno avanzamento.
   * 'start_date' e 'end_date' sono date ISO. Per confrontare con la data odierna usa `date('now')` o `'{today_str}'`.
3. ESCLUSIONE TASSATIVA SEZIONI RISERVATE (NOTE, TODO, TICKET, CALENDARIO PERSONALE, PREVENTIVAZIONE):
   * Le tabelle 'notes', 'todos', 'tickets', 'ticket_replies', 'calendar_events', 'richieste_commerciali' e 'articoli_richiesta' e qualsiasi informazione su note personali, checklist todo, ticket di assistenza, eventi di calendario personale, preventivi, prezzi fornitore o margini sono RIGOROSAMENTE RISERVATE ed ESCLUSE dal chatbot.
   * NON generare MAI query che coinvolgono 'notes', 'todos', 'tickets', 'ticket_replies', 'calendar_events' o le tabelle di preventivazione.
4. Per ricerche testuali usa sempre `LIKE '%...%' COLLATE NOCASE`.

ESEMPI DI QUERY SQL CORRETTE (FEW-SHOT EXAMPLES):
- Domanda: "Quali sono le commesse attive del cliente Alfa?"
  SQL: SELECT p.code, p.name, p.client, p.start_date, p.end_date, p.status, p.is_atex, p.is_alimentare FROM projects p WHERE p.deleted_at IS NULL AND p.status = 'ACTIVE' AND p.client LIKE '%Alfa%' COLLATE NOCASE;
- Domanda: "Quali sono le commesse ATEX o alimentari?"
  SQL: SELECT p.code, p.name, p.client, p.is_atex, p.is_alimentare, p.status FROM projects p WHERE p.deleted_at IS NULL AND (p.is_atex = 1 OR p.is_alimentare = 1);
- Domanda: "Mostrami le commesse standard"
  SQL: SELECT p.code, p.name, p.client, p.status FROM projects p WHERE p.deleted_at IS NULL AND (p.is_atex = 0 OR p.is_atex IS NULL) AND (p.is_alimentare = 0 OR p.is_alimentare IS NULL);
- Domanda: "Quali fasi scadono questo mese?"
  SQL: SELECT t.text, p.name AS project_name, t.end_date, t.progress, t.workers FROM tasks t JOIN projects p ON t.project_id = p.id WHERE p.deleted_at IS NULL AND t.completed = 0 AND strftime('%Y-%m', t.end_date) = strftime('%Y-%m', 'now');
- Domanda: "Quali attività sono assegnate all'utente connesso?"
  SQL: SELECT t.text, p.name AS project_name, t.start_date, t.end_date, t.progress, t.completed FROM tasks t JOIN projects p ON t.project_id = p.id WHERE p.deleted_at IS NULL AND (t.workers LIKE '%{username}%' OR t.assigned_to = '{user_id}') AND t.completed = 0;

{history_context}Schema database:
{table_info}

Domanda: {input}
SQLQuery:"""

            sql_query_prompt = PromptTemplate.from_template(sql_query_template).partial(
                today_str=today_str,
                full_name=full_name,
                username=username,
                user_id=user_id,
                user_role=user_role,
                user_dept=user_dept,
                history_context=history_context
            )

            generate_query = create_sql_query_chain(self.sql_llm, self.db, prompt=sql_query_prompt, k=100)
            
            def clean_sql(query_str: str) -> str:
                q = query_str.strip()
                if "```sql" in q:
                    q = q.split("```sql")[1].split("```")[0]
                elif "```" in q:
                    q = q.split("```")[1].split("```")[0]
                if "SQLQuery:" in q:
                    q = q.split("SQLQuery:")[1]
                match = re.search(r'(SELECT\b.+)', q, re.IGNORECASE | re.DOTALL)
                if match:
                    q = match.group(1)
                if ";" in q:
                    q = q.split(";")[0]
                cleaned = q.strip()
                logger.info(f"Query SQL generata: {cleaned}")
                return cleaned
            
            clean_sql_runnable = RunnableLambda(clean_sql)

            def check_sql_security(query: str) -> str | None:
                """Valida la query SQL per bloccare accessi non autorizzati a sezioni riservate."""
                # Blocco di sicurezza rigoroso su dati di preventivazione
                if re.search(r'\b(richieste_commerciali|articoli_richiesta)\b', query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabelle di preventivazione: {query}")
                    return "ACCESSO_NEGATO_PREVENTIVAZIONE: I dati della pagina Preventivazione sono riservati ed esclusi dal chatbot."

                # Blocco di sicurezza rigoroso su dati di note personali
                if re.search(r'\bnotes\b', query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabella notes: {query}")
                    return "ACCESSO_NEGATO_NOTE: La tabella delle note personali è strettamente riservata ed esclusa dal chatbot per motivi di privacy."

                # Blocco di sicurezza rigoroso su TODO
                if re.search(r'\btodos\b', query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabella todos: {query}")
                    return "ACCESSO_NEGATO_TODO: La tabella dei TODO è strettamente riservata ed esclusa dal chatbot per motivi di privacy."

                # Blocco di sicurezza rigoroso su Ticket
                if re.search(r'\b(tickets|ticket_replies)\b', query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabella tickets: {query}")
                    return "ACCESSO_NEGATO_TICKETS: La gestione dei ticket di assistenza è riservata ed esclusa dal chatbot."

                # Blocco di sicurezza rigoroso su Calendario Personale
                if re.search(r'\bcalendar_events\b', query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabella calendar_events: {query}")
                    return "ACCESSO_NEGATO_CALENDARIO: La tabella degli eventi di calendario personale è strettamente riservata ed esclusa dal chatbot."

                return None
            
            def execute_and_log(sql_query: str) -> str:
                """Esegue la query SQL e, in caso di errore, esegue il Self-Correction Loop automatico."""
                sec_err = check_sql_security(sql_query)
                if sec_err:
                    return sec_err

                try:
                    res = self.db.run(sql_query)
                    logger.info(f"Risultato SQL (1° tentativo riuscito): {res}")
                    return str(res)
                except Exception as ex:
                    logger.warning(f"Errore SQL (1° tentativo) '{sql_query}': {ex}. Avvio Self-Correction Loop...")
                    try:
                        fix_prompt = PromptTemplate.from_template(
                            "La seguente query SQLite ha fallito con un errore sul database HiPlan.\n"
                            "Domanda originale dell'utente: {input_question}\n"
                            "Query SQL errata: {bad_query}\n"
                            "Errore SQLite restituito: {error_msg}\n\n"
                            "Correggi la query SQL risolvendo l'errore SQLite (usa colonne valide e sintassi SQLite corretta).\n"
                            "Genera SOLO la query SQL corretta senza spiegazioni o testo aggiuntivo:\nSQLQuery:"
                        )
                        fix_chain = fix_prompt | self.sql_llm | StrOutputParser()
                        fixed_raw = fix_chain.invoke({
                            "input_question": user_message,
                            "bad_query": sql_query,
                            "error_msg": str(ex)
                        })
                        fixed_clean = clean_sql(fixed_raw)
                        logger.info(f"Query SQL corretta dal Self-Correction Loop: {fixed_clean}")

                        sec_err_fixed = check_sql_security(fixed_clean)
                        if sec_err_fixed:
                            return sec_err_fixed

                        res_fixed = self.db.run(fixed_clean)
                        logger.info(f"Risultato SQL riuscito dopo auto-correzione: {res_fixed}")
                        return str(res_fixed)
                    except Exception as ex2:
                        logger.error(f"Errore persistente anche dopo auto-correzione SQL: {ex2}")
                        return f"Nessun dato corrispondente trovato o errore nei criteri di ricerca: {ex}"

            execute_query_runnable = RunnableLambda(execute_and_log)
            
            answer_prompt = PromptTemplate.from_template(
                "Sei l'assistente virtuale ufficiale di HiPlan per la gestione di commesse, carichi e diagrammi di Gantt.\n"
                "Data odierna: {today_str}\n"
                "Utente interlocutore: {full_name} (@{username}) | Ruolo: {user_role}\n\n"
                "Rispondi alla richiesta dell'utente in italiano in modo chiaro, discorsivo, rigoroso ed elegante.\n\n"
                "REGOLE OBBLIGATORIE DI FORMATTAZIONE:\n"
                "1. TABELLE MARKDOWN:\n"
                "   * Se la risposta contiene 2 o più elementi (commesse, fasi, addetti), DEVI SEMPRE impaginare i dati in una TABELLA MARKDOWN pulita.\n"
                "   * Esempio: `| Stato | Nome | Commessa | Scadenza | Avanzamento |`.\n"
                "2. BADGE ED EMOJI DI STATO:\n"
                "   * 🟢 Completata / In tempo\n"
                "   * 🟡 In scadenza ravvicinata / In pianificazione\n"
                "   * 🔴 In ritardo / Criticità\n"
                "   * 🔵 In lavorazione / Attiva\n"
                "3. CONCLUSIONE OPERATIVA (NESSUN CONSIGLIO GENERALISTA):\n"
                "   * Al termine della risposta aggiungi SEMPRE un separatore e un consiglio pratico breve:\n"
                "     ---\n"
                "     💡 **Azione consigliata:** [Raccomandazione PUNTUALE e NOMINATIVA citando date, commesse o persone specifiche. NON dare MAI consigli banali o generalisti come 'verificare', 'monitorare', 'fare attenzione', 'sollecitare'. Se tutto è regolare scrivi semplicemente che la situazione è allineata.]\n"
                "4. TRADUZIONE CODICI:\n"
                "   * Non mostrare ID numerici o valori grezzi ('ACTIVE' -> 'Attiva', 'PLANNING' -> 'Pianificazione').\n"
                "5. ESCLUSIONE CONTENUTI RISERVATI (NOTE, TODO, TICKET, CALENDARIO PERSONALE, PREVENTIVAZIONE):\n"
                "   * I contenuti di Preventivazione, Note personali, TODO/Checklist, Ticket di assistenza e Calendario personale sono rigorosamente esclusi dal chatbot per motivi di riservatezza.\n"
                "   * Se il risultato estratto o la domanda fa riferimento a preventivi, richieste commerciali, note personali, TODO, ticket o eventi di calendario, rispondi spiegando chiaramente che tali dati sono riservati, confidenziali ed esclusi dall'assistente virtuale, e sono consultabili unicamente nelle rispettive sezioni di HiPlan.\n\n"
                "{history_context}"
                "Domanda dell'utente: {question}\n"
                "Dati estratti dal sistema: {result}\n\n"
                "Risposta completa, formattata e professionale:"
            )
            
            answer_prompt_bound = answer_prompt.partial(
                today_str=today_str,
                full_name=full_name,
                username=username,
                user_role=user_role,
                history_context=history_context
            )
            
            chain = (
                RunnablePassthrough.assign(query=generate_query | clean_sql_runnable).assign(
                    result=itemgetter("query") | execute_query_runnable
                )
                | answer_prompt_bound
                | self.chat_llm
                | StrOutputParser()
            )

            response = await chain.ainvoke({"question": user_message})
            return response.strip()
            
        except Exception as e:
            logger.error(f"Errore nel chatbot durante l'elaborazione del messaggio '{user_message}': {e}", exc_info=True)
            return f"Si è verificato un errore durante l'elaborazione della tua richiesta: {e}"

    async def generate_admin_report(self, db) -> dict:
        import json
        from datetime import date, datetime, timedelta
        from sqlalchemy import select
        from sqlalchemy.orm import selectinload
        from app.models.project import Project, ProjectStatus
        from app.models.task import Task, TaskType
        from app.models.user import User
        from app.models.todo import Todo
        from app.models.ticket import Ticket, TicketStatus, TicketPriority
        from app.models.richiesta_commerciale import RichiestaCommerciale, RichiestaStatus, ArticoloRichiesta

        today = date.today()
        today_str = today.strftime("%d/%m/%Y")

        def extract_date(val):
            if not val:
                return None
            if isinstance(val, datetime):
                return val.date()
            if isinstance(val, date):
                return val
            try:
                return datetime.fromisoformat(str(val)).date()
            except Exception:
                return None

        # 1. Carica progetti non eliminati
        res_proj = await db.execute(select(Project).where(Project.deleted_at.is_(None)))
        projects = res_proj.scalars().all()

        # 2. Carica task
        res_tasks = await db.execute(select(Task))
        tasks = res_tasks.scalars().all()

        # 3. Carica utenti attivi
        res_users = await db.execute(select(User).where(User.is_active.is_(True)))
        users = res_users.scalars().all()
        user_name_map = {str(u.id): (u.full_name or u.username) for u in users}

        # 4. Carica TODO non eliminati
        res_todos = await db.execute(select(Todo).where(Todo.deleted_at.is_(None)))
        todos = res_todos.scalars().all()

        # 5. Carica Ticket non eliminati
        res_tickets = await db.execute(select(Ticket).where(Ticket.deleted_at.is_(None)))
        tickets = res_tickets.scalars().all()

        # 6. Carica Richieste Commerciali non eliminate (con articoli)
        res_comm = await db.execute(
            select(RichiestaCommerciale)
            .options(selectinload(RichiestaCommerciale.articoli))
            .where(RichiestaCommerciale.deleted_at.is_(None))
        )
        commerciali = res_comm.scalars().all()

        # --- Calcolo KPI Commesse ---
        total_projects = len(projects)
        active_projects = [p for p in projects if p.status == ProjectStatus.ACTIVE]
        planning_projects = [p for p in projects if p.status == ProjectStatus.PLANNING]
        completed_projects = [p for p in projects if p.status == ProjectStatus.COMPLETED]
        archived_projects = [p for p in projects if p.status == ProjectStatus.ARCHIVED]

        total_atex = len([p for p in projects if getattr(p, 'is_atex', False)])
        total_alimentare = len([p for p in projects if getattr(p, 'is_alimentare', False)])
        total_standard = len([p for p in projects if not getattr(p, 'is_atex', False) and not getattr(p, 'is_alimentare', False)])

        operative_tasks = [
            t for t in tasks 
            if getattr(t, 'type', None) != TaskType.PROJECT 
            and getattr(t, 'type', None) != TaskType.MILESTONE 
            and 'milestone' not in str(getattr(t, 'type', '')).lower()
        ]
        total_tasks = len(operative_tasks)
        completed_tasks = [
            t for t in operative_tasks 
            if getattr(t, 'completed', 0) == 1 or normalize_progress(getattr(t, 'progress', 0)) >= 100
        ]
        active_tasks = [t for t in operative_tasks if t not in completed_tasks]
        avg_global_progress = round(sum(normalize_progress(getattr(t, 'progress', 0)) for t in operative_tasks) / len(operative_tasks)) if operative_tasks else 0

        overdue_tasks = []
        upcoming_tasks = []
        for t in active_tasks:
            t_end = extract_date(t.end_date)
            if t_end:
                if t_end < today:
                    overdue_tasks.append(t)
                elif t_end <= today + timedelta(days=7):
                    upcoming_tasks.append(t)

        proj_map = {str(p.id): p for p in projects}

        # Carichi addetti
        worker_stats = {}
        for t in operative_tasks:
            w_list = []
            if t.workers:
                try:
                    w_list = json.loads(t.workers) if isinstance(t.workers, str) else t.workers
                except Exception:
                    w_list = [t.workers] if isinstance(t.workers, str) else []
            if isinstance(w_list, list):
                for w in w_list:
                    if not w or not str(w).strip():
                        continue
                    w_name = str(w).strip()
                    if w_name not in worker_stats:
                        worker_stats[w_name] = {"total": 0, "completed": 0, "active": 0, "overdue": 0}
                    worker_stats[w_name]["total"] += 1
                    if getattr(t, 'completed', 0) == 1 or normalize_progress(getattr(t, 'progress', 0)) >= 100:
                        worker_stats[w_name]["completed"] += 1
                    else:
                        worker_stats[w_name]["active"] += 1
                        t_end = extract_date(t.end_date)
                        if t_end and t_end < today:
                            worker_stats[w_name]["overdue"] += 1

        active_proj_lines = []
        for p in active_projects:
            p_tasks = [
                t for t in tasks 
                if str(t.project_id) == str(p.id)
                and getattr(t, 'type', None) != TaskType.PROJECT 
                and getattr(t, 'type', None) != TaskType.MILESTONE 
                and 'milestone' not in str(getattr(t, 'type', '')).lower()
            ]
            tot_p_tasks = len(p_tasks)
            p_done = [t for t in p_tasks if getattr(t, 'completed', 0) == 1 or normalize_progress(getattr(t, 'progress', 0)) >= 100]
            tot_prog = sum(normalize_progress(getattr(t, 'progress', 0)) for t in p_tasks)
            avg_prog = round(tot_prog / tot_p_tasks) if tot_p_tasks > 0 else 0
            end_d = extract_date(p.end_date)
            end_str = end_d.strftime("%d/%m/%Y") if end_d else "N/D"
            tipi = []
            if getattr(p, 'is_atex', False):
                tipi.append("ATEX")
            if getattr(p, 'is_alimentare', False):
                tipi.append("Alimentare")
            tipo_tag = f"[{' + '.join(tipi)}]" if tipi else "[Standard]"
            active_proj_lines.append(
                f"- **{p.name}** ({p.code or 'No Code'}) | Cliente: {p.client or 'Interno'} | Tipologia: **{tipo_tag}** | Scadenza: {end_str} | Avanzamento commessa: **{avg_prog}%** (Fasi operative: {tot_p_tasks}, di cui concluse al 100%: {len(p_done)})"
            )

        active_proj_text = "\n".join(active_proj_lines) if active_proj_lines else "Nessuna commessa attiva al momento."

        overdue_lines = []
        for t in overdue_tasks[:15]:
            proj = proj_map.get(str(t.project_id))
            p_name = proj.name if proj and proj.name else "Commessa sconosciuta"
            w_str = t.workers or "Non assegnato"
            t_end = extract_date(t.end_date)
            overdue_lines.append(f"- *{t.text}* (Commessa: **{p_name}**) | Scaduta il: {t_end.strftime('%d/%m/%Y') if t_end else 'N/D'} | Addetti: {w_str}")
        overdue_text = "\n".join(overdue_lines) if overdue_lines else "Nessuna attività scaduta in ritardo."

        worker_lines = []
        sorted_workers = sorted(worker_stats.items(), key=lambda x: x[1]["active"], reverse=True)
        for w_name, s in sorted_workers:
            worker_lines.append(f"- **{w_name}**: {s['active']} attive in corso, {s['completed']} completate, {s['overdue']} in ritardo (Totale: {s['total']})")
        worker_text = "\n".join(worker_lines) if worker_lines else "Nessun addetto attualmente assegnato a fasi di commessa."

        upcoming_lines = []
        for t in upcoming_tasks[:15]:
            proj = proj_map.get(str(t.project_id))
            p_name = proj.name if proj and proj.name else "Commessa sconosciuta"
            w_str = t.workers or "Non assegnato"
            t_end = extract_date(t.end_date)
            upcoming_lines.append(f"- *{t.text}* (Commessa: **{p_name}**) | Scadenza: {t_end.strftime('%d/%m/%Y') if t_end else 'N/D'} | Addetti: {w_str}")
        upcoming_text = "\n".join(upcoming_lines) if upcoming_lines else "Nessuna scadenza critica nei prossimi 7 giorni."

        # --- Calcolo Metriche & Sintesi TODO ---
        completed_todos = [t for t in todos if t.is_completed]
        active_todos = [t for t in todos if not t.is_completed]
        overdue_todos = []
        upcoming_todos = []
        for t in active_todos:
            t_due = extract_date(t.due_date)
            if t_due:
                if t_due < today:
                    overdue_todos.append(t)
                elif t_due <= today + timedelta(days=7):
                    upcoming_todos.append(t)

        todo_lines = []
        for t in active_todos[:12]:
            t_due = extract_date(t.due_date)
            due_str = f"Scadenza: {t_due.strftime('%d/%m/%Y')}" if t_due else "Senza scadenza"
            creator_name = user_name_map.get(str(t.creator_id), "Utente")
            is_overdue_flag = " ⚠️ **IN RITARDO**" if (t_due and t_due < today) else ""
            todo_lines.append(f"- **{t.title}** ({due_str}{is_overdue_flag}) | Creato da: {creator_name}")
        todo_text = "\n".join(todo_lines) if todo_lines else "Nessun TODO pendente."

        # --- Calcolo Metriche & Sintesi Ticket ---
        tickets_da_gestire = [t for t in tickets if str(t.status).lower() in ["da gestire", "ticketstatus.da_gestire"]]
        tickets_in_attesa = [t for t in tickets if str(t.status).lower() in ["in attesa del cliente", "ticketstatus.in_attesa"]]
        tickets_completati = [t for t in tickets if str(t.status).lower() in ["completato", "ticketstatus.completato"]]
        unresolved_tickets = [t for t in tickets if t not in tickets_completati]
        
        high_tickets = [t for t in unresolved_tickets if str(t.priority).lower() in ["high", "ticketpriority.high"]]
        medium_tickets = [t for t in unresolved_tickets if str(t.priority).lower() in ["medium", "ticketpriority.medium"]]
        low_tickets = [t for t in unresolved_tickets if str(t.priority).lower() in ["low", "ticketpriority.low"]]

        ticket_lines = []
        for t in unresolved_tickets[:12]:
            pr_code = t.custom_project_code or ""
            if not pr_code and t.project_id:
                pr = proj_map.get(str(t.project_id))
                pr_code = pr.code or pr.name if pr else ""
            pr_label = f" [Commessa: {pr_code}]" if pr_code else ""
            prio_badge = "🔴 ALTA" if str(t.priority).lower() in ["high", "ticketpriority.high"] else ("🟡 MEDIA" if str(t.priority).lower() in ["medium", "ticketpriority.medium"] else "🟢 BASSA")
            ticket_lines.append(f"- **{t.title}** ({prio_badge} | Stato: *{t.status}*{pr_label})")
        ticket_text = "\n".join(ticket_lines) if ticket_lines else "Nessun ticket in attesa di gestione."

        # --- Calcolo Metriche & Sintesi Preventivazione (Richieste Commerciali) ---
        commerciali_aperte = [r for r in commerciali if str(r.status).lower() in ["aperta", "richiestastatus.aperta"]]
        commerciali_in_lav = [r for r in commerciali if str(r.status).lower() in ["in_lavorazione", "richiestastatus.in_lavorazione"]]
        commerciali_manca_listino = [r for r in commerciali if str(r.status).lower() in ["manca_listino", "richiestastatus.manca_listino"]]
        commerciali_completate = [r for r in commerciali if str(r.status).lower() in ["completata", "richiestastatus.completata"]]
        active_commerciali = [r for r in commerciali if r not in commerciali_completate]

        total_preventivi_val = 0.0
        comm_lines = []
        for r in active_commerciali[:12]:
            num_art = len(r.articoli) if r.articoli else 0
            val_r = sum((a.prezzo_listino or a.costo or 0.0) for a in (r.articoli or []))
            total_preventivi_val += val_r
            off_str = f"Offerta: {r.numero_offerta} | " if r.numero_offerta else ""
            comm_lines.append(f"- **{r.title}** (Cliente: **{r.cliente}**) | {off_str}Stato: *{r.status}* | Articoli: {num_art} | Valore stimato: {val_r:,.2f} €")
        commerciali_text = "\n".join(comm_lines) if comm_lines else "Nessuna richiesta di preventivazione aperta o in corso."

        # Tentativo chiamata LLM
        report_markdown = ""
        if self.llm:
            try:
                system_prompt = (
                    f"Sei un Senior Business & Project Management AI Consultant per la piattaforma HiPlan.\n"
                    f"Oggi è il {today_str}.\n"
                    f"Genera un Resoconto Esecutivo Globale chiaro, professionale, completo e altamente azionabile per la direzione aziendale e gli amministratori.\n"
                    f"Il resoconto deve coprire in modo organico: COMMESSE, CARICHI ADDETTI, CHECKLIST TODO, ASSISTENZA TICKET e PIPELINE PREVENTIVAZIONE.\n\n"
                    f"DATI AGGIORNATI DEL SISTEMA:\n"
                    f"1. COMMESSE:\n"
                    f"- Totali: {total_projects} (Attive: {len(active_projects)}, In Pianificazione: {len(planning_projects)}, Completate: {len(completed_projects)}, Archiviate: {len(archived_projects)})\n"
                    f"- Ripartizione Tipologie: Standard: {total_standard}, ATEX (Rischio esplosione): {total_atex}, Alimentare (Food Grade): {total_alimentare}\n"
                    f"- Fasi Operative: Totali: {total_tasks}, Avanzamento medio ponderato: {avg_global_progress}%, Fasi 100%: {len(completed_tasks)}, Fasi in corso: {len(active_tasks)}, In Ritardo: {len(overdue_tasks)}\n"
                    f"- Scadenze a 7 giorni: {len(upcoming_tasks)}\n"
                    f"{active_proj_text}\n\n"
                    f"2. CRITICITÀ E RITARDI COMMESSE:\n{overdue_text}\n\n"
                    f"3. CARICO DI LAVORO ADDETTI:\n{worker_text}\n\n"
                    f"4. SCADENZE IMMINENTI:\n{upcoming_text}\n\n"
                    f"5. CHECKLIST TODO & ATTIVITÀ INTERNE:\n"
                    f"- Totali: {len(todos)} (In sospeso: {len(active_todos)}, Completati: {len(completed_todos)}, Scaduti: {len(overdue_todos)}, Scadenza a 7gg: {len(upcoming_todos)})\n"
                    f"{todo_text}\n\n"
                    f"6. ASSISTENZA & TICKET:\n"
                    f"- Totali: {len(tickets)} (Da gestire: {len(tickets_da_gestire)}, In attesa cliente: {len(tickets_in_attesa)}, Completati: {len(tickets_completati)})\n"
                    f"- Priorità ticket aperti: Alta: {len(high_tickets)}, Media: {len(medium_tickets)}, Bassa: {len(low_tickets)}\n"
                    f"{ticket_text}\n\n"
                    f"7. PIPELINE PREVENTIVAZIONE (RICHIESTE COMMERCIALI):\n"
                    f"- Totali: {len(commerciali)} (Aperte: {len(commerciali_aperte)}, In lavorazione: {len(commerciali_in_lav)}, Manca listino: {len(commerciali_manca_listino)}, Completate: {len(commerciali_completate)})\n"
                    f"- Valore totale stimato offerte attive: {total_preventivi_val:,.2f} €\n"
                    f"{commerciali_text}\n\n"
                    f"ISTRUZIONI RIGOROSE E VINCOLANTI:\n"
                    f"1. PRECISIONE ASSOLUTA SUI DATI:\n"
                    f"   - Riporta fedelmente le percentuali di avanzamento e i dati numerici reali indicati sopra per tutte le sezioni.\n"
                    f"2. DIVIETO ASSOLUTO DI CONSIGLI GENERALISTI O DI BUON SENSO:\n"
                    f"   - Evita formule ovvie ('fare riunioni', 'monitorare attentamente', 'prestare attenzione').\n"
                    f"   - Nelle raccomandazioni operative cita esplicitamente commesse, ticket o preventivi specifici e l'azione concreta da intraprendere.\n"
                    f"3. STRUTTURA DEL DOCUMENTO:\n"
                    f"   - Formatta in Markdown pulito, autorevole ed elegante senza saluti iniziali o finali.\n"
                    f"Usa esattamente questa struttura a 7 capitoli:\n"
                    f"# 📑 Resoconto Esecutivo Globale: Commesse, Operatività & Preventivazione ({today_str})\n\n"
                    f"### 1. 📊 Sintesi Esecutiva & Stato Commesse\n"
                    f"Panoramica sintetica dello stato commesse attive, avanzamento ponderato e tipologie speciali (ATEX, Alimentare, Standard).\n\n"
                    f"### 2. 👥 Analisi Carico di Lavoro & Distribuzione Addetti\n"
                    f"Distribuzione del carico sulle fasi di commessa, individuazione di picchi o sbilanciamenti tra risorse.\n\n"
                    f"### 3. ⚠️ Criticità, Ritardi & Scadenze Imminenti (Commesse)\n"
                    f"Fasi in ritardo e attività in consegna a breve termine (7 giorni), evidenziando vincoli tecnici o collaudi.\n\n"
                    f"### 4. 📋 Panoramica Operativa: TODO & Checklist Interne\n"
                    f"Stato dei TODO aziendali, task scaduti, checklist in lavorazione e priorità operative.\n\n"
                    f"### 5. 🎫 Assistenza & Ticket di Supporto\n"
                    f"Analisi dei ticket aperti, richieste con priorità alta, tempi di attesa e impatto sui clienti o sulle commesse.\n\n"
                    f"### 6. 💼 Pipeline Preventivazione & Richieste Commerciali\n"
                    f"Stato dell'ufficio commerciale e acquisti: richieste in corso, offerte in valutazione, prezzi mancanti e volume stimato.\n\n"
                    f"### 7. 💡 Raccomandazioni Strategiche & Operative Interfunzionali\n"
                    f"3-4 azioni prioritarie e circostanziate che incrociano commesse, smaltimento ticket critici e sblocco preventivi.\n"
                )
                response = await self.llm.ainvoke(system_prompt)
                content = getattr(response, "content", response)
                if isinstance(content, str):
                    report_markdown = content
                elif isinstance(content, list):
                    report_markdown = "\n".join(str(c) for c in content)
                else:
                    report_markdown = str(content)
            except Exception as e:
                logger.error(f"Errore nella generazione report con LLM: {e}")

        # Fallback raccomandazioni specifiche interfunzionali
        rec_bullets = []
        if overdue_tasks:
            for ot in overdue_tasks[:2]:
                pr = proj_map.get(str(ot.project_id))
                pr_label = f"**{pr.name}** ({pr.code or ''})" if pr else "Commessa"
                w_str = ot.workers or "non assegnato"
                t_end = extract_date(ot.end_date)
                rec_bullets.append(f"- **Riprogrammazione commessa**: ridefinire scadenza per fase *{ot.text}* ({pr_label}), scaduta il {t_end.strftime('%d/%m/%Y') if t_end else 'N/D'} (in carico a {w_str}).")
        
        if high_tickets:
            ht = high_tickets[0]
            rec_bullets.append(f"- **Priorità Ticket di Assistenza**: intervenire immediatamente sul ticket ad alta priorità *{ht.title}* per evitare disservizi verso il cliente.")
        
        if commerciali_manca_listino:
            rc = commerciali_manca_listino[0]
            rec_bullets.append(f"- **Sblocco Preventivo ({rc.cliente})**: completare l'inserimento dei prezzi listino per la richiesta *{rc.title}* per consentire l'invio dell'offerta.")
        elif commerciali_in_lav:
            rc = commerciali_in_lav[0]
            rec_bullets.append(f"- **Avanzamento Preventivazione**: sollecitare la quotazione degli articoli per la richiesta di *{rc.cliente}* in lavorazione presso l'ufficio acquisti.")

        if sorted_workers and sorted_workers[0][1]["active"] >= 3:
            bw, bs = sorted_workers[0]
            rec_bullets.append(f"- **Ribilanciamento risorse**: l'addetto {bw} concentra {bs['active']} fasi aperte contemporanee; ridistribuire le lavorazioni non critiche.")

        if not rec_bullets:
            rec_bullets.append("- Nessuna misura correttiva d'emergenza necessaria. Commesse, ticket e preventivi risultano regolarmente presidiati.")
        fallback_rec_text = "\n".join(rec_bullets)

        # Fallback deterministico completo con tutte le 7 sezioni
        if not report_markdown:
            report_markdown = (
                f"# 📑 Resoconto Esecutivo Globale: Commesse, Operatività & Preventivazione ({today_str})\n\n"
                f"### 1. 📊 Sintesi Esecutiva & Stato Commesse\n"
                f"Nel sistema risultano registrate **{total_projects} commesse complessive**, di cui **{len(active_projects)} attive**, "
                f"**{len(planning_projects)} in fase di pianificazione** e **{len(completed_projects)} completate**.\n"
                f"Ripartizione per tipologia: **{total_standard} Standard**, **{total_atex} ATEX**, **{total_alimentare} Alimentare**.\n\n"
                f"**Stato delle commesse attive:**\n"
                f"{active_proj_text}\n\n"
                f"### 2. 👥 Analisi Carico di Lavoro & Distribuzione Addetti\n"
                f"Gli addetti coinvolti nelle attività sono **{len(worker_stats)}**. Di seguito il riepilogo del carico di ciascun membro del team sulle fasi operative:\n\n"
                f"{worker_text}\n\n"
                f"### 3. ⚠️ Criticità, Ritardi & Scadenze Imminenti (Commesse)\n"
                f"Attualmente si registrano **{len(overdue_tasks)} attività in ritardo** e **{len(upcoming_tasks)} attività in scadenza nei prossimi 7 giorni**.\n\n"
                f"**Attività in ritardo:**\n{overdue_text}\n\n"
                f"**Scadenze nei prossimi 7 giorni:**\n{upcoming_text}\n\n"
                f"### 4. 📋 Panoramica Operativa: TODO & Checklist Interne\n"
                f"Nel modulo TODO figurano **{len(todos)} attività complessive**, di cui **{len(active_todos)} in sospeso** e **{len(completed_todos)} completate**. "
                f"Attualmente si contano **{len(overdue_todos)} TODO scaduti** e **{len(upcoming_todos)} in scadenza nei prossimi 7 giorni**.\n\n"
                f"**Principali TODO in lavorazione:**\n"
                f"{todo_text}\n\n"
                f"### 5. 🎫 Assistenza & Ticket di Supporto\n"
                f"Il sistema registra **{len(tickets)} ticket complessivi**. Di questi, **{len(tickets_da_gestire)} sono da gestire**, "
                f"**{len(tickets_in_attesa)} in attesa di risposta dal cliente** e **{len(tickets_completati)} risolti**.\n"
                f"Distribuzione per priorità sui ticket non chiusi: **{len(high_tickets)} Alta**, **{len(medium_tickets)} Media**, **{len(low_tickets)} Bassa**.\n\n"
                f"**Ticket aperti o in attesa:**\n"
                f"{ticket_text}\n\n"
                f"### 6. 💼 Pipeline Preventivazione & Richieste Commerciali\n"
                f"Nella sezione commerciale sono presenti **{len(commerciali)} richieste di offerta**, di cui **{len(active_commerciali)} attive** "
                f"(**{len(commerciali_aperte)} aperte**, **{len(commerciali_in_lav)} in lavorazione ufficio acquisti**, **{len(commerciali_manca_listino)} in attesa listino**, **{len(commerciali_completate)} completate**).\n"
                f"Il volume economico stimato per le offerte attive ammonta a **{total_preventivi_val:,.2f} €**.\n\n"
                f"**Richieste commerciali attive:**\n"
                f"{commerciali_text}\n\n"
                f"### 7. 💡 Raccomandazioni Strategiche & Operative Interfunzionali\n"
                f"{fallback_rec_text}"
            )

        return {
            "report": report_markdown.strip(),
            "kpis": {
                # Commesse
                "total_projects": total_projects,
                "active_projects": len(active_projects),
                "planning_projects": len(planning_projects),
                "completed_projects": len(completed_projects),
                "total_tasks": total_tasks,
                "active_tasks": len(active_tasks),
                "overdue_tasks": len(overdue_tasks),
                "total_workers": len(worker_stats),
                "upcoming_deadlines_count": len(upcoming_tasks),
                "atex_projects": total_atex,
                "alimentare_projects": total_alimentare,
                "standard_projects": total_standard,
                # TODO
                "total_todos": len(todos),
                "pending_todos": len(active_todos),
                "overdue_todos": len(overdue_todos),
                "completed_todos": len(completed_todos),
                # Ticket
                "total_tickets": len(tickets),
                "open_tickets": len(tickets_da_gestire),
                "waiting_tickets": len(tickets_in_attesa),
                "high_priority_tickets": len(high_tickets),
                # Preventivazione
                "total_preventivi": len(commerciali),
                "active_preventivi": len(active_commerciali),
                "in_progress_preventivi": len(commerciali_in_lav),
                "waiting_listino_preventivi": len(commerciali_manca_listino),
                "completed_preventivi": len(commerciali_completate),
                "preventivi_estimated_value": round(total_preventivi_val, 2)
            },
            "generated_at": datetime.now().strftime("%d/%m/%Y alle %H:%M"),
            "generated_timestamp": int(datetime.now().timestamp() * 1000)
        }

    async def generate_meeting_minutes(self, transcript: str, meeting_type: str = "general", title: str | None = None) -> dict:
        """
        Elabora una trascrizione di riunione (in presenza o videochiamata) e genera una minuta strutturata.
        Restituisce un dizionario con titolo, HTML pulito, markdown, punti chiave, decisioni e action items.
        """
        if not transcript or not transcript.strip():
            raise ValueError("La trascrizione non può essere vuota.")

        from datetime import datetime
        type_labels = {
            "general": "Riunione Generale",
            "operativa": "Riunione Operativa / SAL Commessa",
            "commerciale": "Incontro Commerciale / Trattativa Cliente",
            "tecnica": "Briefing Tecnico / Progettazione",
        }
        meeting_label = type_labels.get(meeting_type, "Riunione")
        today_str = datetime.now().strftime("%d/%m/%Y")

        system_prompt = f"""Sei un assistente esecutivo aziendale per HiPlan.
Il tuo compito è analizzare la seguente trascrizione cronologica di una riunione o videochiamata (che include in sequenza temporale sia gli interventi al microfono sia le risposte e l'audio del computer) e redigere una minuta/verbale impeccabile, professionale, chiara e azionabile.

Tipo di Riunione: {meeting_label}
Data: {today_str}
Titolo/Contesto fornito: {title or 'Non specificato'}

Trascrizione (in ordine cronologico reale della discussione):
\"\"\"
{transcript}
\"\"\"

IMPORTANTE SULL'ALTERNANZA DELLA CONVERSAZIONE:
- La trascrizione rispetta l'ordine temporale esatto dello scambio verbale tra i partecipanti.
- Presta particolare attenzione all'alternanza del dialogo: chi pone domande, chi risponde, quali dubbi o obiezioni vengono sollevati e quali accordi vengono raggiunti tra le parti.
- Evidenzia nel testo e negli Action Items l'assegnazione dei compiti a chi si è assunto la responsabilità durante la conversazione.

Devi rispondere ESCLUSIVAMENTE con un oggetto JSON valido (senza testo prima o dopo, senza commenti) con questa struttura esatta:
{{
  "title": "Titolo chiaro e professionale della riunione (es: Minuta: Riunione Avanzamento Commessa XYZ)",
  "key_points": [
    "Punto chiave 1 (con riferimento a chi ha proposto o concordato)...",
    "Punto chiave 2..."
  ],
  "decisions": [
    "Decisione o accordo 1...",
    "Decisione o accordo 2..."
  ],
  "action_items": [
    "[Chi] Azione da fare - eventuale scadenza o commessa",
    "[Chi] Seconda azione..."
  ],
  "summary_html": "<h1>...</h1><p>...</p>...",
  "summary_markdown": "# ..."
}}

Linee guida per `summary_html`:
- Utilizza tag HTML puliti: <h1> per il titolo della minuta, <h2> per le sezioni principali, <p> per i paragrafi, <ul> e <li> per gli elenchi, <strong> per enfasi sui nomi, ruoli o scadenze.
- Sezioni da includere nel summary_html:
  1. <h1>Titolo Minuta</h1>
  2. <p><em>Data: {today_str} | Tipologia: {meeting_label}</em></p>
  3. <h2>📌 Sintesi Esecutiva</h2> con un riassunto discorsivo che descrive lo sviluppo e l'esito del confronto tra le parti.
  4. <h2>📋 Argomenti e Punti Chiave</h2> con lista puntata degli argomenti trattati in ordine di discussione.
  5. <h2>⚖️ Decisioni Prese</h2> con lista puntata dei punti fermi concordati.
- IMPORTANTE: NON inserire in summary_html la trascrizione integrale della riunione (niente blocchi <details> né sezioni con la trascrizione grezza). Includi ESCLUSIVAMENTE la sintesi esecutiva, gli argomenti e punti chiave, le decisioni prese e il piano di azione (TODO).
- Stile elegante, italiano formale e preciso, orientato all'efficienza operativa.
"""

        try:
            if hasattr(self, 'llm') and self.llm:
                response = await self.llm.ainvoke(system_prompt)
                content = response.content if hasattr(response, 'content') else str(response)
                
                # Pulisci eventuale wrapping markdown ```json ... ```
                clean_content = content.strip()
                if clean_content.startswith("```"):
                    clean_content = re.sub(r"^```(?:json)?\s*", "", clean_content)
                    clean_content = re.sub(r"\s*```$", "", clean_content)
                clean_content = clean_content.strip()

                parsed = json.loads(clean_content)
                if isinstance(parsed, dict) and "title" in parsed and "summary_html" in parsed:
                    # Assicurati che non vi siano blocchi details di trascrizione
                    parsed["summary_html"] = re.sub(r'<details\b[^>]*>[\s\S]*?<\/details>', '', parsed["summary_html"]).strip()
                    return parsed
        except Exception as e:
            logger.warning(f"Errore durante invocazione LLM per minuta: {e}. Genero fallback strutturato.")

        # Fallback deterministico intelligente se LLM fallisce o non disponibile
        generated_title = title if title and title.strip() else f"Minuta: {meeting_label} - {today_str}"
        paragraphs = [p.strip() for p in transcript.split("\n") if p.strip()]
        key_points = [p[:100] + "..." if len(p) > 100 else p for p in paragraphs[:4]] or ["Discussione generale dei punti all'ordine del giorno."]
        
        fallback_html = f"""<h1>{generated_title}</h1>
<p><em>Data: {today_str} | Tipologia: {meeting_label}</em></p>
<h2>📌 Sintesi Esecutiva</h2>
<p>Riassunto degli argomenti trattati durante la sessione di lavoro e allineamento operativo.</p>
<h2>📋 Argomenti Trattati</h2>
<ul>
{''.join(f'<li>{kp}</li>' for kp in key_points)}
</ul>
<h2>⚖️ Decisioni Prese</h2>
<ul>
<li>Allineamento operativo sulle attività correnti e verifica delle priorità concordate.</li>
</ul>
"""

        fallback_md = f"""# {generated_title}
- Data: {today_str} | Tipologia: {meeting_label}

## 📌 Sintesi Esecutiva
Riassunto degli argomenti trattati durante la sessione di lavoro e allineamento operativo.

## 📋 Argomenti Trattati
""" + "\n".join(f"- {kp}" for kp in key_points) + """

## ⚖️ Decisioni Prese
- Allineamento operativo sulle attività correnti e verifica delle priorità concordate.
"""

        return {
            "title": generated_title,
            "key_points": key_points,
            "decisions": ["Allineamento operativo sulle attività correnti e verifica delle priorità concordate."],
            "action_items": ["Verificare avanzamento delle attività pianificate con gli addetti incaricati."],
            "summary_html": fallback_html,
            "summary_markdown": fallback_md
        }

    async def transcribe_audio(
        self,
        file_bytes: bytes,
        filename: str = "recording.webm",
        content_type: str = "audio/webm",
        language: str = "it",
        include_timestamps: bool = False
    ) -> dict:
        """
        Trascrive un file audio (es. registrazione mista microfono + audio videochiamata PC)
        utilizzando Whisper Large V3 tramite Groq per una trascrizione ad altissima velocità e precisione.
        """
        if not file_bytes:
            raise ValueError("Il file audio fornito è vuoto.")

        if not settings.GROQ_API_KEY:
            raise ValueError("GROQ_API_KEY non configurata sul server per la trascrizione con Whisper.")

        try:
            from groq import Groq
            client = Groq(api_key=settings.GROQ_API_KEY)

            # Assicura estensione supportata da Whisper
            clean_name = filename or "recording.webm"
            base, ext = os.path.splitext(clean_name)
            if not ext or ext.lower() not in [".webm", ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".flac"]:
                clean_name = f"{base}.webm"

            # Invocazione Whisper su Groq con prompt per formattazione e punteggiatura
            prompt_text = (
                "Trascrizione accurata di una riunione o videochiamata in lingua italiana con alternanza di interlocutori. "
                "Mantieni maiuscole, punteggiatura e corretta separazione delle frasi e dei cambi di voce."
            )
            transcription = client.audio.transcriptions.create(
                file=(clean_name, file_bytes, content_type or "audio/webm"),
                model="whisper-large-v3",
                language=language or "it",
                prompt=prompt_text,
                response_format="verbose_json"
            )

            text = transcription.text if hasattr(transcription, "text") else str(transcription)
            duration = getattr(transcription, "duration", None)

            # Estrai i segmenti cronologici per preservare l'alternanza naturale e ordinata della conversazione
            formatted_lines = []
            segments = getattr(transcription, "segments", None)
            if segments is None and isinstance(transcription, dict):
                segments = transcription.get("segments")

            if segments:
                for seg in segments:
                    s_start = getattr(seg, "start", None) if not isinstance(seg, dict) else seg.get("start")
                    s_text = getattr(seg, "text", "") if not isinstance(seg, dict) else seg.get("text", "")
                    s_text = (s_text or "").strip()
                    if not s_text:
                        continue
                    if include_timestamps and s_start is not None:
                        m = int(float(s_start) // 60)
                        s = int(float(s_start) % 60)
                        formatted_lines.append(f"[{m:02d}:{s:02d}] {s_text}")
                    else:
                        formatted_lines.append(s_text)

            final_transcript = ("\n".join(formatted_lines) if include_timestamps else " ".join(formatted_lines)) if formatted_lines else text.strip()

            return {
                "transcript": final_transcript,
                "duration": duration
            }
        except Exception as e:
            logger.error(f"Errore durante la trascrizione audio con AI: {e}", exc_info=True)
            raise RuntimeError(f"Errore trascrizione audio: {str(e)}")

chat_service = ChatService()

