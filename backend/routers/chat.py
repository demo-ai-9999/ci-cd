import os

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel

load_dotenv()


class ChatRequest(BaseModel):
    question: str


class ChatResponse(BaseModel):
    answer: str


chat_router = APIRouter(prefix="/chat", tags=["chat"])


def get_gemini_client() -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY가 설정되어 있지 않습니다.",
        )

    return genai.Client(api_key=api_key)


@chat_router.post("", response_model=ChatResponse)
def chat(payload: ChatRequest) -> ChatResponse:
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    client = get_gemini_client()

    try:
        response = client.models.generate_content(
            model=model,
            contents=payload.question,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API 호출에 실패했습니다: {exc}",
        ) from exc
    finally:
        client.close()

    answer = response.text
    if not answer:
        raise HTTPException(
            status_code=502,
            detail="Gemini API가 빈 응답을 반환했습니다.",
        )

    return ChatResponse(answer=answer)
