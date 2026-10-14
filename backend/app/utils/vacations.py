"""Utility condivise per ferie a giornata intera e permessi a ore."""
from datetime import date, timedelta
from typing import Dict, Iterable, Set

FULL_DAY_HOURS = 8.0
PART_OF_DAY_LABELS = {"morning": "mattina", "afternoon": "pomeriggio"}


def is_full_day(vacation) -> bool:
    hours = vacation.get("hours") if isinstance(vacation, dict) else getattr(vacation, "hours", None)
    return hours is None or float(hours) >= FULL_DAY_HOURS


def full_day_dates_by_uid(vacations: Iterable) -> Dict[str, Set[date]]:
    """Giorni in cui l'addetto è completamente assente (i permessi a ore non rendono il giorno indisponibile)."""
    result: Dict[str, Set[date]] = {}
    for v in vacations:
        if not is_full_day(v):
            continue
        days = result.setdefault(str(v.user_id), set())
        cur = v.start_date
        while cur <= v.end_date:
            days.add(cur)
            cur += timedelta(days=1)
    return result


def leave_hours_by_uid(vacations: Iterable) -> Dict[str, Dict[date, float]]:
    """Ore di permesso per addetto e giorno, da sottrarre alla capacità giornaliera."""
    result: Dict[str, Dict[date, float]] = {}
    for v in vacations:
        if is_full_day(v):
            continue
        per_day = result.setdefault(str(v.user_id), {})
        per_day[v.start_date] = per_day.get(v.start_date, 0.0) + float(v.hours)
    return result


def describe_vacation(vacation) -> str:
    """Descrizione leggibile del periodo, es. 'il 2026-10-20 (2h)' o 'dal 2026-10-20 al 2026-10-24'."""
    if not is_full_day(vacation):
        hours = float(vacation.hours)
        part = PART_OF_DAY_LABELS.get(vacation.part_of_day or "")
        amount = f"{hours:g}h" + (f", {part}" if part else "")
        return f"il {vacation.start_date} ({amount})"
    if vacation.start_date == vacation.end_date:
        return f"il {vacation.start_date}"
    return f"dal {vacation.start_date} al {vacation.end_date}"


def serialize_vacation_fields(vacation) -> dict:
    return {
        "start_date": str(vacation.start_date),
        "end_date": str(vacation.end_date),
        "reason": vacation.reason,
        "hours": vacation.hours,
        "part_of_day": vacation.part_of_day,
        "created_at": vacation.created_at.isoformat() if vacation.created_at else None,
    }
