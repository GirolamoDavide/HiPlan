import json
import logging
from datetime import datetime, date, timedelta
from typing import Optional, Dict, Any, List
# pyrefly: ignore [missing-import]
from sqlalchemy import select, func, or_
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.models.automation import (
    AutomationRule,
    AutomationLog,
    AutomationTriggerType,
    AutomationActionType,
)
from app.models.task import Task
from app.models.project import Project
from app.models.user import User, UserRole
from app.models.todo import Todo
from app.models.notification import Notification, NotificationType

logger = logging.getLogger(__name__)


def _parse_json(val: Any, default: Any = None) -> Any:
    if val is None:
        return default
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except Exception:
        return default


def _calculate_task_actual_hours(actual_hours_val: Any) -> float:
    if not actual_hours_val:
        return 0.0
    data = _parse_json(actual_hours_val, {})
    if not isinstance(data, dict):
        return 0.0
    tot = 0.0
    for _, dates_map in data.items():
        if isinstance(dates_map, dict):
            for _, h in dates_map.items():
                try:
                    tot += float(h or 0)
                except (ValueError, TypeError):
                    pass
    return round(tot, 1)


def _get_normalized_progress(progress_val: Any) -> int:
    if progress_val is None:
        return 0
    try:
        v = float(progress_val)
        if 0 < v <= 1.0:
            return round(v * 100)
        return round(v)
    except Exception:
        return 0


class AutomationService:
    @staticmethod
    async def seed_default_rules(db: AsyncSession) -> None:
        """Inserisce le regole predefinite di default se la tabella è vuota."""
        count_res = await db.execute(select(func.count(AutomationRule.id)))
        if count_res.scalar_one() == 0:
            default_rules = [
                {
                    "name": "Progettazione UT completata ➔ Ordine Materiali (Acquisti)",
                    "description": "Quando una fase dell'Ufficio Tecnico raggiunge il 100%, crea automaticamente un TODO per il Reparto Acquisti.",
                    "trigger_type": AutomationTriggerType.PHASE_COMPLETED.value,
                    "trigger_config": json.dumps({}),
                    "conditions": json.dumps({"department": "ufficio_tecnico"}),
                    "action_type": AutomationActionType.CREATE_TODO.value,
                    "action_config": json.dumps({
                        "title": "Ordinare materiali e componenti per commessa {project_code}",
                        "content": "La fase '{task_name}' dell'Ufficio Tecnico è completata al 100%. Procedere con l'ordine dei componenti commerciali e semilavorati per la commessa {project_code} ({project_name}).",
                        "assignee_department": "acquisti",
                        "due_days": 3
                    }),
                    "is_active": True,
                },
                {
                    "name": "Superamento 90% ore a budget ➔ Alert PM",
                    "description": "Se il consuntivo ore di una fase supera il 90% delle ore a budget, invia un alert di controllo al Project Manager.",
                    "trigger_type": AutomationTriggerType.BUDGET_HOURS_EXCEEDED.value,
                    "trigger_config": json.dumps({"threshold_pct": 90}),
                    "conditions": json.dumps({}),
                    "action_type": AutomationActionType.SEND_NOTIFICATION.value,
                    "action_config": json.dumps({
                        "title": "⚠️ Raggiunto 90% ore a budget: {task_name}",
                        "message": "La fase '{task_name}' della commessa {project_code} ha consuntivato {actual_hours}h su {planned_hours}h previste ({hours_pct}%). Verifica lo stato avanzamento ({progress}%).",
                        "recipient_role": "pm"
                    }),
                    "is_active": True,
                },
                {
                    "name": "Fase in scadenza tra 48h con avanzamento < 50% ➔ Alert Critico",
                    "description": "Notifica il Project Manager e gli addetti se una fase scade tra 2 giorni ed è ancora a meno di metà completamento.",
                    "trigger_type": AutomationTriggerType.PHASE_DEADLINE_APPROACHING.value,
                    "trigger_config": json.dumps({"days_before": 2, "max_progress": 50}),
                    "conditions": json.dumps({}),
                    "action_type": AutomationActionType.SEND_NOTIFICATION.value,
                    "action_config": json.dumps({
                        "title": "⏰ Scadenza imminente con ritardo: {task_name}",
                        "message": "Attenzione: la fase '{task_name}' (commessa {project_code}) scade il {end_date} ma l'avanzamento registrato è solo del {progress}%.",
                        "recipient_role": "pm_and_workers"
                    }),
                    "is_active": True,
                },
            ]

            for r_data in default_rules:
                rule = AutomationRule(**r_data)
                db.add(rule)
            await db.commit()
            logger.info("[AUTOMATION] Regole predefinite inserite con successo.")

    @staticmethod
    async def evaluate_task_triggers(
        db: AsyncSession,
        task: Task,
        old_state: Dict[str, Any],
        current_user: Optional[User] = None
    ) -> List[AutomationLog]:
        """
        Valuta se l'aggiornamento di un task fa scattare una o più regole di automazione attive.
        """
        rules_res = await db.execute(
            select(AutomationRule).where(AutomationRule.is_active == True)
        )
        active_rules = rules_res.scalars().all()
        if not active_rules:
            return []

        # Carica il progetto associato per contesto e metadati
        proj_res = await db.execute(
            select(Project)
            .options(selectinload(Project.responsible), selectinload(Project.owner))
            .where(Project.id == task.project_id)
        )
        project = proj_res.scalar_one_or_none()
        if not project:
            return []

        # Calcola metriche attuali e precedenti
        current_progress = _get_normalized_progress(task.progress)
        old_progress = _get_normalized_progress(old_state.get("progress"))
        current_completed = int(getattr(task, "completed", 0) or 0)
        old_completed = int(old_state.get("completed", 0) or 0)

        planned_h = float(getattr(task, "planned_hours", 8.0) or 8.0)
        current_actual_h = _calculate_task_actual_hours(task.actual_hours)
        old_actual_h = old_state.get("actual_hours_total", 0.0)

        current_hours_pct = round((current_actual_h / planned_h * 100), 1) if planned_h > 0 else 0.0
        old_hours_pct = round((old_actual_h / planned_h * 100), 1) if planned_h > 0 else 0.0

        executed_logs: List[AutomationLog] = []

        for rule in active_rules:
            try:
                rule_trigger = rule.trigger_type
                rule_t_cfg = _parse_json(rule.trigger_config, {})
                rule_conds = _parse_json(rule.conditions, {})

                # 1. Verifica filtri e condizioni di reparto / progetto / addetti
                req_dept = str(rule_conds.get("department") or "").strip().lower()
                if req_dept and req_dept != "specific_workers":
                    task_dept = str(task.department or "").strip().lower()
                    if req_dept != task_dept:
                        continue

                # Filtro per addetti specifici (se impostato)
                rule_workers = rule_conds.get("workers") or rule_conds.get("assigned_workers") or []
                if req_dept == "specific_workers" or rule_workers:
                    if rule_workers:
                        task_workers = _parse_json(task.workers, [])
                        if not isinstance(task_workers, list):
                            task_workers = []

                        rule_workers_norm = [str(w).strip().lower() for w in rule_workers]
                        matched_worker = False

                        for tw in task_workers:
                            if str(tw).strip().lower() in rule_workers_norm:
                                matched_worker = True
                                break

                        if not matched_worker and task.assigned_to:
                            if str(task.assigned_to).strip().lower() in rule_workers_norm:
                                matched_worker = True
                            elif task.assignee:
                                if (
                                    str(task.assignee.username).strip().lower() in rule_workers_norm
                                    or str(task.assignee.full_name).strip().lower() in rule_workers_norm
                                    or str(task.assignee.id).strip().lower() in rule_workers_norm
                                ):
                                    matched_worker = True

                        if not matched_worker:
                            continue

                if rule_conds.get("project_id"):
                    if str(rule_conds.get("project_id")) != str(task.project_id):
                        continue

                # 2. Verifica del trigger specifico
                triggered = False
                trigger_detail = ""

                if rule_trigger == AutomationTriggerType.PHASE_COMPLETED.value:
                    # Scatta se completato al 100% o spunta completed attiva, e prima NON lo era
                    is_now_complete = (current_completed == 1 or current_progress >= 100)
                    was_complete = (old_completed == 1 or old_progress >= 100)
                    if is_now_complete and not was_complete:
                        triggered = True
                        trigger_detail = f"Fase completata: progress={current_progress}%, completed={current_completed}"

                elif rule_trigger == AutomationTriggerType.PHASE_STARTED.value:
                    # Scatta se la fase viene avviata (avanzamento > 0% o ore consuntivate > 0, mentre prima erano 0)
                    is_started = (current_progress > 0 or current_actual_h > 0)
                    was_started = (old_progress > 0 or old_actual_h > 0)
                    if is_started and not was_started:
                        triggered = True
                        trigger_detail = f"Fase avviata: progress={current_progress}%, consuntivo={current_actual_h}h"

                elif rule_trigger == AutomationTriggerType.PHASE_PROGRESS_REACHED.value:
                    # Scatta quando l'avanzamento raggiunge o supera una soglia specifica (es. 50% o 75%)
                    target_pct = float(rule_t_cfg.get("target_progress", 50))
                    if current_progress >= target_pct and old_progress < target_pct:
                        triggered = True
                        trigger_detail = f"Avanzamento ha raggiunto la soglia {target_pct}%: progress={current_progress}%"

                elif rule_trigger == AutomationTriggerType.PHASE_DELAYED.value:
                    # Scatta se la data fine è superata e la fase non è ancora completata
                    today_d = datetime.utcnow().date()
                    if task.end_date and task.end_date < today_d and current_completed == 0 and current_progress < 100:
                        triggered = True
                        trigger_detail = f"Fase scaduta senza completamento: scadenza={task.end_date.strftime('%d/%m/%Y')}, progress={current_progress}%"

                elif rule_trigger == AutomationTriggerType.BUDGET_HOURS_EXCEEDED.value:
                    threshold = float(rule_t_cfg.get("threshold_pct", 90))
                    if current_hours_pct >= threshold and old_hours_pct < threshold:
                        triggered = True
                        trigger_detail = f"Consuntivo ore ha superato la soglia {threshold}%: {current_actual_h}h / {planned_h}h ({current_hours_pct}%)"

                if not triggered:
                    continue

                # 3. Esegui l'azione configurata
                action_cfg = _parse_json(rule.action_config, {})
                log_entry = await AutomationService._execute_action(
                    db=db,
                    rule=rule,
                    project=project,
                    task=task,
                    trigger_detail=trigger_detail,
                    action_cfg=action_cfg,
                    metrics={
                        "actual_hours": current_actual_h,
                        "planned_hours": planned_h,
                        "hours_pct": current_hours_pct,
                        "progress": current_progress,
                    },
                    current_user=current_user
                )
                if log_entry:
                    rule.trigger_count = (rule.trigger_count or 0) + 1
                    rule.last_triggered_at = datetime.utcnow()
                    executed_logs.append(log_entry)

            except Exception as e:
                logger.error(f"[AUTOMATION] Errore esecuzione regola '{rule.name}': {e}", exc_info=True)
                err_log = AutomationLog(
                    rule_id=rule.id,
                    rule_name=rule.name,
                    trigger_type=rule.trigger_type,
                    action_type=rule.action_type,
                    project_id=project.id,
                    task_id=str(task.id),
                    details=f"Errore durante l'esecuzione",
                    status="error",
                    error_message=str(e)
                )
                db.add(err_log)
                executed_logs.append(err_log)

        if executed_logs:
            await db.commit()

        return executed_logs

    @staticmethod
    async def _execute_action(
        db: AsyncSession,
        rule: AutomationRule,
        project: Project,
        task: Task,
        trigger_detail: str,
        action_cfg: Dict[str, Any],
        metrics: Dict[str, Any],
        current_user: Optional[User] = None
    ) -> AutomationLog:
        """Esegue l'azione (creazione TODO o invio Notifica) sostituendo le variabili segnaposto."""
        project_code = project.code or "Commessa"
        project_name = project.name or ""
        task_name = task.text or ""
        end_date_str = task.end_date.strftime("%d/%m/%Y") if task.end_date else "-"

        pm_name = "-"
        if project.responsible and project.responsible.full_name:
            pm_name = project.responsible.full_name
        elif project.owner and project.owner.full_name:
            pm_name = project.owner.full_name

        start_date_str = task.start_date.strftime("%d/%m/%Y") if getattr(task, "start_date", None) else "-"
        dept_str = str(task.department or "-")

        context_vars = {
            "project_code": project_code,
            "project_name": project_name,
            "task_name": task_name,
            "end_date": end_date_str,
            "start_date": start_date_str,
            "department": dept_str,
            "pm_name": pm_name,
            "actual_hours": metrics.get("actual_hours", 0),
            "planned_hours": metrics.get("planned_hours", 0),
            "hours_pct": metrics.get("hours_pct", 0),
            "progress": metrics.get("progress", 0),
        }

        label_synonyms = {
            "Codice Commessa": project_code,
            "Nome Commessa": project_name,
            "Nome Fase": task_name,
            "Reparto Fase": dept_str,
            "Project Manager": pm_name,
            "Ore Consuntivate": str(metrics.get("actual_hours", 0)),
            "Ore a Budget": str(metrics.get("planned_hours", 0)),
            "% Ore Consuntivo": str(metrics.get("hours_pct", 0)),
            "% Avanzamento": str(metrics.get("progress", 0)),
            "Data Fine Prevista": end_date_str,
            "Data Inizio": start_date_str,
        }

        def format_text(template_str: Optional[str]) -> str:
            if not template_str:
                return ""
            res = str(template_str)
            for k, v in context_vars.items():
                res = res.replace(f"{{{k}}}", str(v))
            for lbl, val in label_synonyms.items():
                res = res.replace(f"[{lbl}]", str(val))
                res = res.replace(f"@{lbl}", str(val))
                # Also without brackets if preceded by label emoji
                for emoji in ("🏷️", "📁", "📌", "🏢", "👤", "⏱️", "🎯", "📊", "📈", "📅", "🗓️"):
                    res = res.replace(f"[{emoji} {lbl}]", str(val))
                    res = res.replace(f"{emoji} {lbl}", str(val))
            return res

        action_type = rule.action_type
        status = "success"
        error_msg = None
        action_summaries = []

        # Determinazione dell'utente mittente (se nullo, usiamo l'owner della commessa o il primo admin)
        sender_id = current_user.id if current_user else (project.responsible_id or project.owner_id)
        if not sender_id:
            admin_res = await db.execute(select(User).where(User.role == UserRole.ADMIN))
            admin = admin_res.scalars().first()
            sender_id = admin.id if admin else None

        # 1. Creazione TODO se CREATE_TODO o CREATE_TODO_AND_NOTIFY
        if action_type in (AutomationActionType.CREATE_TODO.value, AutomationActionType.CREATE_TODO_AND_NOTIFY.value):
            title = format_text(action_cfg.get("title", f"TODO Automatico per {project_code}"))
            content = format_text(action_cfg.get("content", f"Generato automaticamente dalla regola '{rule.name}'"))
            due_days = int(action_cfg.get("due_days", 3))
            due_date = datetime.utcnow() + timedelta(days=due_days)

            # Individua assegnatari
            assignee_ids: List[str] = []
            assignee_dept = action_cfg.get("assignee_department")
            specific_assignees = action_cfg.get("assignee_ids", [])

            if specific_assignees and isinstance(specific_assignees, list):
                assignee_ids.extend([str(u) for u in specific_assignees])

            if assignee_dept:
                u_res = await db.execute(
                    select(User).where(
                        User.department == str(assignee_dept).strip().lower(),
                        User.is_active == True
                    )
                )
                dept_users = u_res.scalars().all()
                for u in dept_users:
                    if str(u.id) not in assignee_ids:
                        assignee_ids.append(str(u.id))

            # Se nessun assegnatario trovato, assegna al PM
            if not assignee_ids and (project.responsible_id or project.owner_id):
                assignee_ids.append(str(project.responsible_id or project.owner_id))

            new_todo = Todo(
                title=title,
                content=content,
                creator_id=sender_id,
                assignees=json.dumps(assignee_ids),
                due_date=due_date,
                notify_email=bool(action_cfg.get("notify_email", False)),
                is_completed=False,
            )
            db.add(new_todo)
            await db.flush()

            # Crea notifica in-app per ogni assegnatario
            for uid in assignee_ids:
                notif = Notification(
                    user_id=uid,
                    title=f"📋 TODO Automatico: {title}",
                    message=f"Creata attività automatica collegata alla fase '{task_name}' ({project_code}).",
                    type=NotificationType.AUTOMATION,
                    project_id=project.id,
                    task_id=str(task.id),
                    link=f"/todo?id={new_todo.id}"
                )
                db.add(notif)

            action_summaries.append(f"Creato TODO '{title}' per {len(assignee_ids)} utenti (scad: {due_date.strftime('%d/%m/%Y')})")

        # 2. Invio Notifica se SEND_NOTIFICATION o CREATE_TODO_AND_NOTIFY
        if action_type in (AutomationActionType.SEND_NOTIFICATION.value, AutomationActionType.CREATE_TODO_AND_NOTIFY.value):
            default_notif_title = f"⚠️ Notifica automatica: {task_name}" if action_type == AutomationActionType.CREATE_TODO_AND_NOTIFY.value else "Avviso Automazione HiPlan"
            title = format_text(action_cfg.get("notify_title") or action_cfg.get("title") or default_notif_title)
            message = format_text(action_cfg.get("notify_message") or action_cfg.get("message") or f"Avviso generato da regola: {rule.name}")
            recipients: List[str] = []

            rec_role = action_cfg.get("recipient_role", "pm")
            if rec_role in ("pm", "pm_and_workers"):
                if project.responsible_id:
                    recipients.append(str(project.responsible_id))
                if project.owner_id and str(project.owner_id) not in recipients:
                    recipients.append(str(project.owner_id))

            if rec_role in ("workers", "pm_and_workers"):
                task_workers = _parse_json(task.workers, [])
                if isinstance(task_workers, list):
                    for w in task_workers:
                        w_res = await db.execute(select(User).where(or_(User.username == w, User.full_name == w)))
                        w_user = w_res.scalar_one_or_none()
                        if w_user and str(w_user.id) not in recipients:
                            recipients.append(str(w_user.id))

            # Se specificati id utente diretti
            for uid in action_cfg.get("recipient_ids", []):
                if str(uid) not in recipients:
                    recipients.append(str(uid))

            for uid in recipients:
                notif = Notification(
                    user_id=uid,
                    title=title,
                    message=message,
                    type=NotificationType.AUTOMATION,
                    project_id=project.id,
                    task_id=str(task.id),
                    link=f"/projects/{project.id}"
                )
                db.add(notif)

            action_summaries.append(f"Inviata notifica '{title}' a {len(recipients)} destinatari")

        # 3. Creazione Evento Calendario se CREATE_CALENDAR_EVENT
        if action_type == AutomationActionType.CREATE_CALENDAR_EVENT.value:
            from app.models.calendar_event import CalendarEvent
            event_title = format_text(action_cfg.get("event_title") or action_cfg.get("title") or f"📅 Evento: {task_name}")
            event_desc = format_text(action_cfg.get("event_description") or action_cfg.get("description") or f"Commessa: {project_code} - {project_name}\nFase: {task_name}")

            date_source = action_cfg.get("event_date_type", "task_end_date")
            days_offset = int(action_cfg.get("event_days_offset", 0))

            base_d = None
            if date_source == "task_start_date" and getattr(task, "start_date", None):
                base_d = task.start_date
            elif date_source == "task_end_date" and (getattr(task, "end_date", None) or getattr(task, "start_date", None)):
                base_d = task.end_date or task.start_date
            else:
                base_d = date.today()

            if days_offset != 0:
                base_d = base_d + timedelta(days=days_offset)

            is_all_day = bool(action_cfg.get("event_all_day", True))
            start_dt = datetime.combine(base_d, datetime.min.time()).replace(hour=9, minute=0)
            end_dt = datetime.combine(base_d, datetime.min.time()).replace(hour=17, minute=0)
            event_color = str(action_cfg.get("event_color") or "#0284c7")

            # Raccolta partecipanti (usernames per shared_with)
            shared_usernames: List[str] = []
            target_aud = action_cfg.get("calendar_attendees", "pm")

            if target_aud in ("pm", "pm_and_workers"):
                if project.responsible and project.responsible.username:
                    shared_usernames.append(project.responsible.username)
                if project.owner and project.owner.username and project.owner.username not in shared_usernames:
                    shared_usernames.append(project.owner.username)

            if target_aud in ("workers", "pm_and_workers"):
                task_workers = _parse_json(task.workers, [])
                if isinstance(task_workers, list):
                    for w in task_workers:
                        if w and str(w) not in shared_usernames:
                            shared_usernames.append(str(w))

            if target_aud == "specific_workers" or action_cfg.get("attendee_ids"):
                for uid in action_cfg.get("attendee_ids", []):
                    u_res = await db.execute(select(User).where(User.id == uid))
                    u_obj = u_res.scalar_one_or_none()
                    if u_obj and u_obj.username and u_obj.username not in shared_usernames:
                        shared_usernames.append(u_obj.username)

            owner_user_id = project.responsible_id or project.owner_id or (current_user.id if current_user else None)
            if not owner_user_id:
                first_u = (await db.execute(select(User).limit(1))).scalar_one_or_none()
                if first_u:
                    owner_user_id = first_u.id

            cal_event = CalendarEvent(
                user_id=owner_user_id,
                title=event_title,
                description=event_desc,
                start_date=start_dt,
                end_date=end_dt,
                is_all_day=is_all_day,
                color=event_color,
                shared_with=json.dumps(shared_usernames),
                reminder_type=action_cfg.get("reminder_type", "none"),
                reminder_time=start_dt - timedelta(hours=2) if action_cfg.get("reminder_type", "none") != "none" else None,
                reminder_sent=False
            )
            db.add(cal_event)
            await db.flush()

            # Notifica in-app opzionale agli utenti invitati
            if bool(action_cfg.get("notify_attendees", True)):
                for uname in shared_usernames:
                    u_res = await db.execute(select(User).where(User.username == uname))
                    u_obj = u_res.scalar_one_or_none()
                    if u_obj:
                        notif = Notification(
                            user_id=u_obj.id,
                            title=f"📅 Calendario: {event_title}",
                            message=f"Aggiunto evento al tuo calendario per il {base_d.strftime('%d/%m/%Y')} (Commessa {project_code}).",
                            type=NotificationType.AUTOMATION,
                            project_id=project.id,
                            task_id=str(task.id),
                            link="/personal-calendar"
                        )
                        db.add(notif)

            action_summaries.append(f"Creato evento a calendario '{event_title}' per il {base_d.strftime('%d/%m/%Y')} ({len(shared_usernames)} partecipanti)")

        action_summary = " + ".join(action_summaries) if action_summaries else "Azione eseguita con successo"

        log = AutomationLog(
            rule_id=rule.id,
            rule_name=rule.name,
            trigger_type=rule.trigger_type,
            action_type=rule.action_type,
            project_id=project.id,
            task_id=str(task.id),
            details=f"Trigger: {trigger_detail}. Azione: {action_summary}",
            status=status,
            error_message=error_msg
        )
        db.add(log)
        return log

    @staticmethod
    async def check_scheduled_automations(db: AsyncSession) -> int:
        """
        Job periodico: controlla le scadenze imminenti e attiva le regole corrispondenti
        (es. phase_deadline_approaching).
        """
        rules_res = await db.execute(
            select(AutomationRule).where(
                AutomationRule.is_active == True,
                AutomationRule.trigger_type == AutomationTriggerType.PHASE_DEADLINE_APPROACHING.value
            )
        )
        deadline_rules = rules_res.scalars().all()
        if not deadline_rules:
            return 0

        total_fired = 0
        today = date.today()

        for rule in deadline_rules:
            try:
                t_cfg = _parse_json(rule.trigger_config, {})
                days_before = int(t_cfg.get("days_before", 2))
                max_prog = int(t_cfg.get("max_progress", 50))
                target_date = today + timedelta(days=days_before)

                # Trova fasi che scadono esattamente nel range e non sono completate
                tasks_res = await db.execute(
                    select(Task)
                    .where(
                        Task.end_date <= target_date,
                        Task.end_date >= today,
                        Task.completed == 0,
                    )
                )
                candidate_tasks = tasks_res.scalars().all()

                for task in candidate_tasks:
                    curr_prog = _get_normalized_progress(task.progress)
                    if curr_prog > max_prog:
                        continue

                    # Controllo anti-duplicato per evitare di spammare notifiche lo stesso giorno
                    recent_log = await db.execute(
                        select(AutomationLog).where(
                            AutomationLog.rule_id == rule.id,
                            AutomationLog.task_id == str(task.id),
                            AutomationLog.created_at >= datetime.utcnow() - timedelta(hours=20)
                        )
                    )
                    if recent_log.scalar_one_or_none():
                        continue

                    # Carica progetto
                    proj_res = await db.execute(
                        select(Project)
                        .options(selectinload(Project.responsible), selectinload(Project.owner))
                        .where(Project.id == task.project_id)
                    )
                    project = proj_res.scalar_one_or_none()
                    if not project:
                        continue

                    action_cfg = _parse_json(rule.action_config, {})
                    await AutomationService._execute_action(
                        db=db,
                        rule=rule,
                        project=project,
                        task=task,
                        trigger_detail=f"Fase in scadenza tra <= {days_before} giorni ({task.end_date}) con prog={curr_prog}%",
                        action_cfg=action_cfg,
                        metrics={
                            "actual_hours": _calculate_task_actual_hours(task.actual_hours),
                            "planned_hours": float(getattr(task, "planned_hours", 8.0) or 8.0),
                            "hours_pct": 0,
                            "progress": curr_prog,
                        }
                    )
                    rule.trigger_count = (rule.trigger_count or 0) + 1
                    rule.last_triggered_at = datetime.utcnow()
                    total_fired += 1

            except Exception as e:
                logger.error(f"[AUTOMATION SCHEDULER] Errore su regola {rule.name}: {e}")

        if total_fired > 0:
            await db.commit()
        return total_fired
