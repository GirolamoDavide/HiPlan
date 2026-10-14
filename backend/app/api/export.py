# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, Query, Body
# pyrefly: ignore [missing-import]
from fastapi.responses import StreamingResponse
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
from typing import List
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
from app.services import project_service
from app.services.project_service import require_project_access
from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.services import export_service

router = APIRouter(prefix="/api/projects", tags=["export"])

class ExportProjectsRequest(BaseModel):
    project_ids: List[str]

@router.get("/{project_id}/export/excel", dependencies=[Depends(require_project_access)])
async def export_excel(
    project_id: str,
    sections: str = Query("tasks,hours", description="Sezioni da includere: tasks, hours, gantt (separate da virgola)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sections_list = [s.strip() for s in sections.split(",") if s.strip()]
    buffer = await export_service.export_excel(db, project_id, sections=sections_list)
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=project_{project_id}.xlsx"},
    )


@router.get("/{project_id}/export/pdf", dependencies=[Depends(require_project_access)])
async def export_pdf(
    project_id: str,
    sections: str = Query("tasks,hours", description="Sezioni da includere: tasks, hours, gantt (separate da virgola)"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sections_list = [s.strip() for s in sections.split(",") if s.strip()]
    buffer = await export_service.export_pdf(db, project_id, sections=sections_list)
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=project_{project_id}.pdf"},
    )

async def _visible_project_ids(db: AsyncSession, user: User, project_ids: List[str]) -> List[str]:
    """Esclude dagli export multipli le commesse che l'utente non può vedere."""
    visible = {p.id for p in await project_service.get_user_projects(db, user)}
    return [pid for pid in project_ids if pid in visible]


@router.post("/export-list/excel")
async def export_projects_list_excel(
    request: ExportProjectsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    buffer = await export_service.export_projects_list_excel(db, await _visible_project_ids(db, current_user, request.project_ids))
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=projects_list.xlsx"},
    )

@router.post("/export-list/pdf")
async def export_projects_list_pdf(
    request: ExportProjectsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    buffer = await export_service.export_projects_list_pdf(db, await _visible_project_ids(db, current_user, request.project_ids))
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=projects_list.pdf"},
    )
