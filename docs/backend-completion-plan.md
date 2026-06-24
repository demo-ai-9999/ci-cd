# 백엔드 기능 완성 계획

## 1. 목적

현재 백엔드는 FastAPI, SQLAlchemy, Gemini API를 사용하며 다음 기능만 최소 구현되어 있다.

- `POST /users`: 사용자 생성
- `POST /chat`: 단일 질문을 Gemini에 전달하고 답변 반환
- 앱 시작 시 `Base.metadata.create_all(bind=engine)`로 테이블 생성

이 문서는 사용자 관리, 세션 관리, 챗봇 기능을 완성하기 위해 기존 백엔드 코드를 어떻게 수정하고 어떤 코드를 새로 작성할지 정리한다.

## 2. 현재 코드 진단

### 2.1 사용자 관리

관련 파일:

- `backend/models.py`
- `backend/routers/user.py`

현재 문제:

- 비밀번호가 평문으로 저장된다.
- 사용자명 중복 시 명시적인 예외 처리가 없다.
- 로그인, 로그아웃, 현재 사용자 조회 API가 없다.
- 인증 의존성 함수가 없어 보호된 API를 만들 수 없다.
- 입력값 검증 정책이 약하다.

### 2.2 세션 관리

현재 문제:

- 세션 저장 모델이 없다.
- 액세스 토큰 또는 세션 쿠키 발급 로직이 없다.
- 세션 만료, 폐기, 갱신 정책이 없다.
- 챗봇 대화와 사용자를 연결할 방법이 없다.

### 2.3 챗봇

관련 파일:

- `backend/routers/chat.py`

현재 문제:

- 단일 질문만 처리하고 대화 맥락을 저장하지 않는다.
- 사용자를 인증하지 않아 개인별 대화 기록을 제공할 수 없다.
- Gemini API 장애, 빈 응답, 긴 입력, 과도한 요청에 대한 처리가 부족하다.
- 모델명 기본값이 코드에 박혀 있어 운영 설정 관리가 약하다.

## 3. 목표 기능

### 3.1 사용자 관리

구현 목표:

- 회원가입
- 로그인
- 로그아웃
- 현재 로그인 사용자 조회
- 사용자명 중복 방지
- 비밀번호 해싱 저장
- 기본 입력값 검증

권장 API:

| Method | Path | 설명 | 인증 |
| --- | --- | --- | --- |
| `POST` | `/users` | 회원가입 | 없음 |
| `POST` | `/auth/login` | 로그인 및 세션 발급 | 없음 |
| `POST` | `/auth/logout` | 현재 세션 폐기 | 필요 |
| `GET` | `/auth/me` | 현재 사용자 조회 | 필요 |

### 3.2 세션 관리

구현 목표:

- DB 기반 세션 테이블 추가
- 로그인 성공 시 세션 토큰 발급
- `Authorization: Bearer <token>` 방식 우선 지원
- 세션 만료 시간 관리
- 로그아웃 시 세션 폐기
- 인증 의존성 함수 제공

세션 저장 방식:

- 클라이언트에는 랜덤 토큰 원문을 반환한다.
- DB에는 토큰 원문 대신 해시를 저장한다.
- 토큰 생성에는 `secrets.token_urlsafe()`를 사용한다.
- 토큰 해시에는 SHA-256을 사용한다.

초기 정책:

- 세션 만료 시간: 7일
- 로그아웃 시 `revoked_at` 기록
- 만료 또는 폐기된 세션은 인증 실패 처리

### 3.3 챗봇

구현 목표:

- 인증된 사용자만 챗봇 사용
- 대화방 생성
- 대화방 목록 조회
- 특정 대화방 메시지 조회
- 대화방에 사용자 메시지 추가 후 Gemini 답변 저장
- 최근 대화 맥락을 Gemini 요청에 포함

권장 API:

| Method | Path | 설명 | 인증 |
| --- | --- | --- | --- |
| `POST` | `/chat/sessions` | 새 대화방 생성 | 필요 |
| `GET` | `/chat/sessions` | 내 대화방 목록 조회 | 필요 |
| `GET` | `/chat/sessions/{session_id}` | 대화방 상세 및 메시지 조회 | 필요 |
| `POST` | `/chat/sessions/{session_id}/messages` | 메시지 전송 및 답변 생성 | 필요 |
| `DELETE` | `/chat/sessions/{session_id}` | 대화방 삭제 또는 보관 | 필요 |

기존 `POST /chat`는 다음 중 하나로 처리한다.

- 프론트 호환성을 위해 임시 유지하고 내부적으로 기본 대화방을 생성해 처리
- 또는 프론트 수정과 함께 `/chat/sessions/{session_id}/messages`로 전환

## 4. 데이터 모델 계획

### 4.1 `User`

기존 모델 수정:

```python
class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, nullable=False)
```

마이그레이션 호환을 위해 기존 `password` 컬럼 처리 방식을 결정해야 한다.

- 개발 DB를 초기화할 수 있다면 `password`를 `password_hash`로 교체한다.
- 기존 데이터를 보존해야 한다면 마이그레이션에서 `password_hash`를 추가하고 기존 평문 비밀번호는 재설정 대상으로 둔다.

### 4.2 `UserSession`

새 모델:

```python
class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False, index=True)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False)
```

### 4.3 `ChatSession`

새 모델:

```python
class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    is_archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, nullable=False)
```

### 4.4 `ChatMessage`

새 모델:

```python
class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    chat_session_id = Column(Integer, ForeignKey("chat_sessions.id"), nullable=False, index=True)
    role = Column(String(20), nullable=False)
    content = Column(Text, nullable=False)
    model = Column(String(100), nullable=True)
    created_at = Column(DateTime, nullable=False)
```

`role` 값:

- `user`
- `assistant`
- `system`

## 5. 파일 구조 계획

현재 구조를 크게 흔들지 않는 선에서 다음 파일을 추가한다.

```text
backend/
  auth.py                # 비밀번호 해싱, 토큰 생성, 현재 사용자 인증 의존성
  schemas.py             # Pydantic 요청/응답 모델 공통 관리
  models.py              # User, UserSession, ChatSession, ChatMessage
  routers/
    user.py              # 회원가입 중심
    auth.py              # 로그인, 로그아웃, me
    chat.py              # 대화방 및 메시지 API
```

선택 사항:

```text
backend/
  services/
    chat_service.py      # Gemini 호출, 대화 맥락 구성, 메시지 저장 흐름
    session_service.py   # 세션 생성/검증/폐기
```

프로젝트가 작게 유지된다면 서비스 계층은 나중에 분리해도 된다. 다만 Gemini 호출과 DB 저장 흐름이 섞이면 `routers/chat.py`가 빠르게 커지므로 `chat_service.py` 분리를 권장한다.

## 6. 의존성 추가

`backend/requirements.txt`에 추가 권장:

```text
passlib[bcrypt]>=1.7.4,<2.0.0
```

대안:

- `bcrypt`를 직접 사용해도 되지만 FastAPI 예제와 유지보수성을 고려하면 `passlib[bcrypt]`가 단순하다.

테스트를 추가할 경우:

```text
pytest>=8.0.0,<9.0.0
httpx>=0.27.0,<1.0.0
```

## 7. 구현 단계

### 1단계: 공통 DB 의존성 정리

작업:

- `get_db()`를 `routers/user.py`에서 공통 위치로 이동한다.
- 후보 위치: `database.py` 또는 새 파일 `dependencies.py`
- 모든 라우터가 같은 DB 의존성을 사용하게 한다.

완료 기준:

- `routers/user.py`, `routers/auth.py`, `routers/chat.py`에서 동일한 `get_db`를 import한다.

### 2단계: 사용자 모델 및 비밀번호 보안

작업:

- `User.password`를 `User.password_hash`로 변경한다.
- 비밀번호 해싱/검증 함수 작성
- 회원가입 시 중복 username 검사
- 입력값 검증 추가

예상 응답:

- 중복 사용자명: `409 Conflict`
- 약한 입력값: `422 Unprocessable Entity`

완료 기준:

- DB에 평문 비밀번호가 저장되지 않는다.
- 동일 username 가입 시 명확한 에러가 반환된다.

### 3단계: 인증과 세션

작업:

- `UserSession` 모델 추가
- `POST /auth/login` 구현
- `POST /auth/logout` 구현
- `GET /auth/me` 구현
- `get_current_user()` 의존성 구현

완료 기준:

- 로그인 성공 시 토큰 반환
- 보호 API에서 유효한 토큰 없이는 `401 Unauthorized`
- 로그아웃 후 같은 토큰은 재사용 불가

### 4단계: 챗봇 세션과 메시지 저장

작업:

- `ChatSession`, `ChatMessage` 모델 추가
- 대화방 생성/목록/상세 API 구현
- 메시지 전송 API 구현
- Gemini 응답을 assistant 메시지로 저장
- 대화방 소유자 검증 추가

완료 기준:

- 사용자별 대화방이 분리된다.
- 다른 사용자의 대화방 ID로 접근할 수 없다.
- 사용자 질문과 Gemini 답변이 DB에 저장된다.

### 5단계: Gemini 호출 안정화

작업:

- Gemini 호출 로직을 서비스 함수로 분리
- 입력 길이 제한
- 최근 N개 메시지만 맥락으로 전달
- Gemini 장애 시 사용자 메시지 저장 여부 정책 결정
- 모델명은 `GEMINI_MODEL` 환경변수로만 제어

권장 정책:

- 사용자 메시지는 먼저 저장한다.
- Gemini 호출 실패 시 assistant 메시지는 저장하지 않고 `502 Bad Gateway` 반환
- 실패 이력을 남기고 싶다면 별도 `status` 컬럼을 추가한다.

완료 기준:

- Gemini API 실패가 DB 트랜잭션을 불명확하게 만들지 않는다.
- 긴 대화에서도 요청 크기가 제어된다.

### 6단계: 테스트

우선순위 높은 테스트:

- 회원가입 성공
- 중복 username 실패
- 비밀번호가 평문으로 저장되지 않음
- 로그인 성공/실패
- 인증 없는 `/auth/me` 실패
- 로그아웃 후 토큰 재사용 실패
- 대화방 생성
- 다른 사용자의 대화방 접근 실패
- 메시지 전송 시 user/assistant 메시지 저장
- Gemini API 실패 시 `502` 반환

Gemini API는 실제 호출하지 않고 mock 처리한다.

## 8. 에러 응답 정책

권장 상태 코드:

| 상황 | 상태 코드 |
| --- | --- |
| 인증 정보 없음 | `401` |
| 토큰 만료 또는 폐기 | `401` |
| 다른 사용자 리소스 접근 | `404` 또는 `403` |
| username 중복 | `409` |
| Gemini API 실패 | `502` |
| 입력값 검증 실패 | `422` |

다른 사용자 리소스 접근은 보안상 존재 여부를 숨기려면 `404`를 권장한다.

## 9. 프론트엔드 영향

현재 프론트는 `/api/chat`에 `{ question }`만 전송한다.

백엔드 완성 후 필요한 프론트 변경:

- 회원가입 화면
- 로그인 화면
- 토큰 저장 방식 결정
- 인증 헤더 추가
- 대화방 목록 UI
- 대화 메시지 UI
- 기존 `/api/chat` 호출을 새 메시지 API로 변경

초기 구현에서는 프론트 전환 부담을 줄이기 위해 기존 `POST /chat`를 임시 호환 API로 유지할 수 있다.

## 10. 운영 설정

필요 환경변수:

```text
DATABASE_URL=postgresql://myuser:mypass@db:5432/mydb
GEMINI_API_KEY=...
GEMINI_MODEL=...
SESSION_TTL_SECONDS=604800
SQLALCHEMY_ECHO=false
```

보안상 주의:

- `GEMINI_API_KEY`는 커밋하지 않는다.
- 운영 CORS origin은 명시 도메인만 허용한다.
- 세션 토큰은 로그에 남기지 않는다.

## 11. 마이그레이션 전략

현재는 Alembic이 없고 앱 시작 시 `create_all()`을 사용한다.

단기:

- 개발 단계에서는 DB 초기화 후 모델 변경을 반영한다.
- SQLite `app.db`는 개발용으로만 사용한다.

중기:

- Alembic 도입
- 모델 변경마다 마이그레이션 파일 생성
- Docker Compose PostgreSQL 기준으로 마이그레이션 검증

권장 추가 의존성:

```text
alembic>=1.13.0,<2.0.0
```

## 12. 구현 순서 요약

1. 공통 DB 의존성 분리
2. `User` 모델 보강 및 비밀번호 해싱 적용
3. `auth.py`, `routers/auth.py`, `UserSession` 추가
4. 보호된 인증 의존성 `get_current_user()` 완성
5. `ChatSession`, `ChatMessage` 추가
6. 챗봇 라우터를 대화방 기반 API로 확장
7. Gemini 호출 서비스 분리 및 장애 처리 강화
8. 테스트 추가
9. 프론트 API 연동 변경
10. Alembic 도입 검토

## 13. 완료 기준

백엔드 완료 기준:

- 사용자는 가입, 로그인, 로그아웃, 내 정보 조회를 할 수 있다.
- 비밀번호는 해시로만 저장된다.
- 인증 토큰 없이는 챗봇 API를 사용할 수 없다.
- 사용자는 본인의 대화방과 메시지만 조회할 수 있다.
- 챗봇 답변은 대화방별로 저장된다.
- Gemini API 실패 시 명확한 에러가 반환된다.
- 핵심 흐름에 대한 자동 테스트가 존재한다.
