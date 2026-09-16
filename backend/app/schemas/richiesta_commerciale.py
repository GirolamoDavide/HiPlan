from datetime import datetime
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from app.models.richiesta_commerciale import RichiestaStatus, TipoFornitura


# ─── Autore (embed) ──────────────────────────────────────────────────────────

class AuthorOut(BaseModel):
    id: str
    username: str
    full_name: Optional[str] = None

    class Config:
        from_attributes = True


# ─── Articolo ────────────────────────────────────────────────────────────────

class ArticoloCreate(BaseModel):
    titolo: str
    costo: float
    descrizione: Optional[str] = None
    is_standard: bool = False
    is_atex: bool = False
    is_alimentare: bool = False
    tipo_fornitura: Optional[TipoFornitura] = None
    prezzo_listino: Optional[float] = None
    note_admin: Optional[str] = None


class ArticoloUpdate(BaseModel):
    titolo: Optional[str] = None
    costo: Optional[float] = None
    descrizione: Optional[str] = None
    is_standard: Optional[bool] = None
    is_atex: Optional[bool] = None
    is_alimentare: Optional[bool] = None
    tipo_fornitura: Optional[TipoFornitura] = None
    # Campi admin
    prezzo_listino: Optional[float] = None
    note_admin: Optional[str] = None


class ArticoloOut(BaseModel):
    id: str
    richiesta_id: str
    author: Optional[AuthorOut] = None
    titolo: str
    costo: float
    descrizione: Optional[str] = None
    is_standard: bool
    is_atex: bool
    is_alimentare: bool
    tipo_fornitura: Optional[TipoFornitura] = None
    attachments: List[str] = []
    prezzo_listino: Optional[float] = None
    testo_originale_commerciale: Optional[str] = None  # JSON string
    testo_originale_acquisti: Optional[str] = None  # JSON string
    note_admin: Optional[str] = None
    author: Optional[AuthorOut] = None
    updated_by: Optional[AuthorOut] = None
    modifiche: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class ArticoloOutCommerciale(BaseModel):
    """Vista ridotta per il commerciale: solo info essenziali + prezzo listino."""
    id: str
    author: Optional[AuthorOut] = None
    updated_by: Optional[AuthorOut] = None
    titolo: str
    descrizione: Optional[str] = None
    tipo_fornitura: TipoFornitura
    prezzo_listino: Optional[float] = None
    testo_originale_commerciale: Optional[str] = None  # JSON string
    note_admin: Optional[str] = None
    attachments: List[str] = []
    modifiche: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


# ─── Richiesta ───────────────────────────────────────────────────────────────

class ArticoloInitialCreate(BaseModel):
    titolo: str
    descrizione: Optional[str] = None
    is_standard: bool = False
    is_atex: bool = False
    is_alimentare: bool = False
    tipo_fornitura: Optional[TipoFornitura] = None


class RichiestaCreate(BaseModel):
    title: str
    descrizione: Optional[str] = None
    numero_offerta: Optional[str] = None
    cliente: str
    articoli: Optional[List[ArticoloInitialCreate]] = []


class RichiestaUpdate(BaseModel):
    title: Optional[str] = None
    descrizione: Optional[str] = None
    numero_offerta: Optional[str] = None
    cliente: Optional[str] = None
    status: Optional[RichiestaStatus] = None


class RichiestaOut(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    description_originale: Optional[str] = None
    numero_offerta: Optional[str] = None
    cliente: str
    attachments: List[str] = []
    status: RichiestaStatus
    author: AuthorOut
    articoli_inserted_by: Optional[AuthorOut] = None
    articoli_inserted_at: Optional[datetime] = None
    articoli: List[ArticoloOut] = []
    modifiche: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RichiestaOutCommerciale(BaseModel):
    """Vista ridotta per il commerciale."""
    id: str
    title: str
    description: Optional[str] = None
    numero_offerta: Optional[str] = None
    cliente: str
    attachments: List[str] = []
    status: RichiestaStatus
    author: AuthorOut
    articoli_inserted_by: Optional[AuthorOut] = None
    articoli_inserted_at: Optional[datetime] = None
    articoli: List[ArticoloOutCommerciale] = []
    modifiche: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RichiestaOutAcquisti(BaseModel):
    """Vista acquisti: tutto tranne prezzo listino."""
    id: str
    title: str
    description: Optional[str] = None
    numero_offerta: Optional[str] = None
    cliente: str
    attachments: List[str] = []
    status: RichiestaStatus
    author: AuthorOut
    articoli_inserted_by: Optional[AuthorOut] = None
    articoli_inserted_at: Optional[datetime] = None
    articoli: List[ArticoloOut] = []
    modifiche: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ─── Invio ad Admin (Acquisti) ──────────────────────────────────────────────

class InviaAdAdminArticoloIn(BaseModel):
    id: Optional[str] = None
    costo: Optional[float] = None
    titolo: Optional[str] = None
    descrizione: Optional[str] = None
    is_standard: Optional[bool] = None
    is_atex: Optional[bool] = None
    is_alimentare: Optional[bool] = None
    tipo_fornitura: Optional[TipoFornitura] = None
    prezzo_listino: Optional[float] = None
    note_admin: Optional[str] = None


class InviaAdAdminIn(BaseModel):
    articoli: Optional[List[InviaAdAdminArticoloIn]] = None
    descrizione: Optional[str] = None


# ─── Completamento Admin ─────────────────────────────────────────────────────

class CompletaArticoloIn(BaseModel):
    id: Optional[str] = None
    prezzo_listino: float
    costo: Optional[float] = None
    titolo: Optional[str] = None
    descrizione: Optional[str] = None
    note_admin: Optional[str] = None


class CompletaRichiestaIn(BaseModel):
    articoli: List[CompletaArticoloIn]
    descrizione: Optional[str] = None


# ─── Schemi Articoli a Listino (Archivio Admin) ──────────────────────────────

class ArticoloListinoItemOut(BaseModel):
    id: str
    richiesta_id: str
    titolo: str
    descrizione: Optional[str] = None
    costo: float
    prezzo_listino: float
    margine: float
    ricarico_percentuale: float
    is_standard: bool = False
    is_atex: bool = False
    is_alimentare: bool = False
    tipo_fornitura: Optional[str] = None
    note_admin: Optional[str] = None
    created_at: str
    inserito_da: Optional[str] = None
    inserito_da_id: Optional[str] = None
    richiesta_titolo: str
    cliente: str
    numero_offerta: Optional[str] = None
    commerciale: Optional[str] = None
    commerciale_id: Optional[str] = None
    listino_inserito_da: Optional[str] = None
    listino_inserito_at: Optional[str] = None


class ArticoliListinoStatsOut(BaseModel):
    totale_articoli: int
    totale_costo: float
    totale_listino: float
    totale_margine: float
    margine_medio_percentuale: float


class ArticoliListinoResponse(BaseModel):
    articoli: List[ArticoloListinoItemOut]
    stats: ArticoliListinoStatsOut


