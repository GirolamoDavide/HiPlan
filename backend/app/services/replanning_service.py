import json
from datetime import date, timedelta, datetime, timezone
import logging
import math
from uuid import uuid4
from typing import Any, Dict, List, Optional
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select, or_
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.models.task import Task, TaskType
from app.models.project import Project, ProjectStatus
from app.models.link import Link, LinkType
from app.models.vacation import Vacation
from app.models.user import User
from app.models.setting import Setting
from app.models.replan_log import ReplanLog, ReplanActionType
from app.core.websocket_manager import manager
from app.utils.working_days import is_working_day

logger = logging.getLogger(__name__)

async def check_replanning_enabled(db: AsyncSession) -> bool:
    res = await db.execute(select(Setting).where(Setting.key == "replanning_agent_enabled"))
    setting = res.scalar_one_or_none()
    return bool(setting is not None and setting.value == "true")


def is_weekend_or_holiday(d: date) -> bool:
    return not is_working_day(d)


def add_working_days(start: date, days: int) -> date:
    cur = start
    while is_weekend_or_holiday(cur):
        cur += timedelta(days=1)
    
    count = 0
    while count < days:
        cur += timedelta(days=1)
        if not is_weekend_or_holiday(cur):
            count += 1
    return cur


def get_working_days_count(start: date, end: date, excluded_dates: Optional[list] = None) -> int:
    if excluded_dates is None:
        excluded_dates = []
    if not start or not end or start > end:
        return 1
    count = 0
    cur = start
    while cur <= end:
        if not is_weekend_or_holiday(cur) and cur.strftime("%Y-%m-%d") not in excluded_dates:
            count += 1
        cur += timedelta(days=1)
    return max(1, count)


async def get_replanning_suggestions(db: AsyncSession, current_user=None):
    today = date.today()
    suggestions: List[Dict[str, Any]] = []
    
    # 1. Fetch data - solo per commesse attive (in pianificazione o in corso), escludendo eliminate e archiviate
    tasks_res = await db.execute(
        select(Task)
        .join(Project, Task.project_id == Project.id)
        .options(selectinload(Task.project))
        .where(Task.type != TaskType.PROJECT)
        .where(Task.type != TaskType.MILESTONE)
        .where(Task.completed != 1)
        .where(Project.deleted_at.is_(None))
        .where(Project.status.in_([ProjectStatus.PLANNING, ProjectStatus.ACTIVE, "planning", "active", "PLANNING", "ACTIVE"]))
    )
    all_tasks_raw = tasks_res.scalars().all()
    all_tasks = []
    for t in all_tasks_raw:
        if not t.project or getattr(t.project, 'deleted_at', None) is not None:
            continue
        p_status = t.project.status.value if hasattr(t.project.status, 'value') else str(t.project.status)
        p_status_clean = p_status.lower().replace("projectstatus.", "").strip()
        if p_status_clean not in ("planning", "active"):
            continue
        all_tasks.append(t)
    
    vacs_res = await db.execute(select(Vacation))
    vacations = vacs_res.scalars().all()
    
    users_res = await db.execute(select(User))
    users = users_res.scalars().all()
    username_to_id = {u.username: str(u.id) for u in users}
    fullname_to_id = {u.full_name: str(u.id) for u in users if u.full_name}

    if current_user and getattr(current_user, 'role', None) == "editor" and getattr(current_user, 'department', None):
        username_to_dept = {u.username: u.department for u in users}
        fullname_to_dept = {u.full_name: u.department for u in users if u.full_name}
        
        filtered_tasks = []
        for t in all_tasks:
            if getattr(t, 'department', None) == current_user.department:
                filtered_tasks.append(t)
                continue
            try:
                workers_list = json.loads(t.workers) if t.workers else []
            except:
                workers_list = []
                
            has_dept_worker = False
            for w in workers_list:
                dept = fullname_to_dept.get(w) or username_to_dept.get(w)
                if dept == current_user.department:
                    has_dept_worker = True
                    break
            
            if has_dept_worker:
                filtered_tasks.append(t)
                
        all_tasks = filtered_tasks
    
    def get_user_id(name: str):
        return fullname_to_id.get(name) or username_to_id.get(name)

    vacation_dates_by_uid = {}
    for v in vacations:
        uid = str(v.user_id)
        if uid not in vacation_dates_by_uid:
            vacation_dates_by_uid[uid] = set()
        cur = v.start_date
        while cur <= v.end_date:
            vacation_dates_by_uid[uid].add(cur)
            cur += timedelta(days=1)

    max_daily_hours = 8.0
    timeline = {}
    checked_projects = set()
    
    for task in all_tasks:
        if task.project and task.project.id not in checked_projects:
            checked_projects.add(task.project.id)
            if not getattr(task.project, 'responsible_id', None):
                if current_user and getattr(current_user, "role", "") in ["admin", "editor"]:
                    suggestions.append({
                        "id": f"proj_no_resp_{task.project.id}",
                        "type": "missing_data",
                        "task_id": None,
                        "task_name": "Intera Commessa",
                        "project_id": str(task.project.id),
                        "project_name": task.project.name,
                        "project_code": task.project.code if task.project.code else "",
                        "project_color": task.project.color if task.project.color else None,
                        "department": None,
                        "worker": None,
                        "date": str(today),
                        "reason": "La commessa non ha un responsabile assegnato."
                    })

        workers_list = []
        if task.workers:
            try:
                workers_list = json.loads(task.workers) if isinstance(task.workers, str) else task.workers
            except:
                pass
        if len(workers_list) == 0 and getattr(task, 'type', '') != 'milestone':
            suggestions.append({
                "id": f"orphan_{task.id}",
                "type": "missing_data",
                "task_id": str(task.id),
                "task_name": task.text,
                "project_id": str(task.project_id),
                "project_name": task.project.name if task.project else "-",
                "project_code": (task.project.code if task.project.code else "") if task.project else "",
                "project_color": task.project.color if getattr(task, 'project', None) and getattr(task.project, 'color', None) else None,
                "department": getattr(task, "department", None),
                "worker": None,
                "date": str(task.start_date) if task.start_date else str(today),
                "reason": "La fase non ha nessun addetto assegnato."
            })

        if not task.start_date or not task.end_date:
            continue
            
        # Controllo: fine fase oltre fine commessa
        if task.project and task.project.end_date and task.end_date > task.project.end_date:
            diff = (task.end_date - task.project.end_date).days
            sugg_id = f"ext_proj_{task.id}_{task.end_date.strftime('%Y%m%d')}"
            suggestions.append({
                "id": sugg_id,
                "type": "project_end_exceeded",
                "task_id": str(task.id),
                "task_name": task.text,
                "project_id": str(task.project_id),
                "project_name": task.project.name,
                "project_code": task.project.code if task.project.code else "",
                "project_color": task.project.color if getattr(task.project, 'color', None) else None,
                "department": getattr(task, "department", None),
                "worker": None,
                "date": str(task.end_date),
                "reason": f"La fase termina il {task.end_date.strftime('%d/%m/%Y')}, superando la scadenza della commessa ({task.project.end_date.strftime('%d/%m/%Y')})."
            })

        # Ritardo Critico (Motore Semafori)
        # Parse actual_hours
        try:
            actual_h_map = json.loads(task.actual_hours) if task.actual_hours else {}
        except:
            actual_h_map = {}
            
        tot_eff = 0
        for day_map in actual_h_map.values():
            if isinstance(day_map, dict):
                for h in day_map.values():
                    try:
                        tot_eff += float(h)
                    except:
                        pass
                        
        planned_h = float(task.planned_hours or 8.0)
        
        # 1. Sforamento
        if planned_h > 0 and tot_eff > planned_h:
            sugg_id = f"delay_{task.id}_{today.strftime('%Y%m%d')}_sforamento"
            suggestions.append({
                "id": sugg_id,
                "type": "delay_conflict",
                "task_id": str(task.id),
                "task_name": task.text,
                "project_id": str(task.project_id),
                "project_name": task.project.name if task.project else "-",
                "project_code": (task.project.code if task.project.code else "") if task.project else "",
                "project_color": task.project.color if getattr(task, 'project', None) and getattr(task.project, 'color', None) else None,
                "department": getattr(task, "department", None),
                "worker": None,
                "date": str(task.end_date),
                "reason": f"La fase ha superato le ore previste ({round(tot_eff, 1)}h consuntivate su {planned_h}h previste)."
            })
        elif (getattr(task, 'completed', 0) == 1) or (float(getattr(task, 'progress', 0) or 0) >= 1.0) or (planned_h > 0 and tot_eff >= planned_h):
            # Fase completata o ore previste già interamente consuntivate -> nessun ritardo
            pass
        elif task.start_date > today:
            # Fase futura non ancora iniziata -> nessun ritardo
            pass
        elif task.end_date < today:
            # Fase scaduta e non completata
            lost_hours = planned_h - tot_eff
            if lost_hours > 0:
                is_crit = tot_eff < (planned_h * 0.5)
                days_to_add = get_working_days_count(task.end_date, today)
                if days_to_add <= 0:
                    days_to_add = 1
                sugg_id = f"delay_{task.id}_{task.end_date.strftime('%Y%m%d')}_{'critico' if is_crit else 'scaduta'}"
                reason_msg = (
                    f"Ritardo critico: la fase è scaduta il {task.end_date.strftime('%d/%m/%Y')} con solo {round(tot_eff, 1)}h consuntivate su {planned_h}h (mancano {round(lost_hours, 1)}h)."
                    if is_crit
                    else f"La fase è scaduta il {task.end_date.strftime('%d/%m/%Y')} ma non risulta completata (mancano circa {round(lost_hours, 1)}h)."
                )
                suggestions.append({
                    "id": sugg_id,
                    "type": "delay_conflict",
                    "task_id": str(task.id),
                    "task_name": task.text,
                    "project_id": str(task.project_id),
                    "project_name": task.project.name if task.project else "-",
                    "project_code": (task.project.code if task.project.code else "") if task.project else "",
                    "project_color": task.project.color if getattr(task, 'project', None) and getattr(task.project, 'color', None) else None,
                    "department": getattr(task, "department", None),
                    "worker": None,
                    "date": str(task.end_date),
                    "reason": reason_msg
                })
        else:
            # Fase in corso (task.start_date <= today <= task.end_date)
            working_days = get_working_days_count(task.start_date, task.end_date)
            ore_gg = (planned_h / working_days) if working_days > 0 else planned_h
            workdays_past = get_working_days_count(task.start_date, today - timedelta(days=1))
            
            if workdays_past > 0:
                expected_past = ore_gg * workdays_past
                # Se tot_eff >= expected_past, le ore consuntivate finora coprono i giorni passati
                if tot_eff < expected_past:
                    lost_hours = expected_past - tot_eff
                    is_crit = tot_eff < (expected_past * 0.5)
                    days_to_add = math.ceil(lost_hours / ore_gg) if ore_gg > 0 else 1
                    if days_to_add <= 0:
                        days_to_add = 1
                    
                    sugg_id = f"delay_{task.id}_{today.strftime('%Y%m%d')}_{'critico' if is_crit else 'attenzione'}"
                    reason_msg = (
                        f"Ritardo critico: consuntivate {round(tot_eff, 1)}h rispetto a {round(expected_past, 1)}h attese (mancano all'appello circa {round(lost_hours, 1)}h)."
                        if is_crit
                        else f"Attenzione: la consuntivazione è sotto le attese (consuntivate {round(tot_eff, 1)}h su {round(expected_past, 1)}h attese, mancano circa {round(lost_hours, 1)}h)."
                    )
                    suggestions.append({
                        "id": sugg_id,
                        "type": "delay_conflict",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "project_id": str(task.project_id),
                        "project_name": task.project.name if task.project else "-",
                        "project_code": (task.project.code if task.project.code else "") if task.project else "",
                        "project_color": task.project.color if getattr(task, 'project', None) and getattr(task.project, 'color', None) else None,
                        "department": getattr(task, "department", None),
                        "worker": None,
                        "date": str(today),
                        "reason": reason_msg
                    })

        try:
            workers = json.loads(task.workers) if task.workers else []
        except Exception:
            workers = []
            
        if not workers:
            continue
            
        try:
            worker_hours = json.loads(task.worker_hours) if task.worker_hours else {}
        except Exception:
            worker_hours = {}
            
        try:
            excluded_dates = json.loads(task.excluded_dates) if getattr(task, 'excluded_dates', None) else []
        except:
            excluded_dates = []

        # task.end_date is already inclusive in the database as sent by the frontend modal
        inclusive_end = task.end_date
        duration_days = get_working_days_count(task.start_date, inclusive_end, excluded_dates)
        
        cur = task.start_date
        while cur <= inclusive_end:
            if not is_weekend_or_holiday(cur) and cur.strftime("%Y-%m-%d") not in excluded_dates:
                if cur not in timeline:
                    timeline[cur] = {}
                    
                for w in workers:
                    if w not in timeline[cur]:
                        timeline[cur][w] = []
                        
                    if w in worker_hours and worker_hours[w] is not None:
                        try:
                            total_h = float(worker_hours[w])
                        except Exception:
                            total_h = float(task.planned_hours or 0) / len(workers)
                    else:
                        total_h = float(task.planned_hours or 0) / len(workers)
                        
                    daily_h = total_h / duration_days
                    
                    timeline[cur][w].append((task, daily_h))
            cur += timedelta(days=1)

    # Controlla conflitti operativi
    sorted_dates = sorted([d for d in timeline.keys() if d >= today])
    for d in sorted_dates:
        for w, w_tasks in timeline[d].items():
            w_id = get_user_id(w)
            
            # Ferie
            if w_id and w_id in vacation_dates_by_uid and d in vacation_dates_by_uid[w_id]:
                conflict_tasks = [t for t, _ in w_tasks]
                for t in conflict_tasks:
                    shift_days = 1
                    
                    sugg_id = f"vac_{t.id}_{w_id}_{d.strftime('%Y%m%d')}"
                    suggestions.append({
                        "id": sugg_id,
                        "type": "vacation_conflict",
                        "task_id": str(t.id),
                        "task_name": t.text,
                        "project_id": str(t.project_id),
                        "project_name": t.project.name if t.project else "-",
                        "project_code": (t.project.code if t.project.code else "") if t.project else "",
                        "project_color": t.project.color if getattr(t, 'project', None) and getattr(t.project, 'color', None) else None,
                        "department": getattr(t, "department", None),
                        "worker": w,
                        "date": str(d),
                        "reason": f"L'addetto {w} è in ferie il {d.strftime('%d/%m/%Y')}."
                    })
                continue
                
            # Sovraccarico
            total_h = sum(h for _, h in w_tasks)
            if total_h > max_daily_hours:
                conflict_tasks = [t for t, _ in w_tasks]
                conflict_tasks.sort(key=lambda t: (t.start_date, t.id))
                t_to_shift = conflict_tasks[-1] # Proponiamo di spostare l'ultima arrivata/iniziata
                
                old_start = t_to_shift.start_date
                if old_start <= d:
                    target_start = add_working_days(d, 1)
                    shift_days = get_working_days_count(old_start, target_start) - 1
                else:
                    shift_days = 1
                if shift_days <= 0: shift_days = 1
                
                sugg_id = f"overload_{t_to_shift.id}_{w_id}_{d.strftime('%Y%m%d')}"
                suggestions.append({
                    "id": sugg_id,
                    "type": "overload_conflict",
                    "task_id": str(t_to_shift.id),
                    "task_name": t_to_shift.text,
                    "project_id": str(t_to_shift.project_id),
                    "project_name": t_to_shift.project.name if t_to_shift.project else "-",
                    "project_code": (t_to_shift.project.code if t_to_shift.project.code else "") if t_to_shift.project else "",
                    "project_color": t_to_shift.project.color if getattr(t_to_shift, 'project', None) and getattr(t_to_shift.project, 'color', None) else None,
                    "department": getattr(t_to_shift, "department", None),
                    "worker": w,
                    "date": str(d),
                    "reason": f"L'addetto {w} ha un carico di {round(total_h, 1)}h (limite {max_daily_hours}h) il {d.strftime('%d/%m/%Y')}."
                })

    return suggestions


async def get_zero_hours_alerts(db: AsyncSession, current_user: Optional[User] = None) -> List[Dict[str, Any]]:
    """
    Rileva le mancate consuntivazioni: per ciascuna fase attiva e non completata,
    individua gli addetti assegnati che in un giorno lavorativo trascorso (start_date <= giorno <= oggi)
    non hanno registrato alcuna ora consuntivata (e non erano in ferie).
    """
    today = date.today()
    tasks_res = await db.execute(
        select(Task)
        .join(Project, Task.project_id == Project.id)
        .options(selectinload(Task.project))
        .where(Task.type != TaskType.PROJECT)
        .where(Task.type != TaskType.MILESTONE)
        .where(Task.completed != 1)
        .where(Project.deleted_at.is_(None))
        .where(Project.status.in_([ProjectStatus.PLANNING, ProjectStatus.ACTIVE, "planning", "active", "PLANNING", "ACTIVE"]))
    )
    all_tasks_raw = tasks_res.scalars().all()
    all_tasks = []
    for t in all_tasks_raw:
        if not t.project or getattr(t.project, 'deleted_at', None) is not None:
            continue
        p_status = t.project.status.value if hasattr(t.project.status, 'value') else str(t.project.status)
        p_status_clean = p_status.lower().replace("projectstatus.", "").strip()
        if p_status_clean not in ("planning", "active"):
            continue
        all_tasks.append(t)

    # Se l'utente non è admin, possiamo filtrare per reparto se desiderato
    # (Per default in amministrazione mostriamo tutto o per reparto)
    # Carichiamo ferie e utenti per escludere assenze giustificate
    vac_res = await db.execute(select(Vacation))
    vacations = vac_res.scalars().all()
    users_res = await db.execute(select(User))
    users = users_res.scalars().all()
    fullname_to_id = {u.full_name: str(u.id) for u in users if u.full_name}
    username_to_id = {u.username: str(u.id) for u in users if u.username}

    def get_user_id(name: str):
        return fullname_to_id.get(name) or username_to_id.get(name)

    vacation_dates_by_uid = {}
    for v in vacations:
        uid = str(v.user_id)
        if uid not in vacation_dates_by_uid:
            vacation_dates_by_uid[uid] = set()
        cur = v.start_date
        while cur <= v.end_date:
            vacation_dates_by_uid[uid].add(cur)
            cur += timedelta(days=1)

    alerts = []
    seen_ids = set()

    for task in all_tasks:
        if not task.start_date or not task.end_date:
            continue
        if getattr(task, 'type', '') == 'milestone':
            continue

        workers_list = []
        if task.workers:
            try:
                workers_list = json.loads(task.workers) if isinstance(task.workers, str) else task.workers
            except Exception:
                pass
        if not workers_list:
            continue

        try:
            actual_h_map = json.loads(task.actual_hours) if task.actual_hours else {}
        except Exception:
            actual_h_map = {}

        planned_h = float(task.planned_hours or 8.0)
        tot_eff = 0.0
        for day_map in actual_h_map.values():
            if isinstance(day_map, dict):
                for h in day_map.values():
                    try:
                        tot_eff += float(h)
                    except Exception:
                        pass

        # Se la fase è già completata o le ore previste sono state interamente consuntivate
        if getattr(task, 'completed', 0) == 1 or (float(getattr(task, 'progress', 0) or 0) >= 1.0) or (planned_h > 0 and tot_eff >= planned_h):
            continue

        working_days = get_working_days_count(task.start_date, task.end_date)
        if working_days <= 0 or planned_h <= 0:
            continue

        # Consideriamo solo le giornate lavorative concluse strettamente prima di oggi
        yesterday = today - timedelta(days=1)
        if yesterday < task.start_date:
            continue

        past_end_date = min(task.end_date, yesterday)
        workdays_past = get_working_days_count(task.start_date, past_end_date)
        if workdays_past <= 0:
            continue

        worker_hours_map = {}
        if getattr(task, 'worker_hours', None):
            try:
                worker_hours_map = json.loads(task.worker_hours) if isinstance(task.worker_hours, str) else task.worker_hours
            except Exception:
                worker_hours_map = {}

        for w in workers_list:
            uid = get_user_id(w)

            # Ore previste per questo lavoratore
            w_allocated = worker_hours_map.get(w)
            if w_allocated is not None:
                try:
                    w_planned = float(w_allocated)
                except Exception:
                    w_planned = planned_h / len(workers_list)
            else:
                w_planned = planned_h / len(workers_list)

            if w_planned <= 0:
                continue

            # Ore totali già consuntivate da questo lavoratore su questa fase
            w_tot_eff = 0.0
            if w in actual_h_map and isinstance(actual_h_map[w], dict):
                for h_val in actual_h_map[w].values():
                    try:
                        w_tot_eff += float(h_val)
                    except Exception:
                        pass

            # Se il lavoratore ha già consuntivato tutte le ore previste per lui
            if w_tot_eff >= w_planned:
                continue

            w_ore_gg = w_planned / working_days
            w_expected_past = w_ore_gg * workdays_past

            # Se le ore consuntivate complessivamente coprono o superano l'atteso dei giorni trascorsi
            if w_tot_eff >= w_expected_past:
                continue

            # Altrimenti l'addetto è in debito per i giorni trascorsi
            cur_d = task.start_date
            while cur_d <= past_end_date:
                if not is_weekend_or_holiday(cur_d):
                    if uid and cur_d in vacation_dates_by_uid.get(uid, set()):
                        pass  # In ferie autorizzate
                    else:
                        date_str = cur_d.strftime("%Y-%m-%d")
                        w_day_eff = 0.0
                        if w in actual_h_map and isinstance(actual_h_map[w], dict) and date_str in actual_h_map[w]:
                            try:
                                w_day_eff = float(actual_h_map[w][date_str])
                            except Exception:
                                pass

                        if w_day_eff == 0:
                            alert_id = f"zero_hours_{task.id}_{w}_{date_str.replace('-', '')}"
                            if alert_id not in seen_ids:
                                seen_ids.add(alert_id)
                                alerts.append({
                                    "id": alert_id,
                                    "type": "zero_hours",
                                    "task_id": str(task.id),
                                    "task_name": task.text,
                                    "project_id": str(task.project_id),
                                    "project_name": task.project.name if task.project else "-",
                                    "project_code": (task.project.code if task.project.code else "") if task.project else "",
                                    "project_color": task.project.color if getattr(task, 'project', None) and getattr(task.project, 'color', None) else None,
                                    "department": getattr(task, "department", None),
                                    "worker": w,
                                    "date": str(cur_d),
                                    "formatted_date": cur_d.strftime('%d/%m/%Y'),
                                    "planned_daily_hours": round(w_ore_gg, 1),
                                    "reason": f"L'addetto {w} il {cur_d.strftime('%d/%m/%Y')} non ha consuntivato ore per questa fase."
                                })
                cur_d += timedelta(days=1)

    alerts.sort(key=lambda x: x["date"], reverse=True)
    return alerts
