from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path
from fastapi import HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from models import ChatMessage, ChatSession, User
from services.chat_service import create_chat_session, get_gemini_model_name, call_gemini

DOCUMENT_CHUNK_SIZE = 6000
DOCUMENT_STORAGE_CHUNK_SIZE = 7000
MAX_SUMMARY_LENGTH = 4096
DEFAULT_DOCUMENT_TITLE = "문서 요약"
ANSWER_ONLY_INSTRUCTION = "설명이나 해설은 하지 말고, 바로 대답만 하세요."


def _normalize_text(value: str) -> str:
    return value.replace("\x00", "").strip()


def _is_pdf_file(upload_file: UploadFile) -> bool:
    filename = (upload_file.filename or "").lower()
    content_type = (upload_file.content_type or "").lower()
    return filename.endswith(".pdf") or content_type == "application/pdf"


def _is_text_file(upload_file: UploadFile) -> bool:
    filename = (upload_file.filename or "").lower()
    content_type = (upload_file.content_type or "").lower()
    return filename.endswith(".txt") or content_type.startswith("text/")


def _split_text(text: str, max_chars: int) -> list[str]:
    normalized = _normalize_text(text)
    if not normalized:
        return []

    if len(normalized) <= max_chars:
        return [normalized]

    chunks: list[str] = []
    start = 0
    length = len(normalized)
    while start < length:
        end = min(start + max_chars, length)
        if end < length:
            boundary = normalized.rfind("\n\n", start, end)
            if boundary <= start:
                boundary = normalized.rfind("\n", start, end)
            if boundary <= start:
                boundary = normalized.rfind(" ", start, end)
            if boundary > start:
                end = boundary

        chunk = normalized[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end
        while start < length and normalized[start].isspace():
            start += 1

    return chunks


def _extract_pdf_text(upload_file: UploadFile) -> str:
    try:
        import pdfplumber  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised in deployment, not unit tests
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="pdfplumber가 설치되어 있지 않습니다.",
        ) from exc

    upload_file.file.seek(0)
    pdf_bytes = upload_file.file.read()
    if not pdf_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="PDF 파일이 비어 있습니다.",
        )

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages: list[str] = []
            for page in pdf.pages:
                page_text = _normalize_text(page.extract_text() or "")
                if page_text:
                    pages.append(page_text)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"PDF에서 텍스트를 추출하지 못했습니다: {exc}",
        ) from exc

    extracted_text = "\n\n".join(pages).strip()
    if not extracted_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="PDF에서 추출할 텍스트를 찾지 못했습니다.",
        )

    return extracted_text


def _extract_text_file(upload_file: UploadFile) -> str:
    upload_file.file.seek(0)
    raw_bytes = upload_file.file.read()
    if not raw_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="텍스트 파일이 비어 있습니다.",
        )

    try:
        return raw_bytes.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="텍스트 파일은 UTF-8 형식이어야 합니다.",
        ) from exc


def extract_uploaded_file_text(upload_file: UploadFile) -> str:
    if _is_pdf_file(upload_file):
        return _extract_pdf_text(upload_file)

    if _is_text_file(upload_file):
        return _extract_text_file(upload_file)

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="PDF 또는 텍스트 파일만 업로드할 수 있습니다.",
    )


def _build_summary_prompt(file_name: str, document_text: str, chunk_info: str = "") -> str:
    chunk_instruction = f"\n{chunk_info}" if chunk_info else ""
    return (
        "당신은 문서 요약기입니다.\n"
        f"{ANSWER_ONLY_INSTRUCTION}\n"
        f"파일명: {file_name}{chunk_instruction}\n"
        "다음 문서를 한국어로 핵심 위주로 요약하세요.\n"
        "- 중요한 사실, 수치, 결론, 일정, 조건을 우선 반영하세요.\n"
        "- 불필요한 수식어는 줄이고, 읽기 쉬운 글머리표를 사용해도 됩니다.\n"
        f"- 최종 결과는 {MAX_SUMMARY_LENGTH}자를 넘기지 않도록 작성하세요.\n\n"
        "문서 내용:\n"
        f"{document_text}\n"
    )


def recursive_summarize_document(file_name: str, document_text: str) -> str:
    normalized = _normalize_text(document_text)
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="요약할 문서 내용이 비어 있습니다.",
        )

    chunks = _split_text(normalized, DOCUMENT_CHUNK_SIZE)
    if not chunks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="요약할 문서 내용을 찾지 못했습니다.",
        )

    if len(chunks) == 1:
        summary = _normalize_text(call_gemini(_build_summary_prompt(file_name, chunks[0], "(전체 문서)")))
        return summary[:MAX_SUMMARY_LENGTH].strip()

    chunk_summaries: list[str] = []
    total_chunks = len(chunks)
    for index, chunk in enumerate(chunks, start=1):
        chunk_prompt = _build_summary_prompt(
            file_name,
            chunk,
            f"(문서 조각 {index}/{total_chunks})",
        )
        chunk_summary = _normalize_text(call_gemini(chunk_prompt))
        if chunk_summary:
            chunk_summaries.append(chunk_summary)

    combined_summary = "\n\n".join(chunk_summaries).strip()
    if len(combined_summary) > DOCUMENT_CHUNK_SIZE:
        return recursive_summarize_document(file_name, combined_summary)

    final_summary = _normalize_text(
        call_gemini(_build_summary_prompt(file_name, combined_summary, "(통합 요약)"))
    )
    return final_summary[:MAX_SUMMARY_LENGTH].strip()


def _build_session_title(file_name: str) -> str:
    stem = Path(file_name).stem.strip()
    return stem[:200] if stem else DEFAULT_DOCUMENT_TITLE


def _build_stored_document_messages(
    chat_session_id: int,
    file_name: str,
    extracted_text: str,
    summary: str,
) -> tuple[ChatMessage, list[ChatMessage], ChatMessage]:
    now = datetime.utcnow()
    user_message = ChatMessage(
        chat_session_id=chat_session_id,
        role="user",
        content=f"[파일 업로드] {file_name}",
        model=None,
        created_at=now,
    )

    text_chunks = _split_text(extracted_text, DOCUMENT_STORAGE_CHUNK_SIZE)
    if not text_chunks:
        text_chunks = [extracted_text.strip()]

    system_messages = [
        ChatMessage(
            chat_session_id=chat_session_id,
            role="system",
            content=f"[문서 내용 {index}/{len(text_chunks)}] {chunk}",
            model=None,
            created_at=now,
        )
        for index, chunk in enumerate(text_chunks, start=1)
    ]

    assistant_message = ChatMessage(
        chat_session_id=chat_session_id,
        role="assistant",
        content=summary,
        model=get_gemini_model_name(),
        created_at=now,
    )
    return user_message, system_messages, assistant_message


def save_document_summary_turn(
    db: Session,
    chat_session: ChatSession,
    file_name: str,
    extracted_text: str,
    summary: str,
) -> tuple[ChatMessage, ChatMessage]:
    user_message, system_messages, assistant_message = _build_stored_document_messages(
        chat_session.id,
        file_name,
        extracted_text,
        summary,
    )
    chat_session.updated_at = datetime.utcnow()

    db.add(user_message)
    db.add_all(system_messages)
    db.add(assistant_message)
    db.add(chat_session)
    db.commit()
    db.refresh(user_message)
    db.refresh(assistant_message)
    db.refresh(chat_session)
    return user_message, assistant_message


def create_document_summary_session(
    db: Session,
    user: User,
    file_name: str,
) -> ChatSession:
    return create_chat_session(db, user, _build_session_title(file_name))
