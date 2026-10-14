from typing import List, Optional
from datetime import datetime, timedelta
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select, func
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload
from app.models.project import Project, ProjectMember, MemberRole
from app.models.task import Task, TaskType
from app.models.user import User, UserRole
from app.schemas.project import ProjectCreate, ProjectUpdate, MemberAdd, ProjectOut, MemberOut
from app.models.notification import Notification, NotificationType
# pyrefly: ignore [missing-import]
from fastapi import HTTPException, status
from app.core.websocket_manager import manager


async def get_user_projects(db: AsyncSession, user: User) -> List[ProjectOut]:
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.responsible))
        .where(Project.deleted_at.is_(None))
        .order_by(Project.created_at.desc())
    )
    projects = result.scalars().all()

    output = []
    import json
    for p in projects:
        tasks_data = await db.execute(
            select(Task.id, Task.progress, Task.workers, Task.type)
            .where(Task.project_id == p.id)
        )
        tasks_rows = tasks_data.all()
        
        progress_tasks = [row for row in tasks_rows if row.type != TaskType.MILESTONE]
        task_count = len(progress_tasks)
        avg_progress = sum((row.progress or 0) for row in progress_tasks) / task_count if task_count > 0 else 0.0
        
        unique_workers = set()
        for row in tasks_rows:
            if row.workers:
                try:
                    w_list = json.loads(row.workers)
                    for w in w_list:
                        unique_workers.add(w)
                except:
                    pass
        
        assigned_workers_list = []
        if p.assigned_workers:
            try:
                parsed_aw = json.loads(p.assigned_workers)
                if isinstance(parsed_aw, list):
                    assigned_workers_list = parsed_aw
            except:
                pass

        all_workers = unique_workers.union(set(assigned_workers_list))
        worker_count = len(all_workers)

        is_assigned = (
            user.id == p.owner_id
            or user.id == p.responsible_id
            or (p.responsible and p.responsible.username == user.username)
            or (user.username in assigned_workers_list)
            or (user.full_name and user.full_name in assigned_workers_list)
            or (user.username in unique_workers)
            or (user.full_name and user.full_name in unique_workers)
        )

        attachments_list = []
        if p.attachments:
            try:
                parsed_att = json.loads(p.attachments)
                if isinstance(parsed_att, list):
                    attachments_list = parsed_att
            except:
                pass

        out = ProjectOut(
            id=p.id, name=p.name, code=p.code, client=p.client, color=p.color or "#185FA5",
            description=p.description,
            start_date=p.start_date, end_date=p.end_date,
            status=p.status, owner_id=p.owner_id,
            responsible_id=p.responsible_id,
            responsible_username=p.responsible.username if p.responsible else None,
            responsible_name=p.responsible.full_name if p.responsible else (p.responsible.username if p.responsible else None),
            assigned_workers=assigned_workers_list,
            is_assigned=is_assigned,
            created_at=p.created_at, updated_at=p.updated_at,
            task_count=task_count, member_count=worker_count,
            progress=round(avg_progress, 2),
            attachments=attachments_list,
            is_atex=bool(getattr(p, 'is_atex', False) or False),
            is_alimentare=bool(getattr(p, 'is_alimentare', False) or False),
        )
        output.append(out)
    return output


async def create_project(db: AsyncSession, data: ProjectCreate, owner: User) -> Project:
    import json
    project_code = (data.code or "").strip() if data.code else None
    project_name = (data.name or "").strip() or project_code or "Nuova Commessa"
    project_client = (data.client or "").strip() if data.client else None

    project = Project(
        name=project_name,
        code=project_code,
        client=project_client,
        color=data.color or "#185FA5",
        description=data.description,
        start_date=data.start_date,
        end_date=data.end_date,
        status=data.status,
        owner_id=owner.id,
        responsible_id=data.responsible_id if data.responsible_id else None,
        assigned_workers=json.dumps(data.assigned_workers) if data.assigned_workers else "[]",
        is_atex=bool(data.is_atex),
        is_alimentare=bool(data.is_alimentare),
    )
    db.add(project)
    await db.flush()
    
    from app.models.activity_log import ActivityLog, ActivityCategory
    log = ActivityLog(
        project_id=project.id,
        user_id=owner.id,
        category=ActivityCategory.PHASE_PROJECT_EDIT,
        action_text=f"Commessa creata: '{project.name}'"
    )
    db.add(log)
    
    await db.commit()
    
    result = await db.execute(
        select(Project).options(selectinload(Project.responsible)).where(Project.id == project.id)
    )
    return result.scalar_one()


async def get_project(db: AsyncSession, project_id: str, user: User, allow_deleted: bool = False) -> Project:
    query = (
        select(Project)
        .options(selectinload(Project.members), selectinload(Project.responsible))
        .where(Project.id == project_id)
    )
    if not allow_deleted:
        query = query.where(Project.deleted_at.is_(None))
    result = await db.execute(query.execution_options(populate_existing=True))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Progetto non trovato")

    return project


async def update_project(db: AsyncSession, project_id: str, data: ProjectUpdate, user: User) -> Project:
    project = await get_project(db, project_id, user)
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR) and project.owner_id != user.id and project.responsible_id != user.id:
        member = next((m for m in project.members if m.user_id == user.id), None)
        if not member or member.role != MemberRole.MANAGER:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo owner/manager/responsabile possono modificare")

    update_data = data.model_dump(exclude_unset=True)
    new_start = update_data.get("start_date", project.start_date)
    new_end = update_data.get("end_date", project.end_date)
    if new_start and new_end and new_end < new_start:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="La data di fine non può precedere la data di inizio")

    import json
    for key, value in update_data.items():
        if key == "assigned_workers":
            value = json.dumps(value) if value is not None else "[]"
        setattr(project, key, value)
        
    from app.models.activity_log import ActivityLog, ActivityCategory
    log = ActivityLog(
        project_id=project.id,
        user_id=user.id,
        category=ActivityCategory.PHASE_PROJECT_EDIT,
        action_text=f"Commessa modificata"
    )
    db.add(log)
    
    await db.commit()
    
    # Broadcast websocket
    await manager.broadcast(project_id, {"action": "project_updated"})

    return await get_project(db, project_id, user)


async def delete_project(db: AsyncSession, project_id: str, user: User):
    """Sposta la commessa nel cestino (Soft Delete)."""
    project = await get_project(db, project_id, user)
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin ed editor possono eliminare le commesse")
    project.deleted_at = datetime.utcnow()
    await db.commit()


async def purge_expired_trash(db: AsyncSession):
    """Elimina definitivamente le commesse nel cestino da più di 90 giorni."""
    cutoff = datetime.utcnow() - timedelta(days=90)
    res = await db.execute(select(Project).where(Project.deleted_at.isnot(None), Project.deleted_at <= cutoff))
    expired = res.scalars().all()
    for p in expired:
        await db.delete(p)
    if expired:
        await db.commit()


async def get_trash_projects(db: AsyncSession, user: User) -> List[dict]:
    """Restituisce l'elenco delle commesse nel cestino con giorni rimanenti."""
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Non hai i permessi per accedere al cestino")

    # Pulizia automatica preventiva dei record > 90 giorni
    await purge_expired_trash(db)

    res = await db.execute(
        select(Project)
        .where(Project.deleted_at.isnot(None))
        .order_by(Project.deleted_at.desc())
    )
    trashed = res.scalars().all()
    now = datetime.utcnow()
    items = []
    for p in trashed:
        tasks_res = await db.execute(select(func.count(Task.id)).where(Task.project_id == p.id))
        task_count = tasks_res.scalar_one() or 0

        deleted_dt = p.deleted_at or now
        elapsed_days = (now - deleted_dt).days
        days_left = max(0, 90 - elapsed_days)

        items.append({
            "id": str(p.id),
            "name": p.name,
            "code": p.code,
            "client": p.client,
            "color": p.color,
            "status": p.status,
            "deleted_at": p.deleted_at,
            "days_left": days_left,
            "task_count": task_count,
        })
    return items


async def restore_project(db: AsyncSession, project_id: str, user: User) -> Project:
    """Ripristina una commessa dal cestino."""
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin ed editor possono ripristinare le commesse")
    project = await get_project(db, project_id, user, allow_deleted=True)
    if project.deleted_at:
        project.deleted_at = None
        await db.commit()
    return project


async def hard_delete_project(db: AsyncSession, project_id: str, user: User):
    """Elimina definitivamente una commessa dal database."""
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin ed editor possono eliminare definitivamente le commesse")
    project = await get_project(db, project_id, user, allow_deleted=True)
    await db.delete(project)
    await db.commit()


async def empty_trash(db: AsyncSession, user: User):
    """Svuota completamente il cestino."""
    if user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo admin ed editor possono svuotare il cestino")
    res = await db.execute(select(Project).where(Project.deleted_at.isnot(None)))
    trashed = res.scalars().all()
    for p in trashed:
        await db.delete(p)
    if trashed:
        await db.commit()


async def add_member(db: AsyncSession, project_id: str, data: MemberAdd, user: User) -> ProjectMember:
    project = await get_project(db, project_id, user)

    # Verifica permessi
    if user.role != UserRole.ADMIN and project.owner_id != user.id:
        member = next((m for m in project.members if m.user_id == user.id), None)
        if not member or member.role != MemberRole.MANAGER:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo owner/manager possono aggiungere membri")

    # Verifica che l'utente esista
    target = await db.execute(select(User).where(User.id == data.user_id))
    if not target.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Utente non trovato")

    # Verifica duplicato
    existing = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == data.user_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Utente già membro del progetto")

    member = ProjectMember(project_id=project_id, user_id=data.user_id, role=data.role)
    db.add(member)

    # Notifica
    notification = Notification(
        user_id=data.user_id,
        title=f"Aggiunto al progetto: {project.name}",
        message=f"Sei stato aggiunto come {data.role.value} al progetto '{project.name}'",
        type=NotificationType.ASSIGNMENT,
        project_id=project_id,
    )
    db.add(notification)

    await db.commit()
    await db.refresh(member)
    return member


async def remove_member(db: AsyncSession, project_id: str, member_id: str, user: User):
    project = await get_project(db, project_id, user)
    if user.role != UserRole.ADMIN and project.owner_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo owner/admin possono rimuovere membri")

    result = await db.execute(
        select(ProjectMember).where(ProjectMember.id == member_id, ProjectMember.project_id == project_id)
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Membro non trovato")

    await db.delete(member)
    await db.commit()


async def get_project_members(db: AsyncSession, project_id: str) -> List[MemberOut]:
    result = await db.execute(
        select(ProjectMember, User)
        .join(User, User.id == ProjectMember.user_id)
        .where(ProjectMember.project_id == project_id)
    )
    members = []
    for pm, u in result.all():
        members.append(MemberOut(
            id=pm.id, user_id=pm.user_id,
            username=u.username, email=u.email, full_name=u.full_name,
            role=pm.role,
        ))
    return members
