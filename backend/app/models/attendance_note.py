from sqlalchemy import Column, Date, String, ForeignKey, UniqueConstraint
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class AttendanceNote(Base, TimestampMixin):
    """Nota manuale in una cella della griglia presenze (addetto × giorno), come nel foglio Excel."""
    __tablename__ = "attendance_notes"
    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_attendance_note_user_date"),)

    id = uuid_pk()
    user_id = Column(uuid_fk(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    date = Column(Date, nullable=False)
    text = Column(String(500), nullable=False, default="")
    color = Column(String(30), nullable=True)
    updated_by = Column(uuid_fk(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
