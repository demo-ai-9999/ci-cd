from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from auth import hash_password, is_password_hash, verify_password
from database import get_db
from models import User
from schemas import UserCreate, UserRead

user_router = APIRouter(prefix="/users", tags=["users"])


@user_router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    existing_user = (
        db.query(User).filter(User.username == payload.username).first()
    )
    if existing_user is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="이미 사용 중인 사용자명입니다.",
        )

    now = datetime.utcnow()
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        created_at=now,
        updated_at=now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def authenticate_user(db: Session, username: str, password: str) -> User | None:
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        return None

    if verify_password(password, user.password_hash):
        if not is_password_hash(user.password_hash):
            user.password_hash = hash_password(password)
            user.updated_at = datetime.utcnow()
            db.add(user)
            db.commit()
            db.refresh(user)
        return user

    return None
