# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_get_current_user(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/users/me", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert data["email"] == "test@example.com"
    assert data["username"] == "testuser"

@pytest.mark.asyncio
async def test_update_me(client: AsyncClient, auth_headers: dict):
    response = await client.patch(
        "/api/users/me",
        headers=auth_headers,
        json={"full_name": "Test Updated Name"}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["full_name"] == "Test Updated Name"

@pytest.mark.asyncio
async def test_get_users_list(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/users", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert any(u["email"] == "test@example.com" for u in data)

@pytest.mark.asyncio
async def test_update_user(client: AsyncClient, auth_headers: dict):
    # First get user id
    me_res = await client.get("/api/users/me", headers=auth_headers)
    user_id = me_res.json()["id"]

    response = await client.patch(
        f"/api/users/{user_id}",
        headers=auth_headers,
        json={"is_active": False} # Toggle is_active
    )
    assert response.status_code == 200
    assert response.json()["is_active"] is False

    # Restore
    await client.patch(f"/api/users/{user_id}", headers=auth_headers, json={"is_active": True})

@pytest.mark.asyncio
async def test_unauthorized_access(client: AsyncClient):
    response = await client.get("/api/users")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_get_my_unlogged_hours(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/users/me/unlogged-hours", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert "unlogged_hours" in data
    assert isinstance(data["unlogged_hours"], (int, float))
    assert "count" in data
    assert isinstance(data["alerts"], list)

