from __future__ import annotations

import os
from functools import lru_cache

from dotenv import load_dotenv

load_dotenv()

DEFAULT_CORS_ORIGINS = (
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:4173",
)


def _get_bool(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() == "true"


def _get_int(name: str, default: str) -> int:
    return int(os.getenv(name, default))


def _get_csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name)
    if not raw:
        return default
    values = [item.strip() for item in raw.split(",")]
    return tuple(item for item in values if item)


@lru_cache(maxsize=1)
def get_settings() -> dict[str, object]:
    return {
        "database_url": os.getenv("DATABASE_URL", "sqlite:///./app.db"),
        "sqlalchemy_echo": _get_bool("SQLALCHEMY_ECHO"),
        "gemini_api_key": os.getenv("GEMINI_API_KEY"),
        "gemini_model": os.getenv("GEMINI_MODEL", "gemini-3.5-flash"),
        "session_ttl_seconds": _get_int("SESSION_TTL_SECONDS", "604800"),
        "cors_origins": _get_csv("CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
    }

