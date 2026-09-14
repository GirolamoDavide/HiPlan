import enum
# pyrefly: ignore [missing-import]
from sqlalchemy import Column, String, Date, Integer, Float, Enum, ForeignKey, Text
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class TaskType(str, enum.Enum):
    TASK = "task"
    MILESTONE = "milestone"
    PROJECT = "project"


class TaskPriority(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id = uuid_pk()
    project_id = Column(uuid_fk(), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    parent_id = Column(uuid_fk(), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    text = Column(String(500), nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=True)
    duration = Column(Integer, nullable=False, default=1)
    progress = Column(Float, default=0.0, nullable=False)
    type = Column(Enum(TaskType), default=TaskType.TASK, nullable=False)
    priority = Column(Enum(TaskPriority), default=TaskPriority.MEDIUM, nullable=False)
    assigned_to = Column(uuid_fk(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    sort_order = Column(Integer, default=0, nullable=False)
    open = Column(Integer, default=1, nullable=False)  # DHTMLX: 1=expanded, 0=collapsed
    planned_hours = Column(Float, default=8.0, nullable=False)
    workers = Column(Text, nullable=True, default="[]")  # JSON list di addetti (es. Alessio, Edoardo)
    worker_hours = Column(Text, nullable=True, default="{}")  # JSON dict ore assegnate specifiche {worker: ore}
    actual_hours = Column(Text, nullable=True, default="{}")  # JSON dict consuntivazione per data e addetto
    color = Column(String(50), nullable=True)  # Colore personalizzato per la fase nel Gantt
    department = Column(String(50), nullable=True)  # ufficio_tecnico | produzione | acquisti
    budget_mode = Column(String(50), nullable=True)  # start_end | start_hours | end_hours | start_days | end_days | start_days_hours | end_days_hours
    completed = Column(Integer, default=0, nullable=False)  # 1=completato (spunta verde), 0=in corso/non completato
    has_vacation_conflict = Column(Integer, default=0, nullable=False)  # Flag se la fase ha conflitti con ferie (0=no, 1=si)
    excluded_dates = Column(Text, nullable=True, default="[]")  # JSON list of dates excluded from vacation checks
    custom_dates = Column(Text, nullable=True, default="[]")  # JSON list of {date: string, hours: number} for custom_dates budget mode


    project = relationship("Project", back_populates="tasks")
    parent = relationship("Task", remote_side="Task.id")
    assignee = relationship("User", foreign_keys=[assigned_to])
