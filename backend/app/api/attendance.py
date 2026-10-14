"""Griglia presenze: addetti in riga e giorni del mese in colonna, come il foglio Excel di pianificazione.

Le celle si compilano da sole con ferie, permessi a ore, viaggi e fasi assegnate; admin ed editor
possono aggiungere una nota libera colorata per cella.
"""
import calendar
import json
from datetime import date, timedelta
from typing import Dict, List, Optional

# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, Query, status
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
# pyrefly: ignore [missing-import]
from sqlalchemy import select
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.api.trips import get_trip_access
from app.core.dependencies import get_db, get_current_user
from app.models.attendance_note import AttendanceNote
from app.models.task import Task, TaskType
from app.models.trip import Trip
from app.models.user import User, UserRole
from app.models.vacation import Vacation
from app.utils.vacations import is_full_day, PART_OF_DAY_LABELS
from app.utils.working_days import get_italian_holidays

router = APIRouter(prefix="/api/attendance", tags=["attendance"])

INACTIVE_PROJECT_STATUSES = {"completed", "archived"}


class AttendanceNoteIn(BaseModel):
    user_id: str
    date: date
    text: str = ""
    color: Optional[str] = None


def _json_list(value) -> list:
    try:
        parsed = json.loads(value) if value else []
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def _month_bounds(month: str):
    try:
        year, mon = (int(p) for p in month.split("-"))
        first = date(year, mon, 1)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Mese non valido, usa il formato YYYY-MM")
    last = date(year, mon, calendar.monthrange(year, mon)[1])
    return first, last


def _days(first: date, last: date) -> List[date]:
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def _can_edit_notes(user: User) -> bool:
    return user.role in (UserRole.ADMIN, UserRole.EDITOR)


def _task_dates(task: Task, first: date, last: date) -> List[date]:
    """Giorni lavorati nella fase dentro il mese (date personalizzate o giorni feriali non esclusi)."""
    custom = [d.get("date") if isinstance(d, dict) else d for d in _json_list(task.custom_dates)]
    if task.budget_mode == "custom_dates" and custom:
        result = []
        for d in custom:
            try:
                day = date.fromisoformat(str(d)[:10])
            except Exception:
                continue
            if first <= day <= last:
                result.append(day)
        return result
    excluded = {str(d)[:10] for d in _json_list(task.excluded_dates)}
    start = max(task.start_date, first)
    end = min(task.end_date or task.start_date, last)
    return [d for d in _days(start, end) if d.weekday() < 5 and d.isoformat() not in excluded] if start <= end else []


@router.get("")
async def get_attendance_grid(
    month: str = Query(..., description="Mese nel formato YYYY-MM"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    first, last = _month_bounds(month)

    users_res = await db.execute(select(User).where(User.is_active == True))  # noqa: E712
    users = sorted(users_res.scalars().all(), key=lambda u: ((u.department or "zz"), (u.full_name or u.username).lower()))
    uid_by_name: Dict[str, str] = {}
    for u in users:
        uid_by_name[u.username.lower()] = str(u.id)
        if u.full_name:
            uid_by_name[u.full_name.strip().lower()] = str(u.id)

    cells: Dict[str, Dict[str, dict]] = {}

    def cell(uid: str, day: date) -> dict:
        return cells.setdefault(uid, {}).setdefault(day.isoformat(), {"items": [], "note": None})

    # Ferie e permessi a ore
    vac_res = await db.execute(select(Vacation).where(Vacation.start_date <= last, Vacation.end_date >= first))
    for v in vac_res.scalars().all():
        uid = str(v.user_id)
        if is_full_day(v):
            for day in _days(max(v.start_date, first), min(v.end_date, last)):
                cell(uid, day)["items"].append({"kind": "vacation", "label": v.reason or "Ferie"})
        else:
            part = PART_OF_DAY_LABELS.get(v.part_of_day or "")
            label = f"Permesso {v.hours:g}h" + (f" {part}" if part else "")
            cell(uid, v.start_date)["items"].append({"kind": "leave", "label": label, "detail": v.reason})

    # Viaggi: visibili in griglia solo a chi ha accesso al calendario viaggi
    if (await get_trip_access(db, current_user))["can_view"]:
        trip_res = await db.execute(select(Trip).where(Trip.start_date <= last, Trip.end_date >= first))
        for trip in trip_res.scalars().all():
            for name in _json_list(trip.travelers):
                uid = uid_by_name.get(str(name).strip().lower())
                if not uid:
                    continue
                for day in _days(max(trip.start_date, first), min(trip.end_date, last)):
                    cell(uid, day)["items"].append({"kind": "trip", "label": trip.destination or trip.title, "detail": trip.title, "color": trip.color})

    # Fasi assegnate nelle commesse attive
    task_res = await db.execute(
        select(Task).options(selectinload(Task.project))
        .where(Task.type == TaskType.TASK, Task.start_date <= last, Task.completed != 1)
    )
    for task in task_res.scalars().all():
        if (task.end_date or task.start_date) < first:
            continue
        project = task.project
        status_value = getattr(getattr(project, "status", None), "value", None) if project else None
        if status_value in INACTIVE_PROJECT_STATUSES:
            continue
        task_days = _task_dates(task, first, last)
        if not task_days:
            continue
        label = (project.code if project and project.code else None) or (project.name if project else task.text)
        for name in _json_list(task.workers):
            uid = uid_by_name.get(str(name).strip().lower())
            if not uid:
                continue
            for day in task_days:
                cell(uid, day)["items"].append({
                    "kind": "phase", "label": label, "detail": task.text,
                    "color": (project.color if project else None) or task.color, "project_id": task.project_id,
                })

    # Note manuali
    note_res = await db.execute(select(AttendanceNote).where(AttendanceNote.date >= first, AttendanceNote.date <= last))
    for note in note_res.scalars().all():
        cell(str(note.user_id), note.date)["note"] = {"text": note.text, "color": note.color}

    holidays = {h["date"]: h["name"] for h in get_italian_holidays(first.year)}
    return {
        "month": month,
        "can_edit": _can_edit_notes(current_user),
        "days": [
            {"date": d.isoformat(), "weekday": d.weekday(), "holiday": holidays.get(d)}
            for d in _days(first, last)
        ],
        "users": [
            {"id": str(u.id), "username": u.username, "full_name": u.full_name or u.username, "department": u.department}
            for u in users
        ],
        "cells": cells,
    }


@router.put("/notes")
async def upsert_attendance_note(
    data: AttendanceNoteIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not _can_edit_notes(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin ed editor possono modificare la griglia")

    res = await db.execute(
        select(AttendanceNote).where(AttendanceNote.user_id == data.user_id, AttendanceNote.date == data.date)
    )
    note = res.scalar_one_or_none()
    text = data.text.strip()

    # Una cella senza testo né colore viene svuotata
    if not text and not data.color:
        if note:
            await db.delete(note)
            await db.commit()
        return {"user_id": data.user_id, "date": data.date.isoformat(), "note": None}

    if note:
        note.text = text
        note.color = data.color
        note.updated_by = current_user.id
    else:
        db.add(AttendanceNote(user_id=data.user_id, date=data.date, text=text, color=data.color, updated_by=current_user.id))
    await db.commit()
    return {"user_id": data.user_id, "date": data.date.isoformat(), "note": {"text": text, "color": data.color}}
