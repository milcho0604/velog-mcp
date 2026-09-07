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
COPY README.md LICENSE ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
