# Velog — Claude Code 플러그인

벨로그(velog.io)를 Claude Code 안에서 읽고 쓴다. 도구 26종.

전체 문서는 저장소 루트에 있다 — [README.ko.md](../../README.ko.md) ·
[docs/tools.md](../../docs/tools.md) · [docs/security.md](../../docs/security.md)

## 설치

```bash
/plugin marketplace add milcho0604/velog-mcp
/plugin install velog@milcho-plugins
```

설치하면 값 네 개를 묻는다. **하나도 안 넣어도 설치는 되고, 읽기 전용으로 동작한다.**

| 물어보는 것 | 안 넣으면 |
| --- | --- |
| Velog refresh token | 읽기 전용 (조회·검색·통계는 그대로 된다) |
| 공개 발행 허용 | 초안과 비공개 발행까지만 |
| 프로필 수정 허용 | 프로필 관련 도구가 꺼짐 |
| 크롬 경로 | 표준 위치에서 자동으로 찾는다 |

토큰은 macOS 키체인에 들어간다. 설정 파일에 평문으로 남지 않는다.

## 필요한 것

**Node.js 24 이상.** `npx` 로 서버를 받아 실행한다.

**크롬(또는 크로미움 계열).** 그림 도구 3종에만 필요하다 —
`velog_render_diagram` · `velog_render_cover` · 그리고 그 결과를 올리는 경로.
크롬이 없으면 **기동할 때 stderr 로 알려주고**, 그 3종만 실패한다. 나머지는 다 된다.

표준 위치(`/Applications/Google Chrome.app/…` 등)는 자동으로 찾는다.
다른 데 있으면 `/plugin manage` 에서 경로를 지정한다.

## 토큰을 왜 쿠키에서 꺼내나

벨로그에 공개 쓰기 API 가 없다. 발급 절차가 있는 API 키가 존재하지 않아서
브라우저 세션 쿠키를 쓰는 방법뿐이다.

그래서 이 저장소는 토큰이 어디로 가는지를 **테스트로 묶어뒀다**:

- 토큰을 싣는 목적지가 `velog.io` / `v3.velog.io` 외에 하나라도 생기면 테스트가 깨진다 (A6)
- 토큰을 파일로 쓰는 경로가 없다 — `auth.ts` 는 `fs` 를 import 하지 않는다 (A5)
- 토큰이 오류 메시지·로그에 섞여 나가지 않게 마스킹한다

읽어볼 곳: [docs/security.md](../../docs/security.md)

## 되는 것과 안 되는 것

기본으로 **삭제 경로가 아예 없다.** 글·댓글·계정 어느 것도 지울 수 없다.

공개 발행만 따로 켜야 하는 이유는, 한 번 나가면 RSS·검색 색인·구독 메일에서
회수가 안 되기 때문이다. 되돌릴 수 없는 것 하나만 문 뒤에 두는 설계다.
