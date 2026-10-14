# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status, Query
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select
from app.core.dependencies import get_db, get_current_user, require_role
from app.models.user import User, UserRole
from app.models.phase_template import PhaseTemplate
# pyrefly: ignore [missing-import]
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/api/phase-templates", tags=["phase_templates"])


class PhaseTemplateCreate(BaseModel):
    name: str
    department: str = "ufficio_tecnico"
    default_color: str = "#3b82f6"
    is_custom: bool = False
    default_days: Optional[int] = None
    default_hours: Optional[float] = None
    default_budget_mode: Optional[str] = "start_days"


class PhaseTemplateUpdate(BaseModel):
    name: Optional[str] = None
    department: Optional[str] = None
    default_color: Optional[str] = None
    default_days: Optional[int] = None
    default_hours: Optional[float] = None
    default_budget_mode: Optional[str] = None


@router.get("")
async def list_phase_templates(
    department: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = select(PhaseTemplate)
    if department and department != "all":
        query = query.where((PhaseTemplate.department == department) | (PhaseTemplate.department == "condivisa"))
    
    query = query.order_by(PhaseTemplate.department, PhaseTemplate.name)
    result = await db.execute(query)
    templates = result.scalars().all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "department": t.department,
            "default_color": t.default_color,
            "is_custom": t.is_custom,
            "default_days": t.default_days,
            "default_hours": t.default_hours,
            "default_budget_mode": t.default_budget_mode or "start_days",
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in templates
    ]


@router.post("", status_code=201)
async def create_phase_template(
    data: PhaseTemplateCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.EDITOR)),
):
    if not data.name or not data.name.strip():
        raise HTTPException(status_code=400, detail="Il nome della fase è obbligatorio")

    clean_name = data.name.strip()
    # Controlla se esiste già una fase con lo stesso nome per questo reparto o condivisa
    result = await db.execute(
        select(PhaseTemplate).where(
            (PhaseTemplate.name == clean_name) & (PhaseTemplate.department == data.department)
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        if data.default_color:
            existing.default_color = data.default_color
        if data.default_budget_mode:
            existing.default_budget_mode = data.default_budget_mode
        if data.default_days is not None:
            existing.default_days = data.default_days
        if data.default_hours is not None:
            existing.default_hours = data.default_hours
        await db.commit()
        await db.refresh(existing)
        return {
            "id": existing.id,
            "name": existing.name,
            "department": existing.department,
            "default_color": existing.default_color,
            "is_custom": existing.is_custom,
            "default_days": existing.default_days,
            "default_hours": existing.default_hours,
            "default_budget_mode": existing.default_budget_mode or "start_days",
        }

    template = PhaseTemplate(
        name=clean_name,
        department=data.department,
        default_color=data.default_color or "#3b82f6",
        is_custom=data.is_custom,
        default_days=data.default_days,
        default_hours=data.default_hours,
        default_budget_mode=data.default_budget_mode or "start_days",
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return {
        "id": template.id,
        "name": template.name,
        "department": template.department,
        "default_color": template.default_color,
        "is_custom": template.is_custom,
        "default_days": template.default_days,
        "default_hours": template.default_hours,
        "default_budget_mode": template.default_budget_mode or "start_days",
    }


@router.put("/{template_id}")
async def update_phase_template(
    template_id: str,
    data: PhaseTemplateUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.EDITOR)),
):
    result = await db.execute(select(PhaseTemplate).where(PhaseTemplate.id == template_id))
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Fase preimpostata non trovata")

    if data.name is not None and data.name.strip():
        template.name = data.name.strip()
    if data.department is not None:
        template.department = data.department
    if data.default_color is not None:
        template.default_color = data.default_color
    if hasattr(data, 'default_days'):
        template.default_days = data.default_days
    if hasattr(data, 'default_hours'):
        template.default_hours = data.default_hours
    if data.default_budget_mode is not None:
        template.default_budget_mode = data.default_budget_mode

    await db.commit()
    await db.refresh(template)
    return {
        "id": template.id,
        "name": template.name,
        "department": template.department,
        "default_color": template.default_color,
        "is_custom": template.is_custom,
        "default_days": template.default_days,
        "default_hours": template.default_hours,
        "default_budget_mode": template.default_budget_mode or "start_days",
    }


@router.delete("/{template_id}")
async def delete_phase_template(
    template_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_role(UserRole.ADMIN, UserRole.EDITOR)),
):
    result = await db.execute(select(PhaseTemplate).where(PhaseTemplate.id == template_id))
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Fase preimpostata non trovata")

    await db.delete(template)
    await db.commit()
    return {"ok": True}