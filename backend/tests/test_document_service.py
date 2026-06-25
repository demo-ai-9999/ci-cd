import io
import sys
import types

from models import User
from routers.user import create_user
from schemas import UserCreate
from services import document_service
from services.chat_service import create_chat_session, list_chat_messages, list_chat_sessions


class FakeUploadFile:
    def __init__(self, filename: str, content_type: str, data: bytes):
        self.filename = filename
        self.content_type = content_type
        self.file = io.BytesIO(data)


def _create_user(db_session, username: str) -> User:
    return create_user(
        UserCreate(username=username, password="password123"),
        db=db_session,
    )


def test_text_document_upload_creates_session_and_persists_summary(db_session, monkeypatch):
    user = _create_user(db_session, "text-user")
    upload = FakeUploadFile(
        filename="notes.txt",
        content_type="text/plain",
        data="첫 줄\n둘째 줄".encode("utf-8"),
    )
    monkeypatch.setattr(document_service, "call_gemini", lambda prompt: "요약 결과")

    from routers.chat import upload_document

    response = upload_document(
        file=upload,
        session_id=None,
        user=user,
        db=db_session,
    )

    sessions = list_chat_sessions(db_session, user.id)
    messages = list_chat_messages(db_session, response.session_id)

    assert response.answer == "요약 결과"
    assert response.session_id == sessions[0].id
    assert [message.role for message in messages] == ["user", "system", "assistant"]
    assert messages[0].content == "[파일 업로드] notes.txt"
    assert "첫 줄" in messages[1].content
    assert messages[2].content == "요약 결과"


def test_pdf_document_upload_uses_pdfplumber_and_existing_session(db_session, monkeypatch):
    user = _create_user(db_session, "pdf-user")
    session = create_chat_session(db_session, user, "기존 대화")

    class FakePage:
        def __init__(self, text: str):
            self._text = text

        def extract_text(self):
            return self._text

    class FakePdf:
        def __init__(self):
            self.pages = [FakePage("첫 페이지"), FakePage("둘째 페이지")]

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    fake_pdfplumber = types.SimpleNamespace(open=lambda _: FakePdf())
    monkeypatch.setitem(sys.modules, "pdfplumber", fake_pdfplumber)
    monkeypatch.setattr(document_service, "call_gemini", lambda prompt: "PDF 요약")

    from routers.chat import upload_document

    response = upload_document(
        file=FakeUploadFile(
            filename="report.pdf",
            content_type="application/pdf",
            data=b"%PDF-1.4 fake bytes",
        ),
        session_id=session.id,
        user=user,
        db=db_session,
    )

    messages = list_chat_messages(db_session, session.id)

    assert response.session_id == session.id
    assert response.answer == "PDF 요약"
    assert [message.role for message in messages] == ["user", "system", "assistant"]
    assert "첫 페이지" in messages[1].content
    assert "둘째 페이지" in messages[1].content


def test_recursive_summarization_calls_gemini_for_multiple_chunks(monkeypatch):
    calls: list[str] = []

    def fake_call_gemini(prompt: str) -> str:
        calls.append(prompt)
        return "요약"

    monkeypatch.setattr(document_service, "call_gemini", fake_call_gemini)

    summary = document_service.recursive_summarize_document("long.txt", "가" * 13000)

    assert summary == "요약"
    assert len(calls) >= 4
