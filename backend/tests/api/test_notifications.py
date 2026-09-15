# pyrefly: ignore [missing-import]
import pytest
# pyrefly: ignore [missing-import]
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.notification import Notification, NotificationType
from app.models.user import User

@pytest.mark.asyncio
async def test_notifications_crud_and_links(client: AsyncClient, auth_headers: dict, db_session: AsyncSession, test_user: User):
    # Insert test notifications directly with different types and links
    n1 = Notification(
        user_id=test_user.id,
        title="Nuovo TODO Assegnato",
        message="Hai un nuovo todo da completare",
        type=NotificationType.TODO,
        link="/todo?id=test-todo-1",
        is_read=False
    )
    n2 = Notification(
        user_id=test_user.id,
        title="Ticket Risolto",
        message="Il ticket #42 è stato chiuso",
        type=NotificationType.TICKET,
        link="/tickets?id=ticket-42",
        is_read=False
    )
    db_session.add_all([n1, n2])
    await db_session.commit()

    # 1. Check unread count
    resp = await client.get("/api/notifications/unread-count", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["count"] >= 2

    # 2. Get list of notifications and verify link and type
    resp = await client.get("/api/notifications", headers=auth_headers)
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) >= 2
    todo_item = next(i for i in items if i["id"] == n1.id)
    assert todo_item["type"] == "todo"
    assert todo_item["link"] == "/todo?id=test-todo-1"
    assert todo_item["is_read"] is False

    # 3. Mark single as read
    resp = await client.patch(f"/api/notifications/{n1.id}/read", headers=auth_headers)
    assert resp.status_code == 200

    # 4. Mark all as read
    resp = await client.patch("/api/notifications/read-all", headers=auth_headers)
    assert resp.status_code == 200

    # Verify unread count is now 0
    resp = await client.get("/api/notifications/unread-count", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["count"] == 0

    # 5. Delete one notification
    resp = await client.delete(f"/api/notifications/{n1.id}", headers=auth_headers)
    assert resp.status_code == 200

    # 6. Delete all notifications
    resp = await client.delete("/api/notifications", headers=auth_headers)
    assert resp.status_code == 200

    resp = await client.get("/api/notifications", headers=auth_headers)
    assert resp.status_code == 200
    assert len(resp.json()) == 0
