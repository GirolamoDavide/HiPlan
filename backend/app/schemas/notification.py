# pyrefly: ignore [missing-import]
from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import datetime
from app.models.notification import NotificationType


class NotificationOut(BaseModel):
    id: str
    title: str
    message: Optional[str] = None
    type: NotificationType
    is_read: bool
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    link: Optional[str] = None
    created_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class NotificationCreate(BaseModel):
    user_id: str
    title: str
    message: Optional[str] = None
    type: NotificationType = NotificationType.UPDATE
    project_id: Optional[str] = None
    task_id: Optional[str] = None
    link: Optional[str] = None

