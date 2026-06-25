from fastapi import HTTPException

from models import User
from routers.user import create_user
from schemas import UserCreate
from services import chat_service
from services.chat_service import (
    archive_chat_session,
    create_chat_session,
    create_chat_turn,
    delete_chat_session,
    get_or_create_default_chat_session,
    get_owned_chat_session,
    list_chat_messages,
    list_chat_sessions,
)


def _create_user(db_session, username: str) -> User:
    return create_user(
        UserCreate(username=username, password="password123"),
        db=db_session,
    )


def test_chat_session_lifecycle(db_session):
    user = _create_user(db_session, "dave")

    session = create_chat_session(db_session, user, "프로젝트")
    default_session = get_or_create_default_chat_session(db_session, user)
    same_default_session = get_or_create_default_chat_session(db_session, user)

    sessions = list_chat_sessions(db_session, user.id)

    assert session.title == "프로젝트"
    assert default_session.id == same_default_session.id
    assert {item.title for item in sessions} == {"프로젝트", "기본 대화"}

    owned = get_owned_chat_session(db_session, user.id, session.id)
    assert owned.id == session.id

    archive_chat_session(db_session, session)
    archived = get_owned_chat_session(db_session, user.id, session.id)
    assert archived.is_archived is True


def test_create_chat_turn_persists_user_and_assistant_messages(db_session, monkeypatch):
    user = _create_user(db_session, "erin")
    session = create_chat_session(db_session, user, "대화")

    monkeypatch.setattr(chat_service, "call_gemini", lambda prompt: "테스트 답변")

    user_message, assistant_message = create_chat_turn(
        db_session,
        session,
        "안녕, 오늘 일정 알려줘",
    )

    messages = list_chat_messages(db_session, session.id)

    assert user_message.role == "user"
    assert assistant_message.role == "assistant"
    assert assistant_message.content == "테스트 답변"
    assert [message.role for message in messages] == ["user", "assistant"]
    assert [message.content for message in messages] == [
        "안녕, 오늘 일정 알려줘",
        "테스트 답변",
    ]


def test_foreign_chat_session_returns_404(db_session):
    owner = _create_user(db_session, "fiona")
    intruder = _create_user(db_session, "helen")
    session = create_chat_session(db_session, owner, "비공개")

    raised = False
    try:
        get_owned_chat_session(db_session, intruder.id, session.id)
    except HTTPException as exc:
        raised = exc.status_code == 404

    assert raised


def test_archived_chat_session_rejects_messages(db_session, monkeypatch):
    user = _create_user(db_session, "iris")
    session = create_chat_session(db_session, user, "보관 후보")
    archive_chat_session(db_session, session)

    monkeypatch.setattr(chat_service, "call_gemini", lambda prompt: "사용되지 않음")

    raised = False
    try:
        from schemas import ChatMessageCreate
        from routers.chat import send_message

        send_message(
            session_id=session.id,
            payload=ChatMessageCreate(content="메시지"),
            user=user,
            db=db_session,
        )
    except HTTPException as exc:
        raised = exc.status_code == 409

    assert raised


def test_delete_chat_session_removes_session_and_messages(db_session, monkeypatch):
    user = _create_user(db_session, "kate")
    session = create_chat_session(db_session, user, "삭제 대상")

    monkeypatch.setattr(chat_service, "call_gemini", lambda prompt: "삭제 확인 답변")

    create_chat_turn(
        db_session,
        session,
        "테스트 질문",
    )

    delete_chat_session(db_session, session)

    sessions = list_chat_sessions(db_session, user.id)
    messages = list_chat_messages(db_session, session.id)

    assert all(item.id != session.id for item in sessions)
    assert messages == []


def test_gemini_failure_is_reported_as_502(db_session, monkeypatch):
    user = _create_user(db_session, "jane")
    session = create_chat_session(db_session, user, "대화")

    def raise_bad_gateway(prompt: str) -> str:
        raise HTTPException(status_code=502, detail="upstream failed")

    monkeypatch.setattr(chat_service, "call_gemini", raise_bad_gateway)

    raised = False
    try:
        from schemas import ChatMessageCreate
        from routers.chat import send_message

        send_message(
            session_id=session.id,
            payload=ChatMessageCreate(content="메시지"),
            user=user,
            db=db_session,
        )
    except HTTPException as exc:
        raised = exc.status_code == 502

    assert raised
