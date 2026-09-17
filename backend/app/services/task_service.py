import json
import logging
from typing import List, Optional
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select
from app.models.task import Task
from app.models.link import Link
from app.models.vacation import Vacation
from app.models.notification import Notification, NotificationType
from app.models.user import User
from datetime import timedelta, date, datetime
from app.schemas.task import TaskCreate, TaskUpdate, TaskOut, LinkCreate, LinkOut, GanttData
# pyrefly: ignore [missing-import]
from fastapi import HTTPException, status
from app.core.websocket_manager import manager

logger = logging.getLogger(__name__)


def find_vacation_conflicts(task_start, task_end, vacations, excluded_dates=None, custom_dates=None):
    if not vacations or not task_start:
        return []
    excluded_dates = excluded_dates or []
    custom_date_set = None
    if custom_dates:
        custom_date_set = set()
        for d in custom_dates:
            if isinstance(d, str):
                custom_date_set.add(d)
            elif isinstance(d, dict) and d.get("date"):
                custom_date_set.add(str(d["date"]))

    def _to_date(val):
        if not val:
            return None
        if isinstance(val, date):
            return val
        if isinstance(val, datetime):
            return val.date()
        try:
            return datetime.strptime(str(val).split("T")[0].split(" ")[0], "%Y-%m-%d").date()
        except Exception:
            return None

    s_date = _to_date(task_start)
    e_date = _to_date(task_end) or s_date
    if not s_date or not e_date:
        return []

    conflict_days = 0
    conflict_dates = []
    current = s_date
    while current <= e_date:
        cur_str = current.strftime("%Y-%m-%d")
        if custom_date_set is not None:
            is_workday = cur_str in custom_date_set
        else:
            is_workday = current.weekday() < 5 and cur_str not in excluded_dates
        if is_workday:
            for vacation in vacations:
                v_start = None
                v_end = None
                if isinstance(vacation, dict):
                    v_start = _to_date(vacation.get("start_date"))
                    v_end = _to_date(vacation.get("end_date"))
                elif hasattr(vacation, "start_date") and hasattr(vacation, "end_date"):
                    v_start = _to_date(vacation.start_date)
                    v_end = _to_date(vacation.end_date)
                if v_start and v_end:
                    if v_start <= current <= v_end:
                        conflict_days += 1
                        conflict_dates.append(cur_str)
                        break
        current = current + timedelta(days=1)
    return [{"date": str(task_start), "workdays": conflict_days, "conflict_dates": conflict_dates}] if conflict_days else []



def _parse_json(val, default):
    if not val:
        return default
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except Exception:
        return default


def _format_task_details(task):
    details = []
    if getattr(task, "start_date", None) and getattr(task, "end_date", None):
        details.append(f"Dal {task.start_date.strftime('%d/%m/%Y')} al {task.end_date.strftime('%d/%m/%Y')}")
    elif getattr(task, "start_date", None):
        details.append(f"Dal {task.start_date.strftime('%d/%m/%Y')}")
    if getattr(task, "planned_hours", None):
        details.append(f"Ore previste: {task.planned_hours}")
    if getattr(task, "workers", None):
        workers = _parse_json(task.workers, [])
        if workers:
            details.append(f"Addetti: {', '.join(workers)}")
    return " | ".join(details)


def _task_to_out(task: Task) -> TaskOut:
    tot_eff = 0.0
    actual_map = _parse_json(task.actual_hours, {})
    if isinstance(actual_map, dict):
        for day_map in actual_map.values():
            if isinstance(day_map, dict):
                for h in day_map.values():
                    try:
                        tot_eff += float(h or 0)
                    except (ValueError, TypeError):
                        pass

    planned = float(task.planned_hours or 8.0)
    calc_progress = min(1.0, max(0.0, tot_eff / planned)) if planned > 0 else (1.0 if tot_eff > 0 else 0.0)
    
    is_comp = 1 if (task.completed == 1 or (task.completed != -1 and ((task.progress is not None and task.progress >= 1.0) or (calc_progress >= 1.0 and planned > 0)))) else (task.completed if task.completed is not None else 0)
    eff_progress = 1.0 if is_comp == 1 else (task.progress if task.progress is not None else calc_progress)

    return TaskOut(
        id=task.id,
        text=task.text,
        start_date=task.start_date.strftime("%Y-%m-%d 00:00") if task.start_date else "",
        end_date=task.end_date.strftime("%Y-%m-%d 00:00") if task.end_date else None,
        duration=task.duration,
        progress=eff_progress,
        type=task.type.value if task.type else "task",
        priority=task.priority.value if task.priority else "medium",
        parent=task.parent_id or "0",
        assigned_to=task.assigned_to,
        sort_order=task.sort_order,
        open=task.open,
        planned_hours=task.planned_hours or 8.0,
        workers=_parse_json(task.workers, []),
        worker_hours=_parse_json(task.worker_hours, {}),
        actual_hours=actual_map,
        color=task.color,
        department=task.department,
        budget_mode=task.budget_mode,
        completed=is_comp,
        has_vacation_conflict=task.has_vacation_conflict or 0,
        excluded_dates=_parse_json(task.excluded_dates, []),
        custom_dates=_parse_json(task.custom_dates, []),
    )



def _compute_task_progress_and_completed(task: Task, update_data: Optional[dict] = None):
    # Calcola ore consuntivate totali
    tot_eff = 0.0
    actual_map = _parse_json(task.actual_hours, {})
    if isinstance(actual_map, dict):
        for day_map in actual_map.values():
            if isinstance(day_map, dict):
                for h in day_map.values():
                    try:
                        tot_eff += float(h or 0)
                    except (ValueError, TypeError):
                        pass

    planned = float(task.planned_hours or 8.0)
    if planned > 0:
        calc_progress = min(1.0, max(0.0, tot_eff / planned))
    else:
        calc_progress = 1.0 if tot_eff > 0 else 0.0

    explicit_completed = update_data.get("completed") if update_data and "completed" in update_data else None

    if explicit_completed is not None:
        task.completed = int(explicit_completed)

    if task.completed == 1:
        task.progress = 1.0
    elif task.completed == -1:
        task.progress = min(0.99, calc_progress) if calc_progress >= 1.0 else calc_progress
    else:
        # task.completed == 0
        if explicit_completed is None and calc_progress >= 1.0 and planned > 0:
            task.completed = 1
            task.progress = 1.0
        elif tot_eff > 0:
            task.progress = min(0.99, calc_progress) if calc_progress >= 1.0 else calc_progress
        else:
            if update_data and "progress" in update_data and update_data["progress"] is not None:
                task.progress = float(update_data["progress"])
            elif task.progress is None:
                task.progress = 0.0

    # Modifica commentata per mantenere le date originali preventivate:
    # if task.completed == 1 and isinstance(actual_map, dict):
    #     dates_with_hours = set()
    #     for day_map in actual_map.values():
    #         if isinstance(day_map, dict):
    #             for d, h in day_map.items():
    #                 if d != "__extra__":
    #                     try:
    #                         if float(h or 0) > 0:
    #                             dates_with_hours.add(d)
    #                     except (ValueError, TypeError):
    #                         pass
    #     
    #     if dates_with_hours:
    #         from datetime import datetime
    #         first_date_str = min(dates_with_hours)
    #         last_date_str = max(dates_with_hours)
    #         first_date = datetime.strptime(first_date_str, "%Y-%m-%d").date()
    #         last_date = datetime.strptime(last_date_str, "%Y-%m-%d").date()
    #         if getattr(task, "start_date", None) != first_date or getattr(task, "end_date", None) != last_date:
    #             task.start_date = first_date
    #             task.end_date = last_date
    #             task.duration = (last_date - first_date).days + 1


def _link_to_out(link: Link) -> LinkOut:
    return LinkOut(
        id=link.id,
        source=link.source,
        target=link.target,
        type=link.type.value if link.type else "0",
        lag=link.lag,
    )


async def get_gantt_data(db: AsyncSession, project_id: str) -> GanttData:
    tasks_result = await db.execute(
        select(Task).where(Task.project_id == project_id).order_by(Task.start_date.asc(), Task.sort_order.asc())
    )
    links_result = await db.execute(
        select(Link).where(Link.project_id == project_id)
    )
    return GanttData(
        tasks=[_task_to_out(t) for t in tasks_result.scalars().all()],
        links=[_link_to_out(l) for l in links_result.scalars().all()],
    )


async def _check_task_manage_permissions(db: AsyncSession, project_id: str, user):
    if not user:
        return
    from app.models.project import Project
    from app.models.user import UserRole
    # pyrefly: ignore [missing-import]
    from sqlalchemy.orm import selectinload
    proj_res = await db.execute(select(Project).options(selectinload(Project.responsible)).where(Project.id == project_id))
    project = proj_res.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Progetto non trovato")
    can_manage = (
        user.role in (UserRole.ADMIN, UserRole.EDITOR)
        or user.id == project.owner_id
        or user.id == project.responsible_id
        or (project.responsible and project.responsible.username == user.username)
    )
    if not can_manage:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo owner/responsabile/editor possono creare o eliminare fasi e collegamenti")


async def create_task(db: AsyncSession, project_id: str, data: TaskCreate, user=None) -> TaskOut:
    await _check_task_manage_permissions(db, project_id, user)
    from app.models.task import TaskType
    task = Task(
        project_id=project_id,
        text=data.text,
        start_date=data.start_date,
        end_date=data.end_date,
        duration=0 if data.type == TaskType.MILESTONE else data.duration,
        progress=data.progress,
        type=data.type,
        priority=data.priority,
        parent_id=data.parent_id,
        assigned_to=data.assigned_to,
        sort_order=data.sort_order,
        open=data.open,
        planned_hours=data.planned_hours,
        workers=json.dumps(data.workers),
        worker_hours=json.dumps(data.worker_hours),
        actual_hours=json.dumps(data.actual_hours),
        excluded_dates=json.dumps(data.excluded_dates) if getattr(data, 'excluded_dates', None) else "[]",
        color=data.color,
        department=data.department,
        budget_mode=data.budget_mode,
        completed=data.completed,
        custom_dates=json.dumps(data.custom_dates) if getattr(data, 'custom_dates', None) else "[]",
    )
    _compute_task_progress_and_completed(task, data.model_dump())

    # Controllo ferie per eventuali addetti assegnati
    try:
        workers_list = data.workers or []
    except Exception:
        workers_list = []

    total_shift_days = 0
    active_custom_dates = data.custom_dates if data.budget_mode == "custom_dates" else None
    for worker_name in workers_list:
        u_res = await db.execute(select(User).where(User.username == worker_name))
        worker_user = u_res.scalar_one_or_none()
        if not worker_user:
            continue
        vac_res = await db.execute(select(Vacation).where(Vacation.user_id == worker_user.id))
        vacs = vac_res.scalars().all()
        vacation_payloads = [{"start_date": v.start_date, "end_date": v.end_date} for v in vacs]
        conflicts = find_vacation_conflicts(task.start_date, task.end_date or task.start_date, vacation_payloads, data.excluded_dates, active_custom_dates)
        shift_days: int = int(conflicts[0]["workdays"]) if conflicts else 0
        total_shift_days = max(total_shift_days, shift_days)

    if total_shift_days > 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Assegnazione bloccata: esistono ferie nel periodo della fase")

    db.add(task)
    
    from app.models.activity_log import ActivityLog, ActivityCategory
    details = _format_task_details(task)
    action_text = f"Fase creata: '{task.text}'" + (f" ({details})" if details else "")
    log = ActivityLog(
        project_id=project_id,
        user_id=user.id if user else None,
        category=ActivityCategory.PHASE_PROJECT_EDIT,
        action_text=action_text
    )
    db.add(log)
    
    await db.commit()
    await db.refresh(task)

    # Broadcast websocket
    await manager.broadcast(project_id, {"action": "task_created", "task": _task_to_out(task).model_dump()})

    # Esegui ripianificazione in background (non blocca se fallisce)
    import asyncio


    return _task_to_out(task)


async def update_task(db: AsyncSession, task_id: str, data: TaskUpdate, user=None) -> TaskOut:
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task non trovato")

    if user:
        from app.models.project import Project
        from app.models.user import UserRole
        # pyrefly: ignore [missing-import]
        from sqlalchemy.orm import selectinload
        proj_res = await db.execute(select(Project).options(selectinload(Project.responsible)).where(Project.id == task.project_id))
        project = proj_res.scalar_one_or_none()
        if project:
            can_manage = (
                user.role in (UserRole.ADMIN, UserRole.EDITOR)
                or user.id == project.owner_id
                or user.id == project.responsible_id
                or (project.responsible and project.responsible.username == user.username)
            )
            if not can_manage:
                task_workers = _parse_json(task.workers, [])
                proj_workers = _parse_json(project.assigned_workers, []) if project.assigned_workers else []
                is_worker = (
                    user.username in task_workers or (user.full_name and user.full_name in task_workers)
                    or user.username in proj_workers or (user.full_name and user.full_name in proj_workers)
                )
                if not is_worker:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Non hai i permessi per modificare questa fase")
                update_keys = set(data.model_dump(exclude_unset=True).keys())
                allowed_keys = {"actual_hours", "end_date", "duration"}
                if update_keys and not update_keys.issubset(allowed_keys):
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="In modalità consuntivazione puoi aggiornare solo le ore consuntivate o prolungare/ridurre i giorni (actual_hours, end_date, duration)")
                
                
            if user.role != UserRole.ADMIN:
                update_keys = set(data.model_dump(exclude_unset=True).keys())
                if "actual_hours" in update_keys:
                    old_actual_hours = _parse_json(task.actual_hours, {})
                    if not isinstance(old_actual_hours, dict):
                        old_actual_hours = {}
                    
                    new_actual_hours = data.actual_hours if data.actual_hours is not None else {}
                    if not isinstance(new_actual_hours, dict):
                        new_actual_hours = {}
                    
                    def _dates_equal(d1, d2):
                        if d1 is None: d1 = {}
                        if d2 is None: d2 = {}
                        for k, v in d1.items():
                            if v and str(v) != "0" and d2.get(k) != v: return False
                        for k, v in d2.items():
                            if v and str(v) != "0" and d1.get(k) != v: return False
                        return True

                    all_workers = set(old_actual_hours.keys()).union(set(new_actual_hours.keys()))
                    for worker_key in all_workers:
                        if worker_key != user.full_name and worker_key != user.username:
                            if not _dates_equal(old_actual_hours.get(worker_key), new_actual_hours.get(worker_key)):
                                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo l'amministratore può modificare le ore consuntivate di altri addetti.")

    old_start = task.start_date
    old_end = task.end_date
    old_duration = task.duration
    old_actual_hours_str = task.actual_hours
    old_progress_val = task.progress
    old_completed_val = getattr(task, "completed", 0)

    # Calcolo totale ore consuntivate precedenti
    old_actual_hours_total = 0.0
    try:
        from app.services.automation_service import _calculate_task_actual_hours
        old_actual_hours_total = _calculate_task_actual_hours(old_actual_hours_str)
    except Exception:
        pass

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if key == "parent_id" and value == "0":
            value = None
        if key in ("workers", "worker_hours", "actual_hours", "excluded_dates", "custom_dates"):
            value = json.dumps(value) if value is not None else "[]"
        setattr(task, key, value)
    _compute_task_progress_and_completed(task, update_data)
    # Se cambiano workers o date, ricalcoliamo impatti ferie
    try:
        workers_list = json.loads(task.workers) if task.workers else []
    except Exception:
        workers_list = []

    total_shift_days = 0
    active_custom_dates = None
    if task.budget_mode == "custom_dates":
        try:
            active_custom_dates = json.loads(task.custom_dates) if getattr(task, 'custom_dates', None) else []
        except Exception:
            active_custom_dates = []
    for worker_name in workers_list:
        u_res = await db.execute(select(User).where(User.username == worker_name))
        worker_user = u_res.scalar_one_or_none()
        if not worker_user:
            continue
        vac_res = await db.execute(select(Vacation).where(Vacation.user_id == worker_user.id))
        vacs = vac_res.scalars().all()
        vacation_payloads = [{"start_date": v.start_date, "end_date": v.end_date} for v in vacs]
        try:
            excluded_dates_list = json.loads(task.excluded_dates) if getattr(task, 'excluded_dates', None) else []
        except Exception:
            excluded_dates_list = []
        conflicts = find_vacation_conflicts(task.start_date, task.end_date or task.start_date, vacation_payloads, excluded_dates_list, active_custom_dates)
        shift_days: int = int(conflicts[0]["workdays"]) if conflicts else 0
        total_shift_days = max(total_shift_days, shift_days)

    # Salta il controllo ferie se si stanno solo aggiornando ore consuntivate o stato completamento
    # (non stiamo cambiando date o addetti, solo registrando ore effettive)
    _consuntivo_only_keys = {"actual_hours", "completed", "progress"}
    _changed_keys = set(update_data.keys())
    if not _changed_keys.issubset(_consuntivo_only_keys) and total_shift_days > 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Assegnazione bloccata: esistono ferie nel periodo della fase")

    # Propagazione a catena quando la data della fase viene modificata esplicitamente
    if "start_date" in update_data or "end_date" in update_data:
        async def propagate_shift(current_task, shift_days, visited=None):
            if shift_days <= 0:
                return
            if visited is None:
                visited = set()
            if current_task.id in visited:
                return
            visited.add(current_task.id)
            current_task.start_date = current_task.start_date + timedelta(days=shift_days) if current_task.start_date else current_task.start_date
            if current_task.end_date:
                current_task.end_date = current_task.end_date + timedelta(days=shift_days)
            if getattr(current_task, "duration", None) is not None:
                current_task.duration = (current_task.duration or 0) + shift_days
            await db.flush()
            links_result = await db.execute(select(Link).where(Link.source == current_task.id))
            for link in links_result.scalars().all():
                child_res = await db.execute(select(Task).where(Task.id == link.target))
                child = child_res.scalar_one_or_none()
                if child and child.id not in visited:
                    await propagate_shift(child, shift_days, visited)

        delta_days = 0
        if "start_date" in update_data and old_start and task.start_date:
            delta_days = (task.start_date - old_start).days
            # If end_date was not explicitly updated (e.g. drag and drop from Gantt), shift it by the same amount
            if "end_date" not in update_data and old_end:
                task.end_date = old_end + timedelta(days=delta_days)
        elif "end_date" in update_data and old_end and task.end_date:
            delta_days = (task.end_date - old_end).days

        if delta_days != 0:
            visited_for_shift = {task.id}
            links_result = await db.execute(select(Link).where(Link.source == task.id))
            for link in links_result.scalars().all():
                child_res = await db.execute(select(Task).where(Task.id == link.target))
                child = child_res.scalar_one_or_none()
                if child:
                    await propagate_shift(child, delta_days, visited_for_shift)

        # Se ci sono ore consuntivate nella finestra di ferie, segnala criticità
        try:
            actual_map = _parse_json(task.actual_hours, {})
            if not isinstance(actual_map, dict):
                actual_map = {}
        except Exception:
            actual_map = {}
        had_hours_in_vac = False
        for d in actual_map.keys():
            try:
                d_date = date.fromisoformat(d)
            except Exception:
                continue
            for worker_name in workers_list:
                u_res = await db.execute(select(User).where(User.username == worker_name))
                worker_user = u_res.scalar_one_or_none()
                if not worker_user:
                    continue
                vac_res = await db.execute(select(Vacation).where(Vacation.user_id == worker_user.id))
                for v in vac_res.scalars().all():
                    if v.start_date <= d_date <= v.end_date:
                        had_hours_in_vac = True
                        break
                if had_hours_in_vac:
                    break

        # Notifiche
        from app.models.project import Project
        proj_res = await db.execute(select(Project).where(Project.id == task.project_id))
        project = proj_res.scalar_one_or_none()

        if had_hours_in_vac and project:
            resp_id = project.responsible_id or project.owner_id
            if resp_id:
                note = Notification(
                    user_id=resp_id,
                    title="Criticità: ore registrate in ferie",
                    message=f"La fase '{task.text}' ha ore registrate durante le ferie: durata estesa di {total_shift_days} giorni.",
                    type=NotificationType.DEADLINE,
                    project_id=project.id,
                )
                db.add(note)

    from app.models.activity_log import ActivityLog, ActivityCategory
    if "actual_hours" in _changed_keys and _changed_keys.issubset({"actual_hours", "completed", "progress"}):
        cat = ActivityCategory.HOURS_LOG
        old_actual_hours = _parse_json(old_actual_hours_str, {})
        if not isinstance(old_actual_hours, dict):
            old_actual_hours = {}
        new_actual_hours = _parse_json(task.actual_hours, {})
        if not isinstance(new_actual_hours, dict):
            new_actual_hours = {}
        
        added_entries = []
        for worker_key, dates in new_actual_hours.items():
            if not isinstance(dates, dict):
                continue
            old_dates = old_actual_hours.get(worker_key, {})
            if not isinstance(old_dates, dict):
                old_dates = {}
            for d, h in dates.items():
                if old_dates.get(d) != h:
                    try:
                        h_val = float(h or 0)
                        if h_val > 0:
                            added_entries.append(f"{worker_key}: {h_val}h il {d}")
                    except ValueError:
                        pass
        
        details_str = ", ".join(added_entries)
        if details_str:
            action_text = f"Aggiornate ore consuntivate per la fase '{task.text}': inserite {details_str}"
        else:
            action_text = f"Aggiornate ore consuntivate per la fase: '{task.text}'"
    else:
        cat = ActivityCategory.PHASE_PROJECT_EDIT
        details = _format_task_details(task)
        action_text = f"Fase modificata: '{task.text}'" + (f" ({details})" if details else "")
        
    log = ActivityLog(
        project_id=task.project_id,
        user_id=user.id if user else None,
        category=cat,
        action_text=action_text
    )
    db.add(log)

    await db.commit()
    await db.refresh(task)

    # Valutazione regole di automazione
    try:
        from app.services.automation_service import AutomationService
        await AutomationService.evaluate_task_triggers(
            db=db,
            task=task,
            old_state={
                "progress": old_progress_val,
                "completed": old_completed_val,
                "actual_hours_total": old_actual_hours_total,
            },
            current_user=user,
        )
    except Exception as auto_err:
        logger.error(f"[AUTOMATION TRIGGER ERROR] {auto_err}", exc_info=True)

    await manager.broadcast(task.project_id, {"action": "task_updated", "task": _task_to_out(task).model_dump()})

    import asyncio


    return _task_to_out(task)


async def delete_task(db: AsyncSession, task_id: str, user=None):
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task non trovato")

    await _check_task_manage_permissions(db, task.project_id, user)

    # Elimina anche i link collegati
    await db.execute(
        select(Link).where((Link.source == task_id) | (Link.target == task_id))
    )
    # pyrefly: ignore [missing-import]
    from sqlalchemy import delete as sql_delete
    await db.execute(sql_delete(Link).where((Link.source == task_id) | (Link.target == task_id)))

    from app.models.activity_log import ActivityLog, ActivityCategory
    details = _format_task_details(task)
    action_text = f"Fase eliminata: '{task.text}'" + (f" ({details})" if details else "")
    log = ActivityLog(
        project_id=task.project_id,
        user_id=user.id if user else None,
        category=ActivityCategory.PHASE_PROJECT_EDIT,
        action_text=action_text
    )
    db.add(log)

    await db.delete(task)
    await db.commit()

    # Broadcast websocket
    await manager.broadcast(task.project_id, {"action": "task_deleted", "task_id": task_id})

    import asyncio



async def create_link(db: AsyncSession, project_id: str, data: LinkCreate, user=None) -> LinkOut:
    await _check_task_manage_permissions(db, project_id, user)
    from app.models.link import LinkType
    
    # Prevenire duplicati esatti
    existing = await db.execute(
        select(Link).where(
            Link.project_id == project_id,
            Link.source == data.source,
            Link.target == data.target
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Dipendenza già esistente")

    link = Link(
        project_id=project_id,
        source=data.source,
        target=data.target,
        type=LinkType(data.type),
        lag=data.lag,
    )
    db.add(link)
    await db.commit()
    await db.refresh(link)

    # Broadcast websocket
    await manager.broadcast(project_id, {"action": "link_created", "link": _link_to_out(link).model_dump()})

    return _link_to_out(link)


async def delete_link(db: AsyncSession, link_id: str, user=None):
    result = await db.execute(select(Link).where(Link.id == link_id))
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link non trovato")
    await _check_task_manage_permissions(db, link.project_id, user)
    project_id = link.project_id
    await db.delete(link)
    await db.commit()

    # Broadcast websocket
    await manager.broadcast(project_id, {"action": "link_deleted", "link_id": link_id})


async def log_task_hours(db: AsyncSession, task_id: str, date_str: str, hours: float, user):
    result = await db.execute(select(Task).where(Task.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task non trovato")
        
    actual_hours = {}
    if task.actual_hours:
        try:
            actual_hours = json.loads(task.actual_hours)
        except:
            pass
            
    worker_key = user.username
    if worker_key not in actual_hours:
        actual_hours[worker_key] = {}
        
    actual_hours[worker_key][date_str] = str(hours)
    
    task.actual_hours = json.dumps(actual_hours)
    await db.commit()
    await db.refresh(task)
    
    # Broadcast websocket
    await manager.broadcast(task.project_id, {"action": "task_updated", "task": _task_to_out(task).model_dump()})
    
    return _task_to_out(task)

