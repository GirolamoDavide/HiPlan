# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.schemas.task import TaskCreate, TaskUpdate, TaskOut, LinkCreate, LinkOut, GanttData
from app.services import task_service
from app.services.project_service import require_project_access

router = APIRouter(prefix="/api/projects/{project_id}", tags=["tasks"], dependencies=[Depends(require_project_access)])


@router.get("/gantt", response_model=GanttData)
async def get_gantt_data(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await task_service.get_gantt_data(db, project_id)


@router.post("/tasks", response_model=TaskOut, status_code=201)
async def create_task(
    project_id: str,
    data: TaskCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await task_service.create_task(db, project_id, data, current_user)


@router.put("/tasks/{task_id}", response_model=TaskOut)
async def update_task(
    task_id: str,
    data: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await task_service.update_task(db, task_id, data, current_user)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await task_service.delete_task(db, task_id, current_user)


@router.post("/links", response_model=LinkOut, status_code=201)
async def create_link(
    project_id: str,
    data: LinkCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await task_service.create_link(db, project_id, data, current_user)


@router.delete("/links/{link_id}", status_code=204)
async def delete_link(
    project_id: str,
    link_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await task_service.delete_link(db, link_id, current_user)


from app.schemas.task import LogHoursRequest
@router.post("/tasks/{task_id}/log-hours", response_model=TaskOut)
async def log_task_hours_endpoint(
    project_id: str,
    task_id: str,
    data: LogHoursRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await task_service.log_task_hours(db, task_id, data.date, data.hours, current_user)

