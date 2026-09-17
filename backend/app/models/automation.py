import enum
# pyrefly: ignore [missing-import]
from sqlalchemy import Column, String, Text, Boolean, Integer, DateTime, ForeignKey
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class AutomationTriggerType(str, enum.Enum):
    PHASE_COMPLETED = "phase_completed"
    PHASE_STARTED = "phase_started"
    PHASE_PROGRESS_REACHED = "phase_progress_reached"
    PHASE_DELAYED = "phase_delayed"
    BUDGET_HOURS_EXCEEDED = "budget_hours_exceeded"
    PHASE_DEADLINE_APPROACHING = "phase_deadline_approaching"


class AutomationActionType(str, enum.Enum):
    CREATE_TODO = "create_todo"
    SEND_NOTIFICATION = "send_notification"
    CREATE_TODO_AND_NOTIFY = "create_todo_and_notify"
    CREATE_CALENDAR_EVENT = "create_calendar_event"


class AutomationRule(Base, TimestampMixin):
    __tablename__ = "automation_rules"

    id = uuid_pk()
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    trigger_type = Column(String(50), nullable=False)  # phase_completed | budget_hours_exceeded | phase_deadline_approaching
    trigger_config = Column(Text, default="{}", nullable=False)  # JSON config e.g. {"threshold_pct": 90, "days_before": 2}
    conditions = Column(Text, default="{}", nullable=False)  # JSON filters e.g. {"department": "ufficio_tecnico", "project_id": null}
    action_type = Column(String(50), nullable=False)  # create_todo | send_notification
    action_config = Column(Text, default="{}", nullable=False)  # JSON action params e.g. {"title": "...", "assignee_department": "acquisti"}
    is_active = Column(Boolean, default=True, nullable=False)
    trigger_count = Column(Integer, default=0, nullable=False)
    last_triggered_at = Column(DateTime, nullable=True)
    creator_id = Column(uuid_fk(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    creator = relationship("User", foreign_keys=[creator_id])
    logs = relationship("AutomationLog", back_populates="rule", cascade="all, delete-orphan")


class AutomationLog(Base, TimestampMixin):
    __tablename__ = "automation_logs"

    id = uuid_pk()
    rule_id = Column(uuid_fk(), ForeignKey("automation_rules.id", ondelete="CASCADE"), nullable=True)
    rule_name = Column(String(255), nullable=False)
    trigger_type = Column(String(50), nullable=False)
    action_type = Column(String(50), nullable=False)
    project_id = Column(uuid_fk(), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    task_id = Column(String(36), nullable=True)
    details = Column(Text, nullable=True)
    status = Column(String(50), default="success", nullable=False)  # success | error
    error_message = Column(Text, nullable=True)

    rule = relationship("AutomationRule", back_populates="logs")
    project = relationship("Project", foreign_keys=[project_id])
