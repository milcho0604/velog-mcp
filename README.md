# velog-mcp

Velog 를 Claude 같은 MCP 클라이언트에서 다루기 위한 서버.

**설계 원칙 한 줄**: 읽기는 넓게, 쓰기는 **초안까지만**.

```
읽기   글·검색·트렌딩·사용자·시리즈·태그·통계·백업   → 도구 10개
쓰기   초안 작성 / 초안 수정 / 초안 목록            → 도구 3개, is_temp=true 고정
발행   ✗ 코드에 경로 자체가 없음
삭제   ✗ 코드에 경로 자체가 없음
계정   ✗ 탈퇴·프로필·이메일 변경 전부 미구현
```

발행 버튼은 사람이 누른다. 이 서버는 초안을 만들어 놓을 뿐이다.

이 서버가 저지를 수 있는 최악의 일은 **비공개 임시저장 글이 몇 개 생기는 것**이다.
사용자가 벨로그에서 지우면 원복된다.

단, 이건 방어를 넣고 나서야 사실이 됐다. 벨로그는 최근 5분의 공개 글이 10건을
넘으면 **그 시간대 글을 전부 비공개로 바꾸는데**, 초안도 이 계수에 들어간다.
그래서 쓰기는 재시도하지 않고, 초안 생성에 5분 5건 자체 상한을 둔다.
경위는 [docs/security.md](docs/security.md) 에 적어뒀다.

## 할 수 있는 일

```
"이번 기여 건으로 벨로그 초안 잡아줘"        → 마크다운 작성 후 임시저장
"작년에 쓴 HTTP/2 글 어디였지"               → 내 글 안에서 검색
"내 글 조회수 상위 10개랑 태그별 분포"       → 집계 리포트
"내 글 전부 마크다운으로 내려받아"           → 프론트매터 붙여 로컬 백업
"어제 잡아둔 초안 이어서 마무리하자"         → 초안 목록 → 수정
```

## 왜 또 만들었나

기존 구현이 둘 있으나 (`velog-mcp`, `velog-mcp-claude`) 셋 다 다른 문제가 있었다.
자세한 비교는 [docs/decisions/0001-why-build-our-own.md](docs/decisions/0001-why-build-our-own.md).

요약하면 — 발행·삭제가 한 번에 되고, macOS 키체인에서 Chrome 암호키를 뽑고,
npm 배포본이 소스보다 10버전 뒤처져 있었다.

## 요구사항

- Node.js **24 이상** (내장 `fetch`, 타입 스트리핑 사용)

런타임 의존성은 두 개뿐이다 — `@modelcontextprotocol/sdk`, `zod`.
HTTP 클라이언트·테스트 러너·트랜스파일러는 전부 Node 내장을 쓴다.

## 설치

```bash
git clone https://github.com/milcho0604/velog-mcp.git
cd velog-mcp
npm install && npm run build
```

## 설정

토큰은 **환경변수로만** 받는다. 디스크에 쓰지 않고, 브라우저 쿠키 DB 도 읽지 않는다.

```json
{
  "mcpServers": {
    "velog": {
      "command": "node",
      "args": ["/절대경로/velog-mcp/dist/index.js"],
      "env": {
        "VELOG_ACCESS_TOKEN": "…",
        "VELOG_REFRESH_TOKEN": "…"
      }
    }
  }
}
```

토큰 없이 실행하면 **읽기 전용**으로 동작한다. 공개 글 조회·검색·트렌딩은 인증이 필요 없다.

토큰 위치: velog.io 로그인 → `F12` → Application → Cookies

**`VELOG_REFRESH_TOKEN` 하나만 넣어도 된다.** 벨로그 서버가 `access_token` 을
알아서 재발급하고(`authPlugin.mts` 확인), 이 서버는 응답의 `Set-Cookie` 로 오는
새 토큰을 메모리에 반영한다. 그래서 한 번 넣으면 **30일간** 쓸 수 있다.
`access_token` 은 1시간짜리라 단독으로 넣으면 그만큼만 간다.

갱신된 토큰도 디스크에는 쓰지 않는다 — 프로세스가 살아 있는 동안만 존재한다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 기획서 — 목표·비목표·성공 기준 |
| [docs/architecture.md](docs/architecture.md) | 구조와 데이터 흐름 |
| [docs/api-reference.md](docs/api-reference.md) | 벨로그 GraphQL 스키마 실측 기록 |
| [docs/security.md](docs/security.md) | 토큰 취급, 의도적으로 뺀 mutation 목록 |
| [docs/tools.md](docs/tools.md) | 도구 카탈로그 |
| [docs/decisions/](docs/decisions/) | 설계 결정 기록 (ADR) |

## 라이선스

MIT
