from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from auth import hash_password, verify_password
from routers.auth import login
from routers.user import authenticate_user, create_user
from schemas import LoginRequest, UserCreate
from services.session_service import (
    create_user_session,
    get_current_session,
    get_current_user,
    revoke_session,
)


def test_password_hash_roundtrip():
    hashed = hash_password("correct horse battery staple")

    assert hashed != "correct horse battery staple"
    assert verify_password("correct horse battery staple", hashed)
    assert not verify_password("wrong password", hashed)


def test_user_creation_and_duplicate_detection(db_session):
    user = create_user(
        UserCreate(username="alice", password="password123"),
        db=db_session,
    )

    assert user.username == "alice"
    assert user.password_hash != "password123"

    duplicate = False
    try:
        create_user(
            UserCreate(username="alice", password="password123"),
            db=db_session,
        )
    except HTTPException as exc:
        duplicate = exc.status_code == 409

    assert duplicate


def test_session_authentication_and_revocation(db_session):
    user = create_user(
        UserCreate(username="bob", password="password123"),
        db=db_session,
    )

    token, session = create_user_session(db_session, user)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    current_session = get_current_session(credentials=creds, db=db_session)
    current_user = get_current_user(session=current_session, db=db_session)

    assert current_session.id == session.id
    assert current_user.id == user.id

    revoke_session(db_session, current_session)

    revoked = False
    try:
        get_current_session(credentials=creds, db=db_session)
    except HTTPException as exc:
        revoked = exc.status_code == 401

    assert revoked


def test_authenticate_user(db_session):
    create_user(
        UserCreate(username="carol", password="password123"),
        db=db_session,
    )

    user = authenticate_user(db_session, "carol", "password123")

    assert user is not None
    assert user.username == "carol"
    assert authenticate_user(db_session, "carol", "wrong-password") is None


def test_login_invalid_credentials_returns_401(db_session):
    create_user(
        UserCreate(username="frank", password="password123"),
        db=db_session,
    )

    raised = False
    try:
        login(LoginRequest(username="frank", password="wrong-password"), db=db_session)
    except HTTPException as exc:
        raised = exc.status_code == 401

    assert raised


def test_invalid_token_returns_401(db_session):
    create_user(
        UserCreate(username="grace", password="password123"),
        db=db_session,
    )

    token = "not-a-real-token"
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)

    raised = False
    try:
        get_current_session(credentials=creds, db=db_session)
    except HTTPException as exc:
        raised = exc.status_code == 401

    assert raised
