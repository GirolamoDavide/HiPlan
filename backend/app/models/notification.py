import enum
# pyrefly: ignore [missing-import]
from sqlalchemy import Column, String, Text, Boolean, Enum, ForeignKey
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class NotificationType(str, enum.Enum):
    ASSIGNMENT = "assignment"
    DEADLINE = "deadline"
    UPDATE = "update"
    TODO = "todo"
    TICKET = "ticket"
    VACATION = "vacation"
    COMMERCIAL = "commercial"
    AUTOMATION = "automation"
    RISK_RADAR = "risk_radar"


class Notification(Base, TimestampMixin):
    __tablename__ = "notifications"

    id = uuid_pk()
    user_id = Column(uuid_fk(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(200), nullable=False)
    message = Column(Text, nullable=True)
    type = Column(Enum(NotificationType), default=NotificationType.UPDATE, nullable=False)
    is_read = Column(Boolean, default=False, nullable=False)
    project_id = Column(uuid_fk(), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    task_id = Column(String(36), nullable=True)
    link = Column(String(255), nullable=True)

