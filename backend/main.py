from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from typing import cast

from config import get_settings
from routers.auth import auth_router
from routers.chat import chat_router
from routers.user import user_router

settings = get_settings()

app = FastAPI(title="My Project API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(cast(tuple[str, ...], settings["cors_origins"])),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(user_router)
app.include_router(auth_router)
app.include_router(chat_router)


@app.on_event("startup")
def on_startup() -> None:
    # Schema is managed by Alembic migrations.
    return None


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok"}
