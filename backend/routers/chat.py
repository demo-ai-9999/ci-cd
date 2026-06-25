from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import (
    ChatMessageCreate,
    ChatMessageRead,
    ChatReplyResponse,
    ChatSessionCreate,
    ChatSessionDetail,
    ChatSessionSummary,
)
from services.document_service import (
    extract_uploaded_file_text,
    recursive_summarize_document,
    create_document_summary_session,
    save_document_summary_turn,
)
from services.chat_service import (
    create_chat_session,
    create_chat_turn,
    delete_chat_session,
    get_or_create_default_chat_session,
    get_owned_chat_session,
    list_chat_messages,
    list_chat_sessions,
)
from services.session_service import get_current_user

chat_router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(ChatMessageCreate):
    session_id: int | None = None


class ChatResponse(ChatReplyResponse):
    answer: str


@chat_router.post("/sessions", response_model=ChatSessionSummary, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: ChatSessionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatSessionSummary:
    session = create_chat_session(db, user, payload.title)
    return ChatSessionSummary.model_validate(session)


@chat_router.get("/sessions", response_model=list[ChatSessionSummary])
def list_sessions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ChatSessionSummary]:
    sessions = list_chat_sessions(db, user.id)
    return [ChatSessionSummary.model_validate(session) for session in sessions]


@chat_router.get("/sessions/{session_id}", response_model=ChatSessionDetail)
def get_session_detail(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatSessionDetail:
    session = get_owned_chat_session(db, user.id, session_id)
    messages = list_chat_messages(db, session.id)
    return ChatSessionDetail(
        **ChatSessionSummary.model_validate(session).model_dump(),
        messages=[ChatMessageRead.model_validate(message) for message in messages],
    )


@chat_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    session = get_owned_chat_session(db, user.id, session_id)
    delete_chat_session(db, session)


@chat_router.post("/sessions/{session_id}/messages", response_model=ChatResponse)
def send_message(
    session_id: int,
    payload: ChatMessageCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    chat_session = get_owned_chat_session(db, user.id, session_id)
    if chat_session.is_archived:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="보관된 대화방에는 메시지를 보낼 수 없습니다.",
        )

    user_message, assistant_message = create_chat_turn(
        db,
        chat_session,
        payload.content,
    )
    return ChatResponse(
        session_id=chat_session.id,
        answer=assistant_message.content,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )


@chat_router.post("/documents", response_model=ChatResponse)
def upload_document(
    file: UploadFile = File(...),
    session_id: int | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    file_name = file.filename or ""
    if not file_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="업로드된 파일 이름이 비어 있습니다.",
        )

    if session_id is not None:
        chat_session = get_owned_chat_session(db, user.id, session_id)
    else:
        chat_session = create_document_summary_session(db, user, file_name)

    if chat_session.is_archived:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="보관된 대화방에는 파일을 업로드할 수 없습니다.",
        )

    extracted_text = extract_uploaded_file_text(file)
    summary = recursive_summarize_document(file_name, extracted_text)
    user_message, assistant_message = save_document_summary_turn(
        db,
        chat_session,
        file_name,
        extracted_text,
        summary,
    )
    return ChatResponse(
        session_id=chat_session.id,
        answer=assistant_message.content,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )


@chat_router.post("", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    if payload.session_id is not None:
        chat_session = get_owned_chat_session(db, user.id, payload.session_id)
    else:
        chat_session = get_or_create_default_chat_session(db, user)

    if chat_session.is_archived:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="보관된 대화방에는 메시지를 보낼 수 없습니다.",
        )

    user_message, assistant_message = create_chat_turn(
        db,
        chat_session,
        payload.content,
    )
    return ChatResponse(
        session_id=chat_session.id,
        answer=assistant_message.content,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )
