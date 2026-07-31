# 보안 설계

이 서버는 **벨로그 계정 자격증명**을 다루고 **AI 모델이 호출**한다.
두 조건이 겹치므로 "무엇을 할 수 있나"보다 **"최악의 경우 무엇까지 가능한가"**
를 기준으로 설계했다.

## 권한 모델

```
기본 (설정 없음)        읽기 + 초안 + 비공개 발행
VELOG_ALLOW_PUBLIC=1   공개 발행
```

**스위치는 환경변수다. 모델이 못 건드린다.** MCP 설정 파일을 여는 사람만 바꿀 수
있고, 이는 토큰을 넣는 것과 같은 신뢰 경계다. → [ADR 0004](decisions/0004-capability-model.md)

구현이 이 경계를 두 겹으로 지킨다:

| 층 | 역할 |
| --- | --- |
| 스키마 | 설정이 꺼져 있으면 `is_private` 파라미터가 **아예 없다** — 요청할 방법이 없음 |
| 런타임 | 혹시 넘어와도 `resolvePrivacy` 가 `true` 로 확정 |

`1`·`true`·`yes`·`on` 만 '켬'으로 인정한다. 오타로 조용히 켜지지 않는다.

## 능력 상한

**기본 설정에서** 이 서버가 저지를 수 있는 일:

> **비공개 글이 몇 개 생긴다.** (사용자가 지우면 원복. 남에게 보인 적 없음)
>
> ⚠️ 그리고 **드물게** — 사용자가 이미 최근 5분에 공개 글을 10건 올려둔 상태라면,
> 우리가 보내는 비공개 요청 하나가 벨로그의 파괴 동작(그 시간대 글 전부 비공개화)을
> **촉발할 수 있다.** 우리 글이 계수를 올려서가 아니라, 검사가 공개 여부를 보기 전에
> 무조건 돌기 때문이다. 아래 §대응 참고.

`VELOG_ALLOW_PUBLIC=1` 을 켜면 상한이 올라간다 — 공개 발행은 RSS·검색 색인·
구독 메일로 나가므로 지워도 회수되지 않는다.
`VELOG_ALLOW_PROFILE=1` 은 프로필·소개글·블로그제목·SNS·프로필사진을 연다 —
전부 되돌릴 수 있고 배포되지 않아 상한이 크게 오르지는 않는다.

아래는 **처음엔 틀렸다가 고치고 나서야 사실이 된 것**이다.
경위를 남겨둔다 — 같은 착각을 다시 하지 않기 위해서다.

### 초안이 '발행된 글'을 비공개로 만들 수 있었다

벨로그 공식 구현(`apps/server/src/services/PostApiService/index.mts`):

```ts
private async isPostLimitReached(signedUserId) {
  const recentPostCount = await db.post.count({
    where: { fk_user_id, is_private: false,          // ← is_temp 구분 없음
             released_at: { gt: 5분전 } } })
  if (recentPostCount < 10) return false
  await db.post.updateMany({
    where: { fk_user_id, released_at: { gt: 5분전 } },   // ← is_private 필터도 없음
    data: { is_private: true } })                        // ← 최근 5분 글 전부 비공개
}
```

그리고 `schema.prisma`:

```prisma
released_at  DateTime?  @default(now())    // 초안도 생성 즉시 시각이 붙는다
```

두 사실이 겹치면 — **초안을 5분에 10개 만들면 그 시간대에 발행한 진짜 글이
비공개로 내려간다.** 초안은 되돌릴 수 있지만 이건 사용자가 글마다 공개 설정을
다시 손봐야 한다. "최악은 비공개 초안"이라는 전제가 깨진 지점이다.

**대응 — 처음엔 방어를 얹었고, 나중에 근본을 고쳤다:**

| 조치 | 이유 |
| --- | --- |
| 쓰기는 **재시도하지 않는다** (`client.mutate`) | 멱등하지 않다. 응답만 유실돼도 재시도가 글을 하나 더 만들어 한계를 앞당긴다 |
| 공개 발행 **5분 5건** 상한 (`ratelimit.ts`) | 벨로그 임계 10보다 낮게 잡는다 — 사용자가 웹에서 직접 쓴 글은 우리 카운터에 안 잡히므로 여유가 필요하다 |
| ★ **초안을 `is_private: true` 로** | 계수 대상이 `is_private:false` 뿐이라 초안이 카운터를 **올리지 않는다**. ⚠️단 검사는 공개 여부를 보기 전에 무조건 돌아, 이미 공개 글 10건이 쌓였으면 비공개 요청도 조치를 **촉발할 수 있다** — 그래서 위 두 방어를 없애지 않았다 |

세 번째가 **가장 효과가 크다.** 방어를 하나 더 얹는 것보다 애초에 위험 구간에
덜 들어가는 값을 고르는 편이 낫고, 초안은 어차피 본인만 보므로 잃는 것도 없다.

다만 **근본 해결은 아니다.** 처음엔 그렇게 적었다가 정정했다 — 우리 글이 계수를
올리지 않을 뿐, 요청 자체는 이미 쌓인 계수에 대한 조치를 촉발할 수 있다.
그래서 앞의 두 방어(무재시도·상한)를 **없애지 않고 유지한다.** 상한은 공개 발행
경로에 남아 있다.

막을 때는 이유와 해제 시각을 함께 알린다. 조용히 거절하면 사용자가 원인을 못 찾는다.

## 구현하지 않은 것과 이유

introspection 으로 확인한 mutation 23개의 처리를 셋으로 나눈다.

**(1) 기본으로 쓰는 것** — `writePost` / `editPost`.
`is_temp`·`is_private` 조합으로 초안·비공개 발행·공개 발행·발행취소를 모두 처리한다.
공개 여부만 `VELOG_ALLOW_PUBLIC` 게이트를 탄다.

**(2) 게이트로 여는 것** — `VELOG_ALLOW_PROFILE=1` 일 때만 도구로 등록한다.
`updateProfile` / `updateAbout` / `updateVelogTitle` / `updateSocialInfo` /
`updateThumbnail`. 되돌릴 수 있고 본인 계정에만 영향이며 배포되지 않는다.
게이트를 둔 이유는 위험이 아니라 혼동이다 → [ADR 0004](decisions/0004-capability-model.md)

**(3) 어떤 설정으로도 안 여는 것** — 아래. 목록에서 뺀 게 아니라 **호출 코드를 안 썼다.**

| mutation | 뺀 이유 |
| --- | --- |
| `unregister` | **계정 탈퇴.** 복구 불가. 존재 자체가 위험 |
| `logout` | 세션 파괴 |
| `likePost` `unlikePost` | 남의 알림에 내 이름이 뜬다 |
| `follow` `unfollow` | 같음 |
| `sendMail` | 메일 발송 |
| `createNotification` | 알림 생성 |
| `removeAllNotifications` | 일괄 삭제. 되돌릴 수 없음 |
| `readNotification` `readAllNotifications` `updateNotNoticeNotification` | 읽음 상태 변경 |
| `updateEmailRules` | 메일 수신 설정 |
| `initiateChangeEmail` `confirmChangeEmail` | 이메일 변경 = 계정 탈취 경로 |
| `acceptIntegration` | 외부 연동 승인 |

> `deletePost` 는 v3 mutation 목록에 **없다.** 글 삭제는 애초에 불가능하다.

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
