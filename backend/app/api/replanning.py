from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_db, get_current_user
from app.models.user import User, UserRole
from app.models.replan_log import ReplanLog
from app.services.replanning_service import get_replanning_suggestions, get_zero_hours_alerts
from app.services.smart_replanning_service import (
    generate_project_smart_suggestions,
    apply_smart_replanning_proposal,
    apply_smart_replanning_batch,
    revert_smart_replanning_log,
    to_utc_iso
)

router = APIRouter(prefix="/api/replanning", tags=["replanning"])


class ApplyReplanningRequest(BaseModel):
    proposal_payload: Dict[str, Any]


@router.get("/suggestions")
async def get_suggestions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo admin ed editor possono vedere i suggerimenti."
        )
    return await get_replanning_suggestions(db, current_user)


@router.get("/zero-hours")
async def get_zero_hours(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Restituisce l'elenco delle mancate consuntivazioni ore per addetto e data.
    """
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo admin ed editor possono accedere a questa sezione."
        )
    return await get_zero_hours_alerts(db, current_user)


@router.get("/project/{project_id}/suggestions")
async def get_project_smart_suggestions(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Rileva tutti i conflitti della commessa (ferie, sovraccarichi multi-commessa,
    ritardi) e produce suggerimenti intelligenti di rebalance con propagazione a cascata.
    """
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo admin ed editor possono accedere all'ottimizzatore."
        )
    result = await generate_project_smart_suggestions(db, project_id, current_user)
    if "error" in result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=result["error"])
    return result


@router.post("/project/{project_id}/apply")
async def apply_project_suggestion(
    project_id: str,
    request: ApplyReplanningRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Applica una proposta di ripianificazione/rebalance approvata da un editor o admin.
    """
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo editor e admin possono applicare modifiche di ripianificazione."
        )
    try:
        res = await apply_smart_replanning_proposal(
            db, project_id, request.proposal_payload, current_user
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore durante l'applicazione del suggerimento: {str(e)}"
        )


class ApplyReplanningBatchRequest(BaseModel):
    proposals: List[Dict[str, Any]]


@router.post("/project/{project_id}/apply-batch")
async def apply_project_batch_suggestions(
    project_id: str,
    request: ApplyReplanningBatchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Applica un gruppo di proposte di ripianificazione/rebalance approvate da un editor o admin.
    """
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo editor e admin possono applicare modifiche di ripianificazione."
        )
    try:
        return await apply_smart_replanning_batch(
            db, project_id, request.proposals, current_user
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore durante l'applicazione delle modifiche: {str(e)}"
        )


@router.post("/project/{project_id}/revert/{log_id}")
async def revert_project_suggestion(
    project_id: str,
    log_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Annulla una modifica precedentemente applicata ripristinando lo stato precedente.
    """
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accesso negato. Solo editor e admin possono annullare modifiche."
        )
    try:
        res = await revert_smart_replanning_log(db, log_id, current_user)
        return res
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Errore durante l'annullamento: {str(e)}"
        )


@router.get("/logs")
async def get_replanning_logs(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if current_user.role not in [UserRole.ADMIN, UserRole.EDITOR]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Accesso negato.")
        
    res = await db.execute(
        select(ReplanLog)
        .options(selectinload(ReplanLog.task), selectinload(ReplanLog.project), selectinload(ReplanLog.reverted_by_user))
        .order_by(desc(ReplanLog.created_at))
        .limit(200)
    )
    logs = res.scalars().all()
    
    results = []
    for log in logs:
        results.append({
            "id": str(log.id),
            "action_type": log.action_type.value,
            "task_id": str(log.task_id) if log.task_id else None,
            "task_name": log.task.text if log.task else "Fase eliminata",
            "project_id": str(log.project_id) if log.project_id else None,
            "project_name": log.project.name if log.project else "Commessa sconosciuta",
            "worker_name": log.worker_name,
            "reason": log.reason,
            "old_start_date": log.old_start_date.isoformat() if log.old_start_date else None,
            "old_end_date": log.old_end_date.isoformat() if log.old_end_date else None,
            "new_start_date": log.new_start_date.isoformat() if log.new_start_date else None,
            "new_end_date": log.new_end_date.isoformat() if log.new_end_date else None,
            "shift_days": log.shift_days,
            "reverted": log.reverted,
            "created_at": to_utc_iso(log.created_at),
            "reverted_at": to_utc_iso(log.reverted_at),
            "reverted_by_name": log.reverted_by_user.full_name if log.reverted_by_user else None
        })
    return results
