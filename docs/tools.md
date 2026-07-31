# 도구 카탈로그

기본 18개 + 프로필 수정 5개(설정 시).

```
기본 (설정 없음)         읽기 + 초안 + 비공개 발행        도구 18개
VELOG_ALLOW_PUBLIC=1    공개 발행                        (파라미터만 추가)
VELOG_ALLOW_PROFILE=1   프로필·소개글·블로그제목·SNS·사진  도구 5개 추가
```

두 스위치는 **독립**이다. 프로필만 켜도 되고 발행만 켜도 된다.

설정이 꺼져 있으면 `is_private` 파라미터가 **어느 도구에도 없다.**
→ [ADR 0004](decisions/0004-capability-model.md)

| 도구 | 인증 | 성격 |
| --- | --- | --- |
| `velog_get_post` | — | 읽기 |
| `velog_list_posts` | — | 읽기 |
| `velog_search_posts` | — | 읽기 |
| `velog_trending_posts` | — | 읽기 |
| `velog_recent_posts` | — | 읽기 |
| `velog_get_user` | — | 읽기 |
| `velog_list_series` | — | 읽기 |
| `velog_user_tags` | — | 읽기 |
| `velog_blog_stats` | — | 읽기(집계) |
| `velog_export_posts` | — | 읽기 + 로컬 파일 쓰기 |
| `velog_whoami` | **필요** | 읽기 |
| `velog_list_drafts` | **필요** | 읽기 |
| `velog_create_draft` | **필요** | **쓰기 — 초안만** |
| `velog_update_draft` | **필요** | **쓰기 — 초안 전체 교체** (`destructive`) |
| `velog_publish_post` | **필요** | **쓰기 — 발행** (`destructive`) |
| `velog_publish_draft` | **필요** | **쓰기 — 초안을 발행** (`destructive`) |
| `velog_unpublish_post` | **필요** | **쓰기 — 초안으로 되돌림** (`destructive`) |
| `velog_update_post` | **필요** | **쓰기 — 발행글 수정** |

`username` 을 받는 도구 중 `velog_list_drafts`·`velog_blog_stats`·
`velog_export_posts`·`velog_search_posts` 는 **생략하면 토큰의 계정**을 쓴다.

---

## 읽기

### `velog_get_post`
글 하나를 본문까지. `username` + `url_slug` 또는 `id`.

```
https://velog.io/@velopert/react-context-tutorial
                  └ username ┘ └──── url_slug ────┘
```

### `velog_list_posts`
사용자의 글 목록(최신순). `tag` 로 좁힐 수 있다.
`cursor` 에 직전 응답 마지막 글의 `id` 를 주면 다음 페이지.

> `tag` 를 주면 벨로그가 요청 `limit` 을 무시하고 **20건 단위**로 준다(실측).

### `velog_search_posts`
키워드 검색. **`username` 을 함께 주면 그 사람 글 안에서만** 찾는다 —
"내가 예전에 쓴 그 글" 을 찾는 주 경로.

> 반환 건수가 `limit` 보다 적을 수 있다. 벨로그가 조회 후 일부를 걸러낸다.
> `count` 는 필터 이전 총계이므로 다음 페이지는 `offset + limit` 로 넘긴다.

### `velog_trending_posts`
`timeframe`: `day` | `week` | `month` | `year`

> `year` 는 벨로그가 `limit>20`·`offset>1000` 이면 **에러 없이 빈 결과**를 준다.
> 넘기기 전에 깎고, 깎았다는 사실을 응답에 알린다.

### `velog_recent_posts`
벨로그 전체 최신 글.

### `velog_whoami`
현재 토큰으로 인증된 계정. 토큰이 살아있는지 점검하는 용도로도 쓴다.
다른 도구가 `username` 을 생략했을 때 여기서 얻은 계정을 쓴다(프로세스당 1회 조회 후 캐시).

### `velog_get_user`
프로필·팔로워 수·블로그 제목·소개글.

### `velog_list_series`
연재 시리즈 목록과 각 시리즈의 글 수. **`id` 를 함께 낸다** —
`velog_create_draft` 의 `series_id` 에 넣는 값이다.

### `velog_user_tags`
사용자가 쓴 태그와 글 수. "이 사람이 뭘 주로 쓰나"를 요청 한 번으로 파악한다.
`velog_blog_stats` 는 글을 전부 훑으므로 무겁다 — 가벼운 질문엔 이쪽.

---

## 파생 기능

### `velog_blog_stats`
벨로그에 없는 화면이라 직접 집계한다.

```
총 조회수 / 좋아요 / 댓글 / 글당 평균
조회수 상위 N편
연도별 분포
태그별 분포 (편수가 아니라 조회수 순)
```

`max_pages` 상한이 있다(1페이지 = 50편). 수집이 어떻게 끝났는지 **3가지로 구분**해
보고한다 — 이유에 따라 사용자가 할 일이 다르기 때문이다.

| 결과 | 뜻 | 할 일 |
| --- | --- | --- |
| `complete` | 마지막 페이지까지 봤다 | 없음 |
| `page_limit` | `max_pages` 에 걸렸다 | `max_pages` 를 올린다 |
| `cursor_stalled` | 벨로그 커서가 안 움직였다 | 불완전함을 인지한다 |

`truncated` 불린 하나로 두면 커서 고착을 "다 봤다"로 오보고하게 된다.

### `velog_export_posts`
글을 YAML 프론트매터 + 마크다운으로 로컬에 저장한다.

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

본문…
```

글마다 상세를 받아오므로 시간이 걸린다(250ms 간격). 실패한 글은 건너뛰고
끝에 몇 편이 왜 실패했는지 보고한다.

> ⚠️ 같은 이름의 기존 파일은 **덮어쓴다.** 전용 디렉터리를 쓸 것.
> `destructiveHint: true` 로 표시돼 있다.

---

## 쓰기 — 초안 전용

> **이 서버는 글을 발행할 수 없다.** `is_temp: true` 가 상수로 박혀 있고
> 도구 입력 스키마에 그 키가 없다. → [ADR 0002](decisions/0002-draft-only-write.md)

### `velog_create_draft`

> **5분에 5건까지만** 만들 수 있다. 벨로그가 최근 5분의 공개 글 10건 초과 시
> 그 시간대 글을 전부 비공개로 바꾸기 때문이다 — 초안도 계수에 포함된다.
> 막히면 이유와 해제 시각을 알려준다.

| 파라미터 | 필수 | 설명 |
| --- | --- | --- |
| `title` | ○ | 제목 |
| `body` | ○ | 본문 (마크다운) |
| `tags` | | 태그 배열. 기본 `[]` |
| `url_slug` | | 생략하면 제목에서 생성. 한글 그대로 둔다 |
| `thumbnail` | | 이미지 URL |
| `series_id` | | `velog_list_series` 에서 얻은 id. ★ 초안 생성 단계에서는 **벨로그가 무시한다** — `velog_update_draft` 를 한 번 더 불러야 실제로 붙는다 |

성공하면 편집 URL 과 함께 **"아직 발행되지 않았습니다"** 를 명시한다.

### `velog_update_draft`

`id` + 나머지는 `create_draft` 와 같다. **글 전체가 교체된다 — 부분 수정이 아니다.**

생략한 필드는 유지되지 않고 초기화된다:

| 생략하면 | 결과 |
| --- | --- |
| `tags` | 기존 태그가 **전부 삭제** |
| `url_slug` | 제목에서 새로 만들어 **주소가 바뀜** |
| `series_id` | 기존 **시리즈 연결이 끊김** |

그래서 `velog_get_post` 로 현재 값을 읽어 바꾸지 않을 필드도 그대로 다시
넘기는 편이 안전하다. `destructiveHint: true` 로 표시돼 있다.

> ⚠️ **이미 발행된 글의 `id` 를 주면 그 글이 임시저장으로 내려가 비공개가 된다.**
> `editPost` 는 상태를 덮어쓴다. 반드시 `velog_list_drafts` 로 확인한
> 초안 id 만 쓸 것.

### `velog_list_drafts`
내 임시저장 목록. 위 두 도구에 넣을 `id` 를 여기서 얻는다.

---

---

## 발행

> `VELOG_ALLOW_PUBLIC=1` 이 없으면 **비공개로만** 발행된다.
> 그 상태에서는 `is_private` 파라미터가 스키마에 존재하지 않는다.

### `velog_publish_post`
새 글을 바로 발행한다. 초안을 거치지 않는다.
파라미터는 `velog_create_draft` 와 같고, 설정이 켜져 있으면 `is_private` 이 추가된다
(기본 `true`).

### `velog_publish_draft`
기존 초안을 발행한다. **본문을 다시 넘길 필요가 없다** — 저장된 내용을 그대로 쓴다.

```
velog_publish_draft(id, is_private?)
```

이렇게 만든 이유: 호출자가 본문을 다시 넘기게 하면 그 과정에서 태그·슬러그·시리즈가
날아간다(`editPost` 는 전체 교체다). 저장본을 읽어 그대로 실어 보내는 편이 안전하다.

발행된 글의 id 를 주면 거부한다.

### `velog_unpublish_post`
발행글을 임시저장으로 되돌린다. 글은 사라지지 않고 초안 목록으로 간다.

> ⚠️ **이미 나간 RSS·구독 메일은 회수되지 않는다.** 검색엔진 캐시도 한동안 남는다.
> 되돌린다는 건 '앞으로 안 보인다'는 뜻이지 '없던 일이 된다'는 뜻이 아니다.

이미 초안이면 아무것도 하지 않고 그렇다고 알린다.

### `velog_update_post`
발행된 글을 수정한다. **생략한 필드는 기존 값을 유지한다** — 초안 도구와 반대다.

| | `velog_update_draft` | `velog_update_post` |
| --- | --- | --- |
| 생략한 `tags` | 전부 삭제 | 유지 |
| 생략한 `url_slug` | 새로 생성 (주소 바뀜) | 유지 |
| 생략한 `series_id` | 연결 끊김 | 유지 |
| 생략한 `is_private` | — | **기존 공개 범위 유지** |

마지막 줄이 중요하다. 여기에 `default(true)` 를 걸어뒀다가 *공개글을 수정만 해도
비공개로 내려가는* 버그를 냈다. '만들 때'는 안전한 쪽이 기본이고, '고칠 때'는
**건드리지 않는 것**이 기본이다.

> 기본 설정(공개 발행 꺼짐)에서 공개 글을 수정하면 비공개로 내려간다.
> 공개 권한이 없는데 공개 상태를 유지시키면 그게 곧 공개 발행 권한이 되기 때문이다.
> 공개 글을 다루려면 `VELOG_ALLOW_PUBLIC=1` 을 켤 것.

---

## 프로필 수정 (`VELOG_ALLOW_PROFILE=1`)

꺼져 있으면 **도구가 등록조차 되지 않는다** — 목록에 없으니 부를 수도 없다.

| 도구 | 바꾸는 것 |
| --- | --- |
| `velog_update_profile` | 표시 이름 · 한줄 소개 |
| `velog_update_about` | "소개" 탭의 긴 글 (전체 교체) |
| `velog_update_blog_title` | 블로그 제목 |
| `velog_update_social_links` | github · twitter · facebook · url · email |
| `velog_update_profile_image` | 프로필 사진 (http(s) URL) |

**왜 게이트가 있나** — 위험해서가 아니다. 전부 되돌릴 수 있고 본인 계정에만 영향이며
RSS·메일로 나가지도 않는다. 이유는 **혼동**이다: 프로필의 `short_bio` 와 글의
`short_description` 은 이름이 비슷하다. "소개 좀 고쳐줘" 가 어느 쪽인지 모호할 때,
스위치가 꺼져 있으면 모델이 프로필을 건드릴 수 없어 잘못 짚어도 사고가 안 난다.

> `velog_update_profile` 은 **생략한 항목을 유지**한다. 벨로그의
> `UpdateProfileInput` 은 `display_name` 과 `short_bio` 를 둘 다 필수로 받아서,
> 한쪽만 보내면 다른 쪽이 빈 문자열로 덮인다. 그래서 현재 값을 읽어 채워 보낸다.
> 실측 확인: 한줄소개만 바꿔도 이름이 그대로 남는다.

`velog_update_about` 은 **전체 교체**다. 덧붙이려면 `velog_get_user` 로 먼저 읽어
합친 뒤 넘겨야 한다.

---

## 구현하지 않은 것

좋아요·팔로우·댓글·계정 탈퇴·로그아웃·메일 발송·이메일 변경·알림 조작.
목록에서 뺀 게 아니라 **호출 코드를 쓰지 않았다.** 어떤 설정으로도 안 열린다.

글 삭제는 애초에 불가능하다 — v3 mutation 목록에 `deletePost` 가 없다.

전체 목록과 사유는 [security.md](security.md).
