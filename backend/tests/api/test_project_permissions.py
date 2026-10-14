# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient
import json
from datetime import date

from app.core.security import create_access_token, hash_password
from app.models.project import Project
from app.models.task import Task
from app.models.user import User, UserRole


async def _viewer(client, db_session, username="viewer", full_name="Mario Viewer"):
    user = User(email=f"{username}@example.com", username=username, hashed_password=hash_password("pass1234"),
                full_name=full_name, role=UserRole.VIEWER, is_active=True)
    db_session.add(user)
    await db_session.commit()
    res = await client.post("/api/auth/login", json={"email": f"{username}@example.com", "password": "pass1234"})
    return user, {"Authorization": f"Bearer {res.json()['access_token']}"}


async def _project(db_session, owner, name, workers=None):
    project = Project(name=name, owner_id=owner.id, status="active", start_date=date(2026, 10, 1))
    db_session.add(project)
    await db_session.commit()
    if workers:
        db_session.add(Task(text="Fase", project_id=project.id, type="task", start_date=date(2026, 10, 5),
                            end_date=date(2026, 10, 6), duration=2, workers=json.dumps(workers)))
        await db_session.commit()
    return project


@pytest.mark.asyncio
async def test_viewer_sees_only_involved_projects(client: AsyncClient, auth_headers, test_user, db_session):
    _, viewer = await _viewer(client, db_session)
    mine = await _project(db_session, test_user, "Commessa con viewer", workers=["Mario Viewer"])
    other = await _project(db_session, test_user, "Commessa riservata")

    names = {p["name"] for p in (await client.get("/api/projects", headers=viewer)).json()}
    assert names == {"Commessa con viewer"}

    assert (await client.get(f"/api/projects/{mine.id}", headers=viewer)).status_code == 200
    assert (await client.get(f"/api/projects/{mine.id}/gantt", headers=viewer)).status_code == 200

    # Commessa non assegnata: dettaglio, Gantt, export, log e ripianificazione negati
    for url in [f"/api/projects/{other.id}", f"/api/projects/{other.id}/gantt",
                f"/api/projects/{other.id}/export/pdf", f"/api/projects/{other.id}/activity_logs",
                f"/api/replanning/project/{other.id}/suggestions"]:
        assert (await client.get(url, headers=viewer)).status_code == 403, url

    # Gli export multipli escludono le commesse non visibili
    res = await client.post("/api/projects/export-list/excel", headers=viewer, json={"project_ids": [other.id]})
    assert res.status_code == 200

    # Admin continua a vedere tutto
    admin_names = {p["name"] for p in (await client.get("/api/projects", headers=auth_headers)).json()}
    assert {"Commessa con viewer", "Commessa riservata"} <= admin_names


@pytest.mark.asyncio
async def test_viewer_cannot_manage_attachments_or_phase_templates(client: AsyncClient, auth_headers, test_user, db_session):
    _, viewer = await _viewer(client, db_session)
    mine = await _project(db_session, test_user, "Commessa con viewer", workers=["viewer"])

    files = {"file": ("nota.txt", b"ciao", "text/plain")}
    assert (await client.post(f"/api/projects/{mine.id}/attachments", headers=viewer, files=files)).status_code == 403
    assert (await client.post(f"/api/projects/{mine.id}/attachments", headers=auth_headers, files=files)).status_code == 200

    template = {"name": "Nuova fase", "department": "produzione"}
    assert (await client.post("/api/phase-templates", headers=viewer, json=template)).status_code == 403
    assert (await client.post("/api/phase-templates", headers=auth_headers, json=template)).status_code == 201


@pytest.mark.asyncio
async def test_checklist_must_belong_to_task_and_project(client: AsyncClient, auth_headers, test_user, db_session):
    first = await _project(db_session, test_user, "A", workers=["testuser"])
    second = await _project(db_session, test_user, "B", workers=["testuser"])
    from sqlalchemy import select
    task_a = (await db_session.execute(select(Task).where(Task.project_id == first.id))).scalar_one()
    task_b = (await db_session.execute(select(Task).where(Task.project_id == second.id))).scalar_one()

    item = (await client.post(f"/api/projects/{first.id}/tasks/{task_a.id}/checklists", headers=auth_headers,
                              json={"text": "Verifica"})).json()
    # Fase di un'altra commessa nell'URL
    assert (await client.get(f"/api/projects/{first.id}/tasks/{task_b.id}/checklists", headers=auth_headers)).status_code == 404
    # Voce di checklist di un'altra fase: non viene toccata
    await client.delete(f"/api/projects/{second.id}/tasks/{task_b.id}/checklists/{item['id']}", headers=auth_headers)
    res = await client.put(f"/api/projects/{second.id}/tasks/{task_b.id}/checklists/{item['id']}", headers=auth_headers,
                           json={"is_completed": True})
    assert res.status_code == 404
    items = (await client.get(f"/api/projects/{first.id}/tasks/{task_a.id}/checklists", headers=auth_headers)).json()
    assert [i["text"] for i in items] == ["Verifica"]


@pytest.mark.asyncio
async def test_websocket_requires_valid_token_and_project_access(client: AsyncClient, test_user, db_session, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from app.api import websockets
    monkeypatch.setattr(websockets, "AsyncSessionLocal",
                        async_sessionmaker(db_session.bind, class_=AsyncSession, expire_on_commit=False))

    viewer, _ = await _viewer(client, db_session)
    mine = await _project(db_session, test_user, "Con viewer", workers=["viewer"])
    other = await _project(db_session, test_user, "Riservata")
    viewer_token = create_access_token({"sub": viewer.id})

    assert await websockets._authorize(viewer_token, mine.id) is True
    assert await websockets._authorize(viewer_token, other.id) is False
    assert await websockets._authorize("", mine.id) is False
    assert await websockets._authorize("token-non-valido", mine.id) is False
