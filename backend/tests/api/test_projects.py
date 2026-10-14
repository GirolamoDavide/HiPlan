# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_create_project(client: AsyncClient, auth_headers: dict):
    response = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Test Project",
            "code": "PRJ-001",
            "client": "Test Client",
            "status": "planning"
        }
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test Project"
    assert data["code"] == "PRJ-001"
    assert data["status"] == "planning"
    assert "id" in data

@pytest.mark.asyncio
async def test_get_projects(client: AsyncClient, auth_headers: dict):
    # First create a project
    await client.post(
        "/api/projects",
        headers=auth_headers,
        json={"name": "Test Project 2", "status": "active"}
    )
    
    response = await client.get("/api/projects", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    
    # Test filters
    response = await client.get("/api/projects?status=active", headers=auth_headers)
    assert response.status_code == 200
    assert all(p["status"] == "active" for p in response.json())

@pytest.mark.asyncio
async def test_unauthorized_project_access(client: AsyncClient):
    response = await client.get("/api/projects")
    assert response.status_code == 401

@pytest.mark.asyncio
async def test_update_project(client: AsyncClient, auth_headers: dict):
    response = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={"name": "Project to Update", "status": "planning"}
    )
    assert response.status_code == 201
    proj_id = response.json()["id"]

    response_put = await client.put(
        f"/api/projects/{proj_id}",
        headers=auth_headers,
        json={"name": "Project Updated", "status": "active"}
    )
    assert response_put.status_code == 200
    data = response_put.json()
    assert data["name"] == "Project Updated"
    assert data["status"] == "active"

@pytest.mark.asyncio
async def test_delete_project(client: AsyncClient, auth_headers: dict):
    response = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={"name": "Project to Delete"}
    )
    assert response.status_code == 201
    proj_id = response.json()["id"]

    response_del = await client.delete(f"/api/projects/{proj_id}", headers=auth_headers)
    assert response_del.status_code == 204

    response_get = await client.get(f"/api/projects/{proj_id}", headers=auth_headers)
    assert response_get.status_code == 404

@pytest.mark.asyncio
async def test_project_members(client: AsyncClient, auth_headers: dict):
    # Create project
    res = await client.post("/api/projects", headers=auth_headers, json={"name": "Member Project"})
    proj_id = res.json()["id"]
    
    # Add member
    res = await client.post(f"/api/projects/{proj_id}/members", headers=auth_headers, json={"user_id": "test_user_id"})
    assert res.status_code in [200, 404] 
    
    # Remove member
    res = await client.delete(f"/api/projects/{proj_id}/members/test_user_id", headers=auth_headers)
    assert res.status_code in [200, 404]

@pytest.mark.asyncio
async def test_project_tipologia_create_and_update(client: AsyncClient, auth_headers: dict):
    # 1. Create project with ATEX and Alimentare flags
    res = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={
            "name": "Progetto Speciale",
            "code": "SPEC-01",
            "is_atex": True,
            "is_alimentare": True,
            "status": "active"
        }
    )
    assert res.status_code == 201
    data = res.json()
    assert data["is_atex"] is True
    assert data["is_alimentare"] is True
    proj_id = data["id"]

    # 2. Retrieve project and verify flags persisted
    get_res = await client.get(f"/api/projects/{proj_id}", headers=auth_headers)
    assert get_res.status_code == 200
    get_data = get_res.json()
    assert get_data["is_atex"] is True
    assert get_data["is_alimentare"] is True

    # 3. Update to Standard (both false)
    put_res = await client.put(
        f"/api/projects/{proj_id}",
        headers=auth_headers,
        json={
            "is_atex": False,
            "is_alimentare": False
        }
    )
    assert put_res.status_code == 200
    put_data = put_res.json()
    assert put_data["is_atex"] is False
    assert put_data["is_alimentare"] is False


@pytest.mark.asyncio
async def test_update_project_rejects_end_before_start(client: AsyncClient, auth_headers: dict):
    create = await client.post(
        "/api/projects",
        headers=auth_headers,
        json={"name": "Date Check", "start_date": "2026-08-25", "end_date": "2026-11-28"},
    )
    project_id = create.json()["id"]

    response = await client.put(
        f"/api/projects/{project_id}", headers=auth_headers, json={"end_date": "2026-08-01"}
    )
    assert response.status_code == 400

    response = await client.put(
        f"/api/projects/{project_id}",
        headers=auth_headers,
        json={"start_date": None, "end_date": None, "responsible_id": None},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["start_date"] is None and data["end_date"] is None
