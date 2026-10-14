# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient
import json
from datetime import date

from app.core.security import hash_password
from app.models.project import Project
from app.models.task import Task
from app.models.user import User, UserRole


@pytest.mark.asyncio
async def test_attendance_grid_collects_vacations_leave_trips_phases(client: AsyncClient, auth_headers: dict, test_project: Project, test_user, db_session):
    test_project.code = "M26-113"
    db_session.add(Task(text="Montaggio", project_id=test_project.id, type="task",
                        start_date=date(2026, 10, 5), end_date=date(2026, 10, 6), duration=2,
                        workers=json.dumps(["Test User"])))  # assegnato per nome completo
    await db_session.commit()

    await client.post("/api/vacations/me", headers=auth_headers, json={"start_date": "2026-10-12", "end_date": "2026-10-13"})
    await client.post("/api/vacations/me", headers=auth_headers, json={"start_date": "2026-10-14", "end_date": "2026-10-14", "hours": 4, "part_of_day": "morning"})
    await client.post("/api/trips", headers=auth_headers, json={"title": "Collaudo", "destination": "Torino",
                                                              "start_date": "2026-10-20", "end_date": "2026-10-20", "travelers": ["testuser"]})

    grid = (await client.get("/api/attendance?month=2026-10", headers=auth_headers)).json()
    assert len(grid["days"]) == 31
    assert grid["can_edit"] is True

    row = grid["cells"][str(test_user.id)]
    kinds = lambda d: [(i["kind"], i["label"]) for i in row[d]["items"]]
    assert kinds("2026-10-05") == [("phase", "M26-113")]
    assert ("vacation", "Ferie") in kinds("2026-10-12")
    assert kinds("2026-10-14") == [("leave", "Permesso 4h mattina")]
    assert kinds("2026-10-20") == [("trip", "Torino")]


@pytest.mark.asyncio
async def test_attendance_grid_only_for_admin(client: AsyncClient, auth_headers: dict, test_user, db_session):
    note = {"user_id": str(test_user.id), "date": "2026-10-08", "text": "M", "color": "#f9a8d4"}
    assert (await client.put("/api/attendance/notes", headers=auth_headers, json=note)).status_code == 200

    grid = (await client.get("/api/attendance?month=2026-10", headers=auth_headers)).json()
    assert grid["cells"][str(test_user.id)]["2026-10-08"]["note"] == {"text": "M", "color": "#f9a8d4"}

    # Svuotare testo e colore cancella la nota
    await client.put("/api/attendance/notes", headers=auth_headers, json={**note, "text": "", "color": None})
    grid = (await client.get("/api/attendance?month=2026-10", headers=auth_headers)).json()
    assert "2026-10-08" not in grid["cells"].get(str(test_user.id), {})

    db_session.add(User(email="v@example.com", username="viewer", hashed_password=hash_password("pass1234"),
                        full_name="Viewer", role=UserRole.VIEWER, is_active=True))
    await db_session.commit()
    token = (await client.post("/api/auth/login", json={"email": "v@example.com", "password": "pass1234"})).json()["access_token"]
    viewer = {"Authorization": f"Bearer {token}"}
    assert (await client.put("/api/attendance/notes", headers=viewer, json=note)).status_code == 403
    assert (await client.get("/api/attendance?month=2026-10", headers=viewer)).status_code == 403

    db_session.add(User(email="e@example.com", username="editor1", hashed_password=hash_password("pass1234"),
                        full_name="Editor", role=UserRole.EDITOR, is_active=True))
    await db_session.commit()
    token = (await client.post("/api/auth/login", json={"email": "e@example.com", "password": "pass1234"})).json()["access_token"]
    editor = {"Authorization": f"Bearer {token}"}
    assert (await client.get("/api/attendance?month=2026-10", headers=editor)).status_code == 403
    assert (await client.put("/api/attendance/notes", headers=editor, json=note)).status_code == 403
