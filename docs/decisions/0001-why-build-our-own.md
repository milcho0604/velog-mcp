# ADR 0001 — 기존 패키지를 포크하지 않고 직접 만든다

- 날짜: 2026-07-30
- 상태: 채택

## 맥락

Velog MCP 구현이 이미 둘 있다. 처음 검토한 선택지는 세 가지였다.

1. `velog-mcp` (stoneHee99) 를 npm 에서 그대로 설치
2. `velog-mcp-claude` (seongwon030) 를 포크해서 위험한 도구를 제거
3. 직접 만든다

## 조사한 사실 (2026-07-30 실측)

### 라이선스

둘 다 MIT, LICENSE 파일 실물 확인. 포크·수정·재배포에 법적 장애 없음.
의무는 저작권 고지 유지 하나뿐.

### stoneHee99/velog-mcp

- 소스 3파일 26KB. 감사하기 쉬운 크기
- 의존성 2개 (MCP SDK, zod)
- 외부 접속 URL 을 전수 확인한 결과 벨로그 도메인 외에는 없음 — 토큰 유출 코드 없음
- **다만** `security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"`
  로 Chrome 마스터 암호키를 가져와 쿠키 DB 를 복호화한다.
  SQL 은 `WHERE host_key='.velog.io' AND (name='access_token' OR name='refresh_token')`
  으로 정확히 한정돼 있어 **현재 코드는 결백**하다. 문제는 그 키를 다루는 코드가
  상주한다는 구조 자체다
- `write_post` 가 곧바로 발행. `delete_post` 존재

### seongwon030/velog_mcp

- 모듈화 양호, 테스트 있음, `createDraft`/`publishPost` 분리 (설계 좋음)
- 기능 풍부 (시리즈·태그·이미지·github-import)
- 키체인 미접근 — 토큰 붙여넣기 방식
- **npm 배포본이 소스보다 낡음**: npm `velog-mcp-claude` 0.10.0 (2026-04-22) vs
  GitHub `package.json` 0.20.0 (2026-04-28). 소스의 스코프명
  `@seongwon030/velog-mcp-claude` 는 npm 에 **존재하지 않음(404)**

## 결정

**직접 만든다.**

## 근거

**포크로도 해결이 안 되는 문제가 있었다.** 위험한 도구를 지우는 건 포크로 되지만,
그건 "지웠다"는 상태일 뿐 다음 upstream 머지 때 되살아날 수 있다. 우리가 원한 건
**애초에 그 코드가 없는 상태**다. 발행 mutation 을 호출하는 줄이 레포에 한 줄도
없으면, 리뷰할 것도 없고 되살아날 것도 없다.

**직접 만들 재료가 이미 다 있었다.** 결정적이었던 건 이것이다.

```
$ curl -s -X POST https://v3.velog.io/graphql \
    -d '{"query":"{ __schema { queryType { name } } }"}'
{"data":{"__schema":{"queryType":{"name":"Query"}}}}
```

**`v3.velog.io/graphql` 은 introspection 이 열려 있다.** (`v2` 는 막혀 있다.)
즉 벨로그가 스키마 전체를 직접 알려준다. Mutation 23개, Query 24개, 각 입력
타입의 필드까지 전부. 남의 코드를 참고할 이유가 사라졌다.

이건 법적으로도 더 깨끗하다. 우리 구현의 출처는 **벨로그의 introspection 응답**
이지 다른 MIT 패키지가 아니다. (API 인터페이스 재구현 자체는 Google v. Oracle
(2021) 로 침해가 아님이 확립돼 있지만, 애초에 참조하지 않는 편이 낫다.)

**포크 대상을 골라도 유지보수 부담은 같았다.** 비공식 API 라 벨로그가 바꾸면
누가 만들었든 깨진다. 그 부담을 지는 게 전제라면, 남의 설계를 물려받는 것보다
우리 요구(초안 전용)에 맞춰 처음부터 짜는 게 총비용이 낮다. 실제 코어는
GraphQL POST 한 함수 + 도구 정의들이라 규모가 크지 않다.

## 결과

- 런타임 의존성 2개 유지 (MCP SDK, zod). fetch 와 테스트 러너와 타입 스트리핑은 Node 내장
- introspection 실측을 `docs/api-reference.md` 에 날짜와 함께 고정
- 발행·삭제·소셜·계정 mutation 은 **미구현**. `docs/security.md` 에 목록과 이유 기록

## 남는 부채

벨로그가 스키마를 바꾸면 우리가 고쳐야 한다. 이걸 감당하려고
introspection diff 스크립트를 둔다 — 깨졌을 때 "어디가" 바뀌었는지 즉시 나온다.

## 참고

- [stoneHee99/velog-mcp](https://github.com/stoneHee99/velog-mcp) (MIT)
- [seongwon030/velog_mcp](https://github.com/seongwon030/velog_mcp) (MIT)
- [Velog 이용약관](https://velog.io/policy/terms)
