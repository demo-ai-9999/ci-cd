from typing import Generator

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import SessionLocal
from models import User


class UserCreate(BaseModel):
    username: str
    password: str


class UserRead(BaseModel):
    id: int
    username: str

    model_config = {"from_attributes": True}


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


user_router = APIRouter(prefix="/users", tags=["users"])


@user_router.post("", response_model=UserRead, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    user = User(username=payload.username, password=payload.password)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
