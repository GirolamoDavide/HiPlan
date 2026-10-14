# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient

from app.core.security import hash_password
from app.models.user import User, UserRole

TRIP = {"title": "Trasferta cliente", "destination": "Torino", "start_date": "2026-10-20",
        "end_date": "2026-10-22", "travelers": ["viewer"]}


async def _login(client, db_session, username):
    db_session.add(User(email=f"{username}@example.com", username=username, hashed_password=hash_password("pass1234"),
                        full_name=username.title(), role=UserRole.VIEWER, is_active=True))
    await db_session.commit()
    res = await client.post("/api/auth/login", json={"email": f"{username}@example.com", "password": "pass1234"})
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


@pytest.mark.asyncio
async def test_trip_access_viewers_and_editors(client: AsyncClient, auth_headers: dict, db_session):
    viewer = await _login(client, db_session, "viewer")
    editor = await _login(client, db_session, "editor1")
    stranger = await _login(client, db_session, "stranger")

    # Admin configura chi vede e chi compila
    res = await client.put("/api/trips/settings/access", headers=auth_headers,
                           json={"viewers": ["viewer"], "editors": ["editor1"]})
    assert res.status_code == 200
    assert (await client.put("/api/trips/settings/access", headers=viewer, json={"viewers": [], "editors": []})).status_code == 403

    # Chi compila crea il viaggio
    res = await client.post("/api/trips", headers=editor, json=TRIP)
    assert res.status_code == 201
    trip = res.json()
    assert trip["created_by_name"] == "Editor1"

    # Chi vede lo legge ma non può modificarlo
    assert (await client.get("/api/trips/access", headers=viewer)).json() == {"can_view": True, "can_edit": False}
    assert [t["title"] for t in (await client.get("/api/trips", headers=viewer)).json()] == ["Trasferta cliente"]
    assert (await client.post("/api/trips", headers=viewer, json=TRIP)).status_code == 403
    assert (await client.delete(f"/api/trips/{trip['id']}", headers=viewer)).status_code == 403

    # Chi non è in elenco non vede nulla
    assert (await client.get("/api/trips", headers=stranger)).status_code == 403

    # L'admin modifica ed elimina
    updated = await client.put(f"/api/trips/{trip['id']}", headers=auth_headers, json={**TRIP, "destination": "Milano"})
    assert updated.json()["destination"] == "Milano"
    assert (await client.delete(f"/api/trips/{trip['id']}", headers=auth_headers)).status_code == 204


@pytest.mark.asyncio
async def test_trip_dates_validated(client: AsyncClient, auth_headers: dict):
    res = await client.post("/api/trips", headers=auth_headers, json={**TRIP, "end_date": "2026-10-19"})
    assert res.status_code == 400
