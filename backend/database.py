from typing import Generator
from typing import cast

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.orm import Session

from config import get_settings

settings = get_settings()
DATABASE_URL = cast(str, settings["database_url"])
SQLALCHEMY_ECHO = cast(bool, settings["sqlalchemy_echo"])

engine_kwargs = {"echo": SQLALCHEMY_ECHO}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
