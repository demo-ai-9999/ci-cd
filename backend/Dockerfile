FROM python:3.10-slim

# SCRAM 인증을 위해 libpq-dev 등을 설치한다.
RUN apt-get update && apt-get install -y gcc libpq-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# 저장소에 남아 있는 구형 개발 DB를 이미지에 포함하지 않는다.
# 컨테이너 시작 시 Alembic이 현재 모델에 맞는 SQLite 스키마를 생성한다.
RUN rm -f app.db

CMD ["sh", "-c", "alembic upgrade head && exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
