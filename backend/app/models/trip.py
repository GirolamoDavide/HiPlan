from sqlalchemy import Column, Date, String, Text, ForeignKey
from sqlalchemy.orm import relationship
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class Trip(Base, TimestampMixin):
    """Viaggio / trasferta nel calendario viaggi."""
    __tablename__ = "trips"

    id = uuid_pk()
    title = Column(String(255), nullable=False)
    destination = Column(String(255), nullable=True)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    travelers = Column(Text, nullable=False, default="[]")  # JSON list di username
    project_id = Column(uuid_fk(), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    notes = Column(Text, nullable=True)
    color = Column(String(30), nullable=False, default="#0ea5e9")
    created_by = Column(uuid_fk(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    project = relationship("Project")
    author = relationship("User")
