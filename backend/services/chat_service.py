from datetime import datetime
from typing import cast

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from config import get_settings
from models import ChatMessage, ChatSession, User

DEFAULT_CHAT_TITLE = "기본 대화"
DEFAULT_NEW_CHAT_TITLE = "새 대화"
MAX_CONTEXT_MESSAGES = 12
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"


def get_gemini_api_key() -> str:
    api_key = cast(str | None, get_settings()["gemini_api_key"])
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GEMINI_API_KEY가 설정되어 있지 않습니다.",
        )

    return api_key


def get_gemini_model_name() -> str:
    return cast(str, get_settings()["gemini_model"])


def get_owned_chat_session(
    db: Session,
    user_id: int,
    session_id: int,
) -> ChatSession:
    session = (
        db.query(ChatSession)
        .filter(
            ChatSession.id == session_id,
            ChatSession.user_id == user_id,
        )
        .first()
    )
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="대화방을 찾을 수 없습니다.",
        )
    return session


def get_or_create_default_chat_session(db: Session, user: User) -> ChatSession:
    session = (
        db.query(ChatSession)
        .filter(
            ChatSession.user_id == user.id,
            ChatSession.title == DEFAULT_CHAT_TITLE,
            ChatSession.is_archived.is_(False),
        )
        .order_by(ChatSession.updated_at.desc())
        .first()
    )
    if session is not None:
        return session

    now = datetime.utcnow()
    session = ChatSession(
        user_id=user.id,
        title=DEFAULT_CHAT_TITLE,
        is_archived=False,
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def create_chat_session(
    db: Session,
    user: User,
    title: str | None = None,
) -> ChatSession:
    now = datetime.utcnow()
    session = ChatSession(
        user_id=user.id,
        title=title or DEFAULT_NEW_CHAT_TITLE,
        is_archived=False,
        created_at=now,
        updated_at=now,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def list_chat_sessions(db: Session, user_id: int) -> list[ChatSession]:
    return (
        db.query(ChatSession)
        .filter(ChatSession.user_id == user_id)
        .order_by(ChatSession.updated_at.desc(), ChatSession.id.desc())
        .all()
    )


def list_chat_messages(db: Session, session_id: int) -> list[ChatMessage]:
    return (
        db.query(ChatMessage)
        .filter(ChatMessage.chat_session_id == session_id)
        .order_by(ChatMessage.created_at.asc(), ChatMessage.id.asc())
        .all()
    )


def list_recent_messages(db: Session, session_id: int) -> list[ChatMessage]:
    messages = list_chat_messages(db, session_id)
    return messages[-MAX_CONTEXT_MESSAGES:]


def build_gemini_prompt(messages: list[ChatMessage], latest_question: str) -> str:
    lines = [
        "당신은 사용자의 대화 맥락을 기억하는 친절한 챗봇입니다.",
        "이전 대화와 현재 질문을 함께 참고해 답변하세요.",
        "",
        "대화 기록:",
    ]
    for message in messages:
        label = "사용자" if message.role == "user" else "어시스턴트"
        lines.append(f"{label}: {message.content}")

    lines.extend(
        [
            "",
            f"현재 사용자 질문: {latest_question}",
            "답변:",
        ]
    )
    return "\n".join(lines)


def call_gemini(prompt: str) -> str:
    model = get_gemini_model_name()
    api_key = get_gemini_api_key()
    url = f"{GEMINI_API_BASE}/models/{model}:generateContent"

    try:
        response = httpx.post(
            url,
            params={"key": api_key},
            json={
                "contents": [
                    {
                        "role": "user",
                        "parts": [{"text": prompt}],
                    }
                ],
            },
            timeout=60.0,
        )
        response.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini API 호출에 실패했습니다: {exc}",
        ) from exc

    payload = response.json()
    candidates = payload.get("candidates", []) if isinstance(payload, dict) else []
    answer = ""
    if candidates:
        content = candidates[0].get("content", {}) if isinstance(candidates[0], dict) else {}
        parts = content.get("parts", []) if isinstance(content, dict) else []
        answer = "".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict)
        ).strip()

    if not answer:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini API가 빈 응답을 반환했습니다.",
        )
    return answer


def create_chat_turn(
    db: Session,
    chat_session: ChatSession,
    question: str,
) -> tuple[ChatMessage, ChatMessage]:
    user_message = ChatMessage(
        chat_session_id=chat_session.id,
        role="user",
        content=question,
        model=None,
        created_at=datetime.utcnow(),
    )
    db.add(user_message)
    db.flush()

    recent_messages = list_recent_messages(db, chat_session.id)
    prompt = build_gemini_prompt(recent_messages, question)
    answer = call_gemini(prompt)

    assistant_message = ChatMessage(
        chat_session_id=chat_session.id,
        role="assistant",
        content=answer,
        model=get_gemini_model_name(),
        created_at=datetime.utcnow(),
    )
    chat_session.updated_at = datetime.utcnow()
    db.add(assistant_message)
    db.add(chat_session)
    db.commit()
    db.refresh(user_message)
    db.refresh(assistant_message)
    db.refresh(chat_session)
    return user_message, assistant_message


def archive_chat_session(db: Session, chat_session: ChatSession) -> ChatSession:
    chat_session.is_archived = True
    chat_session.updated_at = datetime.utcnow()
    db.add(chat_session)
    db.commit()
    db.refresh(chat_session)
    return chat_session
