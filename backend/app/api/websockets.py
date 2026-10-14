# pyrefly: ignore [missing-import]
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status
# pyrefly: ignore [missing-import]
from sqlalchemy import select
# pyrefly: ignore [missing-import]
from fastapi import HTTPException

from app.core.security import decode_token
from app.core.websocket_manager import manager
from app.models.base import AsyncSessionLocal
from app.models.user import User
from app.services.project_service import get_project

router = APIRouter(prefix="/api/ws", tags=["WebSockets"])


async def _authorize(token: str, project_id: str) -> bool:
    """Il browser non può inviare l'header Authorization sul WebSocket: il token arriva in query string."""
    payload = decode_token(token) if token else None
    if not payload or payload.get("type") != "access" or not payload.get("sub"):
        return False
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.id == payload["sub"]))).scalar_one_or_none()
        if not user or not user.is_active:
            return False
        try:
            await get_project(db, project_id, user)
        except HTTPException:
            return False
    return True


@router.websocket("/projects/{project_id}")
async def websocket_project_endpoint(
    websocket: WebSocket,
    project_id: str,
    token: str = Query(default=""),
):
    """Aggiornamenti in tempo reale di una commessa, solo per utenti autenticati che possono vederla."""
    if not await _authorize(token, project_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(websocket, project_id)
    try:
        while True:
            # Il server invia solo aggiornamenti: i messaggi del client (es. ping) vengono ignorati
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, project_id)
