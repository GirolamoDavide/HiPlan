# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient
from datetime import date

from app.models.project import Project
from app.models.vacation import Vacation
from app.utils.vacations import full_day_dates_by_uid, leave_hours_by_uid, describe_vacation

MONDAY = "2026-10-19"


@pytest.mark.asyncio
async def test_create_hourly_leave(client: AsyncClient, auth_headers: dict):
    res = await client.post(
        "/api/vacations/me",
        headers=auth_headers,
        json={"start_date": MONDAY, "end_date": MONDAY, "hours": 4, "part_of_day": "morning", "reason": "visita"},
    )
    assert res.status_code == 201

    vacations = (await client.get("/api/vacations/me", headers=auth_headers)).json()
    leave = next(v for v in vacations if v["id"] == res.json()["id"])
    assert leave["hours"] == 4
    assert leave["part_of_day"] == "morning"

    all_vacations = (await client.get("/api/vacations/all", headers=auth_headers)).json()
    assert any(v["hours"] == 4 for v in all_vacations)


@pytest.mark.asyncio
async def test_hourly_leave_must_be_single_day(client: AsyncClient, auth_headers: dict):
    res = await client.post(
        "/api/vacations/me",
        headers=auth_headers,
        json={"start_date": MONDAY, "end_date": "2026-10-20", "hours": 2},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_full_day_hours_become_full_day_vacation(client: AsyncClient, auth_headers: dict):
    res = await client.post(
        "/api/vacations/me",
        headers=auth_headers,
        json={"start_date": MONDAY, "end_date": MONDAY, "hours": 8, "part_of_day": "afternoon"},
    )
    assert res.status_code == 201
    vacations = (await client.get("/api/vacations/me", headers=auth_headers)).json()
    leave = next(v for v in vacations if v["id"] == res.json()["id"])
    assert leave["hours"] is None
    assert leave["part_of_day"] is None


@pytest.mark.asyncio
async def test_hourly_leave_does_not_block_task_assignment(client: AsyncClient, auth_headers: dict, test_project: Project):
    await client.post(
        "/api/vacations/me",
        headers=auth_headers,
        json={"start_date": MONDAY, "end_date": MONDAY, "hours": 2},
    )
    res = await client.post(
        f"/api/projects/{test_project.id}/tasks",
        headers=auth_headers,
        json={"text": "Fase con permesso", "start_date": MONDAY, "duration": 3, "type": "task",
              "workers": ["testuser"], "planned_hours": 24.0},
    )
    assert res.status_code == 201


def test_vacation_helpers_split_full_days_and_hours():
    full = Vacation(user_id="u1", start_date=date(2026, 10, 19), end_date=date(2026, 10, 20))
    partial = Vacation(user_id="u1", start_date=date(2026, 10, 21), end_date=date(2026, 10, 21), hours=3, part_of_day=None)

    assert full_day_dates_by_uid([full, partial]) == {"u1": {date(2026, 10, 19), date(2026, 10, 20)}}
    assert leave_hours_by_uid([full, partial]) == {"u1": {date(2026, 10, 21): 3.0}}
    assert describe_vacation(partial) == "il 2026-10-21 (3h)"


def _next_weekday(start: date) -> date:
    from datetime import timedelta
    from app.utils.working_days import is_italian_holiday
    d = start + timedelta(days=7)
    while d.weekday() >= 5 or is_italian_holiday(d):
        d += timedelta(days=1)
    return d


@pytest.mark.asyncio
async def test_hourly_leave_reduces_capacity_in_conflicts(client: AsyncClient, auth_headers: dict, test_project: Project, test_user, db_session):
    import json
    from app.models.task import Task

    day = _next_weekday(date.today())
    db_session.add(Task(
        text="Fase da 7h", project_id=test_project.id, type="task",
        start_date=day, end_date=day, duration=1, planned_hours=7.0,
        workers=json.dumps(["testuser"]),
    ))
    await db_session.commit()

    def overloads(conflicts):
        return [c for c in conflicts if c["type"] == "overload" and c["worker"] == "testuser"]

    # 7h su 8h di capacità: nessun sovraccarico
    assert overloads((await client.get("/api/users/conflicts", headers=auth_headers)).json()) == []

    # Con 2h di permesso la capacità scende a 6h: 7h diventano un sovraccarico
    await client.post(
        "/api/vacations/me",
        headers=auth_headers,
        json={"start_date": str(day), "end_date": str(day), "hours": 2},
    )
    result = overloads((await client.get("/api/users/conflicts", headers=auth_headers)).json())
    assert len(result) == 1
    assert result[0]["start_date"] == str(day)
