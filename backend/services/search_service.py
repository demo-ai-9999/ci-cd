from __future__ import annotations

from typing import Any, cast
from urllib.parse import urlparse

from fastapi import HTTPException, status
from google import genai
from google.genai import types

from config import get_settings
from schemas import SearchResult
from services.chat_service import get_gemini_model_name

MAX_SEARCH_RESULTS = 5
ANSWER_ONLY_INSTRUCTION = "설명이나 해설은 하지 말고, 바로 대답만 하세요."


def _get_grounding_client() -> genai.Client:
    api_key = cast(str | None, get_settings()["google_agentplatform_api_key"])
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="GOOGLE_AGENTPLATFORM_API_KEY가 설정되어 있지 않습니다.",
        )

    return genai.Client(api_key=api_key)


def _get_value(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _fallback_title_from_url(url: str) -> str:
    hostname = urlparse(url).hostname or ""
    return hostname or url


def _build_grounding_config() -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        tools=[
            types.Tool(
                google_search=types.GoogleSearch(),
            )
        ]
    )


def _build_grounded_snippet_map(response: Any) -> dict[int, str]:
    snippet_by_index: dict[int, str] = {}
    candidates = _get_value(response, "candidates", []) or []
    if not candidates:
        return snippet_by_index

    grounding_metadata = _get_value(candidates[0], "grounding_metadata")
    grounding_supports = _get_value(grounding_metadata, "grounding_supports", []) or []

    for support in grounding_supports:
        segment = _get_value(support, "segment")
        snippet = _normalize_text(_get_value(segment, "text"))
        if not snippet:
            continue

        for chunk_index in _get_value(support, "grounding_chunk_indices", []) or []:
            if chunk_index not in snippet_by_index:
                snippet_by_index[int(chunk_index)] = snippet

    return snippet_by_index


def _extract_search_results(response: Any) -> list[SearchResult]:
    candidates = _get_value(response, "candidates", []) or []
    if not candidates:
        return []

    grounding_metadata = _get_value(candidates[0], "grounding_metadata")
    grounding_chunks = _get_value(grounding_metadata, "grounding_chunks", []) or []
    snippet_by_index = _build_grounded_snippet_map(response)

    results: list[SearchResult] = []
    seen_links: set[str] = set()

    for index, chunk in enumerate(grounding_chunks):
        web = _get_value(chunk, "web")
        link = _normalize_text(_get_value(web, "uri"))
        if not link or link in seen_links:
            continue

        title = _normalize_text(_get_value(web, "title")) or _fallback_title_from_url(link)
        snippet = _normalize_text(snippet_by_index.get(index, ""))

        results.append(
            SearchResult(
                title=title,
                link=link,
                snippet=snippet,
            )
        )
        seen_links.add(link)

        if len(results) >= MAX_SEARCH_RESULTS:
            break

    return results


def _call_gemini_with_grounding(query: str) -> Any:
    client = _get_grounding_client()

    try:
        return client.models.generate_content(
            model=get_gemini_model_name(),
            contents=f"{ANSWER_ONLY_INSTRUCTION}\n\n{query}",
            config=_build_grounding_config(),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini Google Search Grounding 호출에 실패했습니다: {exc}",
        ) from exc
    finally:
        client.close()


def search_and_summarize(query: str) -> tuple[str, list[SearchResult]]:
    response = _call_gemini_with_grounding(query)
    answer = _normalize_text(_get_value(response, "text"))
    if not answer:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Gemini Google Search Grounding이 빈 응답을 반환했습니다.",
        )

    results = _extract_search_results(response)
    return answer, results
