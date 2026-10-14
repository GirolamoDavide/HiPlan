# pyrefly: ignore [missing-import]
from pydantic import BaseModel, ConfigDict
from datetime import datetime
from typing import Literal, Optional


class CalendarEventBase(BaseModel):
    title: str
    description: Optional[str] = None
    start_date: datetime
    end_date: datetime
    is_all_day: bool = False
    color: str = "#3b82f6"
    shared_with: Optional[list[str]] = []
    visibility: Optional[Literal["private", "selected", "team"]] = None
    reminder_type: str = "none"
    reminder_time: Optional[datetime] = None


class CalendarEventCreate(CalendarEventBase):
    pass


class CalendarEventUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None
    is_all_day: Optional[bool] = None
    color: Optional[str] = None
    shared_with: Optional[list[str]] = None
    visibility: Optional[Literal["private", "selected", "team"]] = None
    reminder_type: Optional[str] = None
    reminder_time: Optional[datetime] = None


# pyrefly: ignore [missing-import]
from pydantic import BaseModel, ConfigDict, field_validator
import json

class CalendarEventOut(CalendarEventBase):
    id: str
    user_id: str
    created_at: datetime
    updated_at: datetime

    @field_validator("shared_with", mode="before")
    def parse_shared_with(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except:
                return []
        return v or []

    model_config = ConfigDict(from_attributes=True)
