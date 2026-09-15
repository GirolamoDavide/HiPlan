import os
import re
import json
from datetime import date, timedelta
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
                model="gemini-2.5-flash",
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

    @property
    def db(self):
        if self._db is None:
            from sqlalchemy import inspect
            inspector = inspect(self.engine)
            existing_tables = set(inspector.get_table_names())
            
            to_ignore = [
                "activity_logs", "agent_logs", "email_logs", "replan_logs", "planning_runs",
                "notes", "todos", "calendar_events", "richieste_commerciali", "articoli_richiesta"
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
        
        # 0. Esclusione tassativa: Preventivazione / Richieste Commerciali
        preventivazione_keys = [
            "preventiv", "richieste commercial", "richiesta commercial",
            "articoli richiest", "articolo richiest", "offerte commercial",
            "offerta commercial", "prezzi fornitore", "prezzo fornitore",
            "costi fornitore", "costo fornitore", "prezzi d'acquisto",
            "prezzo d'acquisto", "margine preventiv", "margini preventiv"
        ]
        if any(k in m for k in preventivazione_keys):
            return "preventivazione_restricted"

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
        if any(k in m for k in my_tasks_keys):
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

    async def get_response(self, user_message: str, current_user=None, history=None) -> str:
        intent = self._classify_intent(user_message)
        logger.info(f"Chatbot Router: messaggio '{user_message}' classificato come INTENT '{intent}'")

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
            # INTENT 0: ESCLUSIONE PREVENTIVAZIONE / RICHIESTE COMMERCIALI
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
                    "- Rilevare conflitti di calendario, ferie concomitanti, ritardi e carichi addetti\n"
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

                        users_res = await session.execute(select(User))
                        users = users_res.scalars().all()
                        users_list_str = "\n".join([f"- {u.full_name or u.username} ({u.role.value if hasattr(u.role, 'value') else u.role})" for u in users])
                except Exception as e:
                    logger.error(f"Errore recupero suggerimenti/utenti per chatbot: {e}")

                alarms_prompt = PromptTemplate.from_template(
                    "Sei l'assistente virtuale ufficiale di HiPlan per la gestione commesse, Gantt e conflitti aziendali.\n"
                    "Data di oggi: {today_str}\n"
                    "Utente interlocutore: {full_name} (@{username}) | Ruolo: {user_role}\n\n"
                    "ANOMALIE E SUGGERIMENTI RILEVATI DAL MOTORE GANTT:\n"
                    "{suggestions_text}\n\n"
                    "COLLABORATORI AZIENDALI:\n"
                    "{users_list_str}\n\n"
                    "RICHIESTA DELL'UTENTE:\n"
                    "{message}\n\n"
                    "ISTRUZIONI OBBLIGATORIE:\n"
                    "1. TABELLE:\n"
                    "   * Se l'utente chiede una lista o riepilogo delle criticità/ritardi, genera SEMPRE una tabella Markdown chiara e compatta.\n"
                    "   * Usa colonne sintetiche: | Commessa | Fase / Area | Tipo Criticità | Periodo | Addetti | Note |\n"
                    "   * Non mostrare MAI array JSON per gli addetti (es. NON scrivere mai `[\"anna_uff\"]`, scrivi solo `anna_uff`).\n"
                    "2. BOZZE EMAIL:\n"
                    "   * Se l'utente chiede di avvisare, scrivere o inviare un'email, redigi una bozza formale completa con: Oggetto, Destinatario, Testo professionale, Firma.\n"
                    "   * Includi sempre una riga: `[✉️ Invia bozza email](mailto:destinatario@azienda.it?subject=...&body=...)` per consentire l'invio istantaneo.\n"
                    "3. RACCOMANDAZIONE FINALE:\n"
                    "   * Concludi sempre con:\n"
                    "     ---\n"
                    "     💡 **Azione consigliata:** [consiglio pratico chiaro per risolvere la criticità]\n\n"
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
            ticket_permission_rule = (
                "L'utente ha accesso a TUTTI i ticket."
                if user_role in ["ADMIN", "EDITOR"]
                else f"L'utente può vedere SOLO i ticket creati da lui o assegnati a lui: `WHERE (tickets.created_by = '{user_id}' OR tickets.assigned_to = '{user_id}')`."
            )

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
3. Tabella 'tickets' (Ticket di supporto e commessa):
   * {ticket_permission_rule}
   * 'status' contiene: 'DA_GESTIRE', 'IN_ATTESA', 'COMPLETATO'. I ticket aperti sono: `status IN ('DA_GESTIRE', 'IN_ATTESA')`.
4. ESCLUSIONE TASSATIVA SEZIONE PREVENTIVAZIONE:
   * Le tabelle 'richieste_commerciali' e 'articoli_richiesta' e qualsiasi informazione su preventivi, prezzi fornitore, margini o richieste commerciali sono RISERVATE ed ESCLUSE dal chatbot.
   * NON generare MAI query che coinvolgono preventivi o richieste commerciali.
5. Per ricerche testuali usa sempre `LIKE '%...%' COLLATE NOCASE`.

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
- Domanda: "Mostrami i ticket aperti ad alta priorità"
  SQL: SELECT t.id, t.title, t.priority, t.status, p.name AS project_name FROM tickets t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status IN ('DA_GESTIRE', 'IN_ATTESA') AND t.priority = 'HIGH';

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
                ticket_permission_rule=ticket_permission_rule,
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
            
            def execute_and_log(sql_query: str) -> str:
                """Esegue la query SQL e, in caso di errore, esegue il Self-Correction Loop automatico."""
                # Blocco di sicurezza rigoroso su dati di preventivazione
                if re.search(r'\b(richieste_commerciali|articoli_richiesta)\b', sql_query, re.IGNORECASE):
                    logger.warning(f"Bloccato tentativo di query su tabelle di preventivazione: {sql_query}")
                    return "ACCESSO_NEGATO_PREVENTIVAZIONE: I dati della pagina Preventivazione sono riservati ed esclusi dal chatbot."
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
                "   * Se la risposta contiene 2 o più elementi (commesse, fasi, addetti o ticket), DEVI SEMPRE impaginare i dati in una TABELLA MARKDOWN pulita.\n"
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
                "   * Non mostrare ID numerici o valori grezzi ('ACTIVE' -> 'Attiva', 'HIGH' -> 'Alta', 'DA_GESTIRE' -> 'Da gestire').\n"
                "5. ESCLUSIONE CONTENUTI PREVENTIVAZIONE:\n"
                "   * I contenuti della pagina Preventivazione (richieste commerciali, articoli di preventivo, offerte, prezzi fornitore) sono rigorosamente esclusi dal chatbot.\n"
                "   * Se il risultato estratto o la domanda fa riferimento a preventivi o richieste commerciali, rispondi spiegando chiaramente che tali dati sono riservati e consultabili unicamente nella pagina Preventivazione di HiPlan.\n\n"
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
        from app.models.project import Project, ProjectStatus
        from app.models.task import Task, TaskType
        from app.models.user import User

        today = date.today()
        today_str = today.strftime("%d/%m/%Y")

        # 1. Carica progetti non eliminati
        res_proj = await db.execute(select(Project).where(Project.deleted_at.is_(None)))
        projects = res_proj.scalars().all()

        # 2. Carica task
        res_tasks = await db.execute(select(Task))
        tasks = res_tasks.scalars().all()

        # 3. Carica utenti attivi
        res_users = await db.execute(select(User).where(User.is_active.is_(True)))
        users = res_users.scalars().all()

        # Calcolo KPI
        total_projects = len(projects)
        active_projects = [p for p in projects if p.status == ProjectStatus.ACTIVE]
        planning_projects = [p for p in projects if p.status == ProjectStatus.PLANNING]
        completed_projects = [p for p in projects if p.status == ProjectStatus.COMPLETED]
        archived_projects = [p for p in projects if p.status == ProjectStatus.ARCHIVED]

        total_atex = len([p for p in projects if getattr(p, 'is_atex', False)])
        total_alimentare = len([p for p in projects if getattr(p, 'is_alimentare', False)])
        total_standard = len([p for p in projects if not getattr(p, 'is_atex', False) and not getattr(p, 'is_alimentare', False)])

        # Task operativi (escludendo contenitori di commessa e milestone)
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
            if t.end_date:
                if t.end_date < today:
                    overdue_tasks.append(t)
                elif t.end_date <= today + timedelta(days=7):
                    upcoming_tasks.append(t)

        # Mappatura task per progetto
        proj_map = {str(p.id): p for p in projects}

        # Statistiche per addetto (su task operativi)
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
                        if t.end_date and t.end_date < today:
                            worker_stats[w_name]["overdue"] += 1

        # Genera testi di riepilogo dati con avanzamento effettivo e coerente al frontend
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
            end_str = p.end_date.strftime("%d/%m/%Y") if p.end_date else "N/D"
            tipi = []
            if getattr(p, 'is_atex', False):
                tipi.append("ATEX")
            if getattr(p, 'is_alimentare', False):
                tipi.append("Alimentare")
            tipo_tag = f"[{' + '.join(tipi)}]" if tipi else "[Standard]"
            active_proj_lines.append(
                f"- **{p.name}** ({p.code or 'No Code'}) | Cliente: {p.client or 'Interno'} | Tipologia: **{tipo_tag}** | Scadenza: {end_str} | Avanzamento commessa: **{avg_prog}%** (Fasi operative: {tot_p_tasks}, di cui concluse al 100%: {len(p_done)})"
            )

        if not active_proj_lines:
            active_proj_text = "Nessuna commessa attiva al momento."
        else:
            active_proj_text = "\n".join(active_proj_lines)

        # Dettaglio ritardi
        overdue_lines = []
        for t in overdue_tasks[:15]:
            proj = proj_map.get(str(t.project_id))
            p_name = proj.name if proj and proj.name else "Commessa sconosciuta"
            w_str = t.workers or "Non assegnato"
            overdue_lines.append(f"- *{t.text}* (Commessa: **{p_name}**) | Scaduta il: {t.end_date.strftime('%d/%m/%Y')} | Addetti: {w_str}")
        
        overdue_text = "\n".join(overdue_lines) if overdue_lines else "Nessuna attività scaduta in ritardo."

        # Distribuzione addetti
        worker_lines = []
        sorted_workers = sorted(worker_stats.items(), key=lambda x: x[1]["active"], reverse=True)
        for w_name, s in sorted_workers:
            worker_lines.append(f"- **{w_name}**: {s['active']} attive in corso, {s['completed']} completate, {s['overdue']} in ritardo (Totale: {s['total']})")
        
        worker_text = "\n".join(worker_lines) if worker_lines else "Nessun addetto attualmente assegnato a fasi di commessa."

        # Scadenze prossimi 7 giorni
        upcoming_lines = []
        for t in upcoming_tasks[:15]:
            proj = proj_map.get(str(t.project_id))
            p_name = proj.name if proj and proj.name else "Commessa sconosciuta"
            w_str = t.workers or "Non assegnato"
            upcoming_lines.append(f"- *{t.text}* (Commessa: **{p_name}**) | Scadenza: {t.end_date.strftime('%d/%m/%Y')} | Addetti: {w_str}")
        upcoming_text = "\n".join(upcoming_lines) if upcoming_lines else "Nessuna scadenza critica nei prossimi 7 giorni."

        # Tentativo chiamata LLM
        report_markdown = ""
        if self.llm:
            try:
                system_prompt = (
                    f"Sei un Senior Project Management AI Consultant per la piattaforma HiPlan.\n"
                    f"Oggi è il {today_str}.\n"
                    f"Genera un Resoconto Esecutivo chiaro, professionale, completo e altamente azionabile per la direzione aziendale e gli amministratori.\n\n"
                    f"DATI AGGIORNATI DEL SISTEMA:\n"
                    f"- Commesse Totali: {total_projects} (Attive: {len(active_projects)}, In Pianificazione: {len(planning_projects)}, Completate: {len(completed_projects)}, Archiviate: {len(archived_projects)})\n"
                    f"- Ripartizione Tipologie Commessa: Standard: {total_standard}, ATEX (Rischio esplosione): {total_atex}, Alimentare (Food Grade): {total_alimentare}\n"
                    f"- Fasi Operative Totali: {total_tasks} (Avanzamento medio ponderato: {avg_global_progress}%, Fasi 100% completate: {len(completed_tasks)}, Fasi in lavorazione: {len(active_tasks)}, In Ritardo: {len(overdue_tasks)})\n"
                    f"- Scadenze nei prossimi 7 giorni: {len(upcoming_tasks)}\n\n"
                    f"COMMESSE ATTIVE CON STATO AVANZAMENTO REALE:\n{active_proj_text}\n\n"
                    f"ATTIVITÀ SCADUTE O IN RITARDO:\n{overdue_text}\n\n"
                    f"CARICO ADDETTI:\n{worker_text}\n\n"
                    f"SCADENZE IMMINENTI (PROSSIMI 7 GIORNI):\n{upcoming_text}\n\n"
                    f"ISTRUZIONI RIGOROSE E VINCOLANTI:\n"
                    f"1. PRECISIONE ASSOLUTA SULL'AVANZAMENTO E STATO DI COMPLETAMENTO:\n"
                    f"   - Riporta FEDELMENTE la percentuale reale di avanzamento specificata per ciascuna commessa ('Avanzamento commessa: X%'). Per esempio, se una commessa indica 70%, DEVI scrivere 70%, NON 0%! Se indica 97%, riporta 97%, se indica 17%, riporta 17%.\n"
                    f"   - È SEVERAMENTE VIETATO calcolare l'avanzamento dividendo le fasi al 100% per il totale: le fasi in corso possiedono percentuali parziali già calcolate nel valore complessivo della commessa.\n"
                    f"   - Puoi specificare a completamento il numero di fasi chiuse al 100% (es. 'COMM1 è al 97% con 5 fasi su 6 concluse al 100%', oppure 'COMM2 è al 70% sulla fase attualmente in lavorazione').\n"
                    f"2. DIVIETO ASSOLUTO DI CONSIGLI GENERALISTI O DI BUON SENSO:\n"
                    f"   - NON usare MAI formule ovvie, generiche o vaghe come: 'monitorare attentamente', 'fare riunioni di coordinamento', 'verificare periodicamente', 'prestare attenzione alle scadenze', 'sollecitare gli addetti', 'ottimizzare la comunicazione'.\n"
                    f"   - Nella sezione '4. 💡 Raccomandazioni Strategiche & Operative', OGNI punto DEVE essere PUNTUALE, NOMINATIVO E CIRCOSTANZIATO: cita per nome la commessa, la fase esatta o l'addetto sovraccarico, specificando l'azione decisionale precisa.\n"
                    f"   - Se NON vi sono ritardi o criticità rilevanti nei dati, NON inventare raccomandazioni di facciata: scrivi semplicemente 'Nessuna misura correttiva d'emergenza necessaria. I carichi operativi e le scadenze a breve risultano presidiati regolarmente.'\n"
                    f"3. FORMATTAZIONE:\n"
                    f"   - Formatta in Markdown pulito ed elegante, senza preamboli né saluti.\n"
                    f"   - Nel resoconto tieni in debito conto la tipologia normativa delle commesse (Standard, ATEX per atmosfere potenzialmente esplosive, Alimentare per settore igienico/food grade), sottolineando l'importanza delle certificazioni e dei collaudi specifici.\n"
                    f"Usa esattamente questa struttura:\n"
                    f"# 📑 Resoconto Esecutivo: Stato Commesse & Addetti ({today_str})\n\n"
                    f"### 1. 📊 Sintesi Esecutiva & Stato Commesse\n"
                    f"Descrivi la situazione complessiva con tono professionale, evidenziando avanzamento, ripartizione delle tipologie (Standard, ATEX, Alimentare) e stato delle commesse attive.\n\n"
                    f"### 2. 👥 Analisi Carico di Lavoro & Distribuzione Addetti\n"
                    f"Evidenzia la concentrazione dei carichi: chi è maggiormente occupato, chi ha task in ritardo e come bilanciare le risorse.\n\n"
                    f"### 3. ⚠️ Criticità, Ritardi & Scadenze Imminenti\n"
                    f"Analizza le attività in ritardo e quelle che scadono a breve termine, indicando possibili colli di bottiglia o rischi di consegna (con particolare attenzione ai vincoli tecnici delle commesse speciali ATEX / Alimentare).\n\n"
                    f"### 4. 💡 Raccomandazioni Strategiche & Operative\n"
                    f"Fornisci 2-3 raccomandazioni concrete, nominative e azionabili (no frasi generiche).\n"
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

        # Fallback raccomandazioni specifiche e concrete (no consigli generalisti)
        rec_bullets = []
        if overdue_tasks:
            for ot in overdue_tasks[:2]:
                pr = proj_map.get(str(ot.project_id))
                pr_label = f"**{pr.name}** ({pr.code or ''})" if pr else "Commessa"
                w_str = ot.workers or "non assegnato"
                rec_bullets.append(f"- **Riprogrammazione immediata**: ridefinire data utile per la fase *{ot.text}* ({pr_label}), scaduta il {ot.end_date.strftime('%d/%m/%Y')} e in carico a {w_str}.")
        if sorted_workers and sorted_workers[0][1]["active"] >= 3:
            bw, bs = sorted_workers[0]
            rec_bullets.append(f"- **Ribilanciamento carico {bw}**: l'addetto concentra {bs['active']} fasi aperte contemporanee; riassegnare una delle fasi a un collega dello stesso reparto con minor carico.")
        atex_actives = [p for p in active_projects if getattr(p, 'is_atex', False)]
        if atex_actives:
            p_names = ", ".join([p.code or p.name for p in atex_actives[:2]])
            rec_bullets.append(f"- **Conformità ATEX ({p_names})**: verificare l'acquisizione delle schede tecniche dei componenti antideflagranti prima dell'inizio del montaggio quadro.")
        alim_actives = [p for p in active_projects if getattr(p, 'is_alimentare', False)]
        if alim_actives:
            p_names = ", ".join([p.code or p.name for p in alim_actives[:2]])
            rec_bullets.append(f"- **Presidio MOCA Alimentare ({p_names})**: accertare l'idoneità al contatto alimentare dei materiali impiegati prima del collaudo finale.")
        if not rec_bullets:
            rec_bullets.append("- Nessuna misura correttiva d'emergenza necessaria. I carichi operativi e le scadenze a breve risultano presidiati regolarmente.")
        fallback_rec_text = "\n".join(rec_bullets)

        # Fallback se LLM non disponibile o fallito
        if not report_markdown:
            report_markdown = (
                f"# 📑 Resoconto Esecutivo: Stato Commesse & Addetti ({today_str})\n\n"
                f"### 1. 📊 Sintesi Esecutiva & Stato Commesse\n"
                f"Nel sistema risultano registrate **{total_projects} commesse complessive**, di cui **{len(active_projects)} attive**, "
                f"**{len(planning_projects)} in fase di pianificazione** e **{len(completed_projects)} completate**.\n"
                f"Ripartizione per tipologia: **{total_standard} Standard**, **{total_atex} ATEX**, **{total_alimentare} Alimentare**.\n\n"
                f"**Stato delle commesse attive:**\n"
                f"{active_proj_text}\n\n"
                f"### 2. 👥 Analisi Carico di Lavoro & Distribuzione Addetti\n"
                f"Gli addetti coinvolti nelle attività sono **{len(worker_stats)}**. Di seguito il riepilogo del carico di ciascun membro del team:\n\n"
                f"{worker_text}\n\n"
                f"### 3. ⚠️ Criticità, Ritardi & Scadenze Imminenti\n"
                f"Attualmente si registrano **{len(overdue_tasks)} attività in ritardo** rispetto alla data di oggi e **{len(upcoming_tasks)} attività in scadenza nei prossimi 7 giorni**.\n\n"
                f"**Attività in ritardo:**\n{overdue_text}\n\n"
                f"**Scadenze nei prossimi 7 giorni:**\n{upcoming_text}\n\n"
                f"### 4. 💡 Raccomandazioni Strategiche & Operative\n"
                f"{fallback_rec_text}"
            )

        return {
            "report": report_markdown.strip(),
            "kpis": {
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
                "standard_projects": total_standard
            },
            "generated_at": datetime.now().strftime("%d/%m/%Y alle %H:%M"),
            "generated_timestamp": int(datetime.now().timestamp() * 1000)
        }

chat_service = ChatService()
