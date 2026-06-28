# Cloud Run 전환을 위한 코드 변경 Implementation Plan

**주제:** 현재 FastAPI/React 프로젝트를 Cloud Build Trigger + Cloud Run 자동 배포에 맞게 수정하기 위한 코드 변경 계획  
**참조 문서:** `gcp-docs/gcp_cloudbuild_cloudrun_implementation_UTF8.md`  
**작성일:** 2026-06-26  
**대상:** `backend/` FastAPI 서비스 우선. `frontend/`는 배포 방식 결정 후 별도 적용  
**주의:** 이 문서는 구현 계획 문서이며, 실제 코드 변경은 포함하지 않는다.

---

## 1. 현재 코드 기준 진단

현재 저장소는 다음 구조를 가진다.

```text
backend/
  main.py
  Dockerfile
  config.py
  database.py
  requirements.txt
  tests/

frontend/
  Dockerfile
  vite.config.ts
  src/api.ts

docker-compose.yml
docker-compose-gce.yml
```

Cloud Run 전환 관점에서 확인된 주요 상태는 다음과 같다.

| 항목 | 현재 상태 | Cloud Run 기준 판단 |
|---|---|---|
| 백엔드 앱 | FastAPI `main:app` | 적합 |
| 상태 확인 엔드포인트 | `/`가 `{"status": "ok"}` 응답 | `/health` 추가 권장 |
| 백엔드 Dockerfile 포트 | `--port 8000` 고정 | `$PORT` 사용으로 변경 필요 |
| 백엔드 listen host | `0.0.0.0` | 적합 |
| DB 기본값 | `sqlite:///./app.db` | Cloud Run 운영 기본값으로 부적합 |
| DB 마이그레이션 | compose command에서 `alembic upgrade head` 실행 | Cloud Run 배포 흐름에서 별도 전략 필요 |
| 환경변수 로딩 | `python-dotenv`로 `.env` 로드 | 로컬 개발은 유지 가능, 운영은 Secret Manager/Cloud Run env 사용 |
| Secret | `.env.example`에 API Key 항목 존재 | Secret Manager 대상 분류 필요 |
| `.dockerignore` | 없음 | 추가 필요 |
| 테스트 | `backend/tests/` 존재 | Cloud Build test step에 맞게 경로 조정 필요 |
| 프론트 API 호출 | `/api` 상대 경로 | Cloud Run 백엔드 단독 배포 시 별도 배포/프록시 전략 필요 |

---

## 2. 구현 목표

이번 코드 변경의 목표는 백엔드 컨테이너가 Cloud Run 런타임 계약을 만족하고, Cloud Build에서 안정적으로 테스트/빌드/배포될 수 있게 만드는 것이다.

최소 완료 목표:

- Cloud Run이 주입하는 `$PORT`로 FastAPI가 실행된다.
- `/health` 엔드포인트가 존재한다.
- Docker 이미지에 `.env`, DB 파일, 캐시 파일이 포함되지 않는다.
- 운영 환경에서 필수 환경변수가 누락되면 조기에 실패하거나 명확히 확인된다.
- Cloud Build test step이 실제 `backend/` 구조에 맞게 실행된다.
- DB 마이그레이션 실행 위치가 명확히 정해진다.

---

## 3. 백엔드 변경 계획

### 3.1 `backend/main.py`

현재는 `/` 엔드포인트가 상태 확인 역할을 한다.

변경 계획:

- `/health` 엔드포인트를 추가한다.
- 기존 `/` 엔드포인트는 유지한다.
- `/health`는 외부 API, Gemini API, DB에 의존하지 않는 가벼운 응답으로 둔다.

권장 응답:

```json
{"status":"ok"}
```

이유:

- Cloud Run 배포 후 검증 명령을 단순화할 수 있다.
- 외부 API 장애와 컨테이너 생존 상태를 분리해서 확인할 수 있다.
- 문서의 배포 검증 절차와 일치한다.

완료 기준:

```bash
curl http://localhost:8080/health
```

위 명령이 `{"status":"ok"}`를 반환한다.

---

### 3.2 `backend/Dockerfile`

현재 Dockerfile은 다음 문제가 있다.

- `uvicorn` 포트가 `8000`으로 고정되어 있다.
- Cloud Run은 컨테이너에 `$PORT` 환경변수를 주입하며, 앱은 이 포트로 listen해야 한다.

변경 계획:

- `CMD`를 shell form 또는 `sh -c` exec form으로 바꿔 `${PORT:-8080}`를 사용한다.
- 로컬 실행 편의를 위해 기본값은 `8080`으로 둔다.
- `EXPOSE`는 필수는 아니지만 문서화 목적으로 `8080` 추가를 검토한다.

권장 실행 형태:

```dockerfile
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
```

추가 검토:

- 현재 Python 버전은 `python:3.10-slim`이다.
- 문서 예시는 `python:3.12-slim`이지만, 버전 변경은 라이브러리 호환성 확인 후 별도 진행한다.
- 이번 1차 전환에서는 포트 대응만 최소 변경으로 처리하는 것을 권장한다.

완료 기준:

```bash
docker build -t local-backend-test ./backend
docker run --rm -p 8080:8080 -e PORT=8080 local-backend-test
curl http://localhost:8080/health
```

---

### 3.3 `backend/config.py`

현재 설정은 `.env`를 로드하고, 값이 없으면 기본값을 사용한다.

운영에서 특히 문제가 될 수 있는 기본값:

```text
DATABASE_URL=sqlite:///./app.db
GEMINI_API_KEY=None
GOOGLE_AGENTPLATFORM_API_KEY=None
```

변경 계획:

- 로컬 개발에서는 `.env` 로드를 유지한다.
- 운영 환경에서는 `DATABASE_URL` 누락 시 SQLite로 조용히 fallback하지 않도록 한다.
- `ENV=prod` 또는 `ENVIRONMENT=production` 같은 운영 모드 변수를 기준으로 필수 환경변수 검증을 추가한다.
- Secret Manager에서 주입될 값과 일반 env 값을 명확히 분리한다.

운영 필수 후보:

| 변수 | 용도 | 권장 주입 방식 |
|---|---|---|
| `DATABASE_URL` | 운영 DB 연결 | Secret Manager 또는 Cloud Run env |
| `GEMINI_API_KEY` | Gemini API 호출 | Secret Manager |
| `GOOGLE_AGENTPLATFORM_API_KEY` | Google Agent Platform 연동 | Secret Manager |
| `GEMINI_MODEL` | 모델명 | Cloud Run env |
| `SESSION_TTL_SECONDS` | 세션 만료 | Cloud Run env |
| `SQLALCHEMY_ECHO` | SQL 로그 | Cloud Run env |
| `CORS_ORIGINS` | 허용 프론트 도메인 | Cloud Run env |

권장 정책:

- `ENV=prod`일 때 `DATABASE_URL`이 없으면 애플리케이션 시작 실패
- API Key는 기능별로 선택 필수 처리
- `CORS_ORIGINS`는 운영 프론트 도메인 확정 후 설정

주의:

- `load_dotenv()`는 Cloud Run에서 `.env` 파일을 읽기 위한 용도가 아니다.
- Cloud Run 운영 환경에서는 Cloud Run env와 Secret Manager가 실제 source of truth가 되어야 한다.

---

### 3.4 `backend/database.py`

현재는 SQLAlchemy 엔진이 모듈 import 시점에 생성된다.

변경 계획:

- 1차 전환에서는 구조를 크게 바꾸지 않아도 된다.
- 단, 운영에서 SQLite fallback이 발생하지 않도록 `config.py`의 검증을 먼저 강화한다.
- Cloud Run에서 PostgreSQL을 계속 사용할 경우 연결 대상이 필요하다.

DB 선택지:

| 선택지 | 설명 | 1차 전환 적합성 |
|---|---|---|
| Cloud SQL PostgreSQL | 기존 PostgreSQL 모델 유지 | 가장 자연스러움. 단, Cloud SQL 설정 필요 |
| 외부 PostgreSQL | 기존 DB를 외부에서 접근 | 네트워크/보안 설정 필요 |
| Firestore | 문서의 다음 단계 후보 | 이번 1차 범위 밖 |
| SQLite | 컨테이너 내부 파일 | 운영 부적합 |

중요:

- Cloud Run 컨테이너 내부의 `backend/app.db`는 영구 저장소로 간주하면 안 된다.
- 현재 `backend/app.db`는 Docker 이미지에 포함되지 않도록 제외해야 한다.

---

### 3.5 Alembic 마이그레이션

현재 compose 배포에서는 백엔드 실행 전에 다음 명령을 수행한다.

```bash
alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000
```

Cloud Run에서는 마이그레이션 전략을 명확히 정해야 한다.

권장 선택지:

| 방식 | 설명 | 권장도 |
|---|---|---|
| Cloud Build step에서 `alembic upgrade head` 실행 | 배포 전 DB 스키마 업데이트 | DB 접근이 Cloud Build에서 가능할 때 적합 |
| Cloud Run Job으로 마이그레이션 실행 | 앱 배포와 마이그레이션 분리 | 운영적으로 가장 깔끔함 |
| 컨테이너 시작 시 매번 실행 | 현재 compose와 유사 | 동시 revision/scale-out에서 위험 |

1차 권장:

- 초기에는 Cloud Build 수동 단계 또는 별도 운영 명령으로 마이그레이션을 분리한다.
- 앱 컨테이너 `CMD`에는 `alembic upgrade head`를 넣지 않는다.
- Cloud SQL을 도입하면 Cloud Build 또는 Cloud Run Job에서 DB 접근 권한을 별도로 설정한다.

---

### 3.6 `backend/requirements.txt`

현재 의존성은 Cloud Run 실행에 큰 문제는 없어 보인다.

검토 계획:

- `pytest`, `httpx`는 테스트 의존성이므로 운영 이미지에 포함할지 결정한다.
- 1차 구현에서는 단순성을 위해 그대로 유지할 수 있다.
- 추후에는 `requirements.txt`와 `requirements-dev.txt` 분리를 검토한다.

주의:

- Python 버전을 3.10에서 3.12로 올릴 경우 `psycopg2-binary`, `pdfplumber`, `google-genai` 호환성을 확인해야 한다.

---

### 3.7 `backend/.dockerignore`

현재 `backend/` 빌드 컨텍스트에는 `.dockerignore`가 없다.

추가 계획:

```text
.env
.env.*
app.db
__pycache__
*.pyc
.pytest_cache
.mypy_cache
.DS_Store
tests/__pycache__
alembic/__pycache__
```

검토 항목:

- `tests/`를 이미지에 포함할지 여부
- Cloud Build test step은 Docker build 전에 소스에서 테스트하므로, 운영 이미지에는 `tests/` 제외 가능

권장:

- 1차에서는 `tests/` 제외까지는 선택 사항으로 둔다.
- 반드시 제외해야 하는 것은 `.env`, `.env.*`, `app.db`, 캐시 파일이다.

---

## 4. Cloud Build 설정에 맞춘 코드 구조 조정

참조 문서의 `cloudbuild.yaml` 예시는 repository root에 `requirements.txt`가 있다고 가정한다.

현재 저장소는 다음과 다르다.

```text
backend/requirements.txt
backend/Dockerfile
backend/tests/
```

따라서 `cloudbuild.yaml` 작성 시 다음을 반영해야 한다.

테스트 단계:

- 작업 디렉터리를 `backend/`로 이동한 뒤 의존성 설치
- `backend/tests/` 기준으로 pytest 실행

Docker build 단계:

- build context는 `backend/`
- Dockerfile은 `backend/Dockerfile`

이미지 대상:

```text
asia-northeast3-docker.pkg.dev/$PROJECT_ID/$REPO_NAME/$IMAGE_NAME:$SHORT_SHA
```

예상 변경 방향:

```text
test step:
  cd backend
  pip install -r requirements.txt
  pytest -q

docker build step:
  docker build -f backend/Dockerfile -t IMAGE ./backend
```

이 문서는 실제 `cloudbuild.yaml` 작성 전 코드 변경 범위만 정의한다.

---

## 5. 프론트엔드 관련 판단

현재 프론트엔드는 Vite 개발 서버를 컨테이너에서 실행한다.

```text
frontend/Dockerfile -> npm run dev -- --host 0.0.0.0
frontend/src/api.ts -> API_BASE = '/api'
frontend/vite.config.ts -> dev server proxy '/api' to backend
```

Cloud Run 백엔드 자동 배포만 먼저 진행한다면 프론트 코드는 1차 변경 대상에서 제외한다.

다만 전체 서비스를 Cloud Run으로 옮기려면 다음 중 하나를 선택해야 한다.

| 방식 | 설명 |
|---|---|
| 백엔드만 Cloud Run | 프론트는 기존 GCE/별도 호스팅 유지 |
| 프론트도 Cloud Run | Vite dev server가 아니라 정적 build + nginx 또는 node static server 사용 |
| Firebase Hosting/Cloud Storage | 정적 프론트 배포에 적합 |
| 백엔드가 정적 파일 서빙 | FastAPI가 빌드된 프론트 파일을 함께 서빙 |

1차 권장:

- 백엔드 Cloud Run 전환을 먼저 완료한다.
- 프론트는 백엔드 Cloud Run URL을 바라보도록 배포 구조를 별도 설계한다.
- 운영 CORS에는 실제 프론트 도메인을 넣는다.

주의:

- 현재 `/api` 상대 경로는 Vite dev proxy가 있을 때 자연스럽다.
- 프론트를 정적 호스팅으로 배포하면 `/api` 프록시가 사라지므로 API base URL 전략을 다시 정해야 한다.

---

## 6. 환경변수와 Secret Manager 매핑

현재 `.env.example` 기준 변수는 다음과 같다.

```text
DATABASE_URL
GEMINI_API_KEY
GOOGLE_AGENTPLATFORM_API_KEY
GEMINI_MODEL
SESSION_TTL_SECONDS
SQLALCHEMY_ECHO
CORS_ORIGINS
```

권장 매핑:

| 변수 | Cloud Run 설정 방식 | 비고 |
|---|---|---|
| `DATABASE_URL` | Secret Manager 권장 | DB 비밀번호 포함 가능 |
| `GEMINI_API_KEY` | Secret Manager | secretAccessor 필요 |
| `GOOGLE_AGENTPLATFORM_API_KEY` | Secret Manager | 사용하는 경우만 |
| `GEMINI_MODEL` | 일반 env | 비밀값 아님 |
| `SESSION_TTL_SECONDS` | 일반 env | 비밀값 아님 |
| `SQLALCHEMY_ECHO` | 일반 env | prod에서는 `false` |
| `CORS_ORIGINS` | 일반 env | 프론트 운영 도메인 |
| `ENV` | 일반 env | `prod` 권장 |
| `GCP_PROJECT_ID` | 일반 env | 문서의 cloudbuild 예시와 일치 |

Cloud Run 배포 옵션 예:

```text
--set-env-vars=ENV=prod,LOG_LEVEL=info,GCP_PROJECT_ID=$PROJECT_ID
--set-secrets=DATABASE_URL=database-url:latest,GEMINI_API_KEY=gemini-api-key:latest
```

실제 secret 이름은 GCP 리소스 생성 시 확정한다.

---

## 7. 테스트 변경 계획

현재 테스트는 `backend/tests/`에 존재한다.

변경 계획:

- `/health` 엔드포인트 테스트 추가
- 운영 모드에서 필수 환경변수 검증 로직을 넣는 경우 해당 테스트 추가
- DB 관련 테스트는 기존 SQLite tmp path fixture를 유지한다.

권장 테스트:

| 테스트 | 목적 |
---|---|
| `GET /health` returns 200 | Cloud Run health 검증 |
| `GET /` remains compatible | 기존 루트 응답 유지 |
| prod env without `DATABASE_URL` fails clearly | 운영 SQLite fallback 방지 |
| env parsing for `CORS_ORIGINS` | Cloud Run env 입력 검증 |

Cloud Build에서 실행할 명령:

```bash
cd backend
pip install --no-cache-dir -r requirements.txt
pytest -q
```

---

## 8. 구현 순서

권장 구현 순서는 다음과 같다.

1. `backend/main.py`에 `/health` 추가
2. `backend/Dockerfile`의 uvicorn 포트를 `${PORT:-8080}`로 변경
3. `backend/.dockerignore` 추가
4. `backend/config.py`에 운영 필수 환경변수 검증 정책 추가
5. `/health`와 설정 검증 테스트 추가
6. 로컬 Docker 실행 검증
7. `cloudbuild.yaml` 작성
8. 수동 `gcloud builds submit` 검증
9. Cloud Build Trigger 생성
10. GitHub `main` push 자동 배포 검증

---

## 9. 로컬 검증 시나리오

코드 변경 후 Cloud Build로 가기 전에 로컬에서 다음을 확인한다.

### 9.1 테스트

```bash
cd backend
pytest -q
```

### 9.2 Docker 빌드

```bash
docker build -t local-backend-test ./backend
```

### 9.3 Cloud Run 포트 방식 실행

```bash
docker run --rm -p 8080:8080 -e PORT=8080 local-backend-test
```

### 9.4 상태 확인

```bash
curl http://localhost:8080/health
```

### 9.5 운영 환경변수 검증

운영 모드 검증 로직을 추가한 경우:

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e ENV=prod \
  local-backend-test
```

이때 `DATABASE_URL`이 없으면 명확한 에러로 실패해야 한다.

---

## 10. 완료 기준

코드 변경은 다음 조건을 만족하면 완료로 본다.

- [ ] `backend/main.py`에 `/health`가 있다.
- [ ] `backend/Dockerfile`이 `$PORT`를 사용한다.
- [ ] `backend/.dockerignore`가 secret, SQLite DB, 캐시 파일을 제외한다.
- [ ] 운영 환경에서 SQLite fallback이 발생하지 않는다.
- [ ] Secret으로 분리할 환경변수 목록이 확정되어 있다.
- [ ] `backend/tests/`가 통과한다.
- [ ] 로컬 Docker 컨테이너가 `PORT=8080`으로 정상 실행된다.
- [ ] `/health`가 로컬 컨테이너에서 정상 응답한다.
- [ ] `cloudbuild.yaml` 작성 시 `backend/` 경로 구조가 반영된다.

---

## 11. 이번 문서에서 의도적으로 제외한 것

다음 항목은 코드 변경 계획의 범위를 넘어서므로 별도 문서 또는 다음 단계에서 다룬다.

- 실제 `cloudbuild.yaml` 작성
- GCP Artifact Registry 생성
- IAM 권한 설정
- Cloud Build Trigger 생성
- Cloud SQL 인스턴스 생성
- Firestore 전환
- 프론트엔드 운영 배포 방식 확정
- Terraform/IaC 적용

---

## 12. 다음 의사결정 필요 항목

구현 전에 사용자가 결정해야 하는 항목은 다음과 같다.

1. 1차 Cloud Run 대상은 백엔드만인지, 프론트까지 포함할지
2. 운영 DB를 Cloud SQL PostgreSQL로 둘지, 다른 DB를 사용할지
3. Cloud Run 서비스를 공개 API로 둘지, 인증된 호출만 허용할지
4. 운영 프론트 도메인과 `CORS_ORIGINS` 값
5. Secret Manager에 등록할 secret 이름

권장 결정:

- 1차는 백엔드만 Cloud Run으로 전환한다.
- DB는 기존 SQLAlchemy/PostgreSQL 구조를 살려 Cloud SQL PostgreSQL을 사용한다.
- 프론트 도메인이 확정되기 전까지 CORS는 최소 허용값으로 둔다.
- API Key와 DB URL은 Secret Manager로 주입한다.
