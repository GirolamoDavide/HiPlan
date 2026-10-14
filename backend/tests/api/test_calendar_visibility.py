# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient

from app.core.security import hash_password
from app.models.user import User, UserRole


async def _login_as_viewer(client: AsyncClient, db_session) -> dict:
    db_session.add(User(
        email="viewer@example.com", username="viewer", hashed_password=hash_password("viewerpass"),
        full_name="Viewer", role=UserRole.VIEWER, is_active=True,
    ))
    await db_session.commit()
    res = await client.post("/api/auth/login", json={"email": "viewer@example.com", "password": "viewerpass"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


async def _create_event(client, headers, title, **extra):
    res = await client.post("/api/calendar/events", headers=headers, json={
        "title": title, "start_date": "2026-10-20T09:00:00", "end_date": "2026-10-20T10:00:00", **extra,
    })
    assert res.status_code == 201
    return res.json()["id"]


def _titles(events):
    return {e["title"] for e in events if e["type"] == "personal"}


@pytest.mark.asyncio
async def test_event_visibility_private_selected_team(client: AsyncClient, auth_headers: dict, db_session):
    viewer_headers = await _login_as_viewer(client, db_session)

    await _create_event(client, auth_headers, "Privato", visibility="private")
    await _create_event(client, auth_headers, "Per viewer", visibility="selected", shared_with=["viewer"])
    await _create_event(client, auth_headers, "Per altri", visibility="selected", shared_with=["qualcuno"])
    team_id = await _create_event(client, auth_headers, "Per tutti", visibility="team")

    viewer_events = (await client.get("/api/calendar/events", headers=viewer_headers)).json()
    assert _titles(viewer_events) == {"Per viewer", "Per tutti"}

    team_event = next(e for e in viewer_events if e["title"] == "Per tutti")
    assert team_event["can_edit"] is False
    assert team_event["owner_name"] == "Test User"

    # Un evento visibile a tutti è in sola lettura per chi non l'ha creato
    res = await client.put(f"/api/calendar/events/{team_id}", headers=viewer_headers, json={"title": "Modificato"})
    assert res.status_code == 403

    owner_events = (await client.get("/api/calendar/events", headers=auth_headers)).json()
    assert {"Privato", "Per viewer", "Per altri", "Per tutti"} <= _titles(owner_events)


@pytest.mark.asyncio
async def test_legacy_event_with_shared_with_is_selected(client: AsyncClient, auth_headers: dict, db_session):
    viewer_headers = await _login_as_viewer(client, db_session)
    # Eventi creati prima della visibilità: solo shared_with
    await _create_event(client, auth_headers, "Vecchio condiviso", shared_with=["viewer"])
    events = (await client.get("/api/calendar/events", headers=viewer_headers)).json()
    shared = next(e for e in events if e["title"] == "Vecchio condiviso")
    assert shared["visibility"] == "selected"
    assert shared["can_edit"] is True


@pytest.mark.asyncio
async def test_migrated_private_event_with_recipients_stays_shared(client: AsyncClient, auth_headers: dict, db_session):
    viewer_headers = await _login_as_viewer(client, db_session)
    # La migrazione automatica ha impostato "private" anche sugli eventi già condivisi
    await _create_event(client, auth_headers, "Migrato", visibility="private", shared_with=["viewer"])
    events = (await client.get("/api/calendar/events", headers=viewer_headers)).json()
    assert "Migrato" in _titles(events)
