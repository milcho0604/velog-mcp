# 도구 카탈로그

14개. 벨로그 상태를 바꾸는 건 **초안 도구 2개뿐**이다.

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
| `velog_update_draft` | **필요** | **쓰기 — 초안만** (`destructive`) |

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

## 구현하지 않은 것

발행·삭제·좋아요·팔로우·댓글·프로필 변경·계정 탈퇴.
목록에서 뺀 게 아니라 **호출 코드를 쓰지 않았다.**
전체 목록과 사유는 [security.md](security.md).
