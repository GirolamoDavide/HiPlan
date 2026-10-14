# pyrefly: ignore [missing-import]
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List
import json
import os

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DB_PATH = os.path.join(BACKEND_DIR, "ganttflow.db").replace("\\", "/")


class Settings(BaseSettings):
    DATABASE_URL: str = f"sqlite+aiosqlite:///{DEFAULT_DB_PATH}"
    SECRET_KEY: str = "dev-secret-key-not-for-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    CORS_ORIGINS: str = '["http://localhost:5173"]'
    # Origini ammesse oltre a CORS_ORIGINS: localhost e rete locale (IP privati, nomi .local o senza dominio),
    # così HiPlan resta raggiungibile dai PC dell'ufficio ma non da siti esterni. Stringa vuota = disattivato.
    CORS_ORIGIN_REGEX: str = (
        r"^https?://("
        r"localhost|127\.0\.0\.1|\[::1\]"
        r"|10(\.\d{1,3}){3}"
        r"|192\.168(\.\d{1,3}){2}"
        r"|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}"
        r"|[a-zA-Z0-9-]+(\.local)?"
        r")(:\d+)?$"
    )
    APP_NAME: str = "HiPlan"
    DEBUG: bool = True

    # Email SMTP
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    SMTP_USE_TLS: bool = True

    # AI
    GEMINI_API_KEY: str = ""
    GROQ_API_KEY: str = ""
    COHERE_API_KEY: str = ""

    @property
    def cors_origins_list(self) -> List[str]:
        return json.loads(self.CORS_ORIGINS)

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()

# Risolvi sempre il percorso SQLite come assoluto nella cartella backend/
# per evitare che su Windows o avviando da cartelle diverse il DB venga creato altrove o non trovato
if settings.DATABASE_URL.startswith("sqlite+aiosqlite:///"):
    path_part = settings.DATABASE_URL.split(":///", 1)[1]
    if path_part.startswith("./") or (not path_part.startswith("/") and not (len(path_part) > 1 and path_part[1] == ":")):
        clean_rel = path_part[2:] if path_part.startswith("./") else path_part
        abs_db_path = os.path.abspath(os.path.join(BACKEND_DIR, clean_rel))
        if os.name == "nt" or (len(abs_db_path) > 1 and abs_db_path[1] == ":"):
            settings.DATABASE_URL = f"sqlite+aiosqlite:///{abs_db_path.replace(os.sep, '/')}"
        else:
            settings.DATABASE_URL = f"sqlite+aiosqlite:///{abs_db_path}"
