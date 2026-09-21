from typing import Optional, List
from pydantic import BaseModel, Field

class MeetingMinutesRequest(BaseModel):
    transcript: str = Field(..., description="Trascrizione integrale della riunione o dettatura vocale", min_length=5)
    meeting_type: Optional[str] = Field("general", description="Tipo di riunione: general, operativa, commerciale, tecnica")
    context_title: Optional[str] = Field(None, description="Titolo o contesto opzionale inserito dall'utente")

class MeetingMinutesResponse(BaseModel):
    title: str = Field(..., description="Titolo sintetico della riunione")
    summary_html: str = Field(..., description="Minuta completa formattata in HTML pulito per l'editor")
    summary_markdown: Optional[str] = Field(None, description="Versione Markdown della minuta")
    key_points: Optional[List[str]] = Field(default_factory=list, description="Punti chiave discussi")
    decisions: Optional[List[str]] = Field(default_factory=list, description="Decisioni prese")
    action_items: Optional[List[str]] = Field(default_factory=list, description="Azioni da fare / TODO con assegnatari")

class AudioTranscriptionResponse(BaseModel):
    transcript: str = Field(..., description="Testo integrale trascritto dall'audio")
    duration: Optional[float] = Field(None, description="Durata in secondi dell'audio trascritto")

