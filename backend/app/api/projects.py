from typing import List
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
import os
import uuid
import json
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.dependencies import get_db, get_current_user, require_role
from app.models.user import User, UserRole
from app.schemas.project import ProjectCreate, ProjectUpdate, ProjectOut, ProjectDetail, MemberAdd, MemberOut, ProjectTrashOut
from app.services import project_service

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("/trash", response_model=List[ProjectTrashOut])
async def list_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restituisce le commesse nel cestino con giorni rimanenti."""
    return await project_service.get_trash_projects(db, current_user)


@router.delete("/trash/empty", status_code=204)
async def empty_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Svuota completamente il cestino."""
    await project_service.empty_trash(db, current_user)


@router.post("/trash/{project_id}/restore")
async def restore_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ripristina una commessa dal cestino."""
    await project_service.restore_project(db, project_id, current_user)
    return {"status": "ok", "message": "Commessa ripristinata con successo"}


@router.delete("/trash/{project_id}", status_code=204)
async def hard_delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina definitivamente una commessa dal database."""
    await project_service.hard_delete_project(db, project_id, current_user)


@router.get("", response_model=List[ProjectOut])
async def list_projects(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await project_service.get_user_projects(db, current_user)


@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(
    data: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.EDITOR)),
):
    project = await project_service.create_project(db, data, current_user)
    import json
    assigned_workers_list = []
    if project.assigned_workers:
        try:
            parsed_aw = json.loads(project.assigned_workers)
            if isinstance(parsed_aw, list):
                assigned_workers_list = parsed_aw
        except:
            pass

    attachments_list = []
    if project.attachments:
        try:
            parsed_att = json.loads(project.attachments)
            if isinstance(parsed_att, list):
                attachments_list = parsed_att
        except:
            pass

    return ProjectOut(
        id=project.id, name=project.name, code=project.code, client=project.client, color=project.color or "#185FA5",
        description=project.description,
        notes=project.notes,
        start_date=project.start_date, end_date=project.end_date,
        status=project.status, owner_id=project.owner_id,
        responsible_id=project.responsible_id,
        responsible_username=project.responsible.username if project.responsible else None,
        responsible_name=project.responsible.full_name if project.responsible else (project.responsible.username if project.responsible else None),
        assigned_workers=assigned_workers_list,
        is_assigned=(current_user.id == project.owner_id or current_user.id == project.responsible_id or current_user.username in assigned_workers_list),
        is_atex=bool(getattr(project, 'is_atex', False) or False),
        is_alimentare=bool(getattr(project, 'is_alimentare', False) or False),
        attachments=attachments_list,
        created_at=project.created_at, updated_at=project.updated_at,
    )


@router.get("/{project_id}", response_model=ProjectDetail)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = await project_service.get_project(db, project_id, current_user)
    members = await project_service.get_project_members(db, project_id)
    import json
    assigned_workers_list = []
    if project.assigned_workers:
        try:
            parsed_aw = json.loads(project.assigned_workers)
            if isinstance(parsed_aw, list):
                assigned_workers_list = parsed_aw
        except:
            pass

    # pyrefly: ignore [missing-import]
    from sqlalchemy import select
    from app.models.task import Task
    tasks_res = await db.execute(select(Task.workers).where(Task.project_id == project_id))
    unique_workers = set()
    for row in tasks_res.all():
        if row.workers:
            try:
                w_list = json.loads(row.workers)
                for w in w_list:
                    unique_workers.add(w)
            except:
                pass

    is_assigned = (
        current_user.id == project.owner_id
        or current_user.id == project.responsible_id
        or (project.responsible and project.responsible.username == current_user.username)
        or (current_user.username in assigned_workers_list)
        or (current_user.full_name and current_user.full_name in assigned_workers_list)
        or (current_user.username in unique_workers)
        or (current_user.full_name and current_user.full_name in unique_workers)
    )

    attachments_list = []
    if project.attachments:
        try:
            parsed_att = json.loads(project.attachments)
            if isinstance(parsed_att, list):
                attachments_list = parsed_att
        except:
            pass

    return ProjectDetail(
        id=project.id, name=project.name, code=project.code, client=project.client, color=project.color or "#185FA5",
        description=project.description,
        notes=project.notes,
        start_date=project.start_date, end_date=project.end_date,
        status=project.status, owner_id=project.owner_id,
        responsible_id=project.responsible_id,
        responsible_username=project.responsible.username if project.responsible else None,
        responsible_name=project.responsible.full_name if project.responsible else (project.responsible.username if project.responsible else None),
        assigned_workers=assigned_workers_list,
        is_assigned=is_assigned,
        is_atex=bool(getattr(project, 'is_atex', False) or False),
        is_alimentare=bool(getattr(project, 'is_alimentare', False) or False),
        attachments=attachments_list,
        created_at=project.created_at, updated_at=project.updated_at,
        members=members,
    )


@router.put("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = await project_service.update_project(db, project_id, data, current_user)
    import json
    assigned_workers_list = []
    if project.assigned_workers:
        try:
            parsed_aw = json.loads(project.assigned_workers)
            if isinstance(parsed_aw, list):
                assigned_workers_list = parsed_aw
        except:
            pass

    attachments_list = []
    if project.attachments:
        try:
            parsed_att = json.loads(project.attachments)
            if isinstance(parsed_att, list):
                attachments_list = parsed_att
        except:
            pass

    return ProjectOut(
        id=project.id, name=project.name, code=project.code, client=project.client, color=project.color or "#185FA5",
        description=project.description,
        notes=project.notes,
        start_date=project.start_date, end_date=project.end_date,
        status=project.status, owner_id=project.owner_id,
        responsible_id=project.responsible_id,
        responsible_username=project.responsible.username if project.responsible else None,
        responsible_name=project.responsible.full_name if project.responsible else (project.responsible.username if project.responsible else None),
        assigned_workers=assigned_workers_list,
        is_assigned=(current_user.id == project.owner_id or current_user.id == project.responsible_id or current_user.username in assigned_workers_list),
        is_atex=bool(getattr(project, 'is_atex', False) or False),
        is_alimentare=bool(getattr(project, 'is_alimentare', False) or False),
        attachments=attachments_list,
        created_at=project.created_at, updated_at=project.updated_at,
    )


@router.delete("/{project_id}", status_code=204)
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await project_service.delete_project(db, project_id, current_user)


@router.post("/{project_id}/members", response_model=MemberOut, status_code=201)
async def add_member(
    project_id: str,
    data: MemberAdd,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    member = await project_service.add_member(db, project_id, data, current_user)
    # Recupera i dati utente per la response
    # pyrefly: ignore [missing-import]
    from sqlalchemy import select
    from app.models.user import User as UserModel
    result = await db.execute(select(UserModel).where(UserModel.id == member.user_id))
    user = result.scalar_one()
    return MemberOut(
        id=member.id, user_id=member.user_id,
        username=user.username, email=user.email, full_name=user.full_name,
        role=member.role,
    )


@router.delete("/{project_id}/members/{member_id}", status_code=204)
async def remove_member(
    project_id: str,
    member_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await project_service.remove_member(db, project_id, member_id, current_user)

PROJECTS_UPLOAD_DIR = "uploads/projects"
os.makedirs(PROJECTS_UPLOAD_DIR, exist_ok=True)
MAX_FILE_SIZE_MB = 10

@router.post("/{project_id}/attachments")
async def upload_project_attachment(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = await project_service.get_project(db, project_id, current_user)
    if not project_service.can_edit_project(project, current_user):
        raise HTTPException(status_code=403, detail="Solo admin, editor, owner o responsabile possono gestire gli allegati della commessa")

    content = await file.read()
    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"File troppo grande (max {MAX_FILE_SIZE_MB}MB)")

    ext = os.path.splitext(file.filename or "")[1]
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(PROJECTS_UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(content)

    attachments = []
    if project.attachments:
        try:
            attachments = json.loads(project.attachments)
            if not isinstance(attachments, list):
                attachments = []
        except:
            pass

    new_att = {"name": file.filename, "path": f"uploads/projects/{filename}"}
    attachments.append(new_att)
    project.attachments = json.dumps(attachments)
    await db.commit()

    return new_att

@router.delete("/{project_id}/attachments/{filename}")
async def delete_project_attachment(
    project_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = await project_service.get_project(db, project_id, current_user)
    if not project_service.can_edit_project(project, current_user):
        raise HTTPException(status_code=403, detail="Solo admin, editor, owner o responsabile possono gestire gli allegati della commessa")

    attachments = []
    if project.attachments:
        try:
            attachments = json.loads(project.attachments)
            if not isinstance(attachments, list):
                attachments = []
        except:
            pass

    new_attachments = []
    found = False
    for att in attachments:
        att_name = att.get("name", "")
        att_path = att.get("path", "")
        if att_name == filename or att_path.endswith(filename):
            found = True
            filepath = att.get("path")
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except:
                    pass
        else:
            new_attachments.append(att)

    if not found:
        raise HTTPException(status_code=404, detail="Allegato non trovato")

    project.attachments = json.dumps(new_attachments)
    await db.commit()
    return {"status": "ok"}


@router.post("/{project_id}/ai-analysis")
async def get_project_ai_analysis(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from app.services.project_ai_service import analyze_project_ai
    await project_service.get_project(db, project_id, current_user)
    result = await analyze_project_ai(db, project_id, current_user)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Errore durante l'analisi AI"))
    return result

