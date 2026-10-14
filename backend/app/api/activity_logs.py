# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.future import select
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload
# pyrefly: ignore [missing-import]
from sqlalchemy import desc
from typing import List, Any
from datetime import timezone
import uuid

from app.models.base import AsyncSessionLocal
from app.models.activity_log import ActivityLog
from app.models.user import User, UserRole
from app.core.dependencies import get_current_user
from app.services.project_service import require_project_access

router = APIRouter(prefix="/api/projects/{project_id}/activity_logs", tags=["Activity Logs"], dependencies=[Depends(require_project_access)])

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session

@router.get("")
async def get_activity_logs(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Non autorizzato. Solo gli admin possono vedere l'activity log.")
    
    try:
        uuid.UUID(project_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project_id format")

    stmt = (
        select(ActivityLog)
        .where(ActivityLog.project_id == project_id)
        .options(selectinload(ActivityLog.user))
        .order_by(desc(ActivityLog.created_at))
    )
    result = await db.execute(stmt)
    logs = result.scalars().all()

    # Format the response
    formatted_logs = []
    for log in logs:
        formatted_logs.append({
            "id": log.id,
            "project_id": log.project_id,
            "user_id": log.user_id,
            "category": log.category.value,
            "action_text": log.action_text,
            "created_at": (log.created_at.replace(tzinfo=timezone.utc).isoformat() if log.created_at.tzinfo is None else log.created_at.isoformat()) if log.created_at else None,
            "user_name": log.user.full_name if log.user else "Sistema"
        })

    return formatted_logs
