from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from app.services.chat_service import chat_service
from app.core.dependencies import get_current_user, get_db
from app.models.user import User, UserRole

from typing import List, Optional

router = APIRouter()

class MessageItem(BaseModel):
    sender: str
    text: str

class AttachmentItem(BaseModel):
    name: str
    type: str
    data: str
    size: Optional[int] = None

class ChatRequest(BaseModel):
    message: str
    history: Optional[List[MessageItem]] = None
    attachments: Optional[List[AttachmentItem]] = None

class ChatResponse(BaseModel):
    response: str

@router.post("/", response_model=ChatResponse)
async def ask_chatbot(
    request: ChatRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Invia un messaggio al chatbot e ricevi una risposta basata sui dati del DB ed eventuali allegati.
    """
    if not request.message.strip() and not request.attachments:
        raise HTTPException(status_code=400, detail="Il messaggio o gli allegati non possono essere vuoti.")
        
    answer = await chat_service.get_response(
        request.message,
        current_user=current_user,
        history=[h.model_dump() for h in request.history] if request.history else None,
        attachments=[a.model_dump() for a in request.attachments] if request.attachments else None
    )
    return ChatResponse(response=answer)

@router.post("/admin-report")
async def get_admin_ai_report(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Genera un report AI esecutivo sullo stato attuale delle commesse e degli addetti.
    Riservato agli amministratori.
    """
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Accesso riservato agli amministratori.")
    
    return await chat_service.generate_admin_report(db)

