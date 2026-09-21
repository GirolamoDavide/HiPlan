from typing import List
from datetime import datetime, timedelta, timezone
# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form
import os
import uuid
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy import select
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload
from app.core.dependencies import get_db, get_current_user
from app.models.user import User, UserRole
from app.models.note import Note
from app.schemas.note import NoteCreate, NoteUpdate, NoteOut
from app.schemas.meeting import MeetingMinutesRequest, MeetingMinutesResponse, AudioTranscriptionResponse
from app.services.chat_service import chat_service

import json

router = APIRouter(prefix="/api/notes", tags=["notes"])

def _serialize_note(note: Note) -> dict:
    attachments_list = []
    if note.attachments:
        try:
            parsed_att = json.loads(note.attachments)
            if isinstance(parsed_att, list):
                attachments_list = parsed_att
        except:
            pass
            
    # Serialize the owner if it exists
    owner_data = None
    if getattr(note, "owner", None):
        owner_data = {
            "id": note.owner.id,
            "username": note.owner.username,
            "full_name": note.owner.full_name,
            "email": note.owner.email,
            "role": note.owner.role,
            "is_active": note.owner.is_active,
            "department": getattr(note.owner, "department", None),
            "created_at": note.owner.created_at,
        }
        
    shared_with_list = []
    if getattr(note, "shared_with", None):
        try:
            parsed_sw = json.loads(note.shared_with)
            if isinstance(parsed_sw, list):
                shared_with_list = parsed_sw
        except:
            pass

    return {
        "id": note.id,
        "title": note.title,
        "content": note.content,
        "is_shared": note.is_shared,
        "visibility": getattr(note, "visibility", "private"),
        "shared_with": shared_with_list,
        "owner_id": note.owner_id,
        "owner": owner_data,
        "attachments": attachments_list,
        "deleted_at": note.deleted_at.isoformat() if getattr(note, "deleted_at", None) else None,
        "created_at": note.created_at,
        "updated_at": note.updated_at
    }


async def purge_expired_note_trash(db: AsyncSession):
    """Elimina definitivamente le note nel cestino da più di 90 giorni."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)
    res = await db.execute(select(Note).where(Note.deleted_at.isnot(None), Note.deleted_at <= cutoff))
    expired = res.scalars().all()
    for n in expired:
        try:
            attachments = json.loads(n.attachments) if n.attachments else []
            for att in attachments:
                fpath = att.get("path", "")
                if fpath and os.path.exists(fpath):
                    os.remove(fpath)
        except Exception:
            pass
        await db.delete(n)
    if expired:
        await db.commit()


@router.get("/trash", response_model=List[dict])
async def list_trash_notes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restituisce le note nel cestino: per ogni utente le proprie note; per gli admin anche quelle condivise con il team."""
    await purge_expired_note_trash(db)

    if current_user.role == UserRole.ADMIN:
        trash_filter = (
            (Note.owner_id == current_user.id)
            | (Note.visibility == "team")
            | (Note.is_shared == True)
        )
    else:
        trash_filter = (Note.owner_id == current_user.id)

    result = await db.execute(
        select(Note)
        .options(selectinload(Note.owner))
        .where(Note.deleted_at.isnot(None), trash_filter)
        .order_by(Note.deleted_at.desc())
    )
    trashed = result.scalars().all()
    now = datetime.now(timezone.utc)

    items = []
    for n in trashed:
        deleted_dt = n.deleted_at or now
        if deleted_dt.tzinfo is None:
            deleted_dt = deleted_dt.replace(tzinfo=timezone.utc)
        elapsed_days = (now - deleted_dt).days
        s = _serialize_note(n)
        s["days_left"] = max(0, 90 - elapsed_days)
        items.append(s)

    return items


@router.delete("/trash/empty", status_code=status.HTTP_204_NO_CONTENT)
async def empty_trash_notes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Svuota il cestino delle note visibili all'utente (le proprie, più quelle team per gli admin)."""
    if current_user.role == UserRole.ADMIN:
        trash_filter = (
            (Note.owner_id == current_user.id)
            | (Note.visibility == "team")
            | (Note.is_shared == True)
        )
    else:
        trash_filter = (Note.owner_id == current_user.id)

    result = await db.execute(
        select(Note).where(Note.deleted_at.isnot(None), trash_filter)
    )
    trashed = result.scalars().all()
    deleted_count = 0
    for n in trashed:
        try:
            attachments = json.loads(n.attachments) if n.attachments else []
            for att in attachments:
                fpath = att.get("path", "")
                if fpath and os.path.exists(fpath):
                    os.remove(fpath)
        except Exception:
            pass
        await db.delete(n)
        deleted_count += 1
    if deleted_count > 0:
        await db.commit()


@router.post("/trash/{note_id}/restore")
async def restore_note(
    note_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ripristina una nota dal cestino (il proprietario, oppure un admin se la nota era condivisa col team)."""
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note_id)
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Nota non trovata")

    can_manage = (note.owner_id == current_user.id) or (
        current_user.role == UserRole.ADMIN and (note.is_shared or note.visibility == "team")
    )
    if not can_manage:
        raise HTTPException(status_code=403, detail="Non hai i permessi per ripristinare questa nota")

    note.deleted_at = None
    await db.commit()
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note_id)
    )
    note = result.scalar_one()
    return _serialize_note(note)


@router.delete("/trash/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def hard_delete_note(
    note_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina definitivamente una nota dal database e rimuove gli allegati fisici (il proprietario, oppure un admin se condivisa col team)."""
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Nota non trovata")

    can_manage = (note.owner_id == current_user.id) or (
        current_user.role == UserRole.ADMIN and (note.is_shared or note.visibility == "team")
    )
    if not can_manage:
        raise HTTPException(status_code=403, detail="Solo il creatore della nota o un amministratore (per note di team) può eliminarla definitivamente")

    try:
        attachments = json.loads(note.attachments) if note.attachments else []
        for att in attachments:
            fpath = att.get("path", "")
            if fpath and os.path.exists(fpath):
                os.remove(fpath)
    except Exception:
        pass

    await db.delete(note)
    await db.commit()


@router.get("", response_model=List[NoteOut])
async def list_notes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = (
        select(Note)
        .options(selectinload(Note.owner))
        .where(
            Note.deleted_at.is_(None),
            (Note.owner_id == current_user.id) | 
            (Note.is_shared == True) | 
            (Note.visibility == 'team') | 
            (Note.shared_with.like(f'%"{current_user.username}"%'))
        )
        .order_by(Note.updated_at.desc())
    )
    result = await db.execute(query)
    notes = result.scalars().all()
    return [_serialize_note(n) for n in notes]



@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    data: NoteCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    title_clean = data.title.strip() if data.title else "Nuova Nota"
    note = Note(
        title=title_clean or "Nuova Nota",
        content=data.content or "",
        is_shared=data.is_shared,
        visibility=data.visibility,
        shared_with=json.dumps(data.shared_with) if data.shared_with else "[]",
        owner_id=current_user.id,
    )
    db.add(note)
    await db.commit()
    
    # Ricarica con eager loading per owner
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note.id)
    )
    loaded_note = result.scalar_one()
    return _serialize_note(loaded_note)


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note_id, Note.deleted_at.is_(None))
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nota non trovata")
    
    if note.owner_id != current_user.id and not note.is_shared and note.visibility != 'team':
        shared_with_list = []
        try:
            shared_with_list = json.loads(note.shared_with) if note.shared_with else []
        except:
            pass
        if current_user.username not in shared_with_list:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Non hai i permessi per visualizzare questa nota privata")
        
    return _serialize_note(note)


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: str,
    data: NoteUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note_id)
    )
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nota non trovata")

    if note.owner_id != current_user.id:
        if current_user.role != UserRole.ADMIN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo l'autore o un amministratore può modificare questa nota")

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if key == "title" and value is not None:
            setattr(note, key, value.strip() or "Senza Titolo")
        elif key == "shared_with" and value is not None:
            setattr(note, key, json.dumps(value))
        else:
            setattr(note, key, value)

    await db.commit()
    
    # Ricarica aggiornato
    result = await db.execute(
        select(Note).options(selectinload(Note.owner)).where(Note.id == note_id)
    )
    loaded_note = result.scalar_one()
    return _serialize_note(loaded_note)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nota non trovata")

    if note.owner_id != current_user.id:
        if current_user.role != UserRole.ADMIN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo l'autore o un amministratore può eliminare questa nota")

    note.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return None

NOTES_UPLOAD_DIR = "uploads/notes"
os.makedirs(NOTES_UPLOAD_DIR, exist_ok=True)
MAX_FILE_SIZE_MB = 10

@router.post("/{note_id}/attachments")
async def upload_note_attachment(
    note_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # pyrefly: ignore [missing-import]
    from sqlalchemy import select
    from app.models.note import Note
    
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Nota non trovata")
        
    if note.owner_id != current_user.id:
        if current_user.role != UserRole.ADMIN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo l'autore o un amministratore può modificare questa nota")

    content = await file.read()
    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"File troppo grande (max {MAX_FILE_SIZE_MB}MB)")

    ext = os.path.splitext(file.filename or "")[1]
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(NOTES_UPLOAD_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(content)

    attachments = []
    if note.attachments:
        try:
            attachments = json.loads(note.attachments)
            if not isinstance(attachments, list):
                attachments = []
        except:
            pass

    new_att = {"name": file.filename, "path": f"uploads/notes/{filename}"}
    attachments.append(new_att)
    note.attachments = json.dumps(attachments)
    await db.commit()

    return new_att

@router.delete("/{note_id}/attachments/{filename}")
async def delete_note_attachment(
    note_id: str,
    filename: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # pyrefly: ignore [missing-import]
    from sqlalchemy import select
    from app.models.note import Note
    
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()
    if not note:
        raise HTTPException(status_code=404, detail="Nota non trovata")

    if note.owner_id != current_user.id:
        if current_user.role != UserRole.ADMIN:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo l'autore o un amministratore può modificare questa nota")

    attachments = []
    if note.attachments:
        try:
            attachments = json.loads(note.attachments)
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

    note.attachments = json.dumps(new_attachments)
    await db.commit()
    return {"status": "ok"}


@router.post("/meeting-minutes", response_model=MeetingMinutesResponse)
async def generate_meeting_minutes_endpoint(
    req: MeetingMinutesRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Riceve la trascrizione vocale di una riunione o videochiamata e genera
    una minuta/verbale strutturata con sintesi, punti chiave, decisioni e action items.
    """
    try:
        res = await chat_service.generate_meeting_minutes(
            transcript=req.transcript,
            meeting_type=req.meeting_type or "general",
            title=req.context_title
        )
        return res
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore generazione minuta: {str(e)}")


@router.post("/transcribe-audio", response_model=AudioTranscriptionResponse)
async def transcribe_meeting_audio_endpoint(
    file: UploadFile = File(...),
    language: str = Form("it"),
    include_timestamps: bool = Form(False),
    current_user: User = Depends(get_current_user),
):
    """
    Riceve un file audio registrato (es. cattura mista microfono + audio videochiamata da Google Meet / Teams / Zoom)
    e lo trascrive ad altissima fedeltà tramite Groq Whisper Large V3.
    """
    try:
        file_bytes = await file.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Il file audio inviato è vuoto.")

        result = await chat_service.transcribe_audio(
            file_bytes=file_bytes,
            filename=file.filename or "recording.webm",
            content_type=file.content_type or "audio/webm",
            language=language,
            include_timestamps=include_timestamps
        )
        return result
    except HTTPException:
        raise
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore trascrizione audio: {str(e)}")



