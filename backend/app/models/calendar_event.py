# pyrefly: ignore [missing-import]
from sqlalchemy import Column, String, Text, Boolean, DateTime, ForeignKey
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class CalendarEvent(Base, TimestampMixin):
    __tablename__ = "calendar_events"

    id = uuid_pk()
    user_id = Column(uuid_fk(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    is_all_day = Column(Boolean, default=False, nullable=False)
    color = Column(String(50), default="#3b82f6", nullable=False)
    shared_with = Column(Text, default="[]", nullable=False)
    # Visibilità come nel blocco note: "private" (solo io), "selected" (utenti in shared_with), "team" (tutti)
    visibility = Column(String(20), nullable=True, default="private")
    
    reminder_type = Column(String(50), default="none", nullable=False)
    reminder_time = Column(DateTime, nullable=True)
    reminder_sent = Column(Boolean, default=False, nullable=False)

    user = relationship("User")
