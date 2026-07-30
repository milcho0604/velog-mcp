# 보안 설계

이 서버는 **벨로그 계정 자격증명**을 다루고 **AI 모델이 호출**한다.
두 조건이 겹치므로 "무엇을 할 수 있나"보다 **"최악의 경우 무엇까지 가능한가"**
를 기준으로 설계했다.

## 능력 상한

이 서버가 저지를 수 있는 최악의 일:

> **비공개 임시저장 글이 여러 개 생긴다.**

그게 전부다. 사용자가 벨로그 임시글 목록에서 지우면 원복된다.
남에게 보인 적도, 알림이 간 적도, 검색에 걸린 적도 없다.

## 구현하지 않은 것과 이유

introspection 으로 확인한 mutation 23개 중 **21개를 의도적으로 뺐다.**
목록에서 뺀 게 아니라 **호출 코드를 안 썼다.**

| mutation | 뺀 이유 |
| --- | --- |
| `unregister` | **계정 탈퇴.** 복구 불가. 존재 자체가 위험 |
| `logout` | 세션 파괴 |
| `writePost(is_temp:false)` | 발행. RSS·검색·구독메일로 이미 나간 뒤엔 못 되돌림 |
| `likePost` `unlikePost` | 남의 알림에 내 이름이 뜬다 |
| `follow` `unfollow` | 같음 |
| `sendMail` | 메일 발송 |
| `createNotification` | 알림 생성 |
| `removeAllNotifications` | 일괄 삭제. 되돌릴 수 없음 |
| `readNotification` `readAllNotifications` `updateNotNoticeNotification` | 읽음 상태 변경 |
| `updateProfile` `updateAbout` `updateThumbnail` `updateVelogTitle` `updateSocialInfo` `updateEmailRules` | 계정 설정 변경 |
| `initiateChangeEmail` `confirmChangeEmail` | 이메일 변경 = 계정 탈취 경로 |
| `acceptIntegration` | 외부 연동 승인 |

남긴 둘:

| mutation | 제한 |
| --- | --- |
| `writePost` | `is_temp: true` **상수**. 파라미터로 노출하지 않음 |
| `editPost` | 같음 |

## `is_temp` 를 상수로 박는 이유

발행과 임시저장은 별도 mutation 이 아니다. **같은 mutation 의 불린 하나**로 갈린다.

```
writePost(input: { ..., is_temp: true  })   → 임시저장 (남에게 안 보임)
writePost(input: { ..., is_temp: false })   → 발행     (되돌릴 수 없음)
```

그래서 "발행 도구를 안 만든다"로는 부족하다. `is_temp` 를 파라미터로 받는 순간
모델이 `false` 를 넣을 수 있다. **값을 상수로 박아야** 호출 경로가 발행에
도달할 수 없다.

```ts
const DRAFT_ONLY = { is_temp: true } as const;
// 도구 입력 스키마에 is_temp 키가 없다 — 받지 않으므로 덮어쓸 수 없다
```

이건 정책이 아니라 구조다. 프롬프트로 "발행하지 마세요"라고 말하는 것과
호출 경로가 존재하지 않는 것은 다르다. → [ADR 0002](decisions/0002-draft-only-write.md)

## 토큰 취급

| 규칙 | 이유 |
| --- | --- |
| 환경변수로만 받는다 | 프로세스 수명만큼만 존재 |
| **디스크에 쓰지 않는다** | 30일 자격증명이 파일로 남으면 백업·동기화·스캔 범위에 계속 노출 |
| **브라우저 쿠키 DB 를 읽지 않는다** | Chrome 마스터 키 접근이라는 능력 상한을 붙이지 않기 위해 |
| **macOS 키체인을 건드리지 않는다** | 같음 |
| 로그·에러에 싣지 않는다 | GraphQL 에러를 그대로 던지면 Cookie 헤더가 섞일 수 있어 마스킹 |
| 없으면 읽기 전용으로 기동 | 토큰 없음은 에러가 아니라 상태 |
| 갱신 토큰도 메모리에만 | 서버가 Set-Cookie 로 주는 새 토큰을 받되 디스크엔 안 쓴다 |
| 갱신 **전** 토큰도 계속 마스킹 | 옛 토큰이 나중에 로그로 새면 갱신한 의미가 없다 |

→ [ADR 0003](decisions/0003-token-env-only.md)

## 네트워크

접속하는 호스트는 **벨로그 하나뿐**이다.

```
https://v3.velog.io/graphql
```

텔레메트리·분석·업데이트 확인 등 다른 호스트로 나가는 요청이 없다.
런타임 의존성이 2개(`@modelcontextprotocol/sdk`, `zod`)뿐인 것도 이 보장을
검증 가능한 크기로 유지하기 위해서다.

## 검증

| # | 항목 | 방법 |
| --- | --- | --- |
| A1 | 발행 경로 0곳 | `is_temp: false` 를 만드는 코드 없음 + 테스트 고정 |
| A2 | 위험 mutation 미구현 | 도구 목록 스냅샷 테스트 |
| A3 | 토큰이 디스크·로그에 안 남음 | 파일 쓰기 없음 + 에러 마스킹 테스트 |
| A5 | 런타임 의존성 ≤ 2 | `package.json` 검사 |

## 사용자가 직접 확인하는 법

```bash
# 발행 경로가 정말 없는지
grep -rn "is_temp" src/

# 벨로그 외 호스트로 나가는 요청이 있는지
grep -rnE "https?://" src/ | grep -v velog.io

# 파일을 쓰는 코드가 있는지
grep -rnE "writeFile|appendFile|createWriteStream" src/
```

마지막 항목은 `velog_export_posts`(글 백업)만 걸려야 한다.
그건 사용자가 명시한 경로에 **글 본문**을 쓰는 것이지 토큰이 아니다.
