from sqlalchemy import Column, Date, Float, String, ForeignKey, Text
from app.models.base import Base, TimestampMixin, uuid_pk, uuid_fk


class Vacation(Base, TimestampMixin):
    __tablename__ = "vacations"

    id = uuid_pk()
    user_id = Column(uuid_fk(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    reason = Column(String(255), nullable=True)
    # Permesso a ore (solo su un singolo giorno): None = giornata intera
    hours = Column(Float, nullable=True)
    part_of_day = Column(String(20), nullable=True)  # "morning" | "afternoon" per la mezza giornata
