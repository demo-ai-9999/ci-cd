FROM node:22

WORKDIR /app

# package.json & package-lock.json을 복사한 후 의존성을 설치한다.
COPY package*.json ./
RUN npm install

# 소스코드 전체를 복사한다.
COPY . .

# 바이트 개발 서버를 실행한다(개발 단계용).
# --host 0.0.0.0 옵션을 주어 외부에서 접속할 수 있게 한다.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
