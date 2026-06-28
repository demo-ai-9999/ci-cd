# Agentic Chatbot 구현 계획

## 1. 목적

현재 챗봇은 사용자의 질문과 최근 대화 맥락을 하나의 프롬프트로 구성한 뒤 Gemini를 한 번 호출하는 구조다. 이 방식은 단순 질의응답에는 충분하지만, 다음과 같은 판단은 애플리케이션이 미리 정해줘야 한다.

- 웹 검색이 필요한 질문인지
- 업로드된 문서를 찾아봐야 하는 질문인지
- 일반 대화로 바로 답해도 되는 질문인지
- 도구 호출 실패 시 어떤 대체 답변을 해야 하는지
- 위험한 작업은 사용자의 승인을 받아야 하는지

이 문서는 기존 FastAPI, Google Gemini, `google-genai`, GCE 배포 구조를 유지하면서 LangChain 기반 Agentic Chatbot으로 전환하는 구현 순서를 정리한다.

## 2. 권장 방향

초기 전환은 LangChain과 `langchain-google-genai`를 사용한다.

이 프로젝트는 최종 배포 대상이 Google GCE다. GCE는 Google Cloud 위에서 동작하지만, 애플리케이션 런타임은 직접 운영하는 VM 또는 컨테이너에 가깝다. 따라서 현재 구조에서는 Google ADK의 관리형 에이전트 런타임보다 LangChain을 FastAPI 서비스 내부에 붙이는 방식이 변경 범위가 작다.

권장 원칙:

- 기존 `google-genai` 기반 검색 기능은 유지한다.
- LangChain은 에이전트 실행 루프와 도구 선택 계층으로만 먼저 도입한다.
- 검색, 문서 조회, 승인 필요한 작업은 순수 Python 서비스 함수로 유지해 프레임워크 종속성을 낮춘다.
- 나중에 Google ADK 또는 Vertex AI Agent Runtime으로 이전하더라도 도구 함수는 재사용할 수 있게 설계한다.

## 3. 현재 구조 요약

관련 파일:

- `backend/services/chat_service.py`
- `backend/services/search_service.py`
- `backend/services/document_service.py`
- `backend/routers/chat.py`
- `backend/models.py`
- `backend/requirements.txt`

현재 흐름:

1. 사용자가 `/chat` 또는 `/chat/sessions/{session_id}/messages`로 메시지를 보낸다.
2. `create_chat_turn()`이 사용자 메시지를 DB에 저장한다.
3. 최근 메시지를 조회해 Gemini 프롬프트를 만든다.
4. `call_gemini()`이 Gemini API를 한 번 호출한다.
5. 답변을 assistant 메시지로 저장한다.

문서 업로드 흐름:

1. PDF 또는 텍스트 파일을 업로드한다.
2. `document_service.py`가 텍스트를 추출하고 요약한다.
3. 원문 조각은 `ChatMessage.role == "system"` 형태로 저장된다.
4. 요약 결과는 assistant 메시지로 저장된다.

검색 흐름:

1. `search_service.py`가 `google-genai`와 Google Search Grounding을 사용한다.
2. `search_and_summarize(query)`가 답변과 검색 결과 목록을 반환한다.

## 4. 목표 아키텍처

GCE 배포 구조는 유지한다.

```text
GCE
└─ Docker Compose 또는 VM 프로세스
   ├─ FastAPI backend
   │  ├─ LangChain agent executor
   │  ├─ Gemini model via langchain-google-genai
   │  ├─ web_search tool
   │  ├─ document_search tool
   │  ├─ tool execution logging
   │  └─ user approval guard
   ├─ frontend
   └─ PostgreSQL 또는 SQLite 개발 DB
```

Agentic Chatbot의 기본 판단 흐름:

1. 사용자의 질문과 최근 대화 맥락을 agent에 전달한다.
2. agent가 일반 답변, 웹 검색, 문서 조회 중 필요한 행동을 선택한다.
3. 도구를 호출하면 호출 내역과 결과 또는 실패 원인을 기록한다.
4. 위험한 도구는 실행 전 승인 상태를 확인한다.
5. 최종 답변을 assistant 메시지로 저장한다.

## 5. 구현 순서

### 1단계: `google-genai`는 그대로 유지

목표:

- 기존 Google Search Grounding 구현을 유지한다.
- 검색 품질과 응답 형식을 먼저 흔들지 않는다.
- LangChain 도입이 검색 로직 전체 교체로 번지지 않게 한다.

작업 방향:

- `backend/services/search_service.py`의 `search_and_summarize(query)`는 유지한다.
- 내부의 `google-genai` 클라이언트 생성, Grounding 설정, 검색 결과 추출 로직도 유지한다.
- 이 함수는 이후 `web_search tool`의 내부 구현으로 사용한다.

완료 기준:

- 기존 검색 API 테스트가 계속 통과한다.
- 기존 환경변수 `GOOGLE_AGENTPLATFORM_API_KEY` 사용 방식이 유지된다.
- 검색 기능 변경 없이 agent 도구로 감쌀 수 있는 상태가 된다.

주의 사항:

- 검색 기능을 LangChain 제공 검색 도구로 바로 교체하지 않는다.
- 검색 결과 출처 추출 로직을 잃지 않는다.
- 운영 중인 Google API 키 구성을 바꾸지 않는다.

### 2단계: `langchain`, `langchain-google-genai` 추가

목표:

- Gemini 호출 자체는 LangChain 모델 어댑터를 통해 agent가 사용할 수 있게 한다.
- 기존 직접 Gemini 호출 함수는 문서 요약 등 기존 기능을 위해 당분간 유지한다.

작업 방향:

- `backend/requirements.txt`에 LangChain 관련 의존성을 추가한다.
- Gemini 모델명은 기존 `GEMINI_MODEL` 설정을 그대로 사용한다.
- API 키는 기존 `GEMINI_API_KEY`를 우선 사용한다.
- LangChain 모델 객체 생성은 별도 서비스 계층으로 분리한다.

권장 파일:

- `backend/services/agent_service.py`

이 파일의 책임:

- agent 모델 생성
- agent 도구 목록 구성
- agent 시스템 지시문 관리
- agent 실행 함수 제공

완료 기준:

- 기존 직접 Gemini 호출 경로가 깨지지 않는다.
- agent 실행에 필요한 모델 객체가 `config.py` 설정을 통해 생성된다.
- GCE 배포 시 추가 환경변수 없이 기존 Gemini 설정을 재사용할 수 있다.

주의 사항:

- 이 단계에서 `call_gemini()`을 삭제하지 않는다.
- 문서 요약 기능은 안정성을 위해 기존 직접 호출 방식을 유지한다.
- LangChain 도입 범위는 agent 응답 생성 경로로 제한한다.

### 3단계: 기존 검색 기능을 `web_search tool`로 변환

목표:

- agent가 질문의 성격을 보고 웹 검색 필요 여부를 직접 판단하게 한다.
- 검색 구현은 기존 `search_and_summarize(query)`를 재사용한다.

작업 방향:

- `web_search` 도구를 만든다.
- 도구 입력은 사용자의 검색 의도를 담은 짧은 질의 문자열로 제한한다.
- 도구 출력은 agent가 최종 답변에 활용하기 쉬운 텍스트 형태로 정리한다.
- 검색 결과 링크와 제목은 가능한 한 함께 반환한다.

도구 설명에 포함할 정책:

- 최신 정보, 가격, 일정, 법/정책, 외부 사실 확인이 필요한 경우 사용한다.
- 사용자가 명시적으로 검색을 요청한 경우 사용한다.
- 업로드 문서 내부 정보만 필요한 경우에는 사용하지 않는다.
- 검색 실패 시 실패 사유를 숨기지 말고 agent가 대체 답변을 만들 수 있게 반환한다.

완료 기준:

- agent가 최신 정보 질문에서 `web_search`를 호출할 수 있다.
- 검색 실패가 전체 채팅 실패로만 끝나지 않고 설명 가능한 실패로 기록된다.
- 기존 `/search` 라우터가 있다면 그 동작은 유지된다.

주의 사항:

- 검색 도구가 사용자별 DB 상태를 변경하지 않게 한다.
- 검색 결과 전체를 과도하게 저장하지 않는다.
- 최종 답변에는 검색 출처가 필요한 경우 함께 포함할 수 있게 한다.

### 4단계: 저장된 업로드 문서를 조회하는 `document_search tool` 추가

목표:

- 사용자가 업로드한 문서 내용을 agent가 필요할 때 찾아볼 수 있게 한다.
- 현재 DB에 저장된 `system` 메시지를 우선 활용한다.

작업 방향:

- 현재 세션의 `ChatMessage.role == "system"` 메시지 중 문서 내용 조각을 조회한다.
- 사용자 질문 또는 agent가 만든 검색어와 문서 조각의 관련도를 계산한다.
- 초기 버전은 벡터 DB 없이 키워드 기반 검색으로 시작한다.
- 관련도가 높은 문서 조각 일부만 agent에 반환한다.

권장 동작:

- 같은 대화방에 업로드된 문서를 우선 검색한다.
- 다른 대화방 문서까지 검색할지는 별도 정책으로 둔다.
- 반환 길이는 제한해 agent 컨텍스트가 과도하게 커지지 않게 한다.

도구 설명에 포함할 정책:

- 사용자가 "업로드한 문서", "첨부한 파일", "이 PDF", "문서 내용"을 언급하면 사용한다.
- 웹의 최신 정보가 아니라 사용자 문서 내부 근거가 필요할 때 사용한다.
- 문서 내용이 없으면 없다고 명확히 반환한다.

완료 기준:

- 업로드된 문서에 대한 후속 질문에서 agent가 `document_search`를 호출할 수 있다.
- 관련 문서 조각을 근거로 답변할 수 있다.
- 문서가 없는 세션에서는 안전하게 "조회할 문서가 없음" 상태를 반환한다.

주의 사항:

- 업로드 문서는 사용자 소유 세션 범위 안에서만 조회한다.
- 다른 사용자의 문서가 섞이지 않게 `user_id`와 `chat_session_id` 범위를 명확히 한다.
- 문서 원문 전체를 매번 agent 입력에 넣지 않는다.

### 5단계: `create_chat_turn()`의 단일 Gemini 호출을 agent 실행으로 교체

목표:

- 기존 저장 흐름은 유지하되, 답변 생성만 agent 실행으로 교체한다.

현재 흐름:

```text
사용자 메시지 저장
→ 최근 메시지 조회
→ 프롬프트 생성
→ Gemini 단일 호출
→ assistant 메시지 저장
```

목표 흐름:

```text
사용자 메시지 저장
→ 최근 메시지 조회
→ agent 입력 구성
→ agent가 필요 시 tool 호출
→ 최종 답변 생성
→ assistant 메시지 저장
→ tool 호출 로그 저장
```

작업 방향:

- `create_chat_turn()`의 DB 저장 책임은 유지한다.
- Gemini 직접 호출 부분만 agent 실행 함수로 교체한다.
- 최근 대화 메시지는 LangChain message 형식으로 변환해 전달한다.
- system 메시지로 저장된 문서 원문은 최근 대화 맥락에 무조건 넣지 않고 `document_search tool`을 통해 조회하게 한다.

완료 기준:

- 기존 채팅 API 응답 형식이 유지된다.
- 프론트엔드 수정 없이 기본 채팅이 계속 동작한다.
- 일반 질문은 도구 없이 답변한다.
- 검색 또는 문서 질문은 agent가 도구를 선택해 답변한다.

주의 사항:

- 사용자가 보낸 메시지는 agent 실행 전에 저장하는 현재 흐름을 유지한다.
- agent 실패 시 사용자 메시지만 저장되고 assistant 메시지가 없는 상태가 생길 수 있으므로 실패 처리 정책을 정한다.
- assistant 메시지에는 최종 답변만 저장하고, tool 호출 세부 내역은 별도 로그로 분리한다.

### 6단계: tool 호출 내역과 실패 원인을 로그로 기록

목표:

- agent가 어떤 판단으로 어떤 도구를 호출했는지 추적 가능하게 한다.
- 운영 중 문제를 재현하고 개선할 수 있는 최소한의 관측성을 확보한다.

기록 대상:

- chat session id
- user id
- user message id
- tool name
- tool input 요약
- 시작 시각
- 종료 시각
- 성공 여부
- 실패 원인
- 결과 요약

권장 저장 방식:

- 초기에는 애플리케이션 로그로 남긴다.
- 운영 분석이 필요해지는 시점에 DB 테이블을 추가한다.

DB 테이블을 추가할 경우 권장 이름:

- `agent_tool_calls`

권장 필드:

- `id`
- `chat_session_id`
- `user_id`
- `message_id`
- `tool_name`
- `tool_input`
- `tool_output_summary`
- `status`
- `error_message`
- `created_at`
- `finished_at`

완료 기준:

- 도구 호출 성공과 실패가 모두 로그에 남는다.
- 검색 API 키 누락, 검색 실패, 문서 없음, 모델 호출 실패를 구분할 수 있다.
- 사용자에게 노출되는 답변과 운영 로그가 분리된다.

주의 사항:

- 로그에 API 키, 세션 토큰, 비밀번호, 문서 원문 전체를 남기지 않는다.
- tool input과 output은 길이를 제한한다.
- 개인정보가 포함될 수 있는 문서 내용은 요약 또는 일부 발췌만 기록한다.

### 7단계: 삭제·외부 변경 같은 위험한 tool에는 사용자 승인 추가

목표:

- agent가 사용자 데이터 삭제, 외부 시스템 변경, 비용 발생 가능 작업을 임의로 실행하지 못하게 한다.

초기 위험 도구 기준:

- 대화방 삭제
- 업로드 문서 삭제
- 외부 API에 데이터를 생성, 수정, 삭제하는 작업
- 이메일, 메시지, 알림 발송
- 결제, 예약, 주문 등 비용 또는 권한 변경이 있는 작업

현재 프로젝트에서 즉시 적용할 후보:

- `delete_chat_session`
- 향후 추가될 문서 삭제 도구
- 향후 추가될 외부 시스템 연동 도구

작업 방향:

- 위험 도구는 agent가 바로 실행하지 못하게 한다.
- agent는 먼저 승인 요청 상태를 생성한다.
- 프론트엔드는 사용자에게 승인 또는 거절 UI를 보여준다.
- 승인된 요청만 실제 도구 실행 함수로 전달한다.

권장 승인 상태:

- `pending`
- `approved`
- `rejected`
- `expired`
- `executed`

완료 기준:

- 위험 도구는 승인 없이는 실행되지 않는다.
- 승인 요청에는 실행 대상, 예상 영향, 만료 시간이 포함된다.
- 승인 이후 실행 결과도 로그에 남는다.

주의 사항:

- "삭제해" 같은 명령은 의도 확인만으로 충분하지 않다. 실제 실행 전 별도 승인 상태를 거친다.
- 읽기 전용 도구와 쓰기 도구를 명확히 분리한다.
- 승인 요청은 사용자별, 세션별로 격리한다.

## 6. 권장 파일 변경 계획

### `backend/requirements.txt`

변경 방향:

- LangChain 핵심 패키지 추가
- Gemini 연동 패키지 추가
- 기존 `google-genai` 유지

완료 기준:

- 기존 테스트와 서버 실행이 유지된다.
- GCE Docker 빌드에서 새 의존성이 설치된다.

### `backend/services/agent_service.py`

신규 파일 권장.

책임:

- Gemini 기반 LangChain 모델 생성
- agent 생성
- agent 시스템 지시문 관리
- 도구 목록 조립
- agent 실행 함수 제공

이 파일은 DB 저장을 직접 많이 담당하지 않게 하고, 가능한 한 agent 실행과 도구 연결에 집중한다.

### `backend/services/agent_tools.py`

신규 파일 권장.

책임:

- `web_search` 도구 정의
- `document_search` 도구 정의
- 도구 입출력 정규화
- 도구 실패 메시지 정규화

도구 내부에서는 기존 서비스 함수를 호출한다.

### `backend/services/agent_logging.py`

신규 파일 권장.

책임:

- tool 호출 시작 기록
- tool 호출 성공 기록
- tool 호출 실패 기록
- 민감정보 마스킹
- 로그 길이 제한

초기에는 Python logger 기반으로 구현하고, 필요 시 DB 저장으로 확장한다.

### `backend/services/chat_service.py`

변경 방향:

- `create_chat_turn()`의 답변 생성 부분을 agent 실행으로 교체한다.
- 기존 메시지 저장, 세션 업데이트, 응답 반환 구조는 유지한다.
- `call_gemini()`은 문서 요약 등 기존 기능을 위해 남긴다.

### `backend/services/document_service.py`

변경 방향:

- 문서 업로드, 텍스트 추출, 요약 저장 흐름은 유지한다.
- document search가 재사용할 수 있는 문서 조각 조회 함수를 추가할 수 있다.

### `backend/routers/chat.py`

변경 방향:

- 기본 채팅 API 응답 형식은 유지한다.
- 승인 기능 도입 시 승인 요청 조회, 승인, 거절 엔드포인트를 추가한다.

## 7. Agent 시스템 지시문 정책

agent에는 다음 정책이 필요하다.

- 사용자의 질문에 바로 답할 수 있으면 도구를 사용하지 않는다.
- 최신 정보, 외부 사실 확인, 현재 가격, 일정, 정책은 `web_search`를 사용한다.
- 업로드 문서나 첨부 파일에 대한 질문은 `document_search`를 사용한다.
- 도구 결과에 없는 내용을 확정적으로 말하지 않는다.
- 도구 실패 시 실패 사실을 바탕으로 가능한 범위에서 답한다.
- 삭제, 외부 변경, 비용 발생 작업은 승인 없이 실행하지 않는다.
- 최종 답변은 사용자가 읽기 쉬운 한국어로 작성한다.

## 8. 테스트 계획

### 단위 테스트

대상:

- `web_search tool`
- `document_search tool`
- agent 입력 메시지 구성
- tool 실패 메시지 정규화
- 민감정보 마스킹

확인 항목:

- 검색 성공 시 답변과 출처가 반환된다.
- 검색 API 키 누락 시 안전한 실패 메시지가 반환된다.
- 문서가 없는 세션에서 안전한 빈 결과가 반환된다.
- 다른 사용자의 문서는 검색되지 않는다.
- 긴 tool output은 제한 길이로 잘린다.

### 서비스 테스트

대상:

- `create_chat_turn()`

확인 항목:

- 일반 질문은 assistant 메시지를 저장한다.
- 검색이 필요한 질문은 tool 호출 로그가 남는다.
- 문서 질문은 저장된 system 문서를 조회한다.
- agent 실패 시 HTTP 에러 또는 fallback 메시지 정책이 일관된다.

### API 테스트

대상:

- `POST /chat`
- `POST /chat/sessions/{session_id}/messages`
- `POST /chat/documents`
- 향후 승인 API

확인 항목:

- 기존 응답 스키마가 유지된다.
- 프론트엔드가 기존 방식으로 계속 답변을 받을 수 있다.
- 보관된 대화방에는 메시지를 보낼 수 없다.
- 승인 없는 위험 작업은 실행되지 않는다.

## 9. 배포 계획

GCE 배포에서 확인할 항목:

- Docker 이미지 빌드 시 LangChain 의존성 설치 확인
- `GEMINI_API_KEY` 설정 확인
- `GOOGLE_AGENTPLATFORM_API_KEY` 설정 확인
- `GEMINI_MODEL` 설정 확인
- 애플리케이션 로그 수집 위치 확인
- tool 호출 로그에 민감정보가 남지 않는지 확인

초기 배포 전략:

1. 로컬 테스트에서 agent 경로 검증
2. GCE staging 또는 별도 인스턴스에서 Docker 빌드 검증
3. 기능 플래그로 agent 응답 경로 활성화
4. 검색과 문서 질문 중심으로 운영 로그 확인
5. 문제가 없으면 기본 경로로 전환

권장 기능 플래그:

- `ENABLE_AGENTIC_CHATBOT`
- `ENABLE_AGENT_TOOL_LOGGING`
- `ENABLE_DANGEROUS_TOOL_APPROVALS`

## 10. 마이그레이션 전략

안전한 전환을 위해 한 번에 전체 구조를 바꾸지 않는다.

1. 기존 단일 Gemini 호출 경로 유지
2. agent 실행 경로 추가
3. 기능 플래그로 일부 환경에서만 agent 활성화
4. 테스트와 로그로 안정성 확인
5. 기본 채팅 경로를 agent로 전환
6. 직접 호출 경로는 문서 요약 등 필요한 곳에만 남김

롤백 전략:

- agent 실행에 문제가 있으면 기능 플래그를 끄고 기존 `call_gemini()` 기반 응답으로 되돌린다.
- DB 스키마 변경이 필요한 tool 로그와 승인 기능은 agent 기본 전환 후 별도 단계로 배포한다.

## 11. 나중에 검토할 확장

### LangGraph

다음 조건이 생기면 LangGraph 도입을 검토한다.

- 여러 단계의 장기 작업이 필요하다.
- 사람 승인, 재시도, 중단 후 재개가 복잡해진다.
- agent 상태를 명시적인 그래프로 관리해야 한다.
- tool 호출 흐름을 더 세밀하게 제어해야 한다.

### Google ADK

다음 조건이 생기면 Google ADK 전환 또는 병행을 검토한다.

- Vertex AI Agent Runtime 또는 Google 관리형 agent 운영을 적극 사용한다.
- Google Cloud의 agent session, memory, evaluation, observability 체계를 중심으로 재구성한다.
- Google 생태계 안에서 장기적으로 agent 운영 표준을 맞추는 것이 더 중요해진다.

현재 GCE 자체 배포 기준으로는 LangChain을 먼저 도입하는 편이 변경 범위와 운영 리스크가 작다.

## 12. 최종 완료 기준

Agentic Chatbot 전환의 완료 기준은 다음과 같다.

- 일반 질문은 기존처럼 자연스럽게 답변한다.
- 최신 정보 질문은 agent가 스스로 웹 검색 도구를 선택한다.
- 업로드 문서 질문은 agent가 저장된 문서 조회 도구를 선택한다.
- tool 호출 성공과 실패가 로그로 남는다.
- 위험한 도구는 사용자 승인 없이는 실행되지 않는다.
- 기존 채팅 API 응답 형식과 GCE 배포 구조가 유지된다.
- 문제가 생기면 기능 플래그로 기존 단일 Gemini 호출 경로로 롤백할 수 있다.
