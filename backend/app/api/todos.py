import json
import os
import uuid
import logging
from typing import List, Optional
from datetime import date, datetime, timedelta

# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select, or_
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_db, get_current_user
from app.models.user import User, UserRole
from app.models.todo import Todo
from app.schemas.todo import TodoCreate, TodoUpdate, TodoOut

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/todos", tags=["todos"])

UPLOAD_DIR = "uploads/todos"


def _serialize_todo(todo: Todo, all_users: dict) -> dict:
    """Converte un oggetto Todo in un dizionario serializzabile."""
    try:
        assignees = json.loads(todo.assignees) if todo.assignees else []
    except Exception:
        assignees = []

    try:
        attachments = json.loads(todo.attachments) if todo.attachments else []
    except Exception:
        attachments = []

    assignees_detail = []
    for uid in assignees:
        u = all_users.get(uid)
        if u:
            assignees_detail.append({
                "id": u.id,
                "username": u.username,
                "full_name": u.full_name,
                "email": u.email,
            })

    creator = all_users.get(todo.creator_id) or getattr(todo, "creator", None)

    return {
        "id": todo.id,
        "title": todo.title,
        "content": todo.content,
        "notify_date": todo.notify_date.isoformat() if todo.notify_date else None,
        "due_date": todo.due_date.isoformat() if todo.due_date else None,
        "creator_id": todo.creator_id,
        "creator_username": creator.username if creator else None,
        "creator_full_name": creator.full_name if creator else None,
        "assignees": assignees,
        "assignees_detail": assignees_detail,
        "attachments": attachments,
        "notify_email": todo.notify_email,
        "is_completed": todo.is_completed,
        "deleted_at": todo.deleted_at.isoformat() if getattr(todo, "deleted_at", None) else None,
        "created_at": todo.created_at.isoformat() if todo.created_at else None,
        "updated_at": todo.updated_at.isoformat() if todo.updated_at else None,
    }


async def _get_users_dict(db: AsyncSession) -> dict:
    """Restituisce un dict {user_id: User} per tutti gli utenti attivi."""
    result = await db.execute(select(User).where(User.is_active == True))
    users = result.scalars().all()
    return {u.id: u for u in users}


async def purge_expired_todo_trash(db: AsyncSession):
    """Elimina definitivamente i TODO nel cestino da più di 90 giorni."""
    cutoff = datetime.utcnow() - timedelta(days=90)
    res = await db.execute(select(Todo).where(Todo.deleted_at.isnot(None), Todo.deleted_at <= cutoff))
    expired = res.scalars().all()
    for t in expired:
        try:
            attachments = json.loads(t.attachments) if t.attachments else []
            for att in attachments:
                fpath = att.get("path", "")
                if fpath and os.path.exists(fpath):
                    os.remove(fpath)
        except Exception:
            pass
        await db.delete(t)
    if expired:
        await db.commit()


@router.get("/trash", response_model=List[dict])
async def list_trash_todos(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restituisce i TODO nel cestino con giorni rimanenti (90 giorni). Riservato ad admin ed editor."""
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso al cestino riservato ad amministratori ed editor"
        )
    await purge_expired_todo_trash(db)

    result = await db.execute(
        select(Todo)
        .options(selectinload(Todo.creator))
        .where(Todo.deleted_at.isnot(None))
        .order_by(Todo.deleted_at.desc())
    )
    all_trashed = result.scalars().all()
    all_users = await _get_users_dict(db)
    now = datetime.utcnow()

    items = []
    for t in all_trashed:
        deleted_dt = t.deleted_at or now
        elapsed_days = (now - deleted_dt).days
        days_left = max(0, 90 - elapsed_days)

        s = _serialize_todo(t, all_users)
        s["days_left"] = days_left
        items.append(s)

    return items


@router.delete("/trash/empty", status_code=status.HTTP_204_NO_CONTENT)
async def empty_trash_todos(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Svuota il cestino dei TODO. Riservato ad admin ed editor."""
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo admin ed editor possono svuotare il cestino dei TODO"
        )
    result = await db.execute(select(Todo).where(Todo.deleted_at.isnot(None)))
    trashed = result.scalars().all()
    deleted_count = 0
    for t in trashed:
        try:
            attachments = json.loads(t.attachments) if t.attachments else []
            for att in attachments:
                fpath = att.get("path", "")
                if fpath and os.path.exists(fpath):
                    os.remove(fpath)
        except Exception:
            pass
        await db.delete(t)
        deleted_count += 1
    if deleted_count > 0:
        await db.commit()


@router.post("/trash/{todo_id}/restore")
async def restore_todo(
    todo_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ripristina un TODO dal cestino. Riservato ad admin ed editor."""
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo admin ed editor possono ripristinare i TODO dal cestino"
        )
    result = await db.execute(select(Todo).where(Todo.id == todo_id))
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    todo.deleted_at = None
    await db.commit()
    result = await db.execute(
        select(Todo).options(selectinload(Todo.creator)).where(Todo.id == todo_id)
    )
    todo = result.scalar_one()
    all_users = await _get_users_dict(db)
    return _serialize_todo(todo, all_users)


@router.delete("/trash/{todo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def hard_delete_todo(
    todo_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina definitivamente un TODO dal database e rimuove gli allegati fisici. Riservato ad admin ed editor."""
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo admin ed editor possono eliminare definitivamente i TODO"
        )
    result = await db.execute(select(Todo).where(Todo.id == todo_id))
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    try:
        attachments = json.loads(todo.attachments) if todo.attachments else []
        for att in attachments:
            fpath = att.get("path", "")
            if fpath and os.path.exists(fpath):
                os.remove(fpath)
    except Exception:
        pass

    await db.delete(todo)
    await db.commit()


@router.get("", response_model=List[dict])
async def list_todos(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Restituisce solo i TODO visibili all'utente corrente e non cestinati:
    - quelli creati da lui
    - quelli in cui è assegnato
    """
    result = await db.execute(
        select(Todo)
        .options(selectinload(Todo.creator))
        .where(Todo.deleted_at.is_(None))
        .order_by(Todo.created_at.desc())
    )
    all_todos = result.scalars().all()
    all_users = await _get_users_dict(db)

    visible = []
    for t in all_todos:
        assignees = []
        try:
            assignees = json.loads(t.assignees) if t.assignees else []
        except Exception:
            pass
        if t.creator_id == current_user.id or current_user.id in assignees:
            visible.append(_serialize_todo(t, all_users))

    return visible



@router.post("", status_code=status.HTTP_201_CREATED)
async def create_todo(
    data: TodoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    assignees = list(data.assignees)

    todo = Todo(
        title=data.title,
        content=data.content,
        notify_date=data.notify_date,
        due_date=data.due_date,
        creator_id=current_user.id,
        assignees=json.dumps(assignees),
        attachments="[]",
        notify_email=data.notify_email,
        is_completed=False,
        notify_sent=False,
        due_reminder_sent=False,
    )
    db.add(todo)
    await db.commit()
    await db.refresh(todo)

    all_users = await _get_users_dict(db)

    # Notifica in-app a tutti gli assegnati (escluso il creatore)
    from app.models.notification import Notification, NotificationType
    for uid in assignees:
        notif_title = f"📋 TODO: {todo.title}" if data.notify_now else f"Nuovo TODO: {todo.title}"
        notif_msg = f"{current_user.full_name or current_user.username} ti ha inviato un promemoria per il TODO." if data.notify_now else f"{current_user.full_name or current_user.username} ti ha assegnato un TODO."
        notif = Notification(
            user_id=uid,
            title=notif_title,
            message=notif_msg,
            type=NotificationType.TODO,
            link=f"/todo?id={todo.id}"
        )
        db.add(notif)
    await db.commit()

    # Email di notifica immediata se l'utente ha esplicitamente spuntato 'notify_now'
    if data.notify_now:
        try:
            from app.services.email_service import send_todo_notification_email
            recipient_emails = [all_users[uid].email for uid in assignees if uid in all_users and all_users[uid].email]
            if recipient_emails:
                import asyncio
                asyncio.create_task(send_todo_notification_email(
                    to_addresses=recipient_emails,
                    todo_title=todo.title,
                    todo_content=todo.content,
                    creator_name=current_user.full_name or current_user.username,
                    notify_type="notification",
                    todo_due_date=todo.due_date,
                ))
        except Exception as e:
            logger.warning(f"[TODO] Errore invio email immediata: {e}")

            logger.warning(f"[TODO] Errore invio email immediata: {e}")

    return _serialize_todo(todo, all_users)


@router.patch("/{todo_id}")
async def update_todo(
    todo_id: str,
    data: TodoUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Todo).options(selectinload(Todo.creator)).where(Todo.id == todo_id)
    )
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    if todo.creator_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Non autorizzato. Solo il creatore o un amministratore possono modificare questo TODO")

    if data.title is not None:
        todo.title = data.title
    if data.content is not None:
        todo.content = data.content
    if data.notify_date is not None:
        todo.notify_date = data.notify_date
        todo.notify_sent = False
    if data.due_date is not None:
        todo.due_date = data.due_date
        todo.due_reminder_sent = False
    if data.notify_email is not None:
        todo.notify_email = data.notify_email
    if data.is_completed is not None:
        todo.is_completed = data.is_completed
    if data.assignees is not None:
        todo.assignees = json.dumps(list(data.assignees))

    await db.commit()
    await db.refresh(todo)
    all_users = await _get_users_dict(db)

    if data.notify_now:
        try:
            from app.models.notification import Notification, NotificationType
            from app.services.email_service import send_todo_notification_email
            assignees_list = json.loads(todo.assignees) if todo.assignees else []
            
            # Crea notifica in-app
            for uid in assignees_list:
                notif = Notification(
                    user_id=uid,
                    title=f"📋 TODO: {todo.title}",
                    message=f"{current_user.full_name or current_user.username} ti ha inviato un promemoria per il TODO.",
                    type=NotificationType.TODO,
                    link=f"/todo?id={todo.id}"
                )
                db.add(notif)
            await db.commit()

            recipient_emails = [all_users[uid].email for uid in assignees_list if uid in all_users and all_users[uid].email]
            if recipient_emails:
                import asyncio
                asyncio.create_task(send_todo_notification_email(
                    to_addresses=recipient_emails,
                    todo_title=todo.title,
                    todo_content=todo.content,
                    creator_name=current_user.full_name or current_user.username,
                    notify_type="notification",
                    todo_due_date=todo.due_date,
                ))
        except Exception as e:
            logger.warning(f"[TODO] Errore invio email immediata (update): {e}")

    return _serialize_todo(todo, all_users)


@router.delete("/{todo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_todo(
    todo_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Todo).where(Todo.id == todo_id))
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    # Solo creator o admin possono eliminare
    if todo.creator_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Solo il creatore o un amministratore possono eliminare questo TODO")

    # Soft delete: sposta nel cestino per 90 giorni
    todo.deleted_at = datetime.utcnow()
    await db.commit()



@router.post("/{todo_id}/attachments")
async def upload_attachment(
    todo_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Todo).where(Todo.id == todo_id))
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    if todo.creator_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Non autorizzato. Solo il creatore può aggiungere allegati")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename)[1] if file.filename else ""
    unique_name = f"{uuid.uuid4()}{ext}"
    file_path = os.path.join(UPLOAD_DIR, unique_name)

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    attachments = []
    try:
        attachments = json.loads(todo.attachments) if todo.attachments else []
    except Exception:
        pass

    attachment_info = {
        "filename": file.filename,
        "path": file_path,
        "url": f"/{file_path}",
        "size": len(content),
    }
    attachments.append(attachment_info)
    todo.attachments = json.dumps(attachments)
    await db.commit()

    return attachment_info


@router.delete("/{todo_id}/attachments/{filename}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_attachment(
    todo_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Todo).where(Todo.id == todo_id))
    todo = result.scalar_one_or_none()
    if not todo:
        raise HTTPException(status_code=404, detail="TODO non trovato")

    if todo.creator_id != current_user.id and current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Non autorizzato")

    attachments = []
    try:
        attachments = json.loads(todo.attachments) if todo.attachments else []
    except Exception:
        pass

    new_attachments = []
    for att in attachments:
        if att.get("filename") == filename:
            fpath = att.get("path", "")
            if fpath and os.path.exists(fpath):
                os.remove(fpath)
        else:
            new_attachments.append(att)

    todo.attachments = json.dumps(new_attachments)
    await db.commit()
