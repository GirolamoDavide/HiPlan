"""Calendario viaggi: gli admin decidono chi può vederlo e chi può compilarlo."""
import json
from datetime import date
from typing import List, Optional

# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status
# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field
# pyrefly: ignore [missing-import]
from sqlalchemy import select
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_db, get_current_user
from app.services.access_lists import get_list_setting, set_list_setting, get_section_access
from app.models.trip import Trip
from app.models.user import User, UserRole

router = APIRouter(prefix="/api/trips", tags=["trips"])

VIEWERS_KEY = "trips_viewers"
EDITORS_KEY = "trips_editors"


class TripIn(BaseModel):
    title: str
    destination: Optional[str] = None
    start_date: date
    end_date: date
    start_time: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_time: Optional[str] = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    travelers: List[str] = []
    project_id: Optional[str] = None
    notes: Optional[str] = None
    color: str = "#0ea5e9"


class TripAccessIn(BaseModel):
    viewers: List[str] = []
    editors: List[str] = []


async def get_trip_access(db: AsyncSession, user: User) -> dict:
    return await get_section_access(db, user, VIEWERS_KEY, EDITORS_KEY)


def _serialize(trip: Trip) -> dict:
    try:
        travelers = json.loads(trip.travelers) if trip.travelers else []
    except Exception:
        travelers = []
    return {
        "id": trip.id,
        "title": trip.title,
        "destination": trip.destination,
        "start_date": str(trip.start_date),
        "end_date": str(trip.end_date),
        "start_time": trip.start_time,
        "end_time": trip.end_time,
        "travelers": travelers,
        "project_id": trip.project_id,
        "project_code": trip.project.code if trip.project else None,
        "notes": trip.notes,
        "color": trip.color,
        "created_by_name": (trip.author.full_name or trip.author.username) if trip.author else None,
    }


def _validate(data: TripIn) -> None:
    if not data.title.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Il titolo del viaggio è obbligatorio")
    if data.end_date < data.start_date:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="La data di ritorno non può precedere la partenza")
    if (data.start_date == data.end_date and data.start_time and data.end_time
            and data.end_time < data.start_time):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="L'orario di ritorno non può precedere la partenza")


async def _require(db: AsyncSession, user: User, permission: str) -> None:
    access = await get_trip_access(db, user)
    if not access[permission]:
        detail = "Non hai i permessi per compilare il calendario viaggi" if permission == "can_edit" else "Non hai accesso al calendario viaggi"
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


async def _load_trip(db: AsyncSession, trip_id: str) -> Trip:
    res = await db.execute(
        select(Trip).options(selectinload(Trip.project), selectinload(Trip.author)).where(Trip.id == trip_id)
    )
    trip = res.scalar_one_or_none()
    if not trip:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Viaggio non trovato")
    return trip


@router.get("/access")
async def my_trip_access(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    return await get_trip_access(db, current_user)


@router.get("/settings/access")
async def get_access_settings(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo gli admin")
    return {
        "viewers": await get_list_setting(db, VIEWERS_KEY),
        "editors": await get_list_setting(db, EDITORS_KEY),
    }


@router.put("/settings/access")
async def update_access_settings(data: TripAccessIn, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo gli admin")
    await set_list_setting(db, VIEWERS_KEY, data.viewers)
    await set_list_setting(db, EDITORS_KEY, data.editors)
    await db.commit()
    return {"viewers": data.viewers, "editors": data.editors}


@router.get("")
async def list_trips(db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await _require(db, current_user, "can_view")
    res = await db.execute(
        select(Trip).options(selectinload(Trip.project), selectinload(Trip.author)).order_by(Trip.start_date)
    )
    return [_serialize(t) for t in res.scalars().all()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_trip(data: TripIn, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await _require(db, current_user, "can_edit")
    _validate(data)
    trip = Trip(
        title=data.title.strip(), destination=data.destination, start_date=data.start_date, end_date=data.end_date,
        start_time=data.start_time or None, end_time=data.end_time or None,
        travelers=json.dumps(data.travelers), project_id=data.project_id or None, notes=data.notes,
        color=data.color, created_by=current_user.id,
    )
    db.add(trip)
    await db.flush()
    trip_id = trip.id
    await db.commit()
    return _serialize(await _load_trip(db, trip_id))


@router.put("/{trip_id}")
async def update_trip(trip_id: str, data: TripIn, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await _require(db, current_user, "can_edit")
    _validate(data)
    trip = await _load_trip(db, trip_id)
    trip.title = data.title.strip()
    trip.destination = data.destination
    trip.start_date = data.start_date
    trip.end_date = data.end_date
    trip.start_time = data.start_time or None
    trip.end_time = data.end_time or None
    trip.travelers = json.dumps(data.travelers)
    trip.project_id = data.project_id or None
    trip.notes = data.notes
    trip.color = data.color
    await db.commit()
    return _serialize(await _load_trip(db, trip_id))


@router.delete("/{trip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trip(trip_id: str, db: AsyncSession = Depends(get_db), current_user: User = Depends(get_current_user)):
    await _require(db, current_user, "can_edit")
    trip = await _load_trip(db, trip_id)
    await db.delete(trip)
    await db.commit()
