# 구조

## 전체 흐름

```
MCP 클라이언트 (Claude 등)
      │  stdio (JSON-RPC)
      ▼
   index.ts ─────────── createServer(client)
      │                    도구 등록만 한다. 로직 없음
      ├── tools/posts.ts      글 조회
      ├── tools/discover.ts   검색·트렌딩·최신
      ├── tools/profile.ts    사용자·시리즈·태그
      ├── tools/stats.ts      통계 (집계)
      ├── tools/export.ts     마크다운 백업 (파일 씀)
      └── tools/drafts.ts     ★ 유일한 쓰기 경로
      │
      ▼
   client.ts ─────────── VelogClient.request()
      │                    재시도 · 마스킹 · 타임아웃
      ├── auth.ts           환경변수 → 쿠키 헤더
      └── graphql.ts        질의문 (필드 선택)
      │
      ▼  HTTPS POST
   https://v3.velog.io/graphql
```

## 레이어 규칙

| 레이어 | 하는 일 | 하면 안 되는 일 |
| --- | --- | --- |
| `index.ts` | 도구 등록, stdio 연결 | 비즈니스 로직 |
| `tools/*` | 입력 검증(zod), 질의 호출, 출력 정형화 | fetch 직접 호출 |
| `client.ts` | HTTP, 재시도, 오류 변환, 마스킹 | 도구별 지식 |
| `auth.ts` | 토큰 읽기·헤더 생성·마스킹 | **파일 접근 (금지)** |
| `graphql.ts` | 질의문 상수 | 실행 |

`tools/*` 가 `fetch` 를 직접 부르면 마스킹과 재시도를 우회하게 된다.
반드시 `client.request()` 를 통한다.

## 이 레포가 쓰지 않는 TypeScript 문법

Node 는 22.18 부터 `.ts` 를 **타입 스트리핑**으로 직접 실행한다. 지우기만 하고 코드를
생성하지 않으므로, 변환이 필요한 문법은 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 로
죽는다. 실제로 겪은 것:

```ts
// ✗ 파라미터 프로퍼티 — 필드 대입 코드를 '생성'해야 하므로 불가
class E extends Error {
  constructor(readonly detail?: Detail) { super(); }
}

// ○ 명시 필드
class E extends Error {
  readonly detail: Detail | undefined;
  constructor(detail?: Detail) { super(); this.detail = detail; }
}
```

같은 이유로 **`enum`·`namespace`·데코레이터**도 쓰지 않는다.
(`const enum` 은 물론이고 일반 `enum` 도 런타임 객체를 생성해야 한다.)

대신 얻는 것: `tsx`·`ts-node`·`jest`·`babel` 이 전부 불필요하다.
테스트는 `node --test src/__tests__/*.test.ts` 로 소스에서 바로 돈다.

## 빌드

```
src/*.ts  ──tsc──▶  dist/*.js
```

소스는 `'./auth.ts'` 로 import 하고, `rewriteRelativeImportExtensions` 가
빌드 시 `'./auth.js'` 로 바꾼다. 그래서 **테스트는 빌드 없이** 돌고
**배포본은 정상 ESM** 이 된다.

## 벨로그 API 를 다룰 때 지킬 것

실측으로 확인한 상대 쪽 특성이다. 어기면 조용히 깨진다.

**1. 한 요청에 쿼리를 묶지 않는다.**
Prisma 커넥션 풀이 작다 (limit 5 / timeout 10s). `searchPosts + trendingPosts`
동시 요청에서 재현됨.

**2. `updated_at` 을 질의하지 않는다.**
스키마는 non-nullable 인데 실제 null 인 글이 있다. 하나만 섞여도 응답 전체가
거부된다 (`Cannot return null for non-nullable field Post.updated_at`).

**3. 목록 응답은 `limit` 보다 적을 수 있다.**
조회 후 일부 글이 사후 필터링된다. `count` 는 필터 이전 총계다.
페이지네이션은 반환 건수가 아니라 `offset + limit` 로 넘긴다.

**4. 5xx·커넥션풀 오류는 재시도한다. 인증 만료·4xx 는 즉시 던진다.**
`isTransient()` 가 판정한다.

**5. 순차 반복 호출에는 간격을 둔다.**
`export` 는 글마다 250ms 쉰다.

## 테스트

```
src/__tests__/auth.test.ts     토큰 취급·마스킹
src/__tests__/client.test.ts   재시도·오류 변환 (가짜 fetch 주입)
src/__tests__/slug.test.ts     슬러그 생성
src/__tests__/safety.test.ts   ★ 안전 불변식 (PRD 성공기준)
```

`safety.test.ts` 는 소스 전체를 읽어 금지 패턴 부재를 단언하고, 실제 MCP
세션(`InMemoryTransport`)을 띄워 도구 목록과 입력 스키마를 검사한다.
**이 파일이 깨지면 우회하지 말고 왜 깨졌는지부터 볼 것.**

네트워크를 타는 테스트는 두지 않았다. 벨로그가 느리거나 막히면 CI 가 흔들린다.
실 API 검증은 개발 중 수동으로 한다 (`npm run schema:dump` 포함).
