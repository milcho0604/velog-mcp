# 도구 카탈로그

13개. 쓰기는 3개뿐이고 그중 둘은 초안 전용이다.

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
| `velog_list_drafts` | **필요** | 읽기 |
| `velog_create_draft` | **필요** | **쓰기 — 초안만** |
| `velog_update_draft` | **필요** | **쓰기 — 초안만** |

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

### `velog_search_posts`
키워드 검색. **`username` 을 함께 주면 그 사람 글 안에서만** 찾는다 —
"내가 예전에 쓴 그 글" 을 찾는 주 경로.

> 반환 건수가 `limit` 보다 적을 수 있다. 벨로그가 조회 후 일부를 걸러낸다.
> `count` 는 필터 이전 총계이므로 다음 페이지는 `offset + limit` 로 넘긴다.

### `velog_trending_posts`
`timeframe`: `day` | `week` | `month` | `year`

### `velog_recent_posts`
벨로그 전체 최신 글.

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

`max_pages` 상한이 있다(1페이지 = 50편). 걸리면 **조용히 자르지 않고**
"상한에서 잘림" 경고를 붙인다.

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

---

## 쓰기 — 초안 전용

> **이 서버는 글을 발행할 수 없다.** `is_temp: true` 가 상수로 박혀 있고
> 도구 입력 스키마에 그 키가 없다. → [ADR 0002](decisions/0002-draft-only-write.md)

### `velog_create_draft`

| 파라미터 | 필수 | 설명 |
| --- | --- | --- |
| `title` | ○ | 제목 |
| `body` | ○ | 본문 (마크다운) |
| `tags` | | 태그 배열. 기본 `[]` |
| `url_slug` | | 생략하면 제목에서 생성. 한글 그대로 둔다 |
| `thumbnail` | | 이미지 URL |
| `series_id` | | `velog_list_series` 에서 얻은 id |

성공하면 편집 URL 과 함께 **"아직 발행되지 않았습니다"** 를 명시한다.

### `velog_update_draft`

`id` + 나머지는 `create_draft` 와 같다. **본문은 부분 수정이 아니라 교체**다.

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
