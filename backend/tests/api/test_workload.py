# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient

@pytest.mark.asyncio
async def test_get_workload_heatmap(client: AsyncClient, auth_headers: dict):
    response = await client.get("/api/workload/heatmap", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert "heatmap" in data

@pytest.mark.asyncio
async def test_export_workload_pdf(client: AsyncClient, auth_headers: dict):
    # Test planned mode
    response = await client.get("/api/workload/export/pdf?mode=planned", headers=auth_headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    
    # Test both mode
    response_both = await client.get("/api/workload/export/pdf?mode=both", headers=auth_headers)
    assert response_both.status_code == 200
    assert response_both.headers["content-type"] == "application/pdf"

@pytest.mark.asyncio
async def test_export_workload_excel(client: AsyncClient, auth_headers: dict):
    # Test planned mode
    response = await client.get("/api/workload/export/excel?mode=planned", headers=auth_headers)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    
    # Test both mode
    response_both = await client.get("/api/workload/export/excel?mode=both", headers=auth_headers)
    assert response_both.status_code == 200
    assert response_both.headers["content-type"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.mark.asyncio
async def test_get_workload_heatmap_custom_dates(client: AsyncClient, auth_headers: dict, test_project, test_user, db_session):
    import json
    import datetime
    from app.models.task import Task

    custom_dates = [
        {"date": "2026-10-05", "hours": 3.0},
        {"date": "2026-10-07", "hours": 4.5}
    ]
    task = Task(
        text="Custom Dates Task",
        start_date=datetime.date(2026, 10, 5),
        end_date=datetime.date(2026, 10, 7),
        duration=2,
        project_id=test_project.id,
        type="task",
        budget_mode="custom_dates",
        custom_dates=json.dumps(custom_dates),
        planned_hours=7.5,
        workers=json.dumps([test_user.username]),
        worker_hours=json.dumps({test_user.username: 7.5})
    )
    db_session.add(task)
    await db_session.commit()

    response = await client.get("/api/workload/heatmap", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    heatmap = data["heatmap"]
    user_workload = heatmap[str(test_user.id)]["workload"]

    # 2026-10-05 should have 3.0h
    assert "2026-10-05" in user_workload
    assert user_workload["2026-10-05"]["hours"] == 3.0
    assert user_workload["2026-10-05"]["tasks"][0]["budget_mode"] == "custom_dates"

    # 2026-10-06 was not selected in custom_dates, so it should NOT be in user_workload
    assert "2026-10-06" not in user_workload

    # 2026-10-07 should have 4.5h
    assert "2026-10-07" in user_workload
    assert user_workload["2026-10-07"]["hours"] == 4.5
