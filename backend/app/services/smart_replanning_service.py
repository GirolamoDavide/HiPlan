import json
import logging
import math
from datetime import date, timedelta, datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple
from uuid import uuid4

# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select, desc, or_
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.models.task import Task, TaskType
from app.models.link import Link, LinkType
from app.models.project import Project, ProjectStatus
from app.models.vacation import Vacation
from app.models.user import User, UserRole
from app.models.replan_log import ReplanLog, ReplanActionType
from app.utils.working_days import is_working_day

logger = logging.getLogger(__name__)

MAX_DAILY_HOURS = 8.0


def to_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


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


def get_working_days_count(start: Optional[date], end: Optional[date], excluded_dates: Optional[list] = None) -> int:
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


def parse_workers_list(workers_val: Any) -> List[str]:
    if not workers_val:
        return []
    if isinstance(workers_val, list):
        return [str(w).strip() for w in workers_val if str(w).strip()]
    try:
        data = json.loads(workers_val)
        if isinstance(data, list):
            return [str(w).strip() for w in data if str(w).strip()]
    except Exception:
        pass
    return []


def parse_worker_hours_map(hours_val: Any) -> Dict[str, float]:
    if not hours_val:
        return {}
    if isinstance(hours_val, dict):
        return {str(k): float(v) for k, v in hours_val.items() if v is not None}
    try:
        data = json.loads(hours_val)
        if isinstance(data, dict):
            return {str(k): float(v) for k, v in data.items() if v is not None}
    except Exception:
        pass
    return {}


def parse_actual_hours_map(actual_val: Any) -> Dict[str, Dict[str, float]]:
    if not actual_val:
        return {}
    if isinstance(actual_val, dict):
        return actual_val
    try:
        data = json.loads(actual_val)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def parse_custom_dates(custom_dates_val: Any) -> List[Dict[str, Any]]:
    if not custom_dates_val:
        return []
    if isinstance(custom_dates_val, list):
        items = []
        for it in custom_dates_val:
            if isinstance(it, str):
                items.append({"date": it, "hours": 8.0})
            elif isinstance(it, dict) and "date" in it:
                items.append({"date": str(it["date"]), "hours": float(it.get("hours", 8.0))})
        return items
    try:
        data = json.loads(custom_dates_val)
        if isinstance(data, list):
            items = []
            for it in data:
                if isinstance(it, str):
                    items.append({"date": it, "hours": 8.0})
                elif isinstance(it, dict) and "date" in it:
                    items.append({"date": str(it["date"]), "hours": float(it.get("hours", 8.0))})
            return items
    except Exception:
        pass
    return []


def shift_custom_dates(custom_dates_list: List[Dict[str, Any]], shift_days: int) -> Tuple[List[Dict[str, Any]], Optional[date], Optional[date]]:
    """
    Sposta ciascuna data del calendario personalizzato di shift_days giorni lavorativi.
    Restituisce (shifted_list, new_start_date, new_end_date).
    """
    if not custom_dates_list or shift_days == 0:
        if not custom_dates_list:
            return [], None, None
        dates = [datetime.strptime(str(it["date"])[:10], "%Y-%m-%d").date() for it in custom_dates_list if it.get("date")]
        return custom_dates_list, min(dates) if dates else None, max(dates) if dates else None

    shifted = []
    shifted_dates = []
    for it in custom_dates_list:
        d_str = it.get("date")
        if not d_str:
            continue
        try:
            orig_d = datetime.strptime(str(d_str)[:10], "%Y-%m-%d").date()
            new_d = add_working_days(orig_d, shift_days)
            shifted.append({
                "date": new_d.strftime("%Y-%m-%d"),
                "hours": it.get("hours", 8.0)
            })
            shifted_dates.append(new_d)
        except Exception:
            continue

    shifted.sort(key=lambda x: str(x["date"]))
    new_start = min(shifted_dates) if shifted_dates else None
    new_end = max(shifted_dates) if shifted_dates else None
    return shifted, new_start, new_end


async def build_global_schedule_context(db: AsyncSession) -> Dict[str, Any]:
    """
    Costruisce la vista olistica globale di:
    - Tutte le commesse attive
    - Tutti i task non completati
    - Tutti i link/dipendenze
    - Tutte le ferie approvate
    - La matrice globale di carico orario per addetto/giorno su tutte le commesse
    """
    # 1. Commesse attive
    proj_res = await db.execute(
        select(Project)
        .where(Project.status != ProjectStatus.COMPLETED)
        .where(Project.status != ProjectStatus.ARCHIVED)
        .where(Project.deleted_at == None)
    )
    active_projects = {str(p.id): p for p in proj_res.scalars().all()}

    # 2. Utenti
    users_res = await db.execute(select(User))
    users = users_res.scalars().all()
    user_by_id = {str(u.id): u for u in users}
    user_by_name = {}
    for u in users:
        if u.username:
            user_by_name[u.username.strip().lower()] = u
        if u.full_name:
            user_by_name[u.full_name.strip().lower()] = u

    # 3. Ferie per utente
    vac_res = await db.execute(select(Vacation))
    vacations = vac_res.scalars().all()
    vacation_days_by_uid: Dict[str, Set[date]] = {}
    for v in vacations:
        uid = str(v.user_id)
        if uid not in vacation_days_by_uid:
            vacation_days_by_uid[uid] = set()
        c = v.start_date
        while c <= v.end_date:
            vacation_days_by_uid[uid].add(c)
            c += timedelta(days=1)

    # 4. Tutti i task di tutte le commesse attive
    task_res = await db.execute(
        select(Task)
        .options(selectinload(Task.project))
        .where(Task.type != TaskType.PROJECT)
        .where(Task.type != TaskType.MILESTONE)
        .where(Task.completed != 1)
    )
    all_tasks = task_res.scalars().all()

    # 5. Tutti i link tra i task
    links_res = await db.execute(select(Link))
    all_links = links_res.scalars().all()
    links_by_source: Dict[str, List[Link]] = {}
    links_by_target: Dict[str, List[Link]] = {}
    for l in all_links:
        s_id = str(l.source)
        t_id = str(l.target)
        links_by_source.setdefault(s_id, []).append(l)
        links_by_target.setdefault(t_id, []).append(l)

    # 6. Mappa timeline carichi giornalieri per addetto:
    # worker_daily_hours[worker_name][date] = List[Tuple[task, daily_h, project_id, project_name]]
    worker_daily_hours: Dict[str, Dict[date, List[Dict[str, Any]]]] = {}

    for t in all_tasks:
        if not t.start_date or not t.end_date:
            continue
        p_id = str(t.project_id)
        if p_id not in active_projects:
            continue
        
        workers = parse_workers_list(t.workers)
        if not workers:
            continue
            
        w_hours_map = parse_worker_hours_map(t.worker_hours)
        duration_days = get_working_days_count(t.start_date, t.end_date)
        
        c = t.start_date
        while c <= t.end_date:
            if not is_weekend_or_holiday(c):
                for w in workers:
                    norm_w = w.strip()
                    total_assigned_h = w_hours_map.get(norm_w)
                    if total_assigned_h is None:
                        total_assigned_h = float(t.planned_hours or 8.0) / len(workers)
                    daily_h = total_assigned_h / max(1, duration_days)

                    worker_daily_hours.setdefault(norm_w, {}).setdefault(c, []).append({
                        "task_id": str(t.id),
                        "task_name": t.text,
                        "project_id": p_id,
                        "project_name": t.project.name if t.project else "Commessa",
                        "project_code": t.project.code if (t.project and t.project.code) else "",
                        "daily_hours": daily_h
                    })
            c += timedelta(days=1)

    return {
        "active_projects": active_projects,
        "users": users,
        "user_by_id": user_by_id,
        "user_by_name": user_by_name,
        "vacation_days_by_uid": vacation_days_by_uid,
        "all_tasks": all_tasks,
        "all_tasks_by_id": {str(t.id): t for t in all_tasks},
        "links_by_source": links_by_source,
        "links_by_target": links_by_target,
        "worker_daily_hours": worker_daily_hours,
    }


def find_alternative_worker(
    candidate_workers: List[User],
    current_worker: str,
    start_d: date,
    end_d: date,
    needed_daily_hours: float,
    context: Dict[str, Any],
    department_filter: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    """
    Cerca un addetto alternativo idoneo che:
    1. Sia attivo e appartenga allo stesso reparto o compatibile.
    2. Non sia in ferie nelle date [start_d, end_d].
    3. Con l'aggiunta di needed_daily_hours, non superi MAI le 8 ore/giorno su nessuna data.
    Restituisce l'addetto con il miglior margine di capacità residua.
    """
    best_candidate = None
    max_spare_capacity = -1.0

    worker_daily_hours = context["worker_daily_hours"]
    vacation_days_by_uid = context["vacation_days_by_uid"]

    for cand in candidate_workers:
        cand_name = cand.full_name or cand.username
        if not cand_name or cand_name.strip().lower() == current_worker.strip().lower():
            continue
            
        if department_filter and cand.department and cand.department != department_filter:
            continue

        cand_uid = str(cand.id)
        cand_vacations = vacation_days_by_uid.get(cand_uid, set())

        # Verifica ferie nel periodo
        has_vacation = False
        c = start_d
        while c <= end_d:
            if not is_weekend_or_holiday(c) and c in cand_vacations:
                has_vacation = True
                break
            c += timedelta(days=1)
        if has_vacation:
            continue

        # Verifica carichi orari
        can_accommodate = True
        cand_hours_map = worker_daily_hours.get(cand_name, {})
        min_daily_free = 999.0

        c = start_d
        while c <= end_d:
            if not is_weekend_or_holiday(c):
                booked_entries = cand_hours_map.get(c, [])
                booked_h = sum(e["daily_hours"] for e in booked_entries)
                if (booked_h + needed_daily_hours) > MAX_DAILY_HOURS:
                    can_accommodate = False
                    break
                daily_free = MAX_DAILY_HOURS - booked_h
                if daily_free < min_daily_free:
                    min_daily_free = daily_free
            c += timedelta(days=1)

        if can_accommodate and min_daily_free > max_spare_capacity:
            max_spare_capacity = min_daily_free
            best_candidate = {
                "user_id": cand_uid,
                "worker_name": cand_name,
                "department": cand.department,
                "min_daily_free_hours": round(min_daily_free, 1)
            }

    return best_candidate


def get_earliest_start_from_predecessors(
    task_id: str,
    context: Dict[str, Any],
    today: date,
    task_projected_ends: Optional[Dict[str, date]] = None
) -> Optional[date]:
    """
    Calcola la data minima in cui un task può iniziare in base a tutti i suoi predecessori
    collegati da Link Finish-to-Start (FS) o Start-to-Start (SS).
    Se un task non ha dipendenze in ingresso (es. Fase 4 che non dipende da Fase 3),
    restituisce None, permettendo al task di essere programmato liberamente.
    """
    links_by_target = context.get("links_by_target", {})
    incoming_links = links_by_target.get(task_id, [])
    if not incoming_links:
        return None

    all_tasks_by_id = context.get("all_tasks_by_id", {})
    min_allowed = None

    for link in incoming_links:
        link_type = link.type.value if hasattr(link.type, 'value') else str(link.type)
        lag = int(link.lag or 0)
        pred_task = all_tasks_by_id.get(str(link.source))
        if not pred_task or pred_task.completed == 1:
            continue

        # Data di fine effettiva del predecessore
        pred_end = None
        if task_projected_ends and str(pred_task.id) in task_projected_ends:
            pred_end = task_projected_ends[str(pred_task.id)]
        elif pred_task.end_date:
            if pred_task.end_date < today:
                pred_duration = pred_task.duration or get_working_days_count(pred_task.start_date, pred_task.end_date)
                pred_end = add_working_days(today, max(1, pred_duration) - 1)
            else:
                pred_end = pred_task.end_date

        if not pred_end:
            continue

        if link_type == "0":  # Finish-to-Start (FS): la fase successiva può iniziare solo dopo che il predecessore è terminato
            allowed = add_working_days(pred_end, 1 + lag)
            if min_allowed is None or allowed > min_allowed:
                min_allowed = allowed
        elif link_type == "1":  # Start-to-Start (SS)
            pred_start = pred_task.start_date or today
            allowed = add_working_days(pred_start, lag)
            if min_allowed is None or allowed > min_allowed:
                min_allowed = allowed

    return min_allowed


def get_all_downstream_task_ids(task_id: str, context: Dict[str, Any]) -> Set[str]:
    """
    Raccoglie ricorsivamente tutti gli ID dei task successori a valle collegati da link.
    """
    succ_ids = set()
    stack = [task_id]
    links_by_source = context.get("links_by_source", {})
    while stack:
        curr = stack.pop()
        for link in links_by_source.get(curr, []):
            tgt = str(link.target)
            if tgt not in succ_ids:
                succ_ids.add(tgt)
                stack.append(tgt)
    return succ_ids


def calculate_cascade_impact(
    task: Task,
    new_start_date: date,
    new_end_date: date,
    project_end_date: Optional[date],
    context: Dict[str, Any],
    visited: Optional[Set[str]] = None
) -> Dict[str, Any]:
    """
    Calcola ricorsivamente la propagazione a cascata sulle fasi successive
    della stessa commessa collegate da Link (Finish-to-Start, ecc.)
    e verifica il rispetto rigoroso della fine commessa.
    """
    if visited is None:
        visited = set()
    visited.add(str(task.id))

    links_by_source = context.get("links_by_source", {})
    downstream_links = links_by_source.get(str(task.id), [])
    
    affected_successors = []
    exceeds_deadline = False
    max_reach_date = new_end_date

    for link in downstream_links:
        succ_task = context.get("all_tasks_by_id", {}).get(str(link.target)) or link.target_task
        if not succ_task or str(succ_task.id) in visited:
            continue
        if succ_task.completed == 1:
            continue

        # In DHTMLX standard Finish-to-Start (FS / type "0")
        link_type = link.type.value if hasattr(link.type, 'value') else str(link.type)
        lag = int(link.lag or 0)
        
        succ_start = succ_task.start_date
        succ_end = succ_task.end_date
        duration = succ_task.duration or get_working_days_count(succ_start, succ_end)
        
        needed_start = succ_start
        if link_type == "0":  # FS
            min_allowed = add_working_days(new_end_date, 1 + lag)
            if succ_start < min_allowed:
                needed_start = min_allowed
        elif link_type == "1":  # SS
            min_allowed = add_working_days(new_start_date, lag)
            if succ_start < min_allowed:
                needed_start = min_allowed
        elif link_type == "2":  # FF
            min_allowed_end = add_working_days(new_end_date, lag)
            if succ_end and succ_end < min_allowed_end:
                needed_start = add_working_days(min_allowed_end, -duration)

        if needed_start > succ_start:
            shift_days = get_working_days_count(succ_start, needed_start) - 1
            is_custom = succ_task.budget_mode == "custom_dates" and succ_task.custom_dates
            succ_custom_dates = parse_custom_dates(succ_task.custom_dates) if is_custom else []
            shifted_custom = None

            if succ_custom_dates:
                shifted_custom, c_start, c_end = shift_custom_dates(succ_custom_dates, shift_days)
                needed_start = c_start or needed_start
                needed_end = c_end or add_working_days(needed_start, duration - 1)
            else:
                needed_end = add_working_days(needed_start, duration - 1)

            if needed_end > max_reach_date:
                max_reach_date = needed_end

            if project_end_date and needed_end > project_end_date:
                exceeds_deadline = True

            succ_info = {
                "task_id": str(succ_task.id),
                "task_name": succ_task.text,
                "current_start": str(succ_start),
                "current_end": str(succ_end),
                "proposed_start": str(needed_start),
                "proposed_end": str(needed_end),
                "shift_working_days": shift_days,
                "custom_dates": shifted_custom
            }

            # Ricorsione sui successori di questo successore
            sub_cascade = calculate_cascade_impact(
                succ_task, needed_start, needed_end, project_end_date, context, visited
            )
            if sub_cascade.get("exceeds_project_deadline"):
                exceeds_deadline = True
            succ_info["sub_successors"] = sub_cascade.get("affected_successors", [])
            affected_successors.append(succ_info)

    return {
        "affected_successors": affected_successors,
        "max_reach_date": str(max_reach_date),
        "exceeds_project_deadline": exceeds_deadline
    }


def find_available_window_for_worker(
    task: Task,
    worker_name: str,
    worker_user_id: Optional[str],
    duration_days: int,
    daily_h_needed: float,
    earliest_start: date,
    proj_end_date: Optional[date],
    context: Dict[str, Any],
    max_search_days: int = 180,
    downstream_task_ids: Optional[Set[str]] = None
) -> Optional[Tuple[date, date, Dict[str, Any]]]:
    """
    Cerca la prima finestra temporale continua di duration_days lavorativi in cui
    lo STESSO addetto (worker_name) può svolgere il task in modo OLISTICO:
    1. Rispettando la data minima earliest_start (vincoli predecessori / oggi).
    2. Senza essere in ferie in nessuna data della finestra.
    3. Senza superare MAI le 8.0 ore/giorno sommando i suoi altri task concorrenti.
    4. Senza sforare la scadenza finale della commessa calcolata tramite propagazione a cascata.
    5. Verificando che NESSUN successore a valle mosso a cascata causi un nuovo sovraccarico (> 8h/gg)
       o finisca su giorni di ferie per i rispettivi addetti assegnati.
    Restituisce (target_start, target_end, cascade_impact).
    """
    w_hours = context.get("worker_daily_hours", {}).get(worker_name, {})
    w_vacations = context.get("vacation_days_by_uid", {}).get(worker_user_id, set()) if worker_user_id else set()
    downstream_ids = downstream_task_ids or set()
    all_tasks_by_id = context.get("all_tasks_by_id", {})
    worker_daily_hours = context.get("worker_daily_hours", {})
    vacation_days_by_uid = context.get("vacation_days_by_uid", {})
    user_by_name = context.get("user_by_name", {})

    cur_start = earliest_start
    while is_weekend_or_holiday(cur_start):
        cur_start += timedelta(days=1)

    def flatten_succs(succ_list):
        res = []
        for s in succ_list:
            res.append(s)
            if s.get("sub_successors"):
                res.extend(flatten_succs(s["sub_successors"]))
        return res

    for _ in range(max_search_days):
        cur_end = add_working_days(cur_start, duration_days - 1)
        valid = True

        # 1. Verifica capienza addetto principale
        c = cur_start
        while c <= cur_end:
            if not is_weekend_or_holiday(c):
                if c in w_vacations:
                    valid = False
                    cur_start = add_working_days(c, 1)
                    break
                other_h = sum(
                    e["daily_hours"]
                    for e in w_hours.get(c, [])
                    if e.get("task_id") != str(task.id) and e.get("task_id") not in downstream_ids
                )
                if other_h + daily_h_needed > MAX_DAILY_HOURS:
                    valid = False
                    cur_start = add_working_days(cur_start, 1)
                    break
            c += timedelta(days=1)

        if not valid:
            continue

        # 1b. Verifica capienza eventuali co-lavoratori assegnati allo stesso task
        task_workers = parse_workers_list(task.workers)
        t_w_hours_map = parse_worker_hours_map(task.worker_hours)
        t_plan_h = float(task.planned_hours or 8.0)
        for tw in task_workers:
            if tw.strip() == worker_name.strip():
                continue
            tw_u = user_by_name.get(tw.strip().lower())
            tw_uid = str(tw_u.id) if tw_u else None
            tw_vac = vacation_days_by_uid.get(tw_uid, set()) if tw_uid else set()
            tw_timeline = worker_daily_hours.get(tw, {})
            tw_assigned_h = t_w_hours_map.get(tw.strip(), t_plan_h / max(1, len(task_workers)))
            tw_daily_h = tw_assigned_h / max(1, duration_days)
            c = cur_start
            while c <= cur_end:
                if not is_weekend_or_holiday(c):
                    if c in tw_vac:
                        valid = False
                        break
                    other_tw_h = sum(
                        e["daily_hours"] for e in tw_timeline.get(c, [])
                        if e.get("task_id") != str(task.id) and e.get("task_id") not in downstream_ids
                    )
                    if other_tw_h + tw_daily_h > MAX_DAILY_HOURS:
                        valid = False
                        break
                c += timedelta(days=1)
            if not valid:
                break

        if not valid:
            cur_start = add_working_days(cur_start, 1)
            continue

        # 2. Verifica scadenza commessa a cascata
        cascade = calculate_cascade_impact(task, cur_start, cur_end, proj_end_date, context)
        if cascade.get("exceeds_project_deadline"):
            cur_start = add_working_days(cur_start, 1)
            continue

        # 3. Verifica olistica: nessun nuovo sovraccarico generato sulle fasi a valle mosse a cascata
        succ_valid = True
        for succ_info in flatten_succs(cascade.get("affected_successors", [])):
            succ_t = all_tasks_by_id.get(succ_info["task_id"])
            if not succ_t:
                continue
            s_st = date.fromisoformat(succ_info["proposed_start"])
            s_en = date.fromisoformat(succ_info["proposed_end"])
            s_dur = succ_t.duration or max(1, get_working_days_count(s_st, s_en))
            s_workers = parse_workers_list(succ_t.workers)
            s_plan_h = float(succ_t.planned_hours or 8.0)
            s_w_hours_map = parse_worker_hours_map(succ_t.worker_hours)

            for sw in s_workers:
                sw_u = user_by_name.get(sw.strip().lower())
                sw_uid = str(sw_u.id) if sw_u else None
                sw_vac = vacation_days_by_uid.get(sw_uid, set()) if sw_uid else set()
                sw_timeline = worker_daily_hours.get(sw, {})
                assigned_sw_h = s_w_hours_map.get(sw.strip(), s_plan_h / max(1, len(s_workers)))
                s_daily_h = assigned_sw_h / max(1, s_dur)

                sc = s_st
                while sc <= s_en:
                    if not is_weekend_or_holiday(sc):
                        if sc in sw_vac:
                            succ_valid = False
                            break
                        other_sw_h = sum(
                            e["daily_hours"] for e in sw_timeline.get(sc, [])
                            if e.get("task_id") != str(succ_t.id) and e.get("task_id") != str(task.id) and e.get("task_id") not in downstream_ids
                        )
                        if other_sw_h + s_daily_h > MAX_DAILY_HOURS:
                            succ_valid = False
                            break
                    sc += timedelta(days=1)
                if not succ_valid:
                    break
            if not succ_valid:
                break

        if not succ_valid:
            cur_start = add_working_days(cur_start, 1)
            continue

        return cur_start, cur_end, cascade

    return None


def calculate_cross_project_correction(
    t_other: Task,
    conflict_worker: str,
    conflict_end_date: date,
    context: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Calcola la correzione a catena (slittamento e propagazione a valle) per una fase
    di un'altra commessa impattata da un sovraccarico con un addetto condiviso.
    """
    op_id = str(t_other.project_id)
    op_proj = context.get("active_projects", {}).get(op_id)
    op_deadline = op_proj.end_date if op_proj else None
    op_code = op_proj.code if op_proj and op_proj.code else ""
    raw_op_name = op_proj.name if op_proj else "Altra Commessa"
    display_op_name = f"[{op_code}] {raw_op_name}" if op_code else raw_op_name

    t_start = t_other.start_date
    t_end = t_other.end_date
    duration = t_other.duration or max(1, get_working_days_count(t_start, t_end))

    # La fase impattata slitta per iniziare al termine del conflitto sull'addetto
    proposed_start = max(t_start, add_working_days(conflict_end_date, 1))
    proposed_end = add_working_days(proposed_start, duration - 1)
    shift_days = get_working_days_count(t_start, proposed_start) - 1

    # Calcola l'effetto a cascata su tutte le fasi successive collegate in quella commessa
    cascade_res = calculate_cascade_impact(t_other, proposed_start, proposed_end, op_deadline, context)
    cascade_tasks = cascade_res.get("affected_successors", [])
    exceeds_deadline = cascade_res.get("exceeds_project_deadline", False)
    if op_deadline and proposed_end > op_deadline:
        exceeds_deadline = True

    # Sintesi leggibile della correzione
    summary = f"Slittamento a catena al termine del picco: {proposed_start.strftime('%d/%m')} → {proposed_end.strftime('%d/%m')} (+{shift_days} gg)"
    if cascade_tasks:
        succ_names = ", ".join([f"'{s['task_name']}' (+{s['shift_working_days']} gg)" for s in cascade_tasks])
        summary += f" con propagazione a cascata su: {succ_names}."
    else:
        summary += " senza ritardo su ulteriori fasi."

    if exceeds_deadline:
        summary += f" Attenzione: supera la scadenza di '{display_op_name}' ({op_deadline.strftime('%d/%m/%Y') if op_deadline else 'N.D.'})."
    else:
        summary += f" Rispetta la consegna di '{display_op_name}'."

    return {
        "task_id": str(t_other.id),
        "task_name": t_other.text,
        "project_id": op_id,
        "project_name": raw_op_name,
        "project_code": op_code,
        "worker": conflict_worker,
        "action": "shift",
        "original_start": t_start.isoformat(),
        "original_end": t_end.isoformat(),
        "proposed_start": proposed_start.isoformat(),
        "proposed_end": proposed_end.isoformat(),
        "shift_working_days": shift_days,
        "exceeds_deadline": exceeds_deadline,
        "cascade_tasks": cascade_tasks,
        "summary": summary
    }


def detect_cross_project_impact(
    workers: List[str],
    start_d: date,
    end_d: date,
    current_project_id: str,
    context: Dict[str, Any],
    needed_daily_h: float = 8.0,
    downstream_tasks: Optional[List[Dict[str, Any]]] = None
) -> List[Dict[str, Any]]:
    """
    Rileva se lo slittamento temporale o il riposizionamento impatta
    i carichi degli addetti su ALTRE commesse attive contemporanee,
    calcolando contestualmente la proposta di correzione a catena.
    """
    worker_daily_hours = context.get("worker_daily_hours", {})
    all_tasks = context.get("all_tasks", [])
    all_tasks_by_id = context.get("all_tasks_by_id", {str(t.id): t for t in all_tasks})
    other_proj_impacts = []
    seen_combos = set()

    # 1. Controlla per i worker della fase principale
    for w in workers:
        w_hours = worker_daily_hours.get(w, {})
        c = start_d
        while c <= end_d:
            if not is_weekend_or_holiday(c):
                entries = w_hours.get(c, [])
                for e in entries:
                    op_id = str(e.get("project_id"))
                    if op_id != current_project_id:
                        op_proj = context.get("active_projects", {}).get(op_id)
                        op_code = (op_proj.code if op_proj and op_proj.code else "") or e.get("project_code", "")
                        raw_op_name = e.get("project_name") or (op_proj.name if op_proj else "Altra Commessa")
                        display_op_name = f"[{op_code}] {raw_op_name}" if op_code else raw_op_name
                        e_task_id = str(e.get("task_id"))
                        combo_key = (w, op_id, e_task_id)
                        if combo_key not in seen_combos:
                            seen_combos.add(combo_key)
                            booked_h = e.get("daily_hours", 0.0)
                            tot_h = booked_h + needed_daily_h
                            t_other = all_tasks_by_id.get(e_task_id)
                            task_name = e.get("task_name") or (t_other.text if t_other else "Fase Commessa")
                            t_start = t_other.start_date.isoformat() if t_other and t_other.start_date else None
                            t_end = t_other.end_date.isoformat() if t_other and t_other.end_date else None

                            if tot_h > MAX_DAILY_HOURS:
                                corr = calculate_cross_project_correction(t_other, w, end_d, context) if (t_other and t_other.start_date and t_other.end_date) else None
                                other_proj_impacts.append({
                                    "worker": w,
                                    "status": "warning",
                                    "project_id": op_id,
                                    "project_name": raw_op_name,
                                    "project_code": op_code,
                                    "task_id": e_task_id,
                                    "task_name": task_name,
                                    "task_start": t_start,
                                    "task_end": t_end,
                                    "daily_hours": round(booked_h, 1),
                                    "peak_hours": round(tot_h, 1),
                                    "message": f"Attenzione: Lo slittamento sovrappone {w} con la fase '{task_name}' della commessa '{display_op_name}' portando il carico a {round(tot_h, 1)}h/gg (>8h).",
                                    "proposed_correction": corr
                                })
                            else:
                                other_proj_impacts.append({
                                    "worker": w,
                                    "status": "safe",
                                    "project_id": op_id,
                                    "project_name": raw_op_name,
                                    "project_code": op_code,
                                    "task_id": e_task_id,
                                    "task_name": task_name,
                                    "task_start": t_start,
                                    "task_end": t_end,
                                    "daily_hours": round(booked_h, 1),
                                    "peak_hours": round(tot_h, 1),
                                    "message": f"{w} è impegnato anche sulla fase '{task_name}' di '{display_op_name}' ({round(booked_h, 1)}h/gg), ma la sovrapposizione rientra nella capienza massima (totale {round(tot_h, 1)}h/gg).",
                                    "proposed_correction": None
                                })
            c += timedelta(days=1)

    # 2. Controlla anche per i worker delle fasi a valle che slittano a catena
    if downstream_tasks:
        for dt in downstream_tasks:
            dt_id = dt.get("task_id")
            orig_task = next((t for t in all_tasks if str(t.id) == dt_id), None)
            if orig_task:
                dt_workers = parse_workers_list(orig_task.workers)
                try:
                    dt_start = date.fromisoformat(dt["proposed_start"])
                    dt_end = date.fromisoformat(dt["proposed_end"])
                except Exception:
                    continue
                dt_dur = get_working_days_count(dt_start, dt_end)
                dt_needed_h = float(orig_task.planned_hours or 8.0) / max(1, len(dt_workers) * dt_dur)

                for dw in dt_workers:
                    dw_hours = worker_daily_hours.get(dw, {})
                    cur = dt_start
                    while cur <= dt_end:
                        if not is_weekend_or_holiday(cur):
                            entries = dw_hours.get(cur, [])
                            for e in entries:
                                op_id = str(e.get("project_id"))
                                if op_id != current_project_id:
                                    op_proj = context.get("active_projects", {}).get(op_id)
                                    op_code = (op_proj.code if op_proj and op_proj.code else "") or e.get("project_code", "")
                                    raw_op_name = e.get("project_name") or (op_proj.name if op_proj else "Altra Commessa")
                                    display_op_name = f"[{op_code}] {raw_op_name}" if op_code else raw_op_name
                                    e_task_id = str(e.get("task_id"))
                                    combo_key = (dw, op_id, e_task_id)
                                    if combo_key not in seen_combos:
                                        seen_combos.add(combo_key)
                                        booked_h = e.get("daily_hours", 0.0)
                                        tot_h = booked_h + dt_needed_h
                                        t_other = all_tasks_by_id.get(e_task_id)
                                        task_name = e.get("task_name") or (t_other.text if t_other else "Fase Commessa")
                                        t_start = t_other.start_date.isoformat() if t_other and t_other.start_date else None
                                        t_end = t_other.end_date.isoformat() if t_other and t_other.end_date else None

                                        if tot_h > MAX_DAILY_HOURS:
                                            corr = calculate_cross_project_correction(t_other, dw, dt_end, context) if (t_other and t_other.start_date and t_other.end_date) else None
                                            other_proj_impacts.append({
                                                "worker": dw,
                                                "status": "warning",
                                                "project_id": op_id,
                                                "project_name": raw_op_name,
                                                "project_code": op_code,
                                                "task_id": e_task_id,
                                                "task_name": task_name,
                                                "task_start": t_start,
                                                "task_end": t_end,
                                                "daily_hours": round(booked_h, 1),
                                                "peak_hours": round(tot_h, 1),
                                                "source_task_name": orig_task.text,
                                                "message": f"Cascata: {dw} sulla fase '{orig_task.text}' si sovrappone a '{task_name}' della commessa '{display_op_name}' portando il carico a {round(tot_h, 1)}h/gg (>8h).",
                                                "proposed_correction": corr
                                            })
                                        else:
                                            other_proj_impacts.append({
                                                "worker": dw,
                                                "status": "safe",
                                                "project_id": op_id,
                                                "project_name": raw_op_name,
                                                "project_code": op_code,
                                                "task_id": e_task_id,
                                                "task_name": task_name,
                                                "task_start": t_start,
                                                "task_end": t_end,
                                                "daily_hours": round(booked_h, 1),
                                                "peak_hours": round(tot_h, 1),
                                                "source_task_name": orig_task.text,
                                                "message": f"Cascata: {dw} sulla fase '{orig_task.text}' ha capienza compatibile con '{task_name}' di '{display_op_name}'.",
                                                "proposed_correction": None
                                            })
                        cur += timedelta(days=1)

    return other_proj_impacts


async def generate_project_smart_suggestions(
    db: AsyncSession,
    project_id: str,
    current_user: Optional[User] = None
) -> Dict[str, Any]:
    """
    Motore Principale di Analisi e Rebalance per una specifica commessa:
    1. Raccoglie il contesto globale di tutte le commesse e tutti gli addetti.
    2. Identifica i conflitti di questa commessa (ferie, sovraccarichi, ritardi, scadenze).
    3. Formula proposte intelligenti secondo l'ordine di priorità:
       - Riassegnazione risorsa (nessun cambio date)
       - Spostamento nel margine libero interno (fine commessa intatta)
       - Supporto / Parallelizzazione
       - Allarme ultima spiaggia (richiesta estensione manuale)
    4. Calcola la propagazione a cascata e verifica l'impatto cross-commessa.
    """
    today = date.today()
    context = await build_global_schedule_context(db)
    
    active_projects = context["active_projects"]
    if project_id not in active_projects:
        # Se la commessa non è attiva, estraila singolarmente
        proj_res = await db.execute(select(Project).where(Project.id == project_id))
        target_project = proj_res.scalar_one_or_none()
        if not target_project:
            return {"error": "Commessa non trovata", "suggestions": []}
    else:
        target_project = active_projects[project_id]

    proj_start_date = target_project.start_date
    proj_end_date = target_project.end_date

    # Estrai i task della commessa target
    task_res = await db.execute(
        select(Task)
        .where(Task.project_id == project_id)
        .where(Task.type != TaskType.PROJECT)
        .where(Task.type != TaskType.MILESTONE)
        .order_by(Task.sort_order, Task.start_date)
    )
    proj_tasks = task_res.scalars().all()

    vacation_days_by_uid = context["vacation_days_by_uid"]
    worker_daily_hours = context["worker_daily_hours"]
    user_by_name = context["user_by_name"]
    users = context["users"]

    suggestions: List[Dict[str, Any]] = []
    handled_by_cascade_ids: Set[str] = set()

    def register_cascade_ids(cascade_dict: Optional[Dict[str, Any]]):
        if not cascade_dict:
            return
        for s in cascade_dict.get("affected_successors", []):
            handled_by_cascade_ids.add(str(s["task_id"]))
            if s.get("sub_successors"):
                for sub in s["sub_successors"]:
                    register_cascade_ids({"affected_successors": [sub]})

    def sync_timeline_with_proposal(
        main_task: Task,
        t_start: date,
        t_end: date,
        cascade_dict: Optional[Dict[str, Any]],
        cross_proj_list: Optional[List[Dict[str, Any]]] = None
    ):
        register_cascade_ids(cascade_dict)
        all_tasks_map = context.get("all_tasks_by_id", {})
        active_projs = context.get("active_projects", {})

        def relocate_task_hours(t_obj: Task, old_st: Optional[date], old_en: Optional[date], new_st: date, new_en: date):
            t_workers = parse_workers_list(t_obj.workers)
            t_w_hours = parse_worker_hours_map(t_obj.worker_hours)
            t_dur = max(1, get_working_days_count(new_st, new_en))
            t_plan_h = float(t_obj.planned_hours or 8.0)
            p_id = str(t_obj.project_id)
            proj_obj = active_projs.get(p_id)
            p_name = proj_obj.name if proj_obj else ""
            p_code = proj_obj.code if proj_obj and proj_obj.code else ""

            for tw in t_workers:
                tw_clean = tw.strip()
                tw_timeline = worker_daily_hours.setdefault(tw_clean, {})
                # Rimuove vecchie entrate
                if old_st and old_en:
                    c = old_st
                    while c <= old_en:
                        if c in tw_timeline:
                            tw_timeline[c] = [e for e in tw_timeline[c] if e.get("task_id") != str(t_obj.id)]
                        c += timedelta(days=1)
                # Aggiunge nuove entrate
                assigned_h = t_w_hours.get(tw_clean, t_plan_h / max(1, len(t_workers)))
                daily_h = assigned_h / t_dur
                c = new_st
                while c <= new_en:
                    if not is_weekend_or_holiday(c):
                        tw_timeline.setdefault(c, []).append({
                            "task_id": str(t_obj.id),
                            "task_text": t_obj.text,
                            "daily_hours": daily_h,
                            "project_id": p_id,
                            "project_name": p_name,
                            "project_code": p_code
                        })
                    c += timedelta(days=1)

        # 1. Ricollocheremo il task principale
        relocate_task_hours(main_task, main_task.start_date, main_task.end_date, t_start, t_end)

        # 2. Ricollocheremo i successori a cascata
        if cascade_dict:
            def flatten_succs(succ_list):
                res = []
                for s in succ_list:
                    res.append(s)
                    if s.get("sub_successors"):
                        res.extend(flatten_succs(s["sub_successors"]))
                return res

            for s_info in flatten_succs(cascade_dict.get("affected_successors", [])):
                st_id = s_info["task_id"]
                s_task = all_tasks_map.get(st_id)
                if s_task:
                    s_old_st = s_task.start_date
                    s_old_en = s_task.end_date
                    s_new_st = date.fromisoformat(s_info["proposed_start"])
                    s_new_en = date.fromisoformat(s_info["proposed_end"])
                    relocate_task_hours(s_task, s_old_st, s_old_en, s_new_st, s_new_en)

        # 3. Ricollocheremo le correzioni a catena su commesse collegate
        if cross_proj_list:
            for op in cross_proj_list:
                corr = op.get("proposed_correction")
                if corr:
                    c_id = corr["task_id"]
                    c_task = all_tasks_map.get(c_id)
                    if c_task:
                        c_old_st = c_task.start_date
                        c_old_en = c_task.end_date
                        c_new_st = date.fromisoformat(corr["proposed_start"])
                        c_new_en = date.fromisoformat(corr["proposed_end"])
                        relocate_task_hours(c_task, c_old_st, c_old_en, c_new_st, c_new_en)
                        for ct in corr.get("cascade_tasks", []):
                            ct_task = all_tasks_map.get(ct["task_id"])
                            if ct_task:
                                ct_old_st = ct_task.start_date
                                ct_old_en = ct_task.end_date
                                ct_new_st = date.fromisoformat(ct["proposed_start"])
                                ct_new_en = date.fromisoformat(ct["proposed_end"])
                                relocate_task_hours(ct_task, ct_old_st, ct_old_en, ct_new_st, ct_new_en)

    for task in proj_tasks:
        if task.completed == 1 or not task.start_date or not task.end_date:
            continue

        # Se questa fase è già stata riprogrammata a valle nella propagazione a cascata
        # di una proposta primaria precedente (ed è già stata verificata in modo olistico esente da ferie/sovraccarichi),
        # non generiamo proposte autonome e contraddittorie basate sulle sue vecchie date obsolete.
        if str(task.id) in handled_by_cascade_ids:
            continue

        workers = parse_workers_list(task.workers)
        w_hours_map = parse_worker_hours_map(task.worker_hours)
        actual_h_map = parse_actual_hours_map(task.actual_hours)
        duration_days = get_working_days_count(task.start_date, task.end_date)
        planned_h = float(task.planned_hours or 8.0)

        # Calcola ore consuntivate totali finora
        tot_actual_h = 0.0
        for day_map in actual_h_map.values():
            if isinstance(day_map, dict):
                for h in day_map.values():
                    try:
                        tot_actual_h += h
                    except Exception:
                        pass

        # -------------------------------------------------------------
        # 1. ANALISI CONFLITTO FERIE
        # -------------------------------------------------------------
        task_custom_dates = parse_custom_dates(task.custom_dates) if task.budget_mode == "custom_dates" else []
        task_custom_dates_set = {it["date"] for it in task_custom_dates} if task_custom_dates else None

        for w in workers:
            w_user = user_by_name.get(w.strip().lower())
            if not w_user:
                continue
            w_uid = str(w_user.id)
            w_vacations = vacation_days_by_uid.get(w_uid, set())

            conflicting_vac_dates = []
            c = task.start_date
            while c <= task.end_date:
                if not is_weekend_or_holiday(c) and c in w_vacations:
                    if task_custom_dates_set is None or c.strftime("%Y-%m-%d") in task_custom_dates_set:
                        conflicting_vac_dates.append(c)
                c += timedelta(days=1)

            if conflicting_vac_dates:
                assigned_h = w_hours_map.get(w, planned_h / len(workers))
                daily_h_needed = assigned_h / max(1, duration_days)

                # PRIORITÀ 1 (PREFERITA): L'addetto stesso recupera le ore al rientro dalle ferie in modo olistico
                max_vac = max(conflicting_vac_dates)
                start_after_vac = add_working_days(max_vac, 1)
                min_from_pred = get_earliest_start_from_predecessors(str(task.id), context, today)
                earliest_search = max(start_after_vac, min_from_pred) if min_from_pred else start_after_vac
                downstream_ids = get_all_downstream_task_ids(str(task.id), context)

                same_worker_res = find_available_window_for_worker(
                    task=task,
                    worker_name=w,
                    worker_user_id=w_uid,
                    duration_days=duration_days,
                    daily_h_needed=daily_h_needed,
                    earliest_start=earliest_search,
                    proj_end_date=proj_end_date,
                    context=context,
                    downstream_task_ids=downstream_ids
                )

                target_start = None
                target_end = None
                cascade = None
                if same_worker_res:
                    target_start, target_end, cascade = same_worker_res

                alt_worker = find_alternative_worker(
                    users, w, task.start_date, task.end_date, daily_h_needed, context,
                    department_filter=task.department or w_user.department
                )

                if same_worker_res and cascade and target_start and target_end and not cascade["exceeds_project_deadline"]:
                    # L'addetto stesso recupera il lavoro al rientro senza violare la scadenza commessa
                    shift_days = get_working_days_count(task.start_date, target_start) - 1
                    shifted_custom_dates = None
                    if task_custom_dates:
                        shifted_custom_dates, sc_start, sc_end = shift_custom_dates(task_custom_dates, shift_days)
                        target_start = sc_start or target_start
                        target_end = sc_end or target_end

                    sugg_id = f"vac_shift_{task.id}_{w_uid}_{target_start.strftime('%Y%m%d')}"
                    daily_needed_h = float(task.planned_hours or 8.0) / max(1, len(workers) * duration_days)
                    cross_proj_impact = detect_cross_project_impact(
                        workers, target_start, target_end, project_id, context,
                        needed_daily_h=daily_needed_h,
                        downstream_tasks=cascade["affected_successors"]
                    )
                    suggestions.append({
                        "id": sugg_id,
                        "type": "vacation_conflict",
                        "severity": "medium",
                        "title": f"Recupero Post-Ferie: {w}",
                        "description": f"L'addetto {w} è in ferie per {len(conflicting_vac_dates)} gg. Come preferito, l'addetto stesso recupera la lavorazione al rientro ({target_start.strftime('%d/%m')}); la commessa ha margine sufficiente per assorbire lo slittamento senza sforare la consegna finale.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "internal_shift",
                        "strategy_label": "Recupero Post-Ferie (Stesso Addetto)",
                        "badge": "Recupero Addetto",
                        "is_alternative": False,
                        "action_label": f"Sposta al rientro di {w} ({target_start.strftime('%d/%m')} → {target_end.strftime('%d/%m')})",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "conflicting_dates": [d.strftime("%d/%m/%Y") for d in conflicting_vac_dates]
                        },
                        "proposed_changes": {
                            "task_id": str(task.id),
                            "workers": workers,
                            "worker_hours": w_hours_map,
                            "start_date": str(target_start),
                            "end_date": str(target_end),
                            "shift_working_days": shift_days,
                            "custom_dates": shifted_custom_dates
                        },
                        "cascade_impact": {
                            "same_project_tasks": cascade["affected_successors"],
                            "other_projects": cross_proj_impact,
                            "project_deadline_status": "safe",
                            "deadline_message": f"Tutte le fasi a valle rimangono entro la scadenza finale ({proj_end_date.strftime('%d/%m/%Y')})."
                        }
                    })
                    sync_timeline_with_proposal(task, target_start, target_end, cascade, cross_proj_impact)

                    # Se esiste anche un collega alternativo, offriamo l'opzione secondaria per mantenere le date fisse
                    if alt_worker:
                        new_workers = [alt_worker["worker_name"] if cur == w else cur for cur in workers]
                        new_w_hours = dict(w_hours_map)
                        if w in new_w_hours:
                            new_w_hours[alt_worker["worker_name"]] = new_w_hours.pop(w)

                        alt_sugg_id = f"vac_reassign_alt_{task.id}_{w_uid}_{conflicting_vac_dates[0].strftime('%Y%m%d')}"
                        suggestions.append({
                            "id": alt_sugg_id,
                            "type": "vacation_conflict",
                            "severity": "low",
                            "title": f"Opzione Alternativa: Riassegna a {alt_worker['worker_name']}",
                            "description": f"Se si preferisce mantenere le date fisse senza far slittare la lavorazione al rientro di {w}, la fase può essere affidata al collega {alt_worker['worker_name']}.",
                            "task_id": str(task.id),
                            "task_name": task.text,
                            "strategy": "reassign_worker",
                            "strategy_label": "Riassegnazione a Risorsa Alternativa",
                            "badge": "Opzione Alternativa",
                            "is_alternative": True,
                            "action_label": f"Riassegna a {alt_worker['worker_name']} (date invariate)",
                            "current_state": {
                                "workers": workers,
                                "start_date": str(task.start_date),
                                "end_date": str(task.end_date),
                                "conflicting_dates": [d.strftime("%d/%m/%Y") for d in conflicting_vac_dates]
                            },
                            "proposed_changes": {
                                "task_id": str(task.id),
                                "workers": new_workers,
                                "worker_hours": new_w_hours,
                                "start_date": str(task.start_date),
                                "end_date": str(task.end_date),
                                "shift_working_days": 0
                            },
                            "cascade_impact": {
                                "same_project_tasks": [],
                                "other_projects": [
                                    {
                                        "worker": alt_worker["worker_name"],
                                        "status": "safe",
                                        "message": f"{alt_worker['worker_name']} ha capienza libera (~{alt_worker['min_daily_free_hours']}h/gg) per coprire la fase."
                                    }
                                ],
                                "project_deadline_status": "safe",
                                "deadline_message": f"Scadenza commessa ({proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}) rispettata."
                            }
                        })
                elif alt_worker:
                    # PRIORITÀ 2 (FALLBACK): Far recuperare l'addetto stesso violerebbe la scadenza di commessa.
                    # Per salvare la consegna finale senza sforare, riassegniamo la fase ad un collega disponibile.
                    new_workers = [alt_worker["worker_name"] if cur == w else cur for cur in workers]
                    new_w_hours = dict(w_hours_map)
                    if w in new_w_hours:
                        new_w_hours[alt_worker["worker_name"]] = new_w_hours.pop(w)

                    sugg_id = f"vac_reassign_{task.id}_{w_uid}_{conflicting_vac_dates[0].strftime('%Y%m%d')}"
                    suggestions.append({
                        "id": sugg_id,
                        "type": "vacation_conflict",
                        "severity": "high",
                        "title": f"Salva Scadenza per Ferie: {w} → {alt_worker['worker_name']}",
                        "description": f"Lo slittamento al rientro di {w} violerebbe la scadenza commessa ({proj_end_date.strftime('%d/%m/%Y')}). Per salvare la consegna, la fase viene riassegnata a {alt_worker['worker_name']} a parità di date.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "reassign_worker",
                        "strategy_label": "Riassegnazione per Salvaguardia Consegna",
                        "badge": "Salva Scadenza",
                        "is_alternative": False,
                        "action_label": f"Riassegna a {alt_worker['worker_name']} (senza variare le date)",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "conflicting_dates": [d.strftime("%d/%m/%Y") for d in conflicting_vac_dates]
                        },
                        "proposed_changes": {
                            "task_id": str(task.id),
                            "workers": new_workers,
                            "worker_hours": new_w_hours,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "shift_working_days": 0
                        },
                        "cascade_impact": {
                            "same_project_tasks": [],
                            "other_projects": [
                                {
                                    "worker": alt_worker["worker_name"],
                                    "status": "safe",
                                    "message": f"Nessun sovraccarico generato: {alt_worker['worker_name']} ha circa {alt_worker['min_daily_free_hours']}h/gg libere nel periodo."
                                }
                            ],
                            "project_deadline_status": "safe",
                            "deadline_message": f"Scadenza commessa ({proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}) pienamente rispettata."
                        }
                    })
                else:
                    # PRIORITÀ 3: Allarme Ultima Spiaggia (violazione scadenza e nessun collega disponibile)
                    sugg_id = f"vac_crit_{task.id}_{w_uid}"
                    suggestions.append({
                        "id": sugg_id,
                        "type": "deadline_breach_risk",
                        "severity": "critical",
                        "title": f"Rischio Consegna per Ferie: {w}",
                        "description": f"Le ferie di {w} e l'assenza di sostituti impediscono di completare la fase in tempo. Lo slittamento violerebbe la consegna del {proj_end_date.strftime('%d/%m/%Y')}.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "manual_action_required",
                        "strategy_label": "Intervento Manuale Necessario",
                        "badge": "Rischio Scadenza",
                        "is_alternative": False,
                        "action_label": "Richiede estensione manuale data consegna o risorsa esterna",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date)
                        },
                        "proposed_changes": None,
                        "cascade_impact": {
                            "same_project_tasks": cascade["affected_successors"] if cascade else [],
                            "other_projects": [],
                            "project_deadline_status": "breached",
                            "deadline_message": f"Attenzione: Lo slittamento supererebbe la consegna finale del {proj_end_date.strftime('%d/%m/%Y')}. È richiesta una modifica manuale della commessa."
                        }
                    })

        # -------------------------------------------------------------
        # 2. ANALISI SOVRACCARICO MULTI-COMMESSA (> 8h/giorno)
        # -------------------------------------------------------------
        for w in workers:
            w_hours_in_timeline = worker_daily_hours.get(w, {})
            w_user = user_by_name.get(w.strip().lower())
            w_uid = str(w_user.id) if w_user else None
            overload_dates = []
            max_overload_val = 0.0

            c = task.start_date
            while c <= task.end_date:
                if not is_weekend_or_holiday(c) and c >= today:
                    entries = w_hours_in_timeline.get(c, [])
                    tot_day_h = sum(e["daily_hours"] for e in entries)
                    if tot_day_h > MAX_DAILY_HOURS:
                        overload_dates.append((c, tot_day_h))
                        if tot_day_h > max_overload_val:
                            max_overload_val = tot_day_h
                c += timedelta(days=1)

            if overload_dates:
                # Identifica se il sovraccarico è causato da altri task o se è dovuto solo a successori a valle
                downstream_ids = get_all_downstream_task_ids(str(task.id), context)
                genuine_overload_dates = []
                for c_date, tot_day_h in overload_dates:
                    other_entries = [
                        e for e in w_hours_in_timeline.get(c_date, [])
                        if e.get("task_id") != str(task.id) and e.get("task_id") not in downstream_ids
                    ]
                    if other_entries:
                        other_tot = sum(e["daily_hours"] for e in other_entries)
                        task_entry_h = sum(e["daily_hours"] for e in w_hours_in_timeline.get(c_date, []) if e.get("task_id") == str(task.id))
                        if other_tot + task_entry_h > MAX_DAILY_HOURS:
                            genuine_overload_dates.append((c_date, other_tot + task_entry_h))

                if not genuine_overload_dates:
                    # Il sovraccarico su questo task è dovuto unicamente a fasi successive che lo precedono indebitamente;
                    # la correzione spetta alle fasi successive
                    continue

                assigned_h = w_hours_map.get(w, planned_h / len(workers))
                daily_h_needed = assigned_h / max(1, duration_days)

                min_from_pred = get_earliest_start_from_predecessors(str(task.id), context, today)
                earliest_possible_start = max(today, min_from_pred) if min_from_pred else max(today, task.start_date)

                # PRIORITÀ 1 (PREFERITA): Risolvere il sovraccarico mantenendo lo STESSO ADDETTO (senza riassegnare ore) in modo OLISTICO
                same_worker_res = find_available_window_for_worker(
                    task=task,
                    worker_name=w,
                    worker_user_id=w_uid,
                    duration_days=duration_days,
                    daily_h_needed=daily_h_needed,
                    earliest_start=earliest_possible_start,
                    proj_end_date=proj_end_date,
                    context=context,
                    downstream_task_ids=downstream_ids
                )

                target_start = None
                target_end = None
                cascade = None
                if same_worker_res:
                    target_start, target_end, cascade = same_worker_res

                alt_worker = find_alternative_worker(
                    users, w, task.start_date, task.end_date, daily_h_needed, context,
                    department_filter=task.department or (w_user.department if w_user else None)
                )

                if same_worker_res and cascade and target_start and target_end and not cascade["exceeds_project_deadline"]:
                    shift_days = get_working_days_count(task.start_date, target_start) - 1
                    sugg_id = f"overload_shift_{task.id}_{w}_{target_start.strftime('%Y%m%d')}"

                    cross_proj_impact = detect_cross_project_impact(
                        workers, target_start, target_end, project_id, context,
                        needed_daily_h=daily_h_needed,
                        downstream_tasks=cascade["affected_successors"]
                    )

                    suggestions.append({
                        "id": sugg_id,
                        "type": "overload_conflict",
                        "severity": "medium",
                        "title": f"Riprogrammazione Sovraccarico: {w}",
                        "description": f"L'addetto {w} ha un picco di {round(max_overload_val, 1)}h/gg. Come preferito, il sovraccarico viene risolto mantenendo {w} senza riassegnare ore ad altri colleghi, riprogrammando la fase nella prima finestra libera ({target_start.strftime('%d/%m')} → {target_end.strftime('%d/%m')}). Consegna commessa rispettata.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "internal_shift",
                        "strategy_label": "Riprogrammazione su Stesso Addetto",
                        "badge": "Rebalance Carichi",
                        "is_alternative": False,
                        "action_label": f"Riprogramma fase su {w} ({target_start.strftime('%d/%m')} → {target_end.strftime('%d/%m')})",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "peak_hours": round(max_overload_val, 1),
                            "overload_days_count": len(genuine_overload_dates)
                        },
                        "proposed_changes": {
                            "task_id": str(task.id),
                            "workers": workers,
                            "worker_hours": w_hours_map,
                            "start_date": str(target_start),
                            "end_date": str(target_end),
                            "shift_working_days": max(0, shift_days)
                        },
                        "cascade_impact": {
                            "same_project_tasks": cascade["affected_successors"],
                            "other_projects": cross_proj_impact,
                            "project_deadline_status": "safe",
                            "deadline_message": f"Scadenza commessa ({proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}) pienamente rispettata."
                        }
                    })
                    sync_timeline_with_proposal(task, target_start, target_end, cascade, cross_proj_impact)

                    # Opzione alternativa secondaria: riassegnare a collega alternativo per mantenere le date attuali fisse
                    if alt_worker:
                        new_workers = [alt_worker["worker_name"] if cur == w else cur for cur in workers]
                        new_w_hours = dict(w_hours_map)
                        if w in new_w_hours:
                            new_w_hours[alt_worker["worker_name"]] = new_w_hours.pop(w)

                        alt_sugg_id = f"overload_reassign_alt_{task.id}_{w}_{genuine_overload_dates[0][0].strftime('%Y%m%d')}"
                        suggestions.append({
                            "id": alt_sugg_id,
                            "type": "overload_conflict",
                            "severity": "low",
                            "title": f"Opzione Alternativa: Riassegna a {alt_worker['worker_name']}",
                            "description": f"Se si preferisce mantenere le date attuali senza far slittare la fase, è possibile affidarla al collega {alt_worker['worker_name']} che ha disponibilità nel periodo.",
                            "task_id": str(task.id),
                            "task_name": task.text,
                            "strategy": "reassign_worker",
                            "strategy_label": "Riassegnazione a Risorsa Alternativa",
                            "badge": "Opzione Alternativa",
                            "is_alternative": True,
                            "action_label": f"Riassegna a {alt_worker['worker_name']} (date invariate)",
                            "current_state": {
                                "workers": workers,
                                "start_date": str(task.start_date),
                                "end_date": str(task.end_date),
                                "peak_hours": round(max_overload_val, 1),
                                "overload_days_count": len(genuine_overload_dates)
                            },
                            "proposed_changes": {
                                "task_id": str(task.id),
                                "workers": new_workers,
                                "worker_hours": new_w_hours,
                                "start_date": str(task.start_date),
                                "end_date": str(task.end_date),
                                "shift_working_days": 0
                            },
                            "cascade_impact": {
                                "same_project_tasks": [],
                                "other_projects": [
                                    {
                                        "worker": alt_worker["worker_name"],
                                        "status": "safe",
                                        "message": f"{alt_worker['worker_name']} accoglie il task rimanendo entro il limite di 8h giornaliere."
                                    }
                                ],
                                "project_deadline_status": "safe",
                                "deadline_message": "Date della commessa invariate al 100%."
                            }
                        })

                elif alt_worker:
                    # PRIORITÀ 2 (FALLBACK): Riprogrammare lo stesso addetto violerebbe la scadenza commessa.
                    # Riassegniamo ad un collega per salvare la data di consegna.
                    new_workers = [alt_worker["worker_name"] if cur == w else cur for cur in workers]
                    new_w_hours = dict(w_hours_map)
                    if w in new_w_hours:
                        new_w_hours[alt_worker["worker_name"]] = new_w_hours.pop(w)

                    sugg_id = f"overload_reassign_{task.id}_{w}_{genuine_overload_dates[0][0].strftime('%Y%m%d')}"
                    suggestions.append({
                        "id": sugg_id,
                        "type": "overload_conflict",
                        "severity": "high",
                        "title": f"Salva Scadenza per Sovraccarico: {w} → {alt_worker['worker_name']}",
                        "description": f"Riprogrammare {w} oltre la data prevista supererebbe la consegna finale del {proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}. Per proteggere la scadenza, la fase viene affidata al collega {alt_worker['worker_name']}.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "reassign_worker",
                        "strategy_label": "Riassegnazione per Salvaguardia Consegna",
                        "badge": "Salva Scadenza",
                        "is_alternative": False,
                        "action_label": f"Riassegna a {alt_worker['worker_name']} per rispettare la consegna finale",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "peak_hours": round(max_overload_val, 1),
                            "overload_days_count": len(genuine_overload_dates)
                        },
                        "proposed_changes": {
                            "task_id": str(task.id),
                            "workers": new_workers,
                            "worker_hours": new_w_hours,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "shift_working_days": 0
                        },
                        "cascade_impact": {
                            "same_project_tasks": [],
                            "other_projects": [
                                {
                                    "worker": w,
                                    "status": "relieved",
                                    "message": f"Il carico di {w} scende a livelli sostenibili (<= 8h/gg) sulle altre commesse."
                                },
                                {
                                    "worker": alt_worker["worker_name"],
                                    "status": "safe",
                                    "message": f"{alt_worker['worker_name']} accoglie il task rimanendo entro il limite di 8h giornaliere."
                                }
                            ],
                            "project_deadline_status": "safe",
                            "deadline_message": f"Scadenza commessa ({proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}) pienamente rispettata."
                        }
                    })

                else:
                    # PRIORITÀ 3: Impossibile risolvere mantenendo l'addetto senza violare la consegna, e nessun collega disponibile
                    sugg_id = f"overload_crit_{task.id}_{w}"
                    suggestions.append({
                        "id": sugg_id,
                        "type": "deadline_breach_risk",
                        "severity": "critical",
                        "title": f"Rischio Consegna per Sovraccarico: {w}",
                        "description": f"L'addetto {w} è sovraccarico ({round(max_overload_val, 1)}h/gg) e spostare la lavorazione sfora la consegna del {proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}. Nessun collega disponibile.",
                        "task_id": str(task.id),
                        "task_name": task.text,
                        "strategy": "manual_action_required",
                        "strategy_label": "Intervento Manuale Necessario",
                        "badge": "Rischio Scadenza",
                        "is_alternative": False,
                        "action_label": "Richiede estensione manuale data consegna o risorsa esterna",
                        "current_state": {
                            "workers": workers,
                            "start_date": str(task.start_date),
                            "end_date": str(task.end_date),
                            "peak_hours": round(max_overload_val, 1),
                            "overload_days_count": len(genuine_overload_dates)
                        },
                        "proposed_changes": None,
                        "cascade_impact": {
                            "same_project_tasks": cascade["affected_successors"] if cascade else [],
                            "other_projects": [],
                            "project_deadline_status": "breached",
                            "deadline_message": f"Attenzione: Lo slittamento supererebbe la consegna finale del {proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'}."
                        }
                    })

        # -------------------------------------------------------------
        # 3. ANALISI FASE SCADUTA O RITARDO ACCUMULATO
        # -------------------------------------------------------------
        if task.end_date < today and tot_actual_h < planned_h:
            # Se la fase ha un predecessore incompleto (link FS) che è anch'esso scaduto o non completato,
            # il ritardo di questa fase è causato a catena dal predecessore.
            # La riprogrammazione del predecessore include già a cascata questa fase con le date corrette.
            # Non generiamo un suggerimento autonomo e contraddittorio che pretenderebbe di far partire
            # questa fase oggi prima che il suo predecessore sia terminato.
            has_uncompleted_pred = False
            incoming_links = context.get("links_by_target", {}).get(str(task.id), [])
            for link in incoming_links:
                link_type = link.type.value if hasattr(link.type, 'value') else str(link.type)
                if link_type == "0":  # FS
                    pred = context.get("all_tasks_by_id", {}).get(str(link.source))
                    if pred and pred.completed != 1 and pred.end_date < today:
                        has_uncompleted_pred = True
                        break
            if has_uncompleted_pred:
                continue

            days_late = get_working_days_count(task.end_date, today) - 1
            needed_days = max(1, math.ceil((planned_h - tot_actual_h) / max(1.0, (planned_h / max(1, duration_days)))))
            
            min_from_pred = get_earliest_start_from_predecessors(str(task.id), context, today)
            target_start = max(today, min_from_pred) if min_from_pred else today
            target_end = add_working_days(target_start, needed_days - 1)

            cascade = calculate_cascade_impact(task, target_start, target_end, proj_end_date, context)
            sugg_id = f"expired_recovery_{task.id}_{today.strftime('%Y%m%d')}"

            if not cascade["exceeds_project_deadline"]:
                remaining_h = max(1.0, planned_h - tot_actual_h)
                daily_needed_h = remaining_h / max(1, len(workers) * needed_days)
                cross_proj_impact = detect_cross_project_impact(
                    workers, target_start, target_end, project_id, context,
                    needed_daily_h=daily_needed_h,
                    downstream_tasks=cascade["affected_successors"]
                )
                suggestions.append({
                    "id": sugg_id,
                    "type": "delay_conflict",
                    "severity": "high",
                    "title": f"Recupero Fase Scaduta: '{task.text}'",
                    "description": f"La fase è scaduta il {task.end_date.strftime('%d/%m/%Y')} ma mancano ancora {round(planned_h - tot_actual_h, 1)}h al completamento.",
                    "task_id": str(task.id),
                    "task_name": task.text,
                    "strategy": "internal_shift",
                    "strategy_label": "Riprogrammazione da Oggi",
                    "badge": "Recupero Ritardo",
                    "is_alternative": False,
                    "action_label": f"Riprogramma dal {target_start.strftime('%d/%m')} al {target_end.strftime('%d/%m')}",
                    "current_state": {
                        "workers": workers,
                        "start_date": str(task.start_date),
                        "end_date": str(task.end_date),
                        "actual_hours": tot_actual_h,
                        "planned_hours": planned_h
                    },
                    "proposed_changes": {
                        "task_id": str(task.id),
                        "workers": workers,
                        "worker_hours": w_hours_map,
                        "start_date": str(target_start),
                        "end_date": str(target_end),
                        "shift_working_days": days_late
                    },
                    "cascade_impact": {
                        "same_project_tasks": cascade["affected_successors"],
                        "other_projects": cross_proj_impact,
                        "project_deadline_status": "safe",
                        "deadline_message": f"Tutte le fasi a valle rientrano entro la consegna finale ({proj_end_date.strftime('%d/%m/%Y') if proj_end_date else 'N.D.'})."
                    }
                })
                sync_timeline_with_proposal(task, target_start, target_end, cascade, cross_proj_impact)
            else:
                suggestions.append({
                    "id": sugg_id,
                    "type": "deadline_breach_risk",
                    "severity": "critical",
                    "title": f"Rischio Consegna: Fase '{task.text}'",
                    "description": f"La fase scaduta richiede almeno {needed_days} gg lavorativi per essere completata; l'effetto a cascata supererebbe la consegna finale del {proj_end_date.strftime('%d/%m/%Y')}.",
                    "task_id": str(task.id),
                    "task_name": task.text,
                    "strategy": "manual_action_required",
                    "strategy_label": "Intervento Manuale Necessario",
                    "badge": "Rischio Scadenza",
                    "is_alternative": False,
                    "action_label": "Richiede estensione data commessa o aumento risorse",
                    "current_state": {
                        "workers": workers,
                        "start_date": str(task.start_date),
                        "end_date": str(task.end_date)
                    },
                    "proposed_changes": None,
                    "cascade_impact": {
                        "same_project_tasks": cascade["affected_successors"],
                        "other_projects": [],
                        "project_deadline_status": "breached",
                        "deadline_message": f"Il percorso critico slitta al {cascade['max_reach_date']}, oltre la scadenza del {proj_end_date.strftime('%d/%m/%Y')}."
                    }
                })

    # Estrai cronologia delle modifiche applicate su questa commessa
    log_res = await db.execute(
        select(ReplanLog)
        .options(
            selectinload(ReplanLog.task),
            selectinload(ReplanLog.reverted_by_user),
            selectinload(ReplanLog.cascade_logs).selectinload(ReplanLog.task)
        )
        .where(
            ReplanLog.project_id == project_id,
            ReplanLog.parent_log_id.is_(None)
        )
        .order_by(desc(ReplanLog.created_at))
        .limit(30)
    )
    history_logs = []
    for log in log_res.scalars().all():
        cascade_items = []
        if getattr(log, "cascade_logs", None):
            for cl in log.cascade_logs:
                cascade_items.append({
                    "id": str(cl.id),
                    "task_id": str(cl.task_id) if cl.task_id else None,
                    "task_name": cl.task.text if cl.task else "Fase a valle",
                    "shift_days": cl.shift_days,
                    "reverted": cl.reverted
                })

        history_logs.append({
            "id": str(log.id),
            "parent_log_id": str(log.parent_log_id) if getattr(log, "parent_log_id", None) else None,
            "action_type": log.action_type.value,
            "task_id": str(log.task_id) if log.task_id else None,
            "task_name": log.task.text if log.task else "Piano Consigliato",
            "worker_name": log.worker_name,
            "reason": log.reason,
            "old_start_date": log.old_start_date.isoformat() if log.old_start_date else None,
            "old_end_date": log.old_end_date.isoformat() if log.old_end_date else None,
            "new_start_date": log.new_start_date.isoformat() if log.new_start_date else None,
            "new_end_date": log.new_end_date.isoformat() if log.new_end_date else None,
            "shift_days": log.shift_days,
            "reverted": log.reverted,
            "created_at": to_utc_iso(log.created_at),
            "reverted_at": to_utc_iso(log.reverted_at),
            "reverted_by_name": log.reverted_by_user.full_name if log.reverted_by_user else None,
            "cascade_logs": cascade_items,
            "cascade_count": len(cascade_items)
        })

    # Estrai commesse correlate impattate dalle proposte
    related_proj_ids = set()
    for s in suggestions:
        for op in s.get("cascade_impact", {}).get("other_projects", []):
            if op.get("project_id"):
                related_proj_ids.add(str(op["project_id"]))

    related_projects: Dict[str, Dict[str, Any]] = {}
    if related_proj_ids:
        rel_tasks_res = await db.execute(
            select(Task)
            .where(Task.project_id.in_(list(related_proj_ids)))
            .where(Task.type != TaskType.PROJECT)
            .where(Task.type != TaskType.MILESTONE)
            .order_by(Task.sort_order, Task.start_date)
        )
        rel_tasks = rel_tasks_res.scalars().all()
        rel_tasks_by_proj: Dict[str, List[Dict[str, Any]]] = {}
        for rt in rel_tasks:
            rel_tasks_by_proj.setdefault(str(rt.project_id), []).append({
                "id": str(rt.id),
                "text": rt.text,
                "start_date": rt.start_date.isoformat() if rt.start_date else None,
                "end_date": rt.end_date.isoformat() if rt.end_date else None,
                "duration": rt.duration,
                "progress": rt.progress or 0.0,
                "workers": parse_workers_list(rt.workers),
                "worker_hours": parse_worker_hours_map(rt.worker_hours),
                "planned_hours": rt.planned_hours or 0.0,
                "actual_hours": parse_actual_hours_map(rt.actual_hours),
                "department": rt.department,
                "completed": rt.completed or 0
            })

        rel_links_res = await db.execute(
            select(Link).where(Link.project_id.in_(list(related_proj_ids)))
        )
        rel_links = rel_links_res.scalars().all()
        rel_links_by_proj: Dict[str, List[Dict[str, Any]]] = {}
        for rl in rel_links:
            rel_links_by_proj.setdefault(str(rl.project_id), []).append({
                "id": str(rl.id),
                "source": str(rl.source),
                "target": str(rl.target),
                "type": rl.type.value if hasattr(rl.type, 'value') else str(rl.type),
                "lag": rl.lag or 0
            })

        for r_pid in related_proj_ids:
            proj_obj = context["active_projects"].get(r_pid)
            if proj_obj:
                related_projects[r_pid] = {
                    "project_id": str(proj_obj.id),
                    "project_name": proj_obj.name,
                    "project_code": proj_obj.code or "",
                    "project_start_date": proj_obj.start_date.isoformat() if proj_obj.start_date else None,
                    "project_end_date": proj_obj.end_date.isoformat() if proj_obj.end_date else None,
                    "color": proj_obj.color or "#2563eb",
                    "client": proj_obj.client or "",
                    "tasks": rel_tasks_by_proj.get(r_pid, []),
                    "links": rel_links_by_proj.get(r_pid, [])
                }

    return {
        "project_id": str(target_project.id),
        "project_name": target_project.name,
        "project_code": target_project.code or "",
        "project_start_date": str(proj_start_date) if proj_start_date else None,
        "project_end_date": str(proj_end_date) if proj_end_date else None,
        "conflicts_count": len(suggestions),
        "actionable_suggestions_count": len([s for s in suggestions if s.get("proposed_changes")]),
        "suggestions": suggestions,
        "related_projects": related_projects,
        "history": history_logs
    }


async def apply_smart_replanning_proposal(
    db: AsyncSession,
    project_id: str,
    proposal_payload: Dict[str, Any],
    current_user: User,
    parent_batch_log_id: Optional[str] = None,
    task_snapshots: Optional[Dict[str, Dict[str, Any]]] = None,
    commit_on_finish: bool = True
) -> Dict[str, Any]:
    """
    Applica transazionalmente le modifiche proposte da un suggerimento approvato:
    1. Aggiorna il task principale (date e/o addetti e/o ore).
    2. Aggiorna a cascata i successori diretti inclusi nella proposta.
    3. Salva la voce di audit in ReplanLog con reverted=False.
    """
    task_id = proposal_payload.get("task_id")
    if not task_id:
        raise ValueError("Parametro task_id mancante.")

    task_res = await db.execute(select(Task).where(Task.id == task_id))
    task = task_res.scalar_one_or_none()
    if not task:
        raise ValueError("Task non trovato.")

    effective_parent_id = parent_batch_log_id or None

    # Snapshot dello stato ante-modifica per prevenire corruzioni da modifiche cumulative successive
    if task_snapshots is not None:
        t_key = str(task.id)
        if t_key not in task_snapshots:
            task_snapshots[t_key] = {
                "start_date": task.start_date,
                "end_date": task.end_date,
                "workers": task.workers,
                "worker_hours": getattr(task, "worker_hours", None),
                "custom_dates": getattr(task, "custom_dates", None)
            }
        snap = task_snapshots[t_key]
        old_start = snap["start_date"]
        old_end = snap["end_date"]
        old_workers = snap["workers"]
        old_worker_hours = snap["worker_hours"]
        old_custom_dates = snap.get("custom_dates")
    else:
        old_start = task.start_date
        old_end = task.end_date
        old_workers = task.workers
        old_worker_hours = getattr(task, "worker_hours", None)
        old_custom_dates = getattr(task, "custom_dates", None)

    # 1. Aggiorna date se fornite
    new_start_str = proposal_payload.get("start_date")
    new_end_str = proposal_payload.get("end_date")
    if new_start_str:
        task.start_date = datetime.strptime(new_start_str[:10], "%Y-%m-%d").date()
    if new_end_str:
        task.end_date = datetime.strptime(new_end_str[:10], "%Y-%m-%d").date()

    # Ricalcola durata
    if task.start_date and task.end_date:
        task.duration = get_working_days_count(task.start_date, task.end_date)

    # Se la fase ha modalità custom_dates, aggiorna le singole date spostate
    shift_days = int(proposal_payload.get("shift_working_days", 0))
    if task.budget_mode == "custom_dates":
        new_c_dates = proposal_payload.get("custom_dates")
        if new_c_dates:
            task.custom_dates = json.dumps(new_c_dates) if isinstance(new_c_dates, list) else str(new_c_dates)
        elif shift_days > 0 and task.custom_dates:
            c_items = parse_custom_dates(task.custom_dates)
            shifted_c, sc_s, sc_e = shift_custom_dates(c_items, shift_days)
            task.custom_dates = json.dumps(shifted_c)
            if sc_s:
                task.start_date = sc_s
            if sc_e:
                task.end_date = sc_e

    # 2. Aggiorna addetti e ore addetto se forniti
    new_workers = proposal_payload.get("workers")
    if new_workers is not None:
        task.workers = json.dumps(new_workers) if isinstance(new_workers, list) else str(new_workers)
    
    new_w_hours = proposal_payload.get("worker_hours")
    if new_w_hours is not None:
        task.worker_hours = json.dumps(new_w_hours) if isinstance(new_w_hours, dict) else str(new_w_hours)

    # Determina l'azione di log
    action_type = ReplanActionType.SHIFT_OVERLOAD
    if proposal_payload.get("workers") != json.loads(old_workers or "[]"):
        action_type = ReplanActionType.SHIFT_CONFLICT
    elif shift_days > 0:
        action_type = ReplanActionType.SHIFT_DELAY

    # 3. Salva in ReplanLog
    log_entry = ReplanLog(
        id=str(uuid4()),
        parent_log_id=effective_parent_id,
        action_type=action_type,
        task_id=task.id,
        project_id=project_id,
        worker_name=", ".join(new_workers) if new_workers else None,
        reason=proposal_payload.get("reason", "Ottimizzazione intelligente applicata"),
        old_start_date=old_start,
        old_end_date=old_end,
        new_start_date=task.start_date,
        new_end_date=task.end_date,
        old_workers=old_workers,
        old_worker_hours=old_worker_hours,
        old_custom_dates=old_custom_dates,
        shift_days=shift_days,
        reverted=False
    )
    db.add(log_entry)

    # 4. Aggiorna a cascata i successori inclusi (inclusi ricorsivamente i sub_successors)
    def flatten_cascade_successors(succ_list):
        result = []
        for s in succ_list:
            result.append(s)
            if s.get("sub_successors"):
                result.extend(flatten_cascade_successors(s["sub_successors"]))
        return result

    raw_cascades = proposal_payload.get("cascade_successors", [])
    cascade_successors = flatten_cascade_successors(raw_cascades)

    for succ_data in cascade_successors:
        s_id = succ_data.get("task_id")
        s_start_str = succ_data.get("proposed_start")
        s_end_str = succ_data.get("proposed_end")
        if s_id and s_start_str and s_end_str:
            s_res = await db.execute(select(Task).where(Task.id == s_id))
            s_task = s_res.scalar_one_or_none()
            if s_task:
                if task_snapshots is not None:
                    st_key = str(s_task.id)
                    if st_key not in task_snapshots:
                        task_snapshots[st_key] = {
                            "start_date": s_task.start_date,
                            "end_date": s_task.end_date,
                            "workers": s_task.workers,
                            "worker_hours": getattr(s_task, "worker_hours", None),
                            "custom_dates": getattr(s_task, "custom_dates", None)
                        }
                    s_snap = task_snapshots[st_key]
                    s_old_start = s_snap["start_date"]
                    s_old_end = s_snap["end_date"]
                    s_old_workers = s_snap["workers"]
                    s_old_worker_hours = s_snap["worker_hours"]
                    s_old_custom_dates = s_snap.get("custom_dates")
                else:
                    s_old_start = s_task.start_date
                    s_old_end = s_task.end_date
                    s_old_workers = s_task.workers
                    s_old_worker_hours = getattr(s_task, "worker_hours", None)
                    s_old_custom_dates = getattr(s_task, "custom_dates", None)

                s_task.start_date = datetime.strptime(s_start_str[:10], "%Y-%m-%d").date()
                s_task.end_date = datetime.strptime(s_end_str[:10], "%Y-%m-%d").date()
                s_task.duration = get_working_days_count(s_task.start_date, s_task.end_date)

                succ_shift = int(succ_data.get("shift_working_days", 0))
                if s_task.budget_mode == "custom_dates":
                    succ_c_dates = succ_data.get("custom_dates")
                    if succ_c_dates:
                        s_task.custom_dates = json.dumps(succ_c_dates) if isinstance(succ_c_dates, list) else str(succ_c_dates)
                    elif succ_shift > 0 and s_task.custom_dates:
                        c_items = parse_custom_dates(s_task.custom_dates)
                        shifted_c, sc_s, sc_e = shift_custom_dates(c_items, succ_shift)
                        s_task.custom_dates = json.dumps(shifted_c)
                        if sc_s:
                            s_task.start_date = sc_s
                        if sc_e:
                            s_task.end_date = sc_e

                # Log successore collegato al log principale genitore o al batch
                s_log = ReplanLog(
                    id=str(uuid4()),
                    parent_log_id=effective_parent_id or log_entry.id,
                    action_type=ReplanActionType.SHIFT_CASCADE,
                    task_id=s_task.id,
                    project_id=project_id,
                    worker_name=s_task.workers,
                    reason=f"Slittamento a cascata dipendente da '{task.text}'",
                    old_start_date=s_old_start,
                    old_end_date=s_old_end,
                    new_start_date=s_task.start_date,
                    new_end_date=s_task.end_date,
                    old_workers=s_old_workers,
                    old_worker_hours=s_old_worker_hours,
                    old_custom_dates=s_old_custom_dates,
                    shift_days=succ_shift,
                    reverted=False
                )
                db.add(s_log)

    # 5. Aggiorna le correzioni a catena su commesse correlate
    related_corrections = proposal_payload.get("related_project_corrections", [])
    for rel_corr in related_corrections:
        r_id = rel_corr.get("task_id")
        r_start_str = rel_corr.get("proposed_start")
        r_end_str = rel_corr.get("proposed_end")
        if r_id and r_start_str and r_end_str:
            r_res = await db.execute(select(Task).where(Task.id == r_id))
            r_task = r_res.scalar_one_or_none()
            if r_task:
                if task_snapshots is not None:
                    rt_key = str(r_task.id)
                    if rt_key not in task_snapshots:
                        task_snapshots[rt_key] = {
                            "start_date": r_task.start_date,
                            "end_date": r_task.end_date,
                            "workers": r_task.workers,
                            "worker_hours": getattr(r_task, "worker_hours", None)
                        }
                    r_snap = task_snapshots[rt_key]
                    r_old_start = r_snap["start_date"]
                    r_old_end = r_snap["end_date"]
                    r_old_workers = r_snap["workers"]
                    r_old_worker_hours = r_snap["worker_hours"]
                else:
                    r_old_start = r_task.start_date
                    r_old_end = r_task.end_date
                    r_old_workers = r_task.workers
                    r_old_worker_hours = getattr(r_task, "worker_hours", None)

                r_task.start_date = datetime.strptime(r_start_str[:10], "%Y-%m-%d").date()
                r_task.end_date = datetime.strptime(r_end_str[:10], "%Y-%m-%d").date()
                r_task.duration = get_working_days_count(r_task.start_date, r_task.end_date)

                r_log = ReplanLog(
                    id=str(uuid4()),
                    parent_log_id=effective_parent_id or log_entry.id,
                    action_type=ReplanActionType.SHIFT_CASCADE,
                    task_id=r_task.id,
                    project_id=r_task.project_id,
                    worker_name=r_task.workers,
                    reason=f"Correzione a catena da '{task.text}': {rel_corr.get('summary', '')}",
                    old_start_date=r_old_start,
                    old_end_date=r_old_end,
                    new_start_date=r_task.start_date,
                    new_end_date=r_task.end_date,
                    old_workers=r_old_workers,
                    old_worker_hours=r_old_worker_hours,
                    shift_days=int(rel_corr.get("shift_working_days", 0)),
                    reverted=False
                )
                db.add(r_log)

                # Gestione eventuali sub-successori a cascata della commessa correlata
                for sub_s in rel_corr.get("cascade_tasks", []):
                    sub_id = sub_s.get("task_id")
                    sub_start_s = sub_s.get("proposed_start")
                    sub_end_s = sub_s.get("proposed_end")
                    if sub_id and sub_start_s and sub_end_s:
                        sub_res = await db.execute(select(Task).where(Task.id == sub_id))
                        sub_t = sub_res.scalar_one_or_none()
                        if sub_t:
                            if task_snapshots is not None:
                                sub_key = str(sub_t.id)
                                if sub_key not in task_snapshots:
                                    task_snapshots[sub_key] = {
                                        "start_date": sub_t.start_date,
                                        "end_date": sub_t.end_date,
                                        "workers": sub_t.workers,
                                        "worker_hours": getattr(sub_t, "worker_hours", None)
                                    }
                                sub_snap = task_snapshots[sub_key]
                                s_old_st = sub_snap["start_date"]
                                s_old_en = sub_snap["end_date"]
                                s_old_wk = sub_snap["workers"]
                                s_old_wh = sub_snap["worker_hours"]
                            else:
                                s_old_st = sub_t.start_date
                                s_old_en = sub_t.end_date
                                s_old_wk = sub_t.workers
                                s_old_wh = getattr(sub_t, "worker_hours", None)

                            sub_t.start_date = datetime.strptime(sub_start_s[:10], "%Y-%m-%d").date()
                            sub_t.end_date = datetime.strptime(sub_end_s[:10], "%Y-%m-%d").date()
                            sub_t.duration = get_working_days_count(sub_t.start_date, sub_t.end_date)

                            sub_l = ReplanLog(
                                id=str(uuid4()),
                                parent_log_id=effective_parent_id or log_entry.id,
                                action_type=ReplanActionType.SHIFT_CASCADE,
                                task_id=sub_t.id,
                                project_id=sub_t.project_id,
                                worker_name=sub_t.workers,
                                reason=f"Slittamento a catena secondario su '{sub_t.text}'",
                                old_start_date=s_old_st,
                                old_end_date=s_old_en,
                                new_start_date=sub_t.start_date,
                                new_end_date=sub_t.end_date,
                                old_workers=s_old_wk,
                                old_worker_hours=s_old_wh,
                                shift_days=int(sub_s.get("shift_working_days", 0)),
                                reverted=False
                            )
                            db.add(sub_l)

    if commit_on_finish:
        await db.commit()
        await db.refresh(task)

    return {
        "success": True,
        "message": f"Suggerimento per '{task.text}' applicato con successo.",
        "log_id": str(log_entry.id),
        "task": {
            "id": str(task.id),
            "start_date": task.start_date.isoformat() if task.start_date else None,
            "end_date": task.end_date.isoformat() if task.end_date else None,
            "workers": parse_workers_list(task.workers),
            "worker_hours": parse_worker_hours_map(task.worker_hours)
        }
    }


async def apply_smart_replanning_batch(
    db: AsyncSession,
    project_id: str,
    proposals: List[Dict[str, Any]],
    current_user: User
) -> Dict[str, Any]:
    """
    Applica atomicamente un intero piano consigliato multi-proposta:
    1. Effettua uno snapshot immutabile di tutti i task ante-modifica, così che nessun task
       possa registrare date intermedie sballate da modifiche cumulative successive.
    2. Crea un master log del batch (parent_log_id=None) a cui aggancia tutti i sotto-log.
    3. Rende l'intero piano reversibile al 100% con un singolo click in modo consistente.
    """
    if not proposals:
        return {"success": True, "message": "Nessuna proposta da applicare.", "results": []}

    batch_log_id = str(uuid4())
    batch_log = ReplanLog(
        id=batch_log_id,
        parent_log_id=None,
        action_type=ReplanActionType.SHIFT_DELAY,
        task_id=None,
        project_id=project_id,
        worker_name=None,
        reason=f"Piano Consigliato Combinato ({len(proposals)} azioni)",
        old_start_date=None,
        old_end_date=None,
        new_start_date=None,
        new_end_date=None,
        shift_days=0,
        reverted=False
    )
    db.add(batch_log)

    task_snapshots: Dict[str, Dict[str, Any]] = {}
    results = []

    for payload in proposals:
        res = await apply_smart_replanning_proposal(
            db=db,
            project_id=project_id,
            proposal_payload=payload,
            current_user=current_user,
            parent_batch_log_id=batch_log_id,
            task_snapshots=task_snapshots,
            commit_on_finish=False
        )
        results.append(res)

    await db.commit()

    return {
        "success": True,
        "batch_log_id": batch_log_id,
        "message": f"{len(proposals)} ottimizzazioni applicate con successo!",
        "results": results
    }


async def revert_smart_replanning_log(
    db: AsyncSession,
    log_id: str,
    current_user: User
) -> Dict[str, Any]:
    """
    Annulla una modifica precedentemente applicata ripristinando date e addetti
    registrati in ReplanLog, insieme a tutte le modifiche a cascata causate da tale operazione.
    """
    res = await db.execute(
        select(ReplanLog)
        .options(selectinload(ReplanLog.task))
        .where(ReplanLog.id == log_id)
    )
    log_entry = res.scalar_one_or_none()
    if not log_entry:
        raise ValueError("Voce di cronologia non trovata.")
    if log_entry.reverted:
        raise ValueError("Questa operazione è già stata annullata in precedenza.")

    # Se è stato selezionato un log a cascata figlio, risali al log genitore principale
    root_log = log_entry
    if log_entry.parent_log_id:
        p_res = await db.execute(
            select(ReplanLog)
            .options(selectinload(ReplanLog.task))
            .where(ReplanLog.id == log_entry.parent_log_id)
        )
        parent_log = p_res.scalar_one_or_none()
        if parent_log and not parent_log.reverted:
            root_log = parent_log

    now = datetime.now(timezone.utc)
    reverted_task_names = []

    # Helper per ripristinare un singolo log
    async def _revert_single_log(item: ReplanLog):
        if item.task_id and not item.reverted:
            t_res = await db.execute(select(Task).where(Task.id == item.task_id))
            task = t_res.scalar_one_or_none()
            if task:
                if item.old_start_date:
                    task.start_date = item.old_start_date
                if item.old_end_date:
                    task.end_date = item.old_end_date
                if task.start_date and task.end_date:
                    task.duration = get_working_days_count(task.start_date, task.end_date)
                if item.old_workers is not None:
                    task.workers = item.old_workers
                if hasattr(item, "old_worker_hours") and item.old_worker_hours is not None:
                    task.worker_hours = item.old_worker_hours
                if hasattr(item, "old_custom_dates") and item.old_custom_dates is not None:
                    task.custom_dates = item.old_custom_dates
                reverted_task_names.append(task.text)

        item.reverted = True
        item.reverted_at = now
        item.reverted_by = current_user.id

    # 1. Annulla il log principale
    await _revert_single_log(root_log)

    # 2. Trova e annulla TUTTI i log a cascata generati da root_log
    cascade_res = await db.execute(
        select(ReplanLog)
        .options(selectinload(ReplanLog.task))
        .where(
            ReplanLog.parent_log_id == root_log.id,
            ReplanLog.reverted == False
        )
    )
    cascade_logs = list(cascade_res.scalars().all())

    # Fallback compatibilità con log legacy (privi di parent_log_id)
    if not cascade_logs and root_log.created_at and root_log.task:
        time_start = root_log.created_at - timedelta(seconds=15)
        time_end = root_log.created_at + timedelta(seconds=15)
        legacy_res = await db.execute(
            select(ReplanLog)
            .options(selectinload(ReplanLog.task))
            .where(
                ReplanLog.action_type == ReplanActionType.SHIFT_CASCADE,
                ReplanLog.reverted == False,
                ReplanLog.created_at >= time_start,
                ReplanLog.created_at <= time_end
            )
        )
        for l in legacy_res.scalars().all():
            if root_log.task.text in (l.reason or ""):
                cascade_logs.append(l)

    cascade_count = 0
    for c_log in cascade_logs:
        await _revert_single_log(c_log)
        cascade_count += 1

    await db.commit()

    msg = "Operazione annullata con successo."
    if cascade_count > 0:
        msg = f"Operazione principale e {cascade_count} slittamenti a cascata annullati con successo."

    return {
        "success": True,
        "message": msg,
        "log_id": str(root_log.id),
        "cascade_reverted_count": cascade_count,
        "reverted_tasks": reverted_task_names
    }
