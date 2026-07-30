# velog-mcp

[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-2-lightgrey)](package.json)

[벨로그](https://velog.io)를 Claude 같은 MCP 클라이언트에서 다루는 서버.
글을 읽고, 초안을 쓰고, 발행하고, 통째로 백업한다.

**[English →](README.md)**

---

## 왜 또 만들었나

벨로그 MCP 서버가 이미 둘 있다. 이 구현은 세 가지가 다르다.

**1. 발행은 기본값이 아니라 권한이다.**
설치 직후에는 초안 작성과 **비공개 발행**까지 된다. 공개 발행은 환경변수를 넣어야
열린다. 그 스위치는 모델이 못 건드린다 — MCP 설정 파일을 여는 사람만 바꿀 수 있다.

**2. 벨로그 동작을 추측하지 않고 실측했다.**
벨로그 GraphQL 은 비공식이라 문서가 없다. 이 레포는 **실제로 어떻게 동작하는지**를
[velog-io/velog](https://github.com/velog-io/velog) 소스와 실호출로 확인해
기록한다. 서버 쪽 함정 6가지가 [docs/api-reference.md](docs/api-reference.md) 에
있다 — 오류 없이 빈 결과를 주는 경우, 발행글을 비공개로 만드는 경우 포함.

**3. 런타임 의존성 2개.** `@modelcontextprotocol/sdk` 와 `zod` 뿐이다.
HTTP·테스트 러너·타입스크립트 실행은 전부 Node 24 내장을 쓴다.

---

## 설치

**Node.js 24 이상**이 필요하다.

```bash
git clone https://github.com/milcho0604/velog-mcp.git
cd velog-mcp
npm install && npm run build
```

## 설정

MCP 클라이언트 설정 파일(`claude_desktop_config.json`, `.mcp.json` 등)에 추가한다.

```json
{
  "mcpServers": {
    "velog": {
      "command": "node",
      "args": ["/절대경로/velog-mcp/dist/index.js"],
      "env": {
        "VELOG_REFRESH_TOKEN": "여기에 토큰"
      }
    }
  }
}
```

Claude Code CLI 라면:

```bash
claude mcp add velog -- node /절대경로/velog-mcp/dist/index.js
# 생성된 항목에 "env" 블록을 추가
```

### 토큰 얻는 법

벨로그는 공개 쓰기 API 가 없어서 브라우저 세션 쿠키로 인증한다.

1. [velog.io](https://velog.io) 에 로그인
2. 개발자도구(`F12`) → **Application** → **Cookies** → `https://velog.io`
3. **`refresh_token`** 값을 복사

**`VELOG_REFRESH_TOKEN` 하나만 넣으면 된다.** 벨로그 서버가 수명 짧은
`access_token` 을 알아서 재발급하고([`authPlugin.mts`](https://github.com/velog-io/velog/blob/main/apps/server/src/common/plugins/global/authPlugin.mts)),
이 서버가 응답에 실려 오는 갱신 쿠키를 받아 쓴다. 한 번 넣으면 **30일** 간다.

`VELOG_ACCESS_TOKEN` 도 받지만 단독으로는 1시간이면 만료된다.

> 토큰은 환경변수로만 읽는다. 디스크에 쓰지 않고, 브라우저 쿠키 DB 나 OS 키체인을
> 건드리지 않는다. 다만 MCP 설정 파일에 적은 값은 그 파일에 평문으로 남는다 —
> 그 파일 관리는 사용자 몫이다.

**토큰이 없어도 서버는 뜬다.** 읽기 전용으로 동작하고, 공개 글 조회·검색·트렌딩·
블로그 통계는 인증 없이 된다.

---

## 권한

| 환경변수 | 되는 것 |
| --- | --- |
| *(설정 없음)* | 전체 읽기 · 초안 작성 · **비공개 발행** |
| `VELOG_ALLOW_PUBLIC=1` | 위 전부 **+ 공개 발행** |

```json
"env": {
  "VELOG_REFRESH_TOKEN": "...",
  "VELOG_ALLOW_PUBLIC": "1"
}
```

'켬'으로 인정하는 값은 `1`, `true`, `yes`, `on` 뿐이다. 나머지는 전부 꺼짐 —
오타로 조용히 켜지지 않는다.

공개 발행이 꺼져 있으면 어떤 도구에도 `is_private` 파라미터가 **존재하지 않는다.**
모델이 공개를 요청할 방법 자체가 없다. 켜면 파라미터가 생기지만 기본값은 여전히
`true`(비공개)다.

### 왜 비공개가 기본인가

몸사리는 게 아니라 실측 근거가 있다. 벨로그의 발행 제한은 `is_private: false` 인
글만 센다:

```ts
// apps/server/src/services/PostApiService/index.mts
count({ where: { fk_user_id, is_private: false, released_at: { gt: 5분전 } } })
if (count >= 10) {
  updateMany({ where: { fk_user_id, released_at: { gt: 5분전 } },
               data: { is_private: true } })   // 최근 글을 '전부' 비공개로
}
```

비공개 글은 이 계수에 아예 안 들어가므로 이 조치를 유발할 수 없다. 공개 글은
들어간다 — 그리고 한번 공개되면 RSS·검색 색인·구독 메일로 이미 나간 뒤라 지워도
회수가 안 된다. 명시적 opt-in 을 둘 만한 비대칭은 여기에 있다.

자세한 내용: [docs/security.md](docs/security.md)

---

## 도구

18개. 벨로그 상태를 바꾸는 건 그중 6개뿐이다.

### 읽기 — 인증 불필요

| 도구 | 하는 일 |
| --- | --- |
| `velog_get_post` | 글 하나를 본문까지 |
| `velog_list_posts` | 사용자의 글 목록, 태그로 좁힐 수 있음 |
| `velog_search_posts` | 키워드 검색. `username` 을 주면 그 블로그 안에서만 |
| `velog_trending_posts` | 트렌딩 (`day`/`week`/`month`/`year`) |
| `velog_recent_posts` | 벨로그 전체 최신 글 |
| `velog_get_user` | 프로필·팔로워 수·소개 |
| `velog_list_series` | 시리즈 목록 (글 수와 id 포함) |
| `velog_user_tags` | 사용자가 쓰는 태그와 글 수 |

### 읽기 — 인증 필요

| 도구 | 하는 일 |
| --- | --- |
| `velog_whoami` | 토큰이 어느 계정인지 (토큰 생존 확인용으로도) |
| `velog_list_drafts` | 내 초안 목록과 id |

### 파생 — 벨로그에 없는 기능

| 도구 | 하는 일 |
| --- | --- |
| `velog_blog_stats` | 조회수·좋아요·댓글 집계, 상위 글, 연도별·태그별 분포 |
| `velog_export_posts` | 글을 YAML 프론트매터 붙은 마크다운으로 저장 |

### 쓰기

| 도구 | 효과 |
| --- | --- |
| `velog_create_draft` | 초안 저장. 어떤 설정에서도 발행하지 않는다 |
| `velog_update_draft` | 초안 **전체 교체** — 생략한 필드는 초기화된다 |
| `velog_publish_post` | 새 글 발행 |
| `velog_publish_draft` | 기존 초안을 발행 (저장된 본문을 그대로 씀) |
| `velog_unpublish_post` | 발행글을 초안으로 되돌림 |
| `velog_update_post` | 발행글 수정 — 생략한 필드는 **유지된다** |

> `velog_update_draft` 는 생략하면 초기화하고, `velog_update_post` 는 유지한다.
> 의도한 비대칭이고 이유는 [docs/tools.md](docs/tools.md) 에 있다.

`username` 을 받는 도구 중 `velog_list_drafts`·`velog_blog_stats`·
`velog_export_posts`·`velog_search_posts` 는 생략하면 **내 계정**을 쓴다.

---

## 사용법

설정이 끝나면 MCP 클라이언트에 그냥 말하면 된다.

```
"오늘 고친 버그로 벨로그 초안 잡아줘"
   → 마크다운을 쓰고 초안으로 저장, 편집 URL 을 준다

"작년에 HTTP/2 로 뭐 썼더라"
   → 내 글 안에서 검색

"내 글 조회수 상위 10개랑 어떤 태그가 제일 많이 읽혔는지"
   → 블로그 전체를 훑어 집계

"내 글 전부 ~/blog-backup 에 백업해"
   → 프론트매터 붙은 .md 로 저장

"그 초안 발행해줘"
   → 기본은 비공개. 공개는 VELOG_ALLOW_PUBLIC=1 이 있어야 한다
```

MCP 클라이언트가 도구 호출 전에 승인을 받고, 되돌릴 수 없는 도구에는
`destructiveHint` 가 붙어 있다. 모르는 새 발행되는 일은 없다.

### 백업 파일 형식

```yaml
---
title: "글 제목"
date: 2022-12-31T18:32:39.790Z
slug: "url-slug"
url: "https://velog.io/@username/url-slug"
tags: ["태그1", "태그2"]
likes: 260
views: 16323
---

마크다운 본문…
```

---

## 개발

```bash
npm test              # node:test 로 .ts 직접 실행 — jest·ts-node 없음
npm run typecheck
npm run build
npm run schema:dump   # 현재 벨로그 GraphQL 스키마 덤프
```

테스트 120건. `src/__tests__/safety.test.ts` 는 보안 불변식을 고정한다 —
이 파일이 깨지면 우회하지 말고 왜 깨졌는지부터 볼 것.

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 기획서 — 목표·비목표·성공 기준 |
| [docs/architecture.md](docs/architecture.md) | 구조, Node 타입 스트리핑이 허용하는 TS 부분집합 |
| [docs/api-reference.md](docs/api-reference.md) | 벨로그 GraphQL 스키마 실측 + 서버 함정 |
| [docs/security.md](docs/security.md) | 토큰 취급, 권한 모델, 의도적으로 뺀 기능 |
| [docs/tools.md](docs/tools.md) | 도구 카탈로그와 주의사항 |
| [docs/decisions/](docs/decisions/) | 설계 결정 기록 (ADR) |

## 참고

벨로그 내부 GraphQL API 를 쓴다. 비공식이라 예고 없이 바뀔 수 있다.
뭔가 깨지면 `npm run schema:dump` 를 돌려 `docs/api-reference.md` 와 diff 하는 게
가장 빠르다.

벨로그 [이용약관](https://velog.io/policy/terms)에는 자동화 접근을 제한하는 조항이
없다. 본인 토큰으로 본인 글을 다루는 것은 권한 내 행위이고, 게시물 저작권은
회원에게 귀속된다(제5조).

## 라이선스

MIT
