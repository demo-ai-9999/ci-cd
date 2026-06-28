# GCP 1차 CI/CD Implementation 문서

**주제:** Cloud Build Trigger + Artifact Registry + Cloud Run 자동 배포  
**대상:** 현재 Dockerfile 기반 이미지를 GHCR에 Push하고 GCE에서 배포 중인 FastAPI/백엔드 프로젝트  
**작성일:** 2026-06-26  
**권장 리전:** `asia-northeast3` 서울

---

## 1. 목표와 범위

이 문서의 목표는 기존 `Dockerfile → GHCR → GCE 배포` 흐름을 GCP 네이티브 1차 CI/CD 구조로 전환하는 것이다.

### 1차 목표

```text
GitHub main branch push
  ↓
Cloud Build Trigger 자동 실행
  ↓
테스트 실행
  ↓
Docker 이미지 빌드
  ↓
Artifact Registry에 이미지 Push
  ↓
Cloud Run에 자동 배포
```

### 이번 문서에 포함하는 것

- GCP API 활성화
- Artifact Registry Docker repository 생성
- Cloud Build용 서비스 계정 생성
- Cloud Run 런타임 서비스 계정 생성
- 최소 권한 기반 IAM 설정
- `cloudbuild.yaml` 작성
- GitHub 연동 Cloud Build Trigger 생성
- Cloud Run 자동 배포 검증
- 운영 확인, 롤백, 자주 발생하는 오류 대응

### 이번 문서에서 제외하는 것

- Firestore/NoSQL 데이터 모델링
- PostgreSQL → Firestore 마이그레이션
- Cloud Deploy 기반 dev/staging/prod 승격 배포
- Terraform 기반 IaC
- VPC, Serverless VPC Connector, 내부망 DB 연결

---

## 2. 최종 1차 아키텍처

```text
[Developer]
    |
    | git push main
    v
[GitHub Repository]
    |
    | repository event trigger
    v
[Cloud Build]
    | 1. test
    | 2. docker build
    | 3. docker push
    | 4. gcloud run deploy
    v
[Artifact Registry]
    |
    | container image
    v
[Cloud Run]
    |
    | runtime service account
    v
[Secret Manager / Future Firestore]
```

핵심 변화는 다음과 같다.

| 기존 방식 | 1차 전환 방식 |
|---|---|
| GHCR | Artifact Registry |
| GCE에서 docker compose 실행 | Cloud Run에서 컨테이너 실행 |
| 수동 pull/restart | GitHub push 기반 자동 배포 |
| 서버 관리 필요 | 서버리스 런타임 |
| `.env` 파일 중심 | Secret Manager + Cloud Run 환경변수 |

---

## 3. 사전 준비

### 3.1 필요 조건

- Google Cloud Project 생성 완료
- Billing 활성화
- GitHub repository 준비 완료
- 프로젝트 루트에 `Dockerfile` 존재
- Cloud Run에서 실행 가능한 웹 서버 구조
- 로컬 또는 Cloud Shell에서 `gcloud` 사용 가능

### 3.2 Cloud Run 컨테이너 조건

Cloud Run 서비스용 컨테이너는 반드시 다음 조건을 만족해야 한다.

- 애플리케이션은 `0.0.0.0`으로 listen 해야 한다.
- 포트는 Cloud Run이 주입하는 `$PORT` 환경변수를 사용해야 한다.
- 기본 포트는 보통 `8080`이다.
- 컨테이너 내부에 영구 저장소가 있다고 가정하면 안 된다.

FastAPI 예시 Dockerfile:

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
```

로컬 테스트:

```bash
docker build -t local-backend-test .
docker run --rm -p 8080:8080 -e PORT=8080 local-backend-test
curl http://localhost:8080/health
```

`/health` 엔드포인트가 없다면 먼저 추가하는 것을 권장한다.

FastAPI 예시:

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health_check():
    return {"status": "ok"}
```

---

## 4. 변수 정의

아래 값은 실제 프로젝트에 맞게 변경한다.

```bash
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export REGION="asia-northeast3"
export REPO_NAME="gen-ai-agent"
export SERVICE_NAME="gen-ai-agent-backend"
export IMAGE_NAME="gen-ai-agent-backend"

export BUILD_SA="cloud-build-deployer"
export RUN_SA="cloud-run-runtime"

export BUILD_SA_EMAIL="${BUILD_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
export RUN_SA_EMAIL="${RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

export PROJECT_NUMBER="$(gcloud projects describe ${PROJECT_ID} --format='value(projectNumber)')"
```

적용:

```bash
gcloud config set project ${PROJECT_ID}
```

---

## 5. GCP API 활성화

```bash
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  secretmanager.googleapis.com \
  logging.googleapis.com \
  cloudresourcemanager.googleapis.com
```

확인:

```bash
gcloud services list --enabled \
  --filter="name:(cloudbuild.googleapis.com OR run.googleapis.com OR artifactregistry.googleapis.com)"
```

---

## 6. Artifact Registry 생성

Docker 이미지를 저장할 Artifact Registry repository를 생성한다.

```bash
gcloud artifacts repositories create ${REPO_NAME} \
  --repository-format=docker \
  --location=${REGION} \
  --description="Docker repository for ${SERVICE_NAME}"
```

이미지 주소 형식:

```text
${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${IMAGE_NAME}:TAG
```

예시:

```text
asia-northeast3-docker.pkg.dev/my-project/gen-ai-agent/gen-ai-agent-backend:abc1234
```

생성 확인:

```bash
gcloud artifacts repositories list --location=${REGION}
```

---

## 7. 서비스 계정 생성

서비스 계정은 2개로 분리하는 것을 권장한다.

| 서비스 계정 | 용도 |
|---|---|
| `cloud-build-deployer` | Cloud Build에서 이미지 빌드, push, Cloud Run 배포 수행 |
| `cloud-run-runtime` | Cloud Run 컨테이너가 실행될 때 사용하는 런타임 권한 |

### 7.1 Cloud Build 배포용 서비스 계정 생성

```bash
gcloud iam service-accounts create ${BUILD_SA} \
  --display-name="Cloud Build Deployer"
```

### 7.2 Cloud Run 런타임 서비스 계정 생성

```bash
gcloud iam service-accounts create ${RUN_SA} \
  --display-name="Cloud Run Runtime"
```

확인:

```bash
gcloud iam service-accounts list \
  --filter="email:(${BUILD_SA_EMAIL} OR ${RUN_SA_EMAIL})"
```

---

## 8. IAM 권한 설정

### 8.1 Cloud Build 서비스 계정 권한

Cloud Build가 해야 하는 일은 다음과 같다.

- Docker 이미지 빌드 로그 기록
- Artifact Registry에 이미지 push
- Cloud Run 서비스 생성 또는 revision 업데이트
- Cloud Run 런타임 서비스 계정을 배포 시 연결

권한 부여:

```bash
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/cloudbuild.builds.builder"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/artifactregistry.writer"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/logging.logWriter"
```

Cloud Build가 Cloud Run 런타임 서비스 계정을 사용할 수 있도록 `iam.serviceAccounts.actAs` 권한을 부여한다.

```bash
gcloud iam service-accounts add-iam-policy-binding ${RUN_SA_EMAIL} \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser"
```

### 8.2 Cloud Run 서비스 에이전트의 Artifact Registry 접근

일반적으로 같은 프로젝트 안에서 Cloud Run과 Artifact Registry를 사용하면 자동으로 처리되는 경우가 많다. 다만 이미지 pull 권한 오류가 발생하면 아래 권한을 추가한다.

```bash
gcloud artifacts repositories add-iam-policy-binding ${REPO_NAME} \
  --location=${REGION} \
  --member="serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

---

## 9. Secret Manager 선택 적용

API Key, JWT Secret, 외부 서비스 Credential은 `.env` 파일로 이미지에 포함하지 않는다. Secret Manager에 저장하고 Cloud Run 배포 시 환경변수로 주입한다.

예시: Gemini API Key 저장

```bash
echo -n "YOUR_SECRET_VALUE" | gcloud secrets create gemini-api-key --data-file=-
```

Cloud Run 런타임 서비스 계정에 Secret 접근 권한 부여:

```bash
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:${RUN_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

Cloud Run 배포 시에는 다음 옵션을 사용한다.

```bash
--set-secrets=GEMINI_API_KEY=gemini-api-key:latest
```

Secret이 아직 없다면 `cloudbuild.yaml`에서 `--set-secrets` 줄을 임시로 제거하고 먼저 배포해도 된다.

---

## 10. cloudbuild.yaml 작성

프로젝트 루트에 `cloudbuild.yaml` 파일을 생성한다.

```yaml
substitutions:
  _REGION: asia-northeast3
  _REPO_NAME: gen-ai-agent
  _SERVICE_NAME: gen-ai-agent-backend
  _IMAGE_NAME: gen-ai-agent-backend
  _RUN_SA_EMAIL: cloud-run-runtime@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com

steps:
  # 1. Python 의존성 설치 및 테스트
  - id: test
    name: python:3.12-slim
    entrypoint: bash
    args:
      - -c
      - |
        set -e
        if [ -f requirements.txt ]; then
          pip install --no-cache-dir -r requirements.txt
        fi
        if [ -d tests ]; then
          pip install pytest
          pytest -q
        else
          echo "No tests directory found. Skip pytest."
        fi

  # 2. Docker 이미지 빌드
  - id: docker-build
    name: gcr.io/cloud-builders/docker
    args:
      - build
      - -t
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:$SHORT_SHA
      - -t
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:latest
      - .

  # 3. Artifact Registry에 이미지 Push
  - id: docker-push-sha
    name: gcr.io/cloud-builders/docker
    args:
      - push
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:$SHORT_SHA

  - id: docker-push-latest
    name: gcr.io/cloud-builders/docker
    args:
      - push
      - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:latest

  # 4. Cloud Run 배포
  - id: deploy-cloud-run
    name: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
    entrypoint: gcloud
    args:
      - run
      - deploy
      - ${_SERVICE_NAME}
      - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:$SHORT_SHA
      - --region=${_REGION}
      - --platform=managed
      - --service-account=${_RUN_SA_EMAIL}
      - --allow-unauthenticated
      - --memory=1Gi
      - --cpu=1
      - --min-instances=0
      - --max-instances=5
      - --set-env-vars=ENV=prod,LOG_LEVEL=info,GCP_PROJECT_ID=$PROJECT_ID
      # Secret Manager 사용 시 아래 주석을 해제한다.
      # - --set-secrets=GEMINI_API_KEY=gemini-api-key:latest

images:
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:$SHORT_SHA
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO_NAME}/${_IMAGE_NAME}:latest

options:
  logging: CLOUD_LOGGING_ONLY
```

수정해야 하는 값:

```yaml
_RUN_SA_EMAIL: cloud-run-runtime@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com
```

공개 API가 아니라면 다음 옵션을 변경한다.

```yaml
--allow-unauthenticated
```

비공개 서비스로 배포하려면 다음처럼 바꾼다.

```yaml
--no-allow-unauthenticated
```

---

## 11. 수동 빌드 테스트

Trigger를 만들기 전에 먼저 수동으로 Cloud Build가 성공하는지 확인한다.

```bash
gcloud builds submit \
  --config=cloudbuild.yaml \
  --service-account=${BUILD_SA_EMAIL} \
  --substitutions=_RUN_SA_EMAIL=${RUN_SA_EMAIL},_REGION=${REGION},_REPO_NAME=${REPO_NAME},_SERVICE_NAME=${SERVICE_NAME},_IMAGE_NAME=${IMAGE_NAME}
```

빌드 로그 확인:

```bash
gcloud builds list --limit=5
```

Cloud Run 서비스 URL 확인:

```bash
gcloud run services describe ${SERVICE_NAME} \
  --region=${REGION} \
  --format="value(status.url)"
```

서비스 호출 테스트:

```bash
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
  --region=${REGION} \
  --format="value(status.url)")

curl ${SERVICE_URL}/health
```

---

## 12. Cloud Build Trigger 생성

### 12.1 Console 방식 권장

1. Google Cloud Console 접속
2. Cloud Build → Triggers 이동
3. Create trigger 클릭
4. Repository event 선택
5. GitHub repository 연결
6. Event: `Push to a branch`
7. Branch: `^main$`
8. Configuration: `Cloud Build configuration file`
9. Location: `Repository`
10. Cloud Build configuration file location: `cloudbuild.yaml`
11. Service account: `cloud-build-deployer@PROJECT_ID.iam.gserviceaccount.com`
12. Create 클릭

이후 `main` branch에 push하면 자동으로 빌드와 배포가 실행된다.

### 12.2 gcloud 방식

GitHub repository가 Cloud Build와 이미 연결되어 있다면 아래 명령을 사용할 수 있다.

```bash
export GITHUB_OWNER="YOUR_GITHUB_OWNER"
export GITHUB_REPO="YOUR_GITHUB_REPO"

gcloud builds triggers create github \
  --name="deploy-${SERVICE_NAME}-main" \
  --repo-owner=${GITHUB_OWNER} \
  --repo-name=${GITHUB_REPO} \
  --branch-pattern="^main$" \
  --build-config="cloudbuild.yaml" \
  --service-account=${BUILD_SA_EMAIL}
```

조직 정책이나 Cloud Build 연결 방식에 따라 Console에서 GitHub App 또는 Developer Connect 연결을 먼저 요구할 수 있다. 이 경우 Console 방식으로 repository 연결을 먼저 완료한다.

---

## 13. 배포 검증 절차

### 13.1 GitHub push

```bash
git add Dockerfile cloudbuild.yaml .
git commit -m "Add Cloud Build to Cloud Run deployment"
git push origin main
```

### 13.2 Cloud Build 확인

```bash
gcloud builds list --limit=5
```

특정 빌드 상세 확인:

```bash
gcloud builds describe BUILD_ID
```

### 13.3 Artifact Registry 이미지 확인

```bash
gcloud artifacts docker images list \
  ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}
```

### 13.4 Cloud Run revision 확인

```bash
gcloud run revisions list \
  --service=${SERVICE_NAME} \
  --region=${REGION}
```

### 13.5 서비스 응답 확인

```bash
SERVICE_URL=$(gcloud run services describe ${SERVICE_NAME} \
  --region=${REGION} \
  --format="value(status.url)")

curl ${SERVICE_URL}/health
```

정상 응답 예시:

```json
{"status":"ok"}
```

---

## 14. 운영 기준 설정

### 14.1 Cloud Run 리소스 기준

초기값은 다음 정도로 시작한다.

| 항목 | 권장 초기값 | 설명 |
|---|---:|---|
| CPU | 1 | 일반 API 서버 기준 |
| Memory | 1Gi | LLM API 호출/데이터 처리 여유 |
| Min instances | 0 | 비용 절감 우선 |
| Max instances | 5 | 과금 폭주 방지 |
| Concurrency | 기본값 유지 또는 20~80 | 응답시간 보고 조정 |
| Timeout | 기본값 또는 300s | 외부 API 호출이 길면 조정 |

### 14.2 비용 관리

초기 운영에서는 반드시 예산 알림을 설정한다.

권장 예산 알림:

- 월 10,000원 또는 20,000원 수준의 테스트 예산
- 50%, 90%, 100% 알림
- Cloud Run max instances 제한
- 불필요한 min instances 0 유지

### 14.3 로그 확인

Cloud Run 로그:

```bash
gcloud run services logs read ${SERVICE_NAME} \
  --region=${REGION} \
  --limit=100
```

Cloud Build 로그:

```bash
gcloud builds log BUILD_ID
```

---

## 15. 롤백 절차

Cloud Run은 배포할 때마다 revision을 만든다. 문제가 생기면 이전 revision으로 traffic을 돌릴 수 있다.

revision 목록 확인:

```bash
gcloud run revisions list \
  --service=${SERVICE_NAME} \
  --region=${REGION}
```

이전 revision으로 100% traffic 전환:

```bash
gcloud run services update-traffic ${SERVICE_NAME} \
  --region=${REGION} \
  --to-revisions=REVISION_NAME=100
```

가장 최근 정상 revision 이름을 운영 기록에 남겨두면 장애 대응이 빠르다.

---

## 16. 자주 발생하는 오류와 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `Permission iam.serviceAccounts.actAs denied` | Cloud Build SA가 Cloud Run 런타임 SA를 사용할 권한 없음 | `roles/iam.serviceAccountUser`를 런타임 SA에 부여 |
| `Artifact Registry permission denied` | 이미지 push/pull 권한 부족 | Build SA에 `roles/artifactregistry.writer` 부여 |
| `Container failed to start and listen on PORT` | 앱이 `$PORT` 또는 `0.0.0.0`으로 listen하지 않음 | uvicorn 실행 옵션 확인 |
| Cloud Build 로그 저장 실패 | 사용자 지정 서비스 계정의 로그 권한 문제 | `options.logging: CLOUD_LOGGING_ONLY` 설정 및 `roles/logging.logWriter` 부여 |
| Secret 접근 실패 | Cloud Run runtime SA에 Secret 권한 없음 | `roles/secretmanager.secretAccessor` 부여 |
| GitHub push 후 빌드 미실행 | Trigger branch pattern 또는 repository 연결 문제 | Trigger의 branch regex와 GitHub App 연결 확인 |
| 배포는 성공했지만 500 응답 | 애플리케이션 런타임 오류 | Cloud Run logs에서 traceback 확인 |

---

## 17. 보안 체크리스트

- [ ] Docker image에 `.env`를 포함하지 않는다.
- [ ] `.dockerignore`에 `.env`, `.git`, `__pycache__`, `.venv`를 포함한다.
- [ ] Cloud Build와 Cloud Run 서비스 계정을 분리한다.
- [ ] Cloud Build SA에는 배포에 필요한 권한만 부여한다.
- [ ] Cloud Run runtime SA에는 런타임 접근 권한만 부여한다.
- [ ] 외부 공개 API가 아니면 `--no-allow-unauthenticated`를 사용한다.
- [ ] Secret Manager 사용 시 runtime SA에만 secretAccessor 권한을 준다.
- [ ] Cloud Run max instances를 설정해 과금 폭주를 방지한다.
- [ ] Artifact Registry cleanup policy는 2차 운영 단계에서 설정한다.

권장 `.dockerignore`:

```text
.git
.github
.env
.env.*
.venv
venv
__pycache__
*.pyc
.pytest_cache
.mypy_cache
.DS_Store
notebooks
*.ipynb
```

---

## 18. 구현 완료 기준

다음 조건을 모두 만족하면 1차 CI/CD 구현 완료로 본다.

- [ ] Artifact Registry repository가 생성되어 있다.
- [ ] Cloud Build Trigger가 GitHub `main` push에 반응한다.
- [ ] Cloud Build에서 테스트 단계가 실행된다.
- [ ] Docker image가 `$SHORT_SHA`와 `latest` 태그로 push된다.
- [ ] Cloud Run에 새 revision이 자동 생성된다.
- [ ] Cloud Run URL의 `/health`가 정상 응답한다.
- [ ] 실패 시 이전 revision으로 rollback할 수 있다.
- [ ] Secret 값은 이미지에 포함하지 않는다.

---

## 19. 다음 단계

1차 구현 이후에는 다음 순서로 확장한다.

1. Firestore Native Mode 데이터 모델링
2. PostgreSQL 의존 코드 제거 또는 repository layer 분리
3. Secret Manager 정식 적용
4. Cloud Run custom domain 연결
5. Cloud Monitoring alert 설정
6. Cloud Deploy 기반 dev/staging/prod 승격 배포
7. Terraform으로 Artifact Registry, Cloud Run, IAM 코드화
8. 취약점 스캔 및 Artifact Registry cleanup policy 적용

---

## 20. 참고 공식 문서

- Cloud Build Trigger: https://docs.cloud.google.com/build/docs/triggers
- GitHub repository와 Cloud Build 연동: https://docs.cloud.google.com/build/docs/automating-builds/github/build-repos-from-github
- Cloud Build에서 Cloud Run 배포: https://docs.cloud.google.com/build/docs/deploying-builds/deploy-cloud-run
- Cloud Run 컨테이너 이미지 배포: https://docs.cloud.google.com/run/docs/deploying
- Cloud Run 컨테이너 런타임 계약: https://docs.cloud.google.com/run/docs/container-contract
- Artifact Registry Docker repository: https://docs.cloud.google.com/artifact-registry/docs/docker/store-docker-container-images
- Cloud Run과 Artifact Registry 연동: https://docs.cloud.google.com/artifact-registry/docs/integrate-cloud-run
- Cloud Run Secret Manager 연동: https://docs.cloud.google.com/run/docs/configuring/services/secrets
- Cloud Build 사용자 지정 서비스 계정: https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts
