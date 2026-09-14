"""
API per il modulo Richieste Commerciali.
Coordina il workflow: Commerciale → Acquisti → Admin.
"""
import json
import os
import re
import shutil
import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Union, Dict, Any, Optional

# pyrefly: ignore [missing-import]
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Query
# pyrefly: ignore [missing-import]
from sqlalchemy.ext.asyncio import AsyncSession
# pyrefly: ignore [missing-import]
from sqlalchemy.future import select
from sqlalchemy import inspect
from sqlalchemy.orm import selectinload

from app.core.dependencies import get_db, get_current_user
from app.models.user import User, UserRole
from app.models.setting import Setting
from app.models.richiesta_commerciale import RichiestaCommerciale, ArticoloRichiesta, RichiestaStatus
from app.schemas.richiesta_commerciale import (
    RichiestaCreate,
    RichiestaUpdate,
    RichiestaOut,
    RichiestaOutCommerciale,
    RichiestaOutAcquisti,
    ArticoloCreate,
    ArticoloUpdate,
    InviaAdAdminIn,
    CompletaRichiestaIn,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/richieste-commerciali", tags=["Richieste Commerciali"])

UPLOAD_DIR = "uploads/richieste_commerciali"
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ─── Helpers per le liste utenti ─────────────────────────────────────────────

async def _get_setting_list(db: AsyncSession, key: str) -> List[str]:
    """Legge una lista JSON dalla tabella settings."""
    res = await db.execute(select(Setting).where(Setting.key == key))
    setting = res.scalar_one_or_none()
    if not setting or not setting.value:
        return []
    try:
        return json.loads(setting.value)
    except Exception:
        return []


async def _get_setting_bool(db: AsyncSession, key: str, default: bool = False) -> bool:
    """Legge un booleano dalla tabella settings."""
    res = await db.execute(select(Setting).where(Setting.key == key))
    setting = res.scalar_one_or_none()
    if not setting or setting.value is None:
        return default
    return str(setting.value).strip().lower() in ("true", "1", "yes")


async def _get_role(db: AsyncSession, user: User) -> str:
    """
    Determina il ruolo dell'utente nel modulo richieste commerciali.
    Restituisce: 'admin' | 'acquisti' | 'commerciale' | 'none'
    Precedenza: admin HiPlan (default) > rc_admin_users / auto_dept admin > rc_acquisti_users / auto_dept acquisti > rc_commerciale_users / auto_dept commerciale
    """
    if user.role == UserRole.ADMIN or str(getattr(user.role, 'value', user.role)).lower() == 'admin':
        return "admin"

    username = str(user.username)
    user_dept = str(user.department or "").strip().lower()

    # Admin via impostazione di reparto o lista manuale
    auto_admin = await _get_setting_bool(db, "rc_auto_admin_dept")
    if auto_admin and user_dept in ("amministrazione", "admin"):
        return "admin"
    admin_list = await _get_setting_list(db, "rc_admin_users")
    if username in admin_list:
        return "admin"

    # Acquisti via impostazione di reparto o lista manuale
    auto_acquisti = await _get_setting_bool(db, "rc_auto_acquisti_dept")
    if auto_acquisti and user_dept in ("acquisti", "ufficio acquisti"):
        return "acquisti"
    acquisti_list = await _get_setting_list(db, "rc_acquisti_users")
    if username in acquisti_list:
        return "acquisti"

    # Commerciale via impostazione di reparto o lista manuale
    auto_commerciale = await _get_setting_bool(db, "rc_auto_commerciale_dept")
    if auto_commerciale and user_dept in ("commerciale", "ufficio commerciale"):
        return "commerciale"
    commerciale_list = await _get_setting_list(db, "rc_commerciale_users")
    if username in commerciale_list:
        return "commerciale"

    return "none"


async def _require_role(db: AsyncSession, user: User, allowed: List[str]) -> str:
    """Verifica che l'utente abbia uno dei ruoli consentiti, altrimenti 403."""
    role = await _get_role(db, user)
    if role not in allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Non sei autorizzato ad accedere a questa sezione.",
        )
    return role


async def _get_user_emails_by_usernames(db: AsyncSession, usernames: List[str]) -> List[str]:
    """Restituisce le email degli utenti attivi nella lista username."""
    if not usernames:
        return []
    res = await db.execute(
        select(User).where(User.username.in_(usernames), User.is_active == True)
    )
    users = res.scalars().all()
    return [str(u.email) for u in users if u.email]


def _parse_attachments(
    attachments_str: str,
    default_author_id: Optional[str] = None,
    default_author_name: Optional[str] = None,
    default_author_role: Optional[str] = None,
) -> List[Dict[str, Any]]:
    try:
        raw = json.loads(attachments_str) if attachments_str else []
        normalized = []
        for item in raw:
            if isinstance(item, dict):
                up_id = str(item["uploaded_by_id"]) if item.get("uploaded_by_id") is not None else default_author_id
                up_role = item.get("uploaded_by_role")
                if not up_role:
                    if up_id and default_author_id and up_id == default_author_id:
                        up_role = default_author_role
                    elif not up_id:
                        up_role = default_author_role
                normalized.append({
                    "name": str(item.get("name") or "Allegato"),
                    "url": str(item.get("url") or item.get("path") or ""),
                    "uploaded_by_id": up_id,
                    "uploaded_by_name": item.get("uploaded_by_name") or default_author_name,
                    "uploaded_by_role": up_role,
                    "uploaded_at": item.get("uploaded_at"),
                })
            elif isinstance(item, str) and item.strip():
                filename = item.split("/")[-1]
                # Se il file ha prefisso hex uuid es. a1b2c3d4_nome.ext, togliamo l'hash iniziale per visualizzare il nome originale
                if "_" in filename and len(filename.split("_")[0]) <= 12:
                    display_name = filename.split("_", 1)[1]
                else:
                    display_name = filename
                normalized.append({
                    "name": display_name,
                    "url": item,
                    "uploaded_by_id": default_author_id,
                    "uploaded_by_name": default_author_name,
                    "uploaded_by_role": default_author_role,
                    "uploaded_at": None,
                })
        return normalized
    except Exception:
        return []


def _to_utc_iso(dt: Union[datetime, None]) -> Union[str, None]:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _richiesta_options():
    return [
        selectinload(RichiestaCommerciale.author),
        selectinload(RichiestaCommerciale.articoli_inserted_by),
        selectinload(RichiestaCommerciale.listino_inserted_by),
        selectinload(RichiestaCommerciale.articoli).selectinload(ArticoloRichiesta.author),
        selectinload(RichiestaCommerciale.articoli).selectinload(ArticoloRichiesta.updated_by),
    ]


# ─── Gestione Modifiche Campi (Tracciamento e Visibilità) ─────────────────────

def _parse_json_dict(val) -> dict:
    if not val:
        return {}
    if isinstance(val, dict):
        return val
    try:
        res = json.loads(val)
        return res if isinstance(res, dict) else {}
    except Exception:
        return {}


def _format_tipologia(is_std, is_atex, is_alim) -> str:
    parts = []
    if is_std:
        parts.append("Standard")
    if is_atex:
        parts.append("ATEX")
    if is_alim:
        parts.append("Alimentare")
    return " + ".join(parts) if parts else "Nessuna tipologia"


def _format_tipo_fornitura(tf) -> str:
    if not tf:
        return ""
    val = tf.value if hasattr(tf, "value") else str(tf)
    labels = {
        "materie_prime": "Materie Prime",
        "mp_lavorazione": "MP + Lavorazione",
        "compravendita": "Compravendita",
    }
    return labels.get(val, val)


def _record_field_modification(
    modifiche_dict: dict,
    field_name: str,
    label: str,
    old_val,
    new_val,
    current_user: User,
    old_author_name: Optional[str] = None,
    old_created_at: Optional[str] = None,
    initial_val: Optional[Any] = None,
):
    """Registra la modifica di un campo mantenendo traccia di tutti i passaggi (history chain)."""
    old_str = str(old_val).strip() if old_val is not None else ""
    new_str = str(new_val).strip() if new_val is not None else ""
    if old_str == new_str:
        return

    now_iso = _to_utc_iso(datetime.now(timezone.utc))
    curr_user_name = current_user.full_name or current_user.username
    curr_user_id = str(current_user.id)

    default_author = "Ufficio Tecnico / Acquisti" if field_name == "costo" else "Commerciale"
    old_author = old_author_name if (old_author_name and (field_name != "costo" or old_author_name != "Commerciale")) else default_author

    prev_mod = modifiche_dict.get(field_name, {})
    existing_steps = prev_mod.get("steps")

    if existing_steps and isinstance(existing_steps, list):
        steps = [dict(s) for s in existing_steps]
    elif prev_mod.get("old_value") or prev_mod.get("new_value"):
        steps = [
            {
                "value": prev_mod.get("old_value", old_str),
                "author_name": prev_mod.get("old_author_name") or old_author,
                "created_at": prev_mod.get("old_created_at") or old_created_at or now_iso,
                "author_id": "",
            },
            {
                "value": prev_mod.get("new_value", old_str),
                "author_name": prev_mod.get("author_name") or old_author,
                "created_at": prev_mod.get("updated_at") or now_iso,
                "author_id": prev_mod.get("author_id", ""),
            },
        ]
    else:
        init_str = str(initial_val).strip() if initial_val is not None else ""
        if init_str and init_str != old_str:
            steps = [
                {
                    "value": init_str,
                    "author_name": old_author,
                    "created_at": old_created_at or now_iso,
                    "author_id": "",
                },
                {
                    "value": old_str,
                    "author_name": "Ufficio Tecnico / Acquisti",
                    "created_at": now_iso,
                    "author_id": "",
                }
            ]
        else:
            steps = [
                {
                    "value": old_str,
                    "author_name": old_author,
                    "created_at": old_created_at or now_iso,
                    "author_id": "",
                }
            ]

    # Per il campo costo, il Commerciale non può aver inserito il costo
    if field_name == "costo" and steps:
        steps = [
            s for s in steps
            if s.get("author_name") != "Commerciale"
            and not (str(s.get("value", "")).strip() in ["0 €", "0.00 €", "0.0 €", "0"] and s.get("author_name") in ["Commerciale", None, ""])
        ]
        if not steps:
            steps = [
                {
                    "value": old_str,
                    "author_name": old_author,
                    "created_at": old_created_at or now_iso,
                    "author_id": "",
                }
            ]

    # Se l'ultimo step ha già lo stesso valore, non duplicarlo
    if steps and steps[-1]["value"] == new_str:
        return

    steps.append({
        "value": new_str,
        "author_name": curr_user_name,
        "created_at": now_iso,
        "author_id": curr_user_id,
    })

    if len(steps) < 2:
        return

    modifiche_dict[field_name] = {
        "field": field_name,
        "label": label,
        "steps": steps,
        "old_value": steps[0]["value"],
        "new_value": steps[-1]["value"],
        "old_author_name": steps[0]["author_name"],
        "old_created_at": steps[0]["created_at"],
        "author_id": curr_user_id,
        "author_name": curr_user_name,
        "updated_at": now_iso,
    }


def _filter_visible_modifiche(modifiche_dict: dict, role: str, current_user: Optional[User]) -> dict:
    """Filtra le modifiche: visibili solo all'admin e a chi ha fatto la modifica."""
    visible = {}
    user_id = str(current_user.id) if current_user else None
    for k, m in modifiche_dict.items():
        if not isinstance(m, dict):
            continue
        # Differenze tra vecchio e nuovo costo: visibili SOLO all'admin
        if k == "costo":
            if role == "admin":
                visible[k] = m
            continue
        if user_id:
            is_author = str(m.get("author_id", "")) == user_id
            if not is_author and "steps" in m and isinstance(m["steps"], list):
                for s in m["steps"]:
                    if str(s.get("author_id", "")) == user_id:
                        is_author = True
                        break
            if is_author:
                visible[k] = m
    return visible


# ─── Serializzatori per ruolo ─────────────────────────────────────────────────

def _serialize_richiesta(richiesta: RichiestaCommerciale, role: str, current_user: Optional[User] = None) -> dict:
    """Serializza una richiesta adattando i dati al ruolo e filtrando le modifiche visibili."""
    articoli_inserted_by_user = richiesta.articoli_inserted_by
    articoli_inserted_at_dt = richiesta.articoli_inserted_at
    listino_inserted_by_user = richiesta.listino_inserted_by
    listino_inserted_at_dt = richiesta.listino_inserted_at

    # Se non impostato esplicitamente ma ci sono articoli: fallback
    if not articoli_inserted_by_user and richiesta.articoli:
        for a in richiesta.articoli:
            if getattr(a, 'author', None):
                articoli_inserted_by_user = a.author
                break
    if not articoli_inserted_at_dt and richiesta.articoli:
        articoli_inserted_at_dt = richiesta.articoli[-1].created_at or richiesta.updated_at

    modifiche_richiesta = _parse_json_dict(getattr(richiesta, "modifiche", None))
    for k, m in modifiche_richiesta.items():
        if isinstance(m, dict) and "steps" not in m and m.get("old_value") and m.get("new_value"):
            m["steps"] = [
                {"value": m["old_value"], "author_name": m.get("old_author_name", "Commerciale"), "created_at": m.get("old_created_at", ""), "author_id": ""},
                {"value": m["new_value"], "author_name": m.get("author_name", "Utente"), "created_at": m.get("updated_at", ""), "author_id": m.get("author_id", "")},
            ]
    if "description" not in modifiche_richiesta and getattr(richiesta, "description_originale", None):
        orig_d = (richiesta.description_originale or "").strip()
        curr_d = (richiesta.description or "").strip()
        if orig_d and orig_d != curr_d:
            comm_author = (richiesta.author.full_name or richiesta.author.username) if richiesta.author else "Commerciale"
            comm_date = _to_utc_iso(richiesta.created_at)
            acq_author = (richiesta.articoli_inserted_by.full_name or richiesta.articoli_inserted_by.username) if richiesta.articoli_inserted_by else "Ufficio Tecnico / Acquisti"
            acq_date = _to_utc_iso(richiesta.articoli_inserted_at or richiesta.updated_at)
            acq_id = str(richiesta.articoli_inserted_by_id) if richiesta.articoli_inserted_by_id else ""
            modifiche_richiesta["description"] = {
                "field": "description",
                "label": "Descrizione Richiesta",
                "steps": [
                    {"value": orig_d, "author_name": comm_author, "created_at": comm_date, "author_id": ""},
                    {"value": curr_d, "author_name": acq_author, "created_at": acq_date, "author_id": acq_id},
                ],
                "old_value": orig_d,
                "new_value": curr_d,
                "old_author_name": comm_author,
                "old_created_at": comm_date,
                "author_id": acq_id,
                "author_name": acq_author,
                "updated_at": acq_date,
            }

    base = {
        "id": richiesta.id,
        "title": richiesta.title,
        "description": richiesta.description,
        "numero_offerta": richiesta.numero_offerta,
        "cliente": richiesta.cliente,
        "attachments": _parse_attachments(
            str(richiesta.attachments),
            str(richiesta.author.id) if richiesta.author else (str(richiesta.author_id) if getattr(richiesta, "author_id", None) else None),
            (richiesta.author.full_name or richiesta.author.username) if richiesta.author else None,
            default_author_role="commerciale",
        ),
        "status": richiesta.status,
        "author": {
            "id": richiesta.author.id,
            "username": richiesta.author.username,
            "full_name": richiesta.author.full_name,
        } if richiesta.author else None,
        "articoli_inserted_by": {
            "id": articoli_inserted_by_user.id,
            "username": articoli_inserted_by_user.username,
            "full_name": articoli_inserted_by_user.full_name,
        } if articoli_inserted_by_user else None,
        "articoli_inserted_at": _to_utc_iso(articoli_inserted_at_dt),
        "listino_inserted_by": {
            "id": listino_inserted_by_user.id if listino_inserted_by_user else "admin",
            "username": listino_inserted_by_user.username if listino_inserted_by_user else "admin",
            "full_name": listino_inserted_by_user.full_name if listino_inserted_by_user else "Amministrazione",
        } if (listino_inserted_by_user or richiesta.status == RichiestaStatus.COMPLETATA) else None,
        "listino_inserted_at": _to_utc_iso(listino_inserted_at_dt or (richiesta.updated_at if richiesta.status == RichiestaStatus.COMPLETATA else None)),
        "modifiche": _filter_visible_modifiche(modifiche_richiesta, role, current_user),
        "created_at": _to_utc_iso(richiesta.created_at),
        "updated_at": _to_utc_iso(richiesta.updated_at),
    }

    if role == "admin":
        base["description_originale"] = getattr(richiesta, "description_originale", None)
        base["articoli"] = [_serialize_articolo(a, "admin", current_user, richiesta) for a in richiesta.articoli]
    elif role == "acquisti":
        base["articoli"] = [_serialize_articolo(a, "acquisti", current_user, richiesta) for a in richiesta.articoli]
    else:
        base["articoli"] = [_serialize_articolo(a, "commerciale", current_user, richiesta) for a in richiesta.articoli]

    return base


def _serialize_articolo(
    articolo: ArticoloRichiesta,
    role: str,
    current_user: Optional[User] = None,
    richiesta: Optional[RichiestaCommerciale] = None,
) -> dict:
    """Serializza un articolo adattando i campi al ruolo e filtrando le modifiche visibili."""
    author_info = None
    try:
        insp = inspect(articolo)
        if "author" in insp.dict and insp.dict["author"] is not None:
            a_author = insp.dict["author"]
            author_info = {
                "id": a_author.id,
                "username": a_author.username,
                "full_name": a_author.full_name,
            }
    except Exception:
        author_info = None

    updated_by_info = None
    try:
        insp = inspect(articolo)
        if "updated_by" in insp.dict and insp.dict["updated_by"] is not None:
            a_upd = insp.dict["updated_by"]
            updated_by_info = {
                "id": a_upd.id,
                "username": a_upd.username,
                "full_name": a_upd.full_name,
            }
    except Exception:
        updated_by_info = None

    # Modifiche per articolo
    modifiche = _parse_json_dict(getattr(articolo, "modifiche", None))
    for k, m in modifiche.items():
        if isinstance(m, dict) and "steps" not in m and m.get("old_value") and m.get("new_value"):
            default_orig = "Ufficio Tecnico / Acquisti" if k == "costo" else "Commerciale"
            m["steps"] = [
                {"value": m["old_value"], "author_name": m.get("old_author_name") or default_orig, "created_at": m.get("old_created_at", ""), "author_id": ""},
                {"value": m["new_value"], "author_name": m.get("author_name", "Utente"), "created_at": m.get("updated_at", ""), "author_id": m.get("author_id", "")},
            ]

    # Per il campo costo, il Commerciale non inserisce il costo:
    # rimuoviamo qualsiasi step attribuito a Commerciale o originato da 0.00 € (Commerciale)
    if "costo" in modifiche and isinstance(modifiche["costo"], dict):
        costo_mod = modifiche["costo"]
        if "steps" in costo_mod and isinstance(costo_mod["steps"], list):
            filtered_steps = [
                s for s in costo_mod["steps"]
                if s.get("author_name") != "Commerciale"
                and not (str(s.get("value", "")).strip() in ["0 €", "0.00 €", "0.0 €", "0"] and s.get("author_name") in ["Commerciale", None, ""])
            ]
            if len(filtered_steps) < 2:
                del modifiche["costo"]
            else:
                costo_mod["steps"] = filtered_steps
                costo_mod["old_value"] = filtered_steps[0]["value"]
                costo_mod["old_author_name"] = filtered_steps[0].get("author_name") or "Ufficio Tecnico / Acquisti"
                costo_mod["old_created_at"] = filtered_steps[0].get("created_at", "")
                costo_mod["new_value"] = filtered_steps[-1]["value"]
                costo_mod["author_name"] = filtered_steps[-1].get("author_name")
                costo_mod["author_id"] = filtered_steps[-1].get("author_id", "")
                costo_mod["updated_at"] = filtered_steps[-1].get("created_at", "")
        elif costo_mod.get("old_author_name") == "Commerciale" or str(costo_mod.get("old_value", "")).strip() in ["0 €", "0.00 €", "0.0 €", "0"]:
            del modifiche["costo"]

    snap_comm = _parse_json_dict(getattr(articolo, "testo_originale_commerciale", None))
    snap_acq = _parse_json_dict(getattr(articolo, "testo_originale_acquisti", None))

    comm_author = snap_comm.get("author_name") or (
        (richiesta.author.full_name or richiesta.author.username) if (richiesta and richiesta.author) else "Commerciale"
    )
    comm_date = snap_comm.get("created_at") or (
        _to_utc_iso(richiesta.created_at) if richiesta else _to_utc_iso(articolo.created_at)
    )

    acq_author = (
        (articolo.updated_by.full_name or articolo.updated_by.username) if getattr(articolo, "updated_by", None)
        else ((richiesta.articoli_inserted_by.full_name or richiesta.articoli_inserted_by.username) if (richiesta and getattr(richiesta, "articoli_inserted_by", None))
        else (snap_acq.get("author_name") if snap_acq else "Ufficio Tecnico / Acquisti"))
    )
    acq_author_id = (
        str(articolo.updated_by_id) if getattr(articolo, "updated_by_id", None)
        else (str(richiesta.articoli_inserted_by_id) if (richiesta and getattr(richiesta, "articoli_inserted_by_id", None)) else "")
    )
    acq_date = _to_utc_iso(articolo.updated_at or articolo.created_at)

    # Sintesi Titolo per record storici
    if "titolo" not in modifiche and snap_comm.get("titolo") and snap_comm["titolo"].strip() != (articolo.titolo or "").strip():
        modifiche["titolo"] = {
            "field": "titolo",
            "label": "Titolo Articolo",
            "steps": [
                {"value": snap_comm["titolo"].strip(), "author_name": comm_author, "created_at": comm_date, "author_id": ""},
                {"value": (articolo.titolo or "").strip(), "author_name": acq_author, "created_at": acq_date, "author_id": acq_author_id},
            ],
            "old_value": snap_comm["titolo"].strip(),
            "new_value": (articolo.titolo or "").strip(),
            "old_author_name": comm_author,
            "old_created_at": comm_date,
            "author_id": acq_author_id,
            "author_name": acq_author,
            "updated_at": acq_date,
        }

    # Sintesi Descrizione per record storici
    old_desc = (snap_comm.get("descrizione") or "").strip()
    curr_desc = (articolo.descrizione or "").strip()
    if "descrizione" not in modifiche and old_desc and old_desc != curr_desc:
        modifiche["descrizione"] = {
            "field": "descrizione",
            "label": "Descrizione Articolo",
            "steps": [
                {"value": old_desc, "author_name": comm_author, "created_at": comm_date, "author_id": ""},
                {"value": curr_desc, "author_name": acq_author, "created_at": acq_date, "author_id": acq_author_id},
            ],
            "old_value": old_desc,
            "new_value": curr_desc,
            "old_author_name": comm_author,
            "old_created_at": comm_date,
            "author_id": acq_author_id,
            "author_name": acq_author,
            "updated_at": acq_date,
        }

    # Sintesi Tipologia per record storici
    if "tipologia" not in modifiche and snap_comm:
        old_tip = _format_tipologia(snap_comm.get("is_standard"), snap_comm.get("is_atex"), snap_comm.get("is_alimentare"))
        curr_tip = _format_tipologia(articolo.is_standard, articolo.is_atex, articolo.is_alimentare)
        if old_tip and old_tip != curr_tip:
            modifiche["tipologia"] = {
                "field": "tipologia",
                "label": "Tipologia Prodotto",
                "steps": [
                    {"value": old_tip, "author_name": comm_author, "created_at": comm_date, "author_id": ""},
                    {"value": curr_tip, "author_name": acq_author, "created_at": acq_date, "author_id": acq_author_id},
                ],
                "old_value": old_tip,
                "new_value": curr_tip,
                "old_author_name": comm_author,
                "old_created_at": comm_date,
                "author_id": acq_author_id,
                "author_name": acq_author,
                "updated_at": acq_date,
            }

    # Sintesi Note Admin per record storici
    if "note_admin" not in modifiche and snap_acq and snap_acq.get("note_admin") and snap_acq["note_admin"].strip() != (articolo.note_admin or "").strip():
        modifiche["note_admin"] = {
            "field": "note_admin",
            "label": "Note Admin",
            "steps": [
                {"value": snap_acq["note_admin"].strip(), "author_name": snap_acq.get("author_name") or "Ufficio Acquisti", "created_at": snap_acq.get("created_at") or acq_date, "author_id": ""},
                {"value": (articolo.note_admin or "").strip(), "author_name": (articolo.updated_by.full_name or articolo.updated_by.username) if getattr(articolo, "updated_by", None) else "Admin", "created_at": acq_date, "author_id": str(articolo.updated_by_id) if getattr(articolo, "updated_by_id", None) else ""},
            ],
            "old_value": snap_acq["note_admin"].strip(),
            "new_value": (articolo.note_admin or "").strip(),
            "old_author_name": snap_acq.get("author_name") or "Ufficio Acquisti",
            "old_created_at": snap_acq.get("created_at") or acq_date,
            "author_id": str(articolo.updated_by_id) if getattr(articolo, "updated_by_id", None) else "",
            "author_name": (articolo.updated_by.full_name or articolo.updated_by.username) if getattr(articolo, "updated_by", None) else "Admin",
            "updated_at": acq_date,
        }

    base = {
        "id": articolo.id,
        "richiesta_id": articolo.richiesta_id,
        "author_id": str(articolo.author_id) if getattr(articolo, "author_id", None) else None,
        "author": author_info,
        "updated_by": updated_by_info,
        "titolo": articolo.titolo,
        "descrizione": articolo.descrizione,
        "is_standard": articolo.is_standard,
        "is_atex": articolo.is_atex,
        "is_alimentare": articolo.is_alimentare,
        "tipo_fornitura": articolo.tipo_fornitura,
        "attachments": _parse_attachments(
            str(articolo.attachments),
            str(articolo.author.id) if getattr(articolo, "author", None) and articolo.author else (str(articolo.author_id) if getattr(articolo, "author_id", None) else None),
            (articolo.author.full_name or articolo.author.username) if getattr(articolo, "author", None) and articolo.author else None,
            default_author_role="commerciale",
        ),
        "testo_originale_commerciale": getattr(articolo, "testo_originale_commerciale", None),
        "modifiche": _filter_visible_modifiche(modifiche, role, current_user),
        "created_at": _to_utc_iso(articolo.created_at),
        "updated_at": _to_utc_iso(articolo.updated_at),
    }

    if role == "admin":
        base["costo"] = articolo.costo
        base["prezzo_listino"] = articolo.prezzo_listino
        base["testo_originale_acquisti"] = articolo.testo_originale_acquisti
        base["note_admin"] = articolo.note_admin
    elif role == "acquisti":
        base["costo"] = articolo.costo
    else:
        # Commerciale: MAI il costo dell'ufficio acquisti e MAI il tipo fornitura! Solo prezzo listino e note admin
        base["prezzo_listino"] = articolo.prezzo_listino
        base["note_admin"] = articolo.note_admin
        base["tipo_fornitura"] = None

    return base


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/my-role")
async def get_my_role(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restituisce il ruolo dell'utente corrente nel modulo RC (admin | acquisti | commerciale | none)."""
    role = await _get_role(db, current_user)
    return {"role": role, "enabled": role != "none"}


@router.get("/")
async def list_richieste(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Lista richieste filtrata per ruolo."""
    role = await _require_role(db, current_user, ["admin", "acquisti", "commerciale"])

    query = (
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.deleted_at.is_(None))
        .order_by(RichiestaCommerciale.created_at.desc())
    )

    # Commerciale, acquisti e admin vedono tutte le richieste
    # I dati sensibili (es. prezzi di costo, tipo fornitura) vengono filtrati a valle in _serialize_richiesta

    res = await db.execute(query)
    richieste = res.scalars().all()
    return [_serialize_richiesta(r, role, current_user) for r in richieste]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_richiesta(
    data: RichiestaCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Crea una nuova richiesta (solo commerciale o admin)."""
    role = await _require_role(db, current_user, ["commerciale", "admin"])

    richiesta = RichiestaCommerciale(
        title=data.title,
        description=data.descrizione,
        numero_offerta=data.numero_offerta,
        cliente=data.cliente,
        attachments="[]",
        author_id=current_user.id,
        status=RichiestaStatus.IN_LAVORAZIONE,
    )
    db.add(richiesta)
    await db.flush()

    if data.articoli:
        for art_data in data.articoli:
            titolo = (art_data.titolo or "").strip()
            if not titolo:
                continue
            snap_comm = {
                "titolo": titolo,
                "descrizione": art_data.descrizione or "",
                "is_standard": art_data.is_standard,
                "is_atex": art_data.is_atex,
                "is_alimentare": art_data.is_alimentare,
                "tipo_fornitura": art_data.tipo_fornitura.value if hasattr(art_data.tipo_fornitura, "value") else art_data.tipo_fornitura,
                "author_name": current_user.full_name or current_user.username,
                "created_at": _to_utc_iso(datetime.now(timezone.utc)),
            }
            articolo = ArticoloRichiesta(
                richiesta_id=richiesta.id,
                author_id=current_user.id,
                titolo=titolo,
                costo=0.0,
                descrizione=art_data.descrizione,
                is_standard=art_data.is_standard,
                is_atex=art_data.is_atex,
                is_alimentare=art_data.is_alimentare,
                tipo_fornitura=art_data.tipo_fornitura,
                attachments="[]",
                testo_originale_commerciale=json.dumps(snap_comm),
            )
            db.add(articolo)

    await db.commit()
    await db.refresh(richiesta)

    # Carica relazioni per la risposta
    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta.id)
    )
    richiesta = res.scalar_one()

    # Email notifica agli acquisti
    await _notify_acquisti_nuova_richiesta(db, richiesta, current_user)

    return _serialize_richiesta(richiesta, role, current_user)


# ─── Cestino (Trash - Solo Admin) ─────────────────────────────────────────────

async def _purge_expired_trash(db: AsyncSession):
    """Elimina definitivamente le richieste nel cestino da più di 90 giorni."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)
    res = await db.execute(
        select(RichiestaCommerciale).where(
            RichiestaCommerciale.deleted_at.isnot(None),
            RichiestaCommerciale.deleted_at <= cutoff,
        )
    )
    expired = res.scalars().all()
    for r in expired:
        folder = os.path.join(UPLOAD_DIR, str(r.id))
        if os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)
        await db.delete(r)
    if expired:
        await db.commit()


@router.get("/trash")
async def list_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Restituisce le richieste nel cestino con giorni rimanenti (solo admin)."""
    await _require_role(db, current_user, ["admin"])
    await _purge_expired_trash(db)

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.deleted_at.isnot(None))
        .order_by(RichiestaCommerciale.deleted_at.desc())
    )
    trashed = res.scalars().all()
    now = datetime.now(timezone.utc)
    items = []
    for r in trashed:
        deleted_dt = r.deleted_at or now
        if deleted_dt.tzinfo is None:
            deleted_dt = deleted_dt.replace(tzinfo=timezone.utc)
        elapsed = (now - deleted_dt).days
        days_left = max(0, 90 - elapsed)
        items.append({
            "id": r.id,
            "title": r.title,
            "cliente": r.cliente,
            "numero_offerta": r.numero_offerta,
            "status": r.status,
            "deleted_at": _to_utc_iso(r.deleted_at),
            "days_left": days_left,
            "author": {
                "id": r.author.id,
                "username": r.author.username,
                "full_name": r.author.full_name,
            } if r.author else None,
            "articoli_count": len(r.articoli),
        })
    return items


@router.post("/trash/{richiesta_id}/restore")
async def restore_richiesta(
    richiesta_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Ripristina una richiesta dal cestino (solo admin)."""
    await _require_role(db, current_user, ["admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    richiesta.deleted_at = None
    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(richiesta)

    # Ricarica per serializzazione
    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one()
    return _serialize_richiesta(richiesta, "admin", current_user)


@router.delete("/trash/empty")
async def empty_trash(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Svuota completamente il cestino delle richieste (solo admin)."""
    await _require_role(db, current_user, ["admin"])

    res = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.deleted_at.isnot(None))
    )
    trashed = res.scalars().all()
    for r in trashed:
        folder = os.path.join(UPLOAD_DIR, str(r.id))
        if os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)
        await db.delete(r)

    if trashed:
        await db.commit()
    return {"message": "Cestino svuotato con successo"}


@router.delete("/trash/{richiesta_id}")
async def hard_delete_richiesta(
    richiesta_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina definitivamente una richiesta dal cestino (solo admin)."""
    await _require_role(db, current_user, ["admin"])

    res = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    folder = os.path.join(UPLOAD_DIR, str(richiesta.id))
    if os.path.isdir(folder):
        shutil.rmtree(folder, ignore_errors=True)

    await db.delete(richiesta)
    await db.commit()
    return {"message": "Richiesta eliminata definitivamente"}


@router.get("/{richiesta_id}")
async def get_richiesta(
    richiesta_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Dettaglio singola richiesta."""
    role = await _require_role(db, current_user, ["admin", "acquisti", "commerciale"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(
            RichiestaCommerciale.id == richiesta_id,
            RichiestaCommerciale.deleted_at.is_(None),
        )
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    # Commerciale, acquisti e admin possono visualizzare la richiesta
    # Dati sensibili (es. costi e margini) vengono filtrati in _serialize_richiesta
    return _serialize_richiesta(richiesta, role, current_user)


@router.put("/{richiesta_id}")
async def update_richiesta(
    richiesta_id: str,
    data: RichiestaUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Modifica una richiesta:
    - Admin: può modificare qualsiasi campo (titolo, descrizione, numero offerta, cliente)
      e cambiare liberamente lo stato (aperta, in_lavorazione, manca_listino, completata).
    - Commerciale: può modificare solo le proprie richieste se ancora in stato APERTA.
    """
    role = await _require_role(db, current_user, ["commerciale", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(
            RichiestaCommerciale.id == richiesta_id,
            RichiestaCommerciale.deleted_at.is_(None),
        )
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if role == "commerciale":
        if richiesta.status not in (RichiestaStatus.APERTA, RichiestaStatus.IN_LAVORAZIONE):
            raise HTTPException(status_code=400, detail="Non puoi modificare la richiesta: è già stata inviata a listino o completata")
        if data.status is not None and data.status != richiesta.status:
            raise HTTPException(status_code=403, detail="Non hai i permessi per modificare lo stato")

    mod_dict = _parse_json_dict(getattr(richiesta, "modifiche", None))
    orig_author = (richiesta.author.full_name or richiesta.author.username) if richiesta.author else "Commerciale"
    orig_date = _to_utc_iso(richiesta.created_at)

    if data.title is not None and data.title.strip() != richiesta.title.strip():
        _record_field_modification(mod_dict, "title", "Titolo Richiesta", richiesta.title, data.title.strip(), current_user, orig_author, orig_date)
        richiesta.title = data.title.strip()  # type: ignore

    if data.descrizione is not None and (data.descrizione.strip() or "") != (richiesta.description or "").strip():
        if not getattr(richiesta, "description_originale", None) and richiesta.description:
            richiesta.description_originale = richiesta.description  # type: ignore
        _record_field_modification(mod_dict, "description", "Descrizione Richiesta", richiesta.description or "", data.descrizione.strip(), current_user, orig_author, orig_date)
        richiesta.description = data.descrizione.strip() or None  # type: ignore

    if data.numero_offerta is not None and (data.numero_offerta.strip() or "") != (richiesta.numero_offerta or "").strip():
        _record_field_modification(mod_dict, "numero_offerta", "Numero Offerta", richiesta.numero_offerta or "", data.numero_offerta.strip(), current_user, orig_author, orig_date)
        richiesta.numero_offerta = data.numero_offerta.strip() or None  # type: ignore

    if data.cliente is not None and data.cliente.strip() != richiesta.cliente.strip():
        _record_field_modification(mod_dict, "cliente", "Cliente", richiesta.cliente, data.cliente.strip(), current_user, orig_author, orig_date)
        richiesta.cliente = data.cliente.strip()  # type: ignore

    if role == "admin" and data.status is not None:
        richiesta.status = data.status  # type: ignore

    richiesta.modifiche = json.dumps(mod_dict)  # type: ignore
    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(richiesta)
    return _serialize_richiesta(richiesta, role, current_user)


@router.delete("/{richiesta_id}")
async def delete_richiesta(
    richiesta_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Sposta la richiesta nel cestino - Soft Delete per 90 giorni (solo admin)."""
    await _require_role(db, current_user, ["admin"])

    res = await db.execute(
        select(RichiestaCommerciale).where(
            RichiestaCommerciale.id == richiesta_id,
            RichiestaCommerciale.deleted_at.is_(None),
        )
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    richiesta.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return {"message": "Richiesta spostata nel cestino (conservata per 90 giorni)"}


@router.post("/{richiesta_id}/attachments")
async def upload_attachments_richiesta(
    richiesta_id: str,
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload allegati per la richiesta (solo autore o admin)."""
    role = await _require_role(db, current_user, ["commerciale", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if role == "commerciale" and richiesta.status not in (RichiestaStatus.APERTA, RichiestaStatus.IN_LAVORAZIONE):
        raise HTTPException(status_code=400, detail="Non puoi caricare allegati: la richiesta è già a listino o completata")

    saved_entries = []
    folder = os.path.join(UPLOAD_DIR, richiesta_id)
    os.makedirs(folder, exist_ok=True)

    for file in files:
        original_name = file.filename or "allegato"
        base, ext = os.path.splitext(original_name)
        safe_base = re.sub(r'[^\w\.\-\_]', '_', base)[:60]
        filename = f"{uuid.uuid4().hex[:8]}_{safe_base}{ext}"
        filepath = os.path.join(folder, filename)
        content = await file.read()
        with open(filepath, "wb") as f:
            f.write(content)
        saved_entries.append({
            "name": original_name,
            "url": f"/uploads/richieste_commerciali/{richiesta_id}/{filename}",
            "uploaded_by_id": str(current_user.id),
            "uploaded_by_name": current_user.full_name or current_user.username,
            "uploaded_by_role": role,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        })

    current = _parse_attachments(
        str(richiesta.attachments),
        str(richiesta.author_id) if getattr(richiesta, "author_id", None) else None,
        default_author_role="commerciale",
    )
    current.extend(saved_entries)
    richiesta.attachments = json.dumps(current)  # type: ignore
    await db.commit()

    return {"attachments": current}


@router.delete("/{richiesta_id}/attachments")
async def delete_attachment_richiesta(
    richiesta_id: str,
    url: str = Query(..., description="URL dell'allegato da eliminare"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina un allegato della richiesta (solo chi lo ha caricato, il rispettivo reparto, o un admin)."""
    user_role = await _require_role(db, current_user, ["commerciale", "acquisti", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(*_richiesta_options())
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    author_id = str(richiesta.author_id) if getattr(richiesta, "author_id", None) else None
    author_name = (richiesta.author.full_name or richiesta.author.username) if getattr(richiesta, "author", None) else None
    current = _parse_attachments(str(richiesta.attachments), author_id, author_name, default_author_role="commerciale")

    is_admin = (user_role == "admin" or current_user.role == "admin")
    if not is_admin:
        if user_role == "commerciale":
            raise HTTPException(
                status_code=400,
                detail="Gli allegati non possono essere rimossi una volta inviata la richiesta",
            )
        if user_role == "acquisti" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
            raise HTTPException(
                status_code=400,
                detail="Gli allegati non possono essere rimossi dopo l'invio all'admin per il listino",
            )

    target = next((a for a in current if a.get("url") == url), None)
    if not target:
        raise HTTPException(status_code=404, detail="Allegato non trovato")

    uploader_id = target.get("uploaded_by_id")
    uploader_role = target.get("uploaded_by_role")
    is_owner_user = bool(uploader_id and str(uploader_id) == str(current_user.id))
    is_owner_role = bool(uploader_role and uploader_role == user_role)

    if not (is_admin or is_owner_user or is_owner_role):
        raise HTTPException(
            status_code=403,
            detail="Non puoi eliminare gli allegati caricati da un altro reparto o utente"
        )

    updated_list = [a for a in current if a.get("url") != url]
    richiesta.attachments = json.dumps(updated_list)

    if url.startswith("/uploads/richieste_commerciali/"):
        rel_path = url[len("/uploads/richieste_commerciali/"):]
        file_path = os.path.join(UPLOAD_DIR, rel_path)
        if os.path.isfile(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass

    await db.commit()
    return {"attachments": updated_list}


@router.put("/{richiesta_id}/prendi-in-carico")
async def prendi_in_carico(
    richiesta_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acquisti prende in carico la richiesta (APERTA → IN_LAVORAZIONE)."""
    role = await _require_role(db, current_user, ["acquisti", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status != RichiestaStatus.APERTA:
        raise HTTPException(status_code=400, detail="La richiesta non è in stato APERTA")

    richiesta.status = RichiestaStatus.IN_LAVORAZIONE  # type: ignore
    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(richiesta)

    return _serialize_richiesta(richiesta, role, current_user)


@router.post("/{richiesta_id}/articoli", status_code=status.HTTP_201_CREATED)
async def add_articolo(
    richiesta_id: str,
    data: ArticoloCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acquisti aggiunge un articolo alla richiesta."""
    role = await _require_role(db, current_user, ["acquisti", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status == RichiestaStatus.APERTA:
        raise HTTPException(
            status_code=400,
            detail="La richiesta deve essere presa in carico dall'Ufficio Acquisti prima di poter inserire articoli",
        )

    if role != "admin" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="Puoi aggiungere articoli solo quando la richiesta è IN LAVORAZIONE",
        )

    snap_comm = {
        "titolo": data.titolo,
        "descrizione": data.descrizione or "",
        "is_standard": data.is_standard,
        "is_atex": data.is_atex,
        "is_alimentare": data.is_alimentare,
        "tipo_fornitura": data.tipo_fornitura.value if hasattr(data.tipo_fornitura, "value") else data.tipo_fornitura,
        "author_name": current_user.full_name or current_user.username,
        "created_at": _to_utc_iso(datetime.now(timezone.utc)),
    }
    articolo = ArticoloRichiesta(
        richiesta_id=richiesta_id,
        author_id=current_user.id,
        titolo=data.titolo,
        costo=data.costo,
        descrizione=data.descrizione,
        is_standard=data.is_standard,
        is_atex=data.is_atex,
        is_alimentare=data.is_alimentare,
        tipo_fornitura=data.tipo_fornitura,
        prezzo_listino=data.prezzo_listino if role == "admin" else None,
        note_admin=data.note_admin if role == "admin" else None,
        attachments="[]",
        testo_originale_commerciale=json.dumps(snap_comm),
    )
    richiesta.articoli_inserted_by_id = current_user.id
    richiesta.articoli_inserted_at = datetime.now(timezone.utc)
    richiesta.updated_at = datetime.now(timezone.utc)
    db.add(articolo)
    await db.commit()
    res_reloaded = await db.execute(
        select(ArticoloRichiesta)
        .options(selectinload(ArticoloRichiesta.author), selectinload(ArticoloRichiesta.updated_by))
        .where(ArticoloRichiesta.id == articolo.id)
    )
    articolo = res_reloaded.scalar_one_or_none()

    return _serialize_articolo(articolo, role, current_user, richiesta)


@router.put("/{richiesta_id}/articoli/{articolo_id}")
async def update_articolo(
    richiesta_id: str,
    articolo_id: str,
    data: ArticoloUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acquisti o Admin modifica un articolo."""
    role = await _require_role(db, current_user, ["acquisti", "admin"])

    res_req = await db.execute(
        select(RichiestaCommerciale)
        .options(*_richiesta_options())
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_req.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status == RichiestaStatus.APERTA:
        raise HTTPException(
            status_code=400,
            detail="La richiesta deve essere presa in carico dall'Ufficio Acquisti prima di poter modificare articoli",
        )

    if role != "admin" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="Puoi modificare articoli solo quando la richiesta è IN LAVORAZIONE",
        )

    res = await db.execute(
        select(ArticoloRichiesta).where(
            ArticoloRichiesta.id == articolo_id,
            ArticoloRichiesta.richiesta_id == richiesta_id,
        )
    )
    articolo = res.scalar_one_or_none()
    if not articolo:
        raise HTTPException(status_code=404, detail="Articolo non trovato")

    if not getattr(articolo, "testo_originale_commerciale", None):
        orig_author = None
        if getattr(articolo, "author", None):
            orig_author = articolo.author.full_name or articolo.author.username
        snap_comm = {
            "titolo": articolo.titolo,
            "descrizione": articolo.descrizione or "",
            "is_standard": bool(articolo.is_standard),
            "is_atex": bool(articolo.is_atex),
            "is_alimentare": bool(articolo.is_alimentare),
            "tipo_fornitura": articolo.tipo_fornitura.value if hasattr(articolo.tipo_fornitura, "value") else articolo.tipo_fornitura,
            "author_name": orig_author or (current_user.full_name or current_user.username),
            "created_at": _to_utc_iso(articolo.created_at) if articolo.created_at else _to_utc_iso(datetime.now(timezone.utc)),
        }
        articolo.testo_originale_commerciale = json.dumps(snap_comm)

    articolo.updated_by_id = current_user.id
    mod_dict = _parse_json_dict(getattr(articolo, "modifiche", None))
    snap_comm = _parse_json_dict(getattr(articolo, "testo_originale_commerciale", None))
    orig_author = snap_comm.get("author_name") or "Commerciale"
    orig_date = snap_comm.get("created_at") or _to_utc_iso(articolo.created_at)

    if data.titolo is not None and data.titolo.strip() != articolo.titolo.strip():
        _record_field_modification(mod_dict, "titolo", "Titolo Articolo", articolo.titolo, data.titolo.strip(), current_user, orig_author, orig_date)
        articolo.titolo = data.titolo.strip()  # type: ignore

    if data.costo is not None and data.costo != articolo.costo:
        old_costo = articolo.costo
        if old_costo is not None and old_costo > 0:
            old_costo_str = f"{old_costo:.2f} €"
            new_costo_str = f"{data.costo:.2f} €"
            snap_acq = _parse_json_dict(getattr(articolo, "testo_originale_acquisti", None))
            costo_author = (articolo.updated_by.full_name or articolo.updated_by.username) if getattr(articolo, "updated_by", None) else (snap_acq.get("author_name") or "Ufficio Tecnico / Acquisti")
            costo_date = snap_acq.get("created_at") or _to_utc_iso(articolo.updated_at or articolo.created_at)
            _record_field_modification(mod_dict, "costo", "Costo Acquisti", old_costo_str, new_costo_str, current_user, costo_author, costo_date)
        else:
            mod_dict.pop("costo", None)
        articolo.costo = data.costo  # type: ignore

    if data.descrizione is not None and (data.descrizione.strip() or "") != (articolo.descrizione or "").strip():
        _record_field_modification(mod_dict, "descrizione", "Descrizione Articolo", articolo.descrizione or "", data.descrizione.strip(), current_user, orig_author, orig_date)
        articolo.descrizione = data.descrizione.strip() or None  # type: ignore

    old_tip = _format_tipologia(articolo.is_standard, articolo.is_atex, articolo.is_alimentare)
    new_std = data.is_standard if data.is_standard is not None else articolo.is_standard
    new_atex = data.is_atex if data.is_atex is not None else articolo.is_atex
    new_alim = data.is_alimentare if data.is_alimentare is not None else articolo.is_alimentare
    new_tip = _format_tipologia(new_std, new_atex, new_alim)
    if old_tip != new_tip:
        _record_field_modification(mod_dict, "tipologia", "Tipologia Prodotto", old_tip, new_tip, current_user, orig_author, orig_date)
        articolo.is_standard = new_std  # type: ignore
        articolo.is_atex = new_atex  # type: ignore
        articolo.is_alimentare = new_alim  # type: ignore

    if "tipo_fornitura" in data.model_fields_set and data.tipo_fornitura != articolo.tipo_fornitura:
        old_tf = _format_tipo_fornitura(articolo.tipo_fornitura)
        new_tf = _format_tipo_fornitura(data.tipo_fornitura)
        _record_field_modification(mod_dict, "tipo_fornitura", "Tipo Fornitura", old_tf, new_tf, current_user, orig_author, orig_date)
        articolo.tipo_fornitura = data.tipo_fornitura  # type: ignore

    # Campi solo admin
    if role == "admin":
        if data.prezzo_listino is not None and data.prezzo_listino != articolo.prezzo_listino:
            old_pl = f"{articolo.prezzo_listino:.2f} €" if articolo.prezzo_listino is not None else "0.00 €"
            new_pl = f"{data.prezzo_listino:.2f} €"
            _record_field_modification(mod_dict, "prezzo_listino", "Prezzo Listino", old_pl, new_pl, current_user, orig_author, orig_date)
            articolo.prezzo_listino = data.prezzo_listino  # type: ignore
        if data.note_admin is not None and (data.note_admin.strip() or "") != (articolo.note_admin or "").strip():
            _record_field_modification(mod_dict, "note_admin", "Note Admin", articolo.note_admin or "", data.note_admin.strip(), current_user, orig_author, orig_date)
            articolo.note_admin = data.note_admin.strip() or None  # type: ignore

    articolo.modifiche = json.dumps(mod_dict)  # type: ignore
    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()
    res_reloaded = await db.execute(
        select(ArticoloRichiesta)
        .options(selectinload(ArticoloRichiesta.author), selectinload(ArticoloRichiesta.updated_by))
        .where(ArticoloRichiesta.id == articolo_id)
    )
    articolo = res_reloaded.scalar_one_or_none()
    return _serialize_articolo(articolo, role, current_user, richiesta)


@router.delete("/{richiesta_id}/articoli/{articolo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_articolo(
    richiesta_id: str,
    articolo_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Acquisti elimina un articolo."""
    role = await _require_role(db, current_user, ["acquisti", "admin"])

    res_req = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_req.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status == RichiestaStatus.APERTA:
        raise HTTPException(
            status_code=400,
            detail="La richiesta deve essere presa in carico dall'Ufficio Acquisti prima di poter eliminare articoli",
        )

    if role != "admin" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="Puoi eliminare articoli solo quando la richiesta è IN LAVORAZIONE",
        )

    res = await db.execute(
        select(ArticoloRichiesta).where(
            ArticoloRichiesta.id == articolo_id,
            ArticoloRichiesta.richiesta_id == richiesta_id,
        )
    )
    articolo = res.scalar_one_or_none()
    if not articolo:
        raise HTTPException(status_code=404, detail="Articolo non trovato")

    await db.delete(articolo)
    await db.commit()


@router.post("/{richiesta_id}/articoli/{articolo_id}/attachments")
async def upload_attachments_articolo(
    richiesta_id: str,
    articolo_id: str,
    files: List[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload allegati per un articolo."""
    role = await _require_role(db, current_user, ["commerciale", "acquisti", "admin"])

    res_req = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_req.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if role == "commerciale":
        if richiesta.status not in (RichiestaStatus.APERTA, RichiestaStatus.IN_LAVORAZIONE):
            raise HTTPException(
                status_code=400,
                detail="Puoi caricare allegati solo finché la richiesta è aperta o in lavorazione",
            )
    elif role != "admin" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="Puoi caricare allegati solo quando la richiesta è IN LAVORAZIONE",
        )

    res = await db.execute(
        select(ArticoloRichiesta).where(
            ArticoloRichiesta.id == articolo_id,
            ArticoloRichiesta.richiesta_id == richiesta_id,
        )
    )
    articolo = res.scalar_one_or_none()
    if not articolo:
        raise HTTPException(status_code=404, detail="Articolo non trovato")

    saved_entries = []
    folder = os.path.join(UPLOAD_DIR, richiesta_id, "articoli", articolo_id)
    os.makedirs(folder, exist_ok=True)

    for file in files:
        original_name = file.filename or "allegato"
        base, ext = os.path.splitext(original_name)
        safe_base = re.sub(r'[^\w\.\-\_]', '_', base)[:60]
        filename = f"{uuid.uuid4().hex[:8]}_{safe_base}{ext}"
        filepath = os.path.join(folder, filename)
        content = await file.read()
        with open(filepath, "wb") as f:
            f.write(content)
        saved_entries.append({
            "name": original_name,
            "url": f"/uploads/richieste_commerciali/{richiesta_id}/articoli/{articolo_id}/{filename}",
            "uploaded_by_id": str(current_user.id),
            "uploaded_by_name": current_user.full_name or current_user.username,
            "uploaded_by_role": role,
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
        })

    author_id = str(articolo.author_id) if getattr(articolo, "author_id", None) else None
    current = _parse_attachments(str(articolo.attachments), author_id, default_author_role="commerciale")
    current.extend(saved_entries)
    articolo.attachments = json.dumps(current)  # type: ignore
    await db.commit()

    return {"attachments": current}


@router.delete("/{richiesta_id}/articoli/{articolo_id}/attachments")
async def delete_attachment_articolo(
    richiesta_id: str,
    articolo_id: str,
    url: str = Query(..., description="URL dell'allegato da eliminare"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Elimina un allegato di un articolo (solo chi lo ha caricato, il rispettivo reparto, o un admin)."""
    user_role = await _require_role(db, current_user, ["commerciale", "acquisti", "admin"])

    res = await db.execute(
        select(ArticoloRichiesta).where(
            ArticoloRichiesta.id == articolo_id,
            ArticoloRichiesta.richiesta_id == richiesta_id,
        )
    )
    articolo = res.scalar_one_or_none()
    if not articolo:
        raise HTTPException(status_code=404, detail="Articolo non trovato")

    author_id = str(articolo.author_id) if getattr(articolo, "author_id", None) else None
    current = _parse_attachments(str(articolo.attachments), author_id, default_author_role="commerciale")

    res_req = await db.execute(
        select(RichiestaCommerciale).where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_req.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    is_admin = (user_role == "admin" or current_user.role == "admin")
    if not is_admin:
        if user_role == "commerciale":
            raise HTTPException(
                status_code=400,
                detail="Gli allegati non possono essere rimossi una volta inviata la richiesta",
            )
        if user_role == "acquisti" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
            raise HTTPException(
                status_code=400,
                detail="Gli allegati non possono essere rimossi dopo l'invio all'admin per il listino",
            )

    target = next((a for a in current if a.get("url") == url), None)
    if not target:
        raise HTTPException(status_code=404, detail="Allegato non trovato")

    uploader_id = target.get("uploaded_by_id")
    uploader_role = target.get("uploaded_by_role")
    is_owner_user = bool(uploader_id and str(uploader_id) == str(current_user.id))
    is_owner_role = bool(uploader_role and uploader_role == user_role)

    if not (is_admin or is_owner_user or is_owner_role):
        raise HTTPException(
            status_code=403,
            detail="Non puoi eliminare gli allegati caricati da un altro reparto o utente"
        )

    updated_list = [a for a in current if a.get("url") != url]
    articolo.attachments = json.dumps(updated_list)

    if url.startswith("/uploads/richieste_commerciali/"):
        rel_path = url[len("/uploads/richieste_commerciali/"):]
        file_path = os.path.join(UPLOAD_DIR, rel_path)
        if os.path.isfile(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass

    await db.commit()
    return {"attachments": updated_list}


@router.put("/{richiesta_id}/articoli-bulk")
async def salva_articoli_bulk(
    richiesta_id: str,
    data: InviaAdAdminIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Acquisti o Admin salva le modifiche di più articoli contemporaneamente senza cambiare lo stato della richiesta.
    """
    role = await _require_role(db, current_user, ["acquisti", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(*_richiesta_options())
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if role != "admin" and richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="Puoi modificare gli articoli solo quando la richiesta è IN LAVORAZIONE",
        )

    if data.articoli:
        art_map: dict[str, ArticoloRichiesta] = {str(a.id): a for a in (richiesta.articoli or [])}
        for art_in in data.articoli:
            art = art_map.get(art_in.id) if art_in.id else None
            if not art:
                snap_comm = {
                    "titolo": (art_in.titolo or "").strip(),
                    "descrizione": (art_in.descrizione or "").strip(),
                    "is_standard": bool(art_in.is_standard),
                    "is_atex": bool(art_in.is_atex),
                    "is_alimentare": bool(art_in.is_alimentare),
                    "tipo_fornitura": art_in.tipo_fornitura.value if hasattr(art_in.tipo_fornitura, "value") else art_in.tipo_fornitura,
                    "author_name": current_user.full_name or current_user.username,
                    "created_at": _to_utc_iso(datetime.now(timezone.utc)),
                }
                new_art = ArticoloRichiesta(
                    richiesta_id=richiesta_id,
                    author_id=current_user.id,
                    titolo=(art_in.titolo or "Nuovo Articolo").strip(),
                    costo=art_in.costo or 0,
                    descrizione=(art_in.descrizione or "").strip() or None,
                    is_standard=bool(art_in.is_standard),
                    is_atex=bool(art_in.is_atex),
                    is_alimentare=bool(art_in.is_alimentare),
                    tipo_fornitura=art_in.tipo_fornitura,
                    prezzo_listino=art_in.prezzo_listino if role == "admin" else None,
                    note_admin=art_in.note_admin if role == "admin" else None,
                    attachments="[]",
                    testo_originale_commerciale=json.dumps(snap_comm),
                )
                db.add(new_art)
                richiesta.articoli.append(new_art)
                if art_in.id:
                    art_map[art_in.id] = new_art
                continue

            if art:
                if not getattr(art, "testo_originale_commerciale", None):
                    orig_author = None
                    if getattr(art, "author", None):
                        orig_author = art.author.full_name or art.author.username
                    snap_comm = {
                        "titolo": art.titolo,
                        "descrizione": art.descrizione or "",
                        "is_standard": bool(art.is_standard),
                        "is_atex": bool(art.is_atex),
                        "is_alimentare": bool(art.is_alimentare),
                        "tipo_fornitura": art.tipo_fornitura.value if hasattr(art.tipo_fornitura, "value") else art.tipo_fornitura,
                        "author_name": orig_author or (current_user.full_name or current_user.username),
                        "created_at": _to_utc_iso(art.created_at) if art.created_at else _to_utc_iso(datetime.now(timezone.utc)),
                    }
                    art.testo_originale_commerciale = json.dumps(snap_comm)

                art.updated_by_id = current_user.id
                mod_dict = _parse_json_dict(getattr(art, "modifiche", None))
                snap_comm = _parse_json_dict(getattr(art, "testo_originale_commerciale", None))
                orig_author = snap_comm.get("author_name") or "Commerciale"
                orig_date = snap_comm.get("created_at") or _to_utc_iso(art.created_at)

                if art_in.titolo is not None and art_in.titolo.strip() != art.titolo.strip():
                    _record_field_modification(mod_dict, "titolo", "Titolo Articolo", art.titolo, art_in.titolo.strip(), current_user, orig_author, orig_date)
                    art.titolo = art_in.titolo.strip()
                if art_in.costo is not None and art_in.costo != art.costo:
                    old_costo = art.costo
                    if old_costo is not None and old_costo > 0:
                        old_costo_str = f"{old_costo:.2f} €"
                        new_costo_str = f"{art_in.costo:.2f} €"
                        snap_acq = _parse_json_dict(getattr(art, "testo_originale_acquisti", None))
                        costo_author = (art.updated_by.full_name or art.updated_by.username) if getattr(art, "updated_by", None) else (snap_acq.get("author_name") or "Ufficio Tecnico / Acquisti")
                        costo_date = snap_acq.get("created_at") or _to_utc_iso(art.updated_at or art.created_at)
                        _record_field_modification(mod_dict, "costo", "Costo Acquisti", old_costo_str, new_costo_str, current_user, costo_author, costo_date)
                    else:
                        mod_dict.pop("costo", None)
                    art.costo = art_in.costo
                if art_in.descrizione is not None and (art_in.descrizione.strip() or "") != (art.descrizione or "").strip():
                    _record_field_modification(mod_dict, "descrizione", "Descrizione Articolo", art.descrizione or "", art_in.descrizione.strip(), current_user, orig_author, orig_date)
                    art.descrizione = art_in.descrizione.strip() or None

                old_tip = _format_tipologia(art.is_standard, art.is_atex, art.is_alimentare)
                new_std = art_in.is_standard if art_in.is_standard is not None else art.is_standard
                new_atex = art_in.is_atex if art_in.is_atex is not None else art.is_atex
                new_alim = art_in.is_alimentare if art_in.is_alimentare is not None else art.is_alimentare
                new_tip = _format_tipologia(new_std, new_atex, new_alim)
                if old_tip != new_tip:
                    _record_field_modification(mod_dict, "tipologia", "Tipologia Prodotto", old_tip, new_tip, current_user, orig_author, orig_date)
                    art.is_standard = new_std
                    art.is_atex = new_atex
                    art.is_alimentare = new_alim

                if "tipo_fornitura" in art_in.model_fields_set and art_in.tipo_fornitura != art.tipo_fornitura:
                    old_tf = _format_tipo_fornitura(art.tipo_fornitura)
                    new_tf = _format_tipo_fornitura(art_in.tipo_fornitura)
                    _record_field_modification(mod_dict, "tipo_fornitura", "Tipo Fornitura", old_tf, new_tf, current_user, orig_author, orig_date)
                    art.tipo_fornitura = art_in.tipo_fornitura

                if role == "admin":
                    if art_in.prezzo_listino is not None and art_in.prezzo_listino != art.prezzo_listino:
                        old_pl = f"{art.prezzo_listino:.2f} €" if art.prezzo_listino is not None else "0.00 €"
                        new_pl = f"{art_in.prezzo_listino:.2f} €"
                        _record_field_modification(mod_dict, "prezzo_listino", "Prezzo Listino", old_pl, new_pl, current_user, orig_author, orig_date)
                        art.prezzo_listino = art_in.prezzo_listino
                    if art_in.note_admin is not None and (art_in.note_admin.strip() or "") != (art.note_admin or "").strip():
                        _record_field_modification(mod_dict, "note_admin", "Note Admin", art.note_admin or "", art_in.note_admin.strip(), current_user, orig_author, orig_date)
                        art.note_admin = art_in.note_admin.strip() or None

                art.modifiche = json.dumps(mod_dict)

        if role == "admin" and data.descrizione is not None and (data.descrizione.strip() or "") != (richiesta.description or "").strip():
            r_mod = _parse_json_dict(getattr(richiesta, "modifiche", None))
            _record_field_modification(
                r_mod,
                "description",
                "Descrizione Richiesta",
                richiesta.description or "",
                data.descrizione.strip(),
                current_user,
                old_author_name=(richiesta.author.full_name or richiesta.author.username) if richiesta.author else "Commerciale",
                old_created_at=_to_utc_iso(richiesta.created_at),
            )
            richiesta.modifiche = json.dumps(r_mod)
            if not getattr(richiesta, "description_originale", None) and richiesta.description:
                richiesta.description_originale = richiesta.description
            richiesta.description = data.descrizione.strip() or None

    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()

    res_reloaded = await db.execute(
        select(RichiestaCommerciale)
        .options(*_richiesta_options())
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_reloaded.scalar_one_or_none()
    return _serialize_richiesta(richiesta, role, current_user)


@router.put("/{richiesta_id}/invia-a-admin")
async def invia_a_admin(
    richiesta_id: str,
    data: Optional[InviaAdAdminIn] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Acquisti invia la richiesta all'admin per il prezzo di listino.
    Salva automaticamente le modifiche inviate agli articoli.
    Salva lo snapshot del testo originale acquisti per il diff.
    (IN_LAVORAZIONE → MANCA_LISTINO)
    """
    await _require_role(db, current_user, ["acquisti", "admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status != RichiestaStatus.IN_LAVORAZIONE:
        raise HTTPException(
            status_code=400,
            detail="La richiesta deve essere IN LAVORAZIONE per inviarla all'admin",
        )

    if not richiesta.articoli and not (data and data.articoli):
        raise HTTPException(
            status_code=400,
            detail="Aggiungi almeno un articolo prima di inviare all'admin",
        )

    # Se passati articoli nel payload, aggiornali o creali prima della transizione
    if data and data.articoli:
        art_map: dict[str, ArticoloRichiesta] = {str(a.id): a for a in (richiesta.articoli or [])}
        for art_in in data.articoli:
            art = art_map.get(art_in.id) if art_in.id else None
            if not art:
                snap_comm = {
                    "titolo": (art_in.titolo or "").strip(),
                    "descrizione": (art_in.descrizione or "").strip(),
                    "is_standard": bool(art_in.is_standard),
                    "is_atex": bool(art_in.is_atex),
                    "is_alimentare": bool(art_in.is_alimentare),
                    "tipo_fornitura": art_in.tipo_fornitura.value if hasattr(art_in.tipo_fornitura, "value") else art_in.tipo_fornitura,
                    "author_name": current_user.full_name or current_user.username,
                    "created_at": _to_utc_iso(datetime.now(timezone.utc)),
                }
                new_art = ArticoloRichiesta(
                    richiesta_id=richiesta_id,
                    author_id=current_user.id,
                    titolo=(art_in.titolo or "Nuovo Articolo").strip(),
                    costo=art_in.costo or 0,
                    descrizione=(art_in.descrizione or "").strip() or None,
                    is_standard=bool(art_in.is_standard),
                    is_atex=bool(art_in.is_atex),
                    is_alimentare=bool(art_in.is_alimentare),
                    tipo_fornitura=art_in.tipo_fornitura,
                    attachments="[]",
                    testo_originale_commerciale=json.dumps(snap_comm),
                )
                db.add(new_art)
                richiesta.articoli.append(new_art)
                if art_in.id:
                    art_map[art_in.id] = new_art
                continue

            if art:
                if not getattr(art, "testo_originale_commerciale", None):
                    orig_author = None
                    if getattr(art, "author", None):
                        orig_author = art.author.full_name or art.author.username
                    snap_comm = {
                        "titolo": art.titolo,
                        "descrizione": art.descrizione or "",
                        "is_standard": bool(art.is_standard),
                        "is_atex": bool(art.is_atex),
                        "is_alimentare": bool(art.is_alimentare),
                        "tipo_fornitura": art.tipo_fornitura.value if hasattr(art.tipo_fornitura, "value") else art.tipo_fornitura,
                        "author_name": orig_author or (current_user.full_name or current_user.username),
                        "created_at": _to_utc_iso(art.created_at) if art.created_at else _to_utc_iso(datetime.now(timezone.utc)),
                    }
                    art.testo_originale_commerciale = json.dumps(snap_comm)

                art.updated_by_id = current_user.id
                mod_dict = _parse_json_dict(getattr(art, "modifiche", None))
                snap_comm = _parse_json_dict(getattr(art, "testo_originale_commerciale", None))
                orig_author = snap_comm.get("author_name") or "Commerciale"
                orig_date = snap_comm.get("created_at") or _to_utc_iso(art.created_at)

                if art_in.titolo is not None and art_in.titolo.strip() != art.titolo.strip():
                    _record_field_modification(mod_dict, "titolo", "Titolo Articolo", art.titolo, art_in.titolo.strip(), current_user, orig_author, orig_date)
                    art.titolo = art_in.titolo.strip()
                if art_in.costo is not None and art_in.costo != art.costo:
                    old_costo = art.costo
                    if old_costo is not None and old_costo > 0:
                        old_costo_str = f"{old_costo:.2f} €"
                        new_costo_str = f"{art_in.costo:.2f} €"
                        snap_acq = _parse_json_dict(getattr(art, "testo_originale_acquisti", None))
                        costo_author = (art.updated_by.full_name or art.updated_by.username) if getattr(art, "updated_by", None) else (snap_acq.get("author_name") or "Ufficio Tecnico / Acquisti")
                        costo_date = snap_acq.get("created_at") or _to_utc_iso(art.updated_at or art.created_at)
                        _record_field_modification(mod_dict, "costo", "Costo Acquisti", old_costo_str, new_costo_str, current_user, costo_author, costo_date)
                    else:
                        mod_dict.pop("costo", None)
                    art.costo = art_in.costo
                if art_in.descrizione is not None and (art_in.descrizione.strip() or "") != (art.descrizione or "").strip():
                    _record_field_modification(mod_dict, "descrizione", "Descrizione Articolo", art.descrizione or "", art_in.descrizione.strip(), current_user, orig_author, orig_date)
                    art.descrizione = art_in.descrizione.strip() or None

                old_tip = _format_tipologia(art.is_standard, art.is_atex, art.is_alimentare)
                new_std = art_in.is_standard if art_in.is_standard is not None else art.is_standard
                new_atex = art_in.is_atex if art_in.is_atex is not None else art.is_atex
                new_alim = art_in.is_alimentare if art_in.is_alimentare is not None else art.is_alimentare
                new_tip = _format_tipologia(new_std, new_atex, new_alim)
                if old_tip != new_tip:
                    _record_field_modification(mod_dict, "tipologia", "Tipologia Prodotto", old_tip, new_tip, current_user, orig_author, orig_date)
                    art.is_standard = new_std
                    art.is_atex = new_atex
                    art.is_alimentare = new_alim

                if "tipo_fornitura" in art_in.model_fields_set and art_in.tipo_fornitura != art.tipo_fornitura:
                    old_tf = _format_tipo_fornitura(art.tipo_fornitura)
                    new_tf = _format_tipo_fornitura(art_in.tipo_fornitura)
                    _record_field_modification(mod_dict, "tipo_fornitura", "Tipo Fornitura", old_tf, new_tf, current_user, orig_author, orig_date)
                    art.tipo_fornitura = art_in.tipo_fornitura

                art.modifiche = json.dumps(mod_dict)
        await db.flush()

    # Valida che tutti gli articoli abbiano un costo valido > 0
    for art in richiesta.articoli:
        if art.costo is None or art.costo <= 0:
            raise HTTPException(
                status_code=400,
                detail=f"Inserisci un costo valido per l'articolo '{art.titolo}' prima di inviare",
            )

    # Salva snapshot testo originale acquisti per ogni articolo
    for articolo in richiesta.articoli:
        if not getattr(articolo, "testo_originale_commerciale", None):
            orig_author = None
            if getattr(articolo, "author", None):
                orig_author = articolo.author.full_name or articolo.author.username
            snap_comm = {
                "titolo": articolo.titolo,
                "descrizione": articolo.descrizione or "",
                "is_standard": bool(articolo.is_standard),
                "is_atex": bool(articolo.is_atex),
                "is_alimentare": bool(articolo.is_alimentare),
                "tipo_fornitura": articolo.tipo_fornitura.value if hasattr(articolo.tipo_fornitura, "value") else articolo.tipo_fornitura,
                "author_name": orig_author or (current_user.full_name or current_user.username),
                "created_at": _to_utc_iso(articolo.created_at) if articolo.created_at else _to_utc_iso(datetime.now(timezone.utc)),
            }
            articolo.testo_originale_commerciale = json.dumps(snap_comm)

        snapshot = {
            "titolo": articolo.titolo,
            "descrizione": articolo.descrizione or "",
            "costo": articolo.costo,
            "note_admin": articolo.note_admin or "",
            "author_name": current_user.full_name or current_user.username,
            "created_at": _to_utc_iso(datetime.now(timezone.utc)),
        }
        articolo.testo_originale_acquisti = json.dumps(snapshot)  # type: ignore
        articolo.updated_by_id = current_user.id

    if not getattr(richiesta, "description_originale", None) and richiesta.description:
        richiesta.description_originale = richiesta.description  # type: ignore

    richiesta.status = RichiestaStatus.MANCA_LISTINO  # type: ignore
    if not richiesta.articoli_inserted_by_id:
        richiesta.articoli_inserted_by_id = current_user.id
    if not richiesta.articoli_inserted_at:
        richiesta.articoli_inserted_at = datetime.now(timezone.utc)
    richiesta.updated_at = datetime.now(timezone.utc)
    await db.commit()

    res_reloaded = await db.execute(
        select(RichiestaCommerciale)
        .options(*_richiesta_options())
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res_reloaded.scalar_one_or_none()

    # Email notifica agli admin
    await _notify_admin_manca_listino(db, richiesta, current_user)

    return _serialize_richiesta(richiesta, "acquisti", current_user)


@router.put("/{richiesta_id}/completa")
async def completa_richiesta(
    richiesta_id: str,
    data: CompletaRichiestaIn,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Admin aggiunge prezzi di listino e completa la richiesta.
    (MANCA_LISTINO → COMPLETATA)
    """
    await _require_role(db, current_user, ["admin"])

    res = await db.execute(
        select(RichiestaCommerciale)
        .options(
            *_richiesta_options(),
        )
        .where(RichiestaCommerciale.id == richiesta_id)
    )
    richiesta = res.scalar_one_or_none()
    if not richiesta:
        raise HTTPException(status_code=404, detail="Richiesta non trovata")

    if richiesta.status != RichiestaStatus.MANCA_LISTINO:
        raise HTTPException(
            status_code=400,
            detail="La richiesta deve essere in stato MANCA LISTINO per completarla",
        )

    # Aggiorna ogni articolo con prezzo listino e eventuali modifiche
    articolo_map: dict[str, ArticoloRichiesta] = {str(a.id): a for a in (richiesta.articoli or [])}
    for item in data.articoli:
        articolo = articolo_map.get(item.id) if item.id else None
        if not articolo:
            snap_comm = {
                "titolo": (item.titolo or "").strip(),
                "descrizione": (item.descrizione or "").strip(),
                "author_name": current_user.full_name or current_user.username,
                "created_at": _to_utc_iso(datetime.now(timezone.utc)),
            }
            new_art = ArticoloRichiesta(
                richiesta_id=richiesta_id,
                author_id=current_user.id,
                titolo=(item.titolo or "Nuovo Articolo").strip(),
                costo=item.costo or 0,
                descrizione=(item.descrizione or "").strip() or None,
                prezzo_listino=item.prezzo_listino,
                note_admin=item.note_admin.strip() if item.note_admin else None,
                attachments="[]",
                testo_originale_commerciale=json.dumps(snap_comm),
            )
            db.add(new_art)
            richiesta.articoli.append(new_art)
            if item.id:
                articolo_map[item.id] = new_art
            continue
        art_mod = _parse_json_dict(getattr(articolo, "modifiche", None))
        orig_author = None
        if getattr(articolo, "author", None):
            orig_author = articolo.author.full_name or articolo.author.username
        old_created = _to_utc_iso(articolo.created_at)

        if item.costo is not None and item.costo != articolo.costo:
            old_costo = articolo.costo
            if old_costo is not None and old_costo > 0:
                old_costo_str = f"{old_costo:.2f} €"
                new_costo_str = f"{item.costo:.2f} €"
                snap_acq = _parse_json_dict(getattr(articolo, "testo_originale_acquisti", None))
                costo_author = (articolo.updated_by.full_name or articolo.updated_by.username) if getattr(articolo, "updated_by", None) else (snap_acq.get("author_name") or "Ufficio Tecnico / Acquisti")
                costo_date = snap_acq.get("created_at") or _to_utc_iso(articolo.updated_at or articolo.created_at)
                _record_field_modification(art_mod, "costo", "Costo Acquisti", old_costo_str, new_costo_str, current_user, costo_author, costo_date)
            articolo.costo = item.costo  # type: ignore

        if item.prezzo_listino is not None and item.prezzo_listino != articolo.prezzo_listino:
            old_pl = f"{articolo.prezzo_listino:.2f} €" if articolo.prezzo_listino is not None else "0.00 €"
            new_pl = f"{item.prezzo_listino:.2f} €"
            _record_field_modification(art_mod, "prezzo_listino", "Prezzo Listino", old_pl, new_pl, current_user, orig_author, old_created)
            articolo.prezzo_listino = item.prezzo_listino  # type: ignore

        if item.note_admin is not None and (item.note_admin.strip() or "") != (articolo.note_admin or "").strip():
            _record_field_modification(art_mod, "note_admin", "Note Admin", articolo.note_admin or "", item.note_admin.strip(), current_user, orig_author, old_created)
            articolo.note_admin = item.note_admin.strip() or None  # type: ignore

        if item.titolo is not None and item.titolo.strip() != articolo.titolo.strip():
            _record_field_modification(art_mod, "titolo", "Titolo Articolo", articolo.titolo, item.titolo.strip(), current_user, orig_author, old_created)
            articolo.titolo = item.titolo.strip()  # type: ignore

        if item.descrizione is not None and (item.descrizione.strip() or "") != (articolo.descrizione or "").strip():
            _record_field_modification(art_mod, "descrizione", "Descrizione Articolo", articolo.descrizione or "", item.descrizione.strip(), current_user, orig_author, old_created)
            articolo.descrizione = item.descrizione.strip() or None  # type: ignore

        articolo.modifiche = json.dumps(art_mod)  # type: ignore
        articolo.updated_by_id = current_user.id  # type: ignore

    if data.descrizione is not None and (data.descrizione.strip() or "") != (richiesta.description or "").strip():
        r_mod = _parse_json_dict(getattr(richiesta, "modifiche", None))
        _record_field_modification(
            r_mod,
            "description",
            "Descrizione Richiesta",
            richiesta.description or "",
            data.descrizione.strip(),
            current_user,
            old_author_name=(richiesta.author.full_name or richiesta.author.username) if richiesta.author else "Commerciale",
            old_created_at=_to_utc_iso(richiesta.created_at),
        )
        richiesta.modifiche = json.dumps(r_mod)  # type: ignore
        if not getattr(richiesta, "description_originale", None) and richiesta.description:
            richiesta.description_originale = richiesta.description  # type: ignore
        richiesta.description = data.descrizione.strip() or None  # type: ignore

    richiesta.status = RichiestaStatus.COMPLETATA  # type: ignore
    richiesta.listino_inserted_by_id = current_user.id  # type: ignore
    richiesta.listino_inserted_at = datetime.now(timezone.utc)  # type: ignore
    await db.commit()
    await db.refresh(richiesta)

    # Email notifica al commerciale
    await _notify_commerciale_completata(db, richiesta, current_user)

    return _serialize_richiesta(richiesta, "admin", current_user)


# ─── Funzioni di notifica email ───────────────────────────────────────────────

async def _is_email_enabled(db: AsyncSession) -> bool:
    res = await db.execute(select(Setting).where(Setting.key == "rc_email_enabled"))
    setting = res.scalar_one_or_none()
    if not setting:
        return True  # default: abilitato
    return str(setting.value).lower() != "false"


async def _notify_acquisti_nuova_richiesta(
    db: AsyncSession,
    richiesta: RichiestaCommerciale,
    author: User,
):
    """Notifica l'ufficio acquisti di una nuova richiesta."""
    if not await _is_email_enabled(db):
        return
    try:
        from app.services.email_service import send_richiesta_commerciale_email
        from sqlalchemy import or_

        acquisti_usernames = await _get_setting_list(db, "rc_acquisti_users")
        conditions = []
        if acquisti_usernames:
            conditions.append(User.username.in_(acquisti_usernames))
        auto_acquisti = await _get_setting_bool(db, "rc_auto_acquisti_dept")
        if auto_acquisti:
            conditions.append(User.department.in_(["acquisti", "ufficio acquisti"]))

        if not conditions:
            return

        res = await db.execute(
            select(User).where(or_(*conditions), User.is_active == True)
        )
        users = res.scalars().all()
        emails = [str(u.email) for u in users if u.email]
        if emails:
            await send_richiesta_commerciale_email(
                to_addresses=emails,
                richiesta_title=str(richiesta.title),
                cliente=str(richiesta.cliente),
                author_name=str(author.full_name or author.username),
                phase="nuova_richiesta",
            )
    except Exception as e:
        logger.error(f"[RC] Errore notifica acquisti: {e}")


async def _notify_admin_manca_listino(
    db: AsyncSession,
    richiesta: RichiestaCommerciale,
    by_user: User,
):
    """Notifica gli admin che manca il prezzo di listino."""
    if not await _is_email_enabled(db):
        return
    try:
        from app.services.email_service import send_richiesta_commerciale_email
        from sqlalchemy import or_

        admin_usernames = await _get_setting_list(db, "rc_admin_users")
        conditions = [User.role == "admin"]
        if admin_usernames:
            conditions.append(User.username.in_(admin_usernames))
        auto_admin = await _get_setting_bool(db, "rc_auto_admin_dept")
        if auto_admin:
            conditions.append(User.department.in_(["amministrazione", "admin"]))

        res = await db.execute(
            select(User).where(or_(*conditions), User.is_active == True)
        )
        users = res.scalars().all()
        emails = [str(u.email) for u in users if u.email]
        if emails:
            await send_richiesta_commerciale_email(
                to_addresses=emails,
                richiesta_title=str(richiesta.title),
                cliente=str(richiesta.cliente),
                author_name=str(by_user.full_name or by_user.username),
                phase="manca_listino",
            )
    except Exception as e:
        logger.error(f"[RC] Errore notifica admin: {e}")


async def _notify_commerciale_completata(
    db: AsyncSession,
    richiesta: RichiestaCommerciale,
    by_user: User,
):
    """Notifica il commerciale che la richiesta è completata."""
    if not await _is_email_enabled(db):
        return
    try:
        from app.services.email_service import send_richiesta_commerciale_email

        # Notifica l'autore della richiesta
        emails = []
        if richiesta.author and richiesta.author.email:
            emails.append(str(richiesta.author.email))
        if emails:
            await send_richiesta_commerciale_email(
                to_addresses=emails,
                richiesta_title=str(richiesta.title),
                cliente=str(richiesta.cliente),
                author_name=str(by_user.full_name or by_user.username),
                phase="completata",
            )
    except Exception as e:
        logger.error(f"[RC] Errore notifica commerciale: {e}")
