# 빌드: devDependencies 포함해 tsc 로 dist 생성
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 실행: 런타임 의존성 2개만
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json npm-shrinkwrap.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
# ⚠️ 기준선을 빠뜨리면 이미지 안에서 velog_diagnose 가 꺼지고, 오류에 붙는 진단도
#    사라진다. dist 밖에 있는 파일이라 조용히 누락됐다(코덱스 18차).
#    npm 발행물의 `files` 와 여기가 **따로 관리된다는 점**을 잊지 말 것.
COPY schema ./schema
COPY README.md LICENSE ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
