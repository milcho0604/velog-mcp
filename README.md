# velog-mcp

Velog 를 Claude 같은 MCP 클라이언트에서 다루기 위한 서버.

**설계 원칙 한 줄**: 읽기는 넓게, 쓰기는 **초안까지만**.

```
읽기   글·검색·트렌딩·사용자·시리즈·태그·통계   → 전면 지원
쓰기   초안 작성 / 초안 수정                    → is_temp=true 고정
발행   ✗ 코드에 경로 자체가 없음
삭제   ✗ 코드에 경로 자체가 없음
계정   ✗ 탈퇴·프로필·이메일 변경 전부 미구현
```

발행 버튼은 사람이 누른다. 이 서버는 초안을 만들어 놓을 뿐이다.

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

토큰 위치: velog.io 로그인 → `F12` → Application → Cookies → `access_token` / `refresh_token`
(`access_token` 1시간, `refresh_token` 30일)

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
