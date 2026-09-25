import json
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select
from app.core.dependencies import get_db, get_current_user
from app.models.user import User, UserRole
from app.models.vacation import Vacation
from app.models.task import Task
from app.models.project import Project
from app.models.notification import Notification, NotificationType

# pyrefly: ignore [missing-import]
from pydantic import BaseModel
from datetime import date
from app.utils.working_days import get_working_days_in_range

router = APIRouter(prefix="/api/vacations", tags=["vacations"])


from typing import Optional, Any
import asyncio

class VacationCreate(BaseModel):
    start_date: date
    end_date: date
    reason: Optional[str] = None


def _parse_json_list(val: Any) -> list:
    if not val:
        return []
    if isinstance(val, list):
        return val
    try:
        loaded = json.loads(val)
        return loaded if isinstance(loaded, list) else []
    except Exception:
        return []


def _parse_json_dict(val: Any) -> dict:
    if not val:
        return {}
    if isinstance(val, dict):
        return val
    try:
        loaded = json.loads(val)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _parse_json(val, default):
    if not val:
        return default
    if isinstance(val, (list, dict)):
        return val
    try:
        return json.loads(val)
    except Exception:
        return default


async def _compute_recovery_for_user(db: AsyncSession, user: User, vacation: Vacation) -> list:
    """
    For a given vacation period, find tasks assigned to the user that overlap,
    compute how many planned hours fall in the vacation working days,
    and return a list of recovery items.
    """
    vac_start = vacation.start_date
    vac_end = vacation.end_date

    # pyrefly: ignore [missing-import]
    from sqlalchemy.orm import joinedload
    # All tasks where user is in workers list
    tasks_res = await db.execute(select(Task).options(joinedload(Task.project)))
    all_tasks = tasks_res.scalars().all()

    username = str(user.username)
    recovery_items = []
    for task in all_tasks:
        if task.project:
            p_status = task.project.status.value if hasattr(task.project.status, 'value') else str(task.project.status)
            if p_status in ("completed", "archived", "ProjectStatus.COMPLETED", "ProjectStatus.ARCHIVED"):
                continue
        workers = _parse_json_list(task.workers)
        if username not in workers:
            continue
        if not task.start_date or not task.end_date:
            continue

        # Overlap between task period and vacation period
        overlap_start = max(task.start_date, vac_start)
        overlap_end = min(task.end_date, vac_end)
        if overlap_start > overlap_end:
            continue

        # Count working days in overlap
        overlap_days = get_working_days_in_range(overlap_start, overlap_end)
        if not overlap_days:
            continue

        # Total working days in the full task
        task_working_days = get_working_days_in_range(task.start_date, task.end_date)
        if not task_working_days:
            continue

        # Hours assigned to this worker
        worker_hours_map: dict = _parse_json_dict(task.worker_hours)
        if username in worker_hours_map and worker_hours_map[username] is not None:
            assigned_h = float(worker_hours_map[username])
        else:
            n_workers = len(workers) if workers else 1
            assigned_h = float(task.planned_hours or 8.0) / n_workers

        daily_h = assigned_h / len(task_working_days)
        hours_to_recover = round(daily_h * len(overlap_days), 1)

        if hours_to_recover <= 0:
            continue

        # Get project name
        proj_res = await db.execute(select(Project).where(Project.id == task.project_id))
        project = proj_res.scalar_one_or_none()

        recovery_items.append({
            "task_id": task.id,
            "task_name": task.text,
            "project_id": task.project_id,
            "project_name": project.name if project else "—",
            "project_code": project.code if project else "—",
            "hours_to_recover": hours_to_recover,
            "vacation_days": [str(d) for d in overlap_days],
            "vacation_start": str(vac_start),
            "vacation_end": str(vac_end),
        })

    return recovery_items


@router.get("/me", response_model=list)
async def list_my_vacations(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(select(Vacation).where(Vacation.user_id == current_user.id).order_by(Vacation.start_date.desc()))
    vacations = result.scalars().all()
    return [
        {
            "id": v.id,
            "user_id": v.user_id,
            "start_date": str(v.start_date),
            "end_date": str(v.end_date),
            "reason": v.reason,
            "created_at": v.created_at.isoformat() if v.created_at else None,
            "updated_at": v.updated_at.isoformat() if v.updated_at else None,
        }
        for v in vacations
    ]


@router.post("/me", status_code=201)
async def create_my_vacation(data: VacationCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if data.end_date < data.start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")
    vac = Vacation(user_id=current_user.id, start_date=data.start_date, end_date=data.end_date, reason=data.reason)
    db.add(vac)
    await db.commit()
    await db.refresh(vac)

    # Compute recovery items for this vacation
    recovery_items = await _compute_recovery_for_user(db, current_user, vac)

    # Notification to the user confirming vacation creation
    note = Notification(
        user_id=current_user.id,
        title="Ferie inserite",
        message=f"Ferie dal {data.start_date} al {data.end_date} registrate.",
        type=NotificationType.UPDATE,
    )
    db.add(note)

    # Flag task as having vacation conflict
    for item in recovery_items:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 1

    # Single notification to admins if there are conflicts
    if recovery_items:
        admins_res = await db.execute(select(User).where(User.role.in_([UserRole.ADMIN, UserRole.EDITOR])))
        for admin_user in admins_res.scalars().all():
            note_admin = Notification(
                user_id=admin_user.id,
                title=f"⚠️ Conflitti ferie: {current_user.username}",
                message=f"L'addetto {current_user.username} ha inserito ferie dal {data.start_date} al {data.end_date}. Ci sono {len(recovery_items)} possibili conflitti da controllare.",
                type=NotificationType.UPDATE,
            )
            db.add(note_admin)

    await db.commit()
    return {"ok": True, "id": vac.id, "recovery_items": recovery_items}


@router.post("/admin/user/{user_id}", status_code=201)
async def create_admin_vacation(user_id: str, data: VacationCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin/editor possono inserire ferie per altri")
    if data.end_date < data.start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")
    
    target_res = await db.execute(select(User).where(User.id == user_id))
    target_user = target_res.scalar_one_or_none()
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Utente non trovato")

    vac = Vacation(user_id=target_user.id, start_date=data.start_date, end_date=data.end_date, reason=data.reason)
    db.add(vac)
    await db.commit()
    await db.refresh(vac)

    # Compute recovery items for this vacation
    recovery_items = await _compute_recovery_for_user(db, target_user, vac)

    # Notification to the target user confirming vacation creation by admin
    note = Notification(
        user_id=target_user.id,
        title="Ferie inserite da Admin",
        message=f"{current_user.full_name or current_user.username} ti ha inserito ferie dal {data.start_date} al {data.end_date}.",
        type=NotificationType.UPDATE,
    )
    db.add(note)

    # Flag task as having vacation conflict
    for item in recovery_items:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 1

    # Single notification to admins if there are conflicts
    if recovery_items:
        admins_res = await db.execute(select(User).where(User.role.in_([UserRole.ADMIN, UserRole.EDITOR])))
        for admin_user in admins_res.scalars().all():
            note_admin = Notification(
                user_id=admin_user.id,
                title=f"⚠️ Conflitti ferie: {target_user.username}",
                message=f"L'addetto {target_user.username} ha ferie dal {data.start_date} al {data.end_date} (inserite da {current_user.username}). Ci sono {len(recovery_items)} possibili conflitti da controllare nella Panoramica Addetti.",
                type=NotificationType.UPDATE,
            )
            db.add(note_admin)

    await db.commit()
    return {"ok": True, "id": vac.id, "recovery_items": recovery_items}


@router.post("/admin/company_closure", status_code=201)
async def create_company_closure(data: VacationCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin/editor possono inserire chiusure aziendali")
    if data.end_date < data.start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="end_date must be >= start_date")
    
    users_res = await db.execute(select(User))
    all_users = users_res.scalars().all()

    created_ids = []
    all_recovery_items = []
    
    for user in all_users:
        vac = Vacation(user_id=user.id, start_date=data.start_date, end_date=data.end_date, reason=data.reason or "Chiusura Aziendale")
        db.add(vac)
        await db.commit()
        await db.refresh(vac)
        created_ids.append(vac.id)
        
        recovery_items = await _compute_recovery_for_user(db, user, vac)
        all_recovery_items.extend(recovery_items)
        
        note = Notification(
            user_id=user.id,
            title="Chiusura Aziendale",
            message=f"È stata inserita una chiusura aziendale dal {data.start_date} al {data.end_date}.",
            type=NotificationType.UPDATE,
        )
        db.add(note)
        
        for item in recovery_items:
            task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
            task_obj = task_res.scalar_one_or_none()
            if task_obj:
                task_obj.has_vacation_conflict = 1

    if all_recovery_items:
        admins_res = await db.execute(select(User).where(User.role.in_([UserRole.ADMIN, UserRole.EDITOR])))
        for admin_user in admins_res.scalars().all():
            note_admin = Notification(
                user_id=admin_user.id,
                title="⚠️ Conflitti da Chiusura Aziendale",
                message=f"La chiusura aziendale dal {data.start_date} al {data.end_date} ha generato {len(all_recovery_items)} possibili conflitti sulle fasi attive.",
                type=NotificationType.UPDATE,
            )
            db.add(note_admin)
            
    await db.commit()
    return {"ok": True, "created_count": len(created_ids), "recovery_items": all_recovery_items}


@router.delete("/me/{vacation_id}")
async def delete_my_vacation(vacation_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(select(Vacation).where(Vacation.id == vacation_id, Vacation.user_id == current_user.id))
    vac = result.scalar_one_or_none()
    if not vac:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vacanza non trovata")
    
    # Compute recovery items before deleting to find affected tasks
    recovery_items = await _compute_recovery_for_user(db, current_user, vac)

    await db.delete(vac)

    # Reset vacation conflict flag for affected tasks
    for item in recovery_items:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 0

    await db.commit()
    return {"ok": True}


@router.get("/me/recovery", response_model=list)
async def get_my_recovery_hours(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Return all 'ore da recuperare' for the current user based on their future/current vacations."""
    vac_res = await db.execute(
        select(Vacation).where(Vacation.user_id == current_user.id).order_by(Vacation.start_date.asc())
    )
    vacations = vac_res.scalars().all()

    all_items = []
    for vac in vacations:
        items = await _compute_recovery_for_user(db, current_user, vac)
        all_items.extend(items)

    # Deduplicate by task_id (sum hours if same task appears across multiple vacation periods)
    deduped: dict = {}
    for item in all_items:
        key = item["task_id"]
        if key in deduped:
            deduped[key]["hours_to_recover"] = round(deduped[key]["hours_to_recover"] + item["hours_to_recover"], 1)
            deduped[key]["vacation_days"] = list(set(deduped[key]["vacation_days"] + item["vacation_days"]))
        else:
            deduped[key] = item

    return list(deduped.values())


@router.get("/all", response_model=list)
async def list_all_vacations(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    query = select(Vacation, User).join(User, Vacation.user_id == User.id)
    result = await db.execute(query)
    rows = result.all()
    return [
        {
            "id": v.id,
            "username": u.username,
            "full_name": u.full_name,
            "start_date": str(v.start_date),
            "end_date": str(v.end_date),
            "reason": v.reason,
            "department": u.department
        }
        for v, u in rows
    ]


@router.delete("/admin/{vacation_id}")
async def delete_admin_vacation(vacation_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin/editor possono eliminare ferie per altri")
    result = await db.execute(select(Vacation).where(Vacation.id == vacation_id))
    vac = result.scalar_one_or_none()
    if not vac:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vacanza non trovata")
    
    target_res = await db.execute(select(User).where(User.id == vac.user_id))
    target_user = target_res.scalar_one_or_none()
    
    recovery_items = await _compute_recovery_for_user(db, target_user, vac)
    await db.delete(vac)
    
    for item in recovery_items:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 0

    await db.commit()
    return {"ok": True}


@router.put("/admin/{vacation_id}")
async def update_admin_vacation(vacation_id: str, data: VacationCreate, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin/editor")
    
    result = await db.execute(select(Vacation).where(Vacation.id == vacation_id))
    vac = result.scalar_one_or_none()
    if not vac:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vacanza non trovata")
        
    target_res = await db.execute(select(User).where(User.id == vac.user_id))
    target_user = target_res.scalar_one_or_none()

    old_recovery = await _compute_recovery_for_user(db, target_user, vac)
    for item in old_recovery:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 0

    vac.start_date = data.start_date
    vac.end_date = data.end_date
    vac.reason = data.reason
    
    new_recovery = await _compute_recovery_for_user(db, target_user, vac)
    for item in new_recovery:
        task_res = await db.execute(select(Task).where(Task.id == item["task_id"]))
        task_obj = task_res.scalar_one_or_none()
        if task_obj:
            task_obj.has_vacation_conflict = 1
            
    await db.commit()
    return {"ok": True}
