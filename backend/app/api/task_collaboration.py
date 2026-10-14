import os
import re
import uuid
import shutil
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.future import select
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload
from typing import List
from datetime import datetime

from app.services.project_service import require_project_access
from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.task import Task
from app.models.task_collaboration import TaskComment, TaskChecklistItem
from app.models.notification import Notification, NotificationType
from app.schemas.task_collaboration import (
    TaskCommentCreate, TaskCommentOut,
    TaskChecklistItemCreate, TaskChecklistItemUpdate, TaskChecklistItemOut
)

async def require_task_in_project(project_id: str, task_id: str, db: AsyncSession = Depends(get_db)) -> None:
    """La fase indicata nell'URL deve appartenere alla commessa (a cui l'utente ha già accesso)."""
    res = await db.execute(select(Task.id).where(Task.id == task_id, Task.project_id == project_id))
    if res.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Fase non trovata in questa commessa")


router = APIRouter(
    prefix="/api/projects/{project_id}/tasks/{task_id}",
    tags=["task-collaboration"],
    dependencies=[Depends(require_project_access), Depends(require_task_in_project)],
)

# --- COMMENTS ---
@router.get("/comments", response_model=List[TaskCommentOut])
async def get_comments(project_id: str, task_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(select(TaskComment).where(TaskComment.task_id == task_id).order_by(TaskComment.created_at.asc()))
    return result.scalars().all()

@router.post("/comments", response_model=TaskCommentOut)
async def add_comment(
    project_id: str,
    task_id: str,
    data: TaskCommentCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    # Verify task exists
    task_res = await db.execute(select(Task).where(Task.id == task_id))
    task = task_res.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    comment = TaskComment(
        task_id=task_id,
        author_id=current_user.id,
        content=data.content
    )
    db.add(comment)
    
    # Extract mentions and create notifications
    mentions = set(re.findall(r"@(\w+)", data.content))
    if mentions:
        users_res = await db.execute(select(User).where(User.username.in_(mentions)))
        mentioned_users = users_res.scalars().all()
        for u in mentioned_users:
            if u.id != current_user.id:
                notif = Notification(
                    user_id=u.id,
                    title="Sei stato menzionato",
                    message=f"{current_user.full_name or current_user.username} ti ha menzionato nel task '{task.text}'",
                    type=NotificationType.UPDATE,
                    project_id=project_id,
                    task_id=task_id
                )
                db.add(notif)
                
    await db.commit()
    await db.refresh(comment)
    return comment

@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    project_id: str,
    task_id: str,
    comment_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(select(TaskComment).where(TaskComment.id == comment_id, TaskComment.task_id == task_id))
    comment = res.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")
    
    # Only author or admin can delete
    if comment.author_id != current_user.id and current_user.role.value != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to delete this comment")
        
    await db.delete(comment)
    await db.commit()
    return None


# --- CHECKLISTS ---
@router.get("/checklists", response_model=List[TaskChecklistItemOut])
async def get_checklists(project_id: str, task_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    result = await db.execute(select(TaskChecklistItem).where(TaskChecklistItem.task_id == task_id).order_by(TaskChecklistItem.created_at.asc()))
    return result.scalars().all()

@router.post("/checklists", response_model=TaskChecklistItemOut)
async def add_checklist_item(
    project_id: str,
    task_id: str,
    data: TaskChecklistItemCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    item = TaskChecklistItem(task_id=task_id, text=data.text)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item

@router.put("/checklists/{item_id}", response_model=TaskChecklistItemOut)
async def update_checklist_item(
    project_id: str,
    task_id: str,
    item_id: str,
    data: TaskChecklistItemUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(select(TaskChecklistItem).where(TaskChecklistItem.id == item_id, TaskChecklistItem.task_id == task_id))
    item = res.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=404, detail="Checklist item not found")
        
    item.is_completed = data.is_completed
    await db.commit()
    await db.refresh(item)
    return item

@router.delete("/checklists/{item_id}", status_code=204)
async def delete_checklist_item(
    project_id: str,
    task_id: str,
    item_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    res = await db.execute(select(TaskChecklistItem).where(TaskChecklistItem.id == item_id, TaskChecklistItem.task_id == task_id))
    item = res.scalar_one_or_none()
    if item:
        await db.delete(item)
        await db.commit()
    return None

