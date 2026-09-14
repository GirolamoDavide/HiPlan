from datetime import date

from app.services import task_service


def test_find_vacation_conflicts_for_dates_returns_workdays_overlap():
    vacations = [
        {"start_date": date(2026, 7, 20), "end_date": date(2026, 7, 24)}
    ]

    conflicts = task_service.find_vacation_conflicts(
        task_start=date(2026, 7, 21),
        task_end=date(2026, 7, 23),
        vacations=vacations,
    )

    assert len(conflicts) == 1
    assert conflicts[0]["workdays"] == 3


def test_find_vacation_conflicts_with_custom_dates():
    vacations = [
        {"start_date": "2026-07-20", "end_date": "2026-07-24"}
    ]
    # Only 2026-07-21 overlaps; 2026-07-28 is after vacation
    custom_dates = [
        {"date": "2026-07-21", "hours": 8},
        {"date": "2026-07-28", "hours": 8}
    ]
    conflicts = task_service.find_vacation_conflicts(
        task_start="2026-07-21",
        task_end="2026-07-28",
        vacations=vacations,
        custom_dates=custom_dates
    )
    assert len(conflicts) == 1
    assert conflicts[0]["workdays"] == 1
    assert "2026-07-21" in conflicts[0]["conflict_dates"]
