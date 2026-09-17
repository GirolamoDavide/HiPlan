import json
from typing import List, Optional
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status
# pyrefly: ignore [missing-import]
from sqlalchemy import select, desc
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.models.automation import AutomationRule, AutomationLog
from app.models.task import Task
from app.models.user import User, UserRole
from app.schemas.automation import (
    AutomationRuleCreate,
    AutomationRuleUpdate,
    AutomationRuleOut,
    AutomationLogOut,
)
from app.core.dependencies import get_db, get_current_user
from app.services.automation_service import AutomationService

router = APIRouter(prefix="/api/automations", tags=["Automations"])


def _rule_to_out(rule: AutomationRule) -> AutomationRuleOut:
    def _safe_json(v):
        if not v:
            return {}
        if isinstance(v, dict):
            return v
        try:
            return json.loads(v)
        except Exception:
            return {}

    return AutomationRuleOut(
        id=str(rule.id),
        name=rule.name,
        description=rule.description,
        trigger_type=rule.trigger_type,
        trigger_config=_safe_json(rule.trigger_config),
        conditions=_safe_json(rule.conditions),
        action_type=rule.action_type,
        action_config=_safe_json(rule.action_config),
        is_active=rule.is_active,
        trigger_count=rule.trigger_count or 0,
        last_triggered_at=rule.last_triggered_at,
        creator_id=str(rule.creator_id) if rule.creator_id else None,
        creator_name=rule.creator.full_name or rule.creator.username if rule.creator else None,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


@router.get("/rules", response_model=List[AutomationRuleOut])
async def list_rules(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Assicurati che le regole predefinite esistano
    await AutomationService.seed_default_rules(db)

    result = await db.execute(
        select(AutomationRule)
        .options(selectinload(AutomationRule.creator))
        .order_by(desc(AutomationRule.created_at))
    )
    rules = result.scalars().all()
    return [_rule_to_out(r) for r in rules]


@router.post("/rules", response_model=AutomationRuleOut)
async def create_rule(
    payload: AutomationRuleCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permesso negato: solo amministratori ed editor possono configurare regole di automazione")

    rule = AutomationRule(
        name=payload.name,
        description=payload.description,
        trigger_type=payload.trigger_type,
        trigger_config=json.dumps(payload.trigger_config or {}),
        conditions=json.dumps(payload.conditions or {}),
        action_type=payload.action_type,
        action_config=json.dumps(payload.action_config or {}),
        is_active=payload.is_active,
        creator_id=current_user.id,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)

    res = await db.execute(
        select(AutomationRule).options(selectinload(AutomationRule.creator)).where(AutomationRule.id == rule.id)
    )
    return _rule_to_out(res.scalar_one())


@router.put("/rules/{rule_id}", response_model=AutomationRuleOut)
async def update_rule(
    rule_id: str,
    payload: AutomationRuleUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permesso negato")

    res = await db.execute(select(AutomationRule).where(AutomationRule.id == rule_id))
    rule = res.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regola non trovata")

    update_data = payload.model_dump(exclude_unset=True)
    for k, v in update_data.items():
        if k in ("trigger_config", "conditions", "action_config") and v is not None:
            v = json.dumps(v)
        setattr(rule, k, v)

    await db.commit()
    await db.refresh(rule)

    rule_with_creator = await db.execute(
        select(AutomationRule).options(selectinload(AutomationRule.creator)).where(AutomationRule.id == rule.id)
    )
    return _rule_to_out(rule_with_creator.scalar_one())


@router.patch("/rules/{rule_id}/toggle", response_model=AutomationRuleOut)
async def toggle_rule(
    rule_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permesso negato")

    res = await db.execute(select(AutomationRule).where(AutomationRule.id == rule_id))
    rule = res.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regola non trovata")

    rule.is_active = not rule.is_active
    await db.commit()
    await db.refresh(rule)

    rule_with_creator = await db.execute(
        select(AutomationRule).options(selectinload(AutomationRule.creator)).where(AutomationRule.id == rule.id)
    )
    return _rule_to_out(rule_with_creator.scalar_one())


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role not in (UserRole.ADMIN, UserRole.EDITOR):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Permesso negato")

    res = await db.execute(select(AutomationRule).where(AutomationRule.id == rule_id))
    rule = res.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regola non trovata")

    await db.delete(rule)
    await db.commit()
    return {"message": "Regola eliminata con successo"}


@router.get("/logs", response_model=List[AutomationLogOut])
async def list_logs(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    res = await db.execute(
        select(AutomationLog)
        .options(selectinload(AutomationLog.project))
        .order_by(desc(AutomationLog.created_at))
        .limit(limit)
    )
    logs = res.scalars().all()

    out_list = []
    for log in logs:
        # Recupera nome task se presente
        task_name = None
        if log.task_id:
            t_res = await db.execute(select(Task.text).where(Task.id == log.task_id))
            task_name = t_res.scalar_one_or_none()

        out_list.append(AutomationLogOut(
            id=str(log.id),
            rule_id=str(log.rule_id) if log.rule_id else None,
            rule_name=log.rule_name,
            trigger_type=log.trigger_type,
            action_type=log.action_type,
            project_id=str(log.project_id) if log.project_id else None,
            project_code=log.project.code if log.project else None,
            project_name=log.project.name if log.project else None,
            task_id=log.task_id,
            task_name=task_name,
            details=log.details,
            status=log.status,
            error_message=log.error_message,
            created_at=log.created_at,
        ))
    return out_list
