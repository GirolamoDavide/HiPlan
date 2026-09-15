import enum
# pyrefly: ignore [missing-import]
from sqlalchemy import Column, String, Date, Integer, Boolean, DateTime, Enum, ForeignKey, Text
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import relationship
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class ReplanActionType(str, enum.Enum):
    SHIFT_CONFLICT = "shift_conflict"        # Spostamento per conflitto sovrapposizione addetto
    SHIFT_VACATION = "shift_vacation"        # Spostamento per ferie
    SHIFT_CASCADE = "shift_cascade"          # Spostamento a cascata da dipendenza
    SHIFT_OVERLOAD = "shift_overload"        # Spostamento per sovraccarico ore
    EXTEND_PROJECT = "extend_project"        # Estensione commessa per fasi fuori limite
    TRUNCATE_TASK = "truncate_task"          # Riduzione fase per limiti commessa
    SHIFT_DELAY = "shift_delay"              # Spostamento fase scaduta non completata
    WARNING_UNACCOUNTED = "warning_unaccounted" # Avviso per ore non consuntivate in passato


class ReplanLog(Base, TimestampMixin):
    __tablename__ = "replan_logs"

    id = uuid_pk()
    parent_log_id = Column(uuid_fk(), ForeignKey("replan_logs.id", ondelete="CASCADE"), nullable=True)
    action_type = Column(Enum(ReplanActionType), nullable=False)
    task_id = Column(uuid_fk(), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    project_id = Column(uuid_fk(), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    worker_name = Column(String(200), nullable=True)
    reason = Column(Text, nullable=False)
    old_start_date = Column(Date, nullable=True)
    old_end_date = Column(Date, nullable=True)
    new_start_date = Column(Date, nullable=True)
    new_end_date = Column(Date, nullable=True)
    old_workers = Column(Text, nullable=True)
    old_worker_hours = Column(Text, nullable=True)
    old_custom_dates = Column(Text, nullable=True)
    shift_days = Column(Integer, default=0, nullable=False)
    reverted = Column(Boolean, default=False, nullable=False)
    reverted_at = Column(DateTime(timezone=True), nullable=True)
    reverted_by = Column(uuid_fk(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    # Relazioni
    task = relationship("Task", foreign_keys=[task_id])
    project = relationship("Project", foreign_keys=[project_id])
    reverted_by_user = relationship("User", foreign_keys=[reverted_by])
    parent_log = relationship("ReplanLog", remote_side=[id], back_populates="cascade_logs")
    cascade_logs = relationship("ReplanLog", back_populates="parent_log")
