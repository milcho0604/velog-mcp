# 벨로그 GraphQL 스키마 실측 기록

- 측정: **2026-07-30**
- 방법: 엔드포인트에 introspection 질의 직접 전송 (인증 불필요)
- 출처: 벨로그 서버 응답. 타사 구현 소스를 참조하지 않았다
- **교차검증**: 벨로그 공식 오픈소스 [velog-io/velog](https://github.com/velog-io/velog)
  (⭐207, 2025-10-24) 의 `apps/server/src/graphql/Post.gql` 및
  `apps/server/src/services/PostService/index.ts` 와 대조 — 아래 표시된 항목 일치 확인

> 비공식 API 다. 벨로그가 예고 없이 바꿀 수 있다.
> 무언가 깨지면 **먼저 이 문서와 현재 스키마를 diff** 하라.

## 엔드포인트

| URL | introspection | 비고 |
| --- | --- | --- |
| `https://v3.velog.io/graphql` | **열림** | 현행. 이 프로젝트가 쓰는 곳 |
| `https://v2.velog.io/graphql` | 막힘 | `GRAPHQL_VALIDATION_FAILED` 반환 |

v2 응답 원문:
```
GraphQL introspection is not allowed by Apollo Server, but the query
contained __schema or __type.
```

재확인 명령:

```bash
curl -s -X POST https://v3.velog.io/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { queryType { name } mutationType { name } } }"}'
```

## 인증

쿠키 헤더로 전달한다. 공개 조회는 인증 없이 된다.

```
Cookie: access_token=<...>; refresh_token=<...>
```

| 토큰 | 유효기간 |
| --- | --- |
| `access_token` | 1시간 |
| `refresh_token` | 30일 |

## Mutation — 전체 23개

`*` = 이 프로젝트가 구현하는 것. 나머지는 **의도적으로 미구현** (사유는 `security.md`)

```
* writePost(input: WritePostInput)          글 작성 — is_temp:true 로만 호출
* editPost(input: EditPostInput)            글 수정 — is_temp:true 로만 호출

  likePost / unlikePost                     ✗ 소셜 행위
  follow / unfollow                         ✗ 소셜 행위
  sendMail                                  ✗ 메일 발송
  createNotification                        ✗ 알림 생성
  readNotification / readAllNotifications   ✗ 상태 변경
  removeAllNotifications                    ✗ 되돌릴 수 없음
  updateNotNoticeNotification               ✗ 상태 변경
  updateAbout / updateThumbnail             ✗ 계정 설정
  updateProfile / updateVelogTitle          ✗ 계정 설정
  updateSocialInfo / updateEmailRules       ✗ 계정 설정
  initiateChangeEmail / confirmChangeEmail  ✗ 계정 설정
  acceptIntegration                         ✗ 계정 설정
  logout                                    ✗ 세션 파괴
  unregister                                ✗✗ 계정 탈퇴. 절대 노출 금지
```

> `deletePost` 는 v3 mutation 목록에 **없다**. 삭제는 다른 경로인 듯하나
> 어차피 구현하지 않으므로 조사하지 않았다.

### WritePostInput (11필드) — ✅ 공식 소스와 일치

`velog-io/velog` 의 `apps/server/src/graphql/Post.gql` 원문과 대조했고 필드·필수여부가
전부 같다. introspection 실측이 정확했음이 확인됐다.

```
* title          String        필수
* body           String        필수 — 마크다운 본문
* tags           [String]      필수 — 빈 배열 허용. 생략하면 조용히 실패한다
* is_markdown    Boolean       필수 — true
* is_temp        Boolean       필수 — ★ true=임시저장, false=발행
* is_private     Boolean       필수
* url_slug       String        필수
* meta           JSON          필수 — 빈 객체 허용
  thumbnail      String        선택
  series_id      ID            선택
  token          String        선택
```

### EditPostInput (12필드)

`WritePostInput` 과 동일하되 맨 앞에 `id: ID!` 가 붙는다.

## Query — 전체 24개

```
읽기 (무인증 가능)
  post(input: ReadPostInput)                글 하나
  posts(input: GetPostsInput)               글 목록
  recentPosts(input: RecentPostsInput)      최신
  trendingPosts(input: TrendingPostsInput)  트렌딩
  searchPosts(input: GetSearchPostsInput)   검색
  user(input: GetUserInput)                 사용자
  series(input: GetSeriesInput)             시리즈 하나
  seriesList(input: GetSeriesListInput)     시리즈 목록
  tag(name: String)                         태그
  userTags(input: UserTagsInput)            사용자 태그
  trendingWriters(input: TrendingWritersInput)
  velogConfig(input: GetVelogConfigInput)

읽기 (인증 필요)
  currentUser()                             로그인 확인용
  isLogged()
  feedPosts(input: FeedPostsInput)          구독 피드
  readingList(input: ReadingListInput)      읽기목록
  notifications(input: NotificationsInput)
  notNoticeNotificationCount()
  followers / followings(input: GetFollowInput)

미사용
  ads / restoreToken / unregisterToken / checkEmailExists
```

### 주요 입력 타입

```
ReadPostInput          id? / username? / url_slug?
GetPostsInput          cursor? / username? / temp_only? / tag? / limit?
                       └ temp_only:true = 내 임시글 목록 (인증 필요)
GetSearchPostsInput    keyword* / offset? / limit? / username?
TrendingPostsInput     offset? / limit? / timeframe?
GetUserInput           id? / username?
```

## Post 타입 (27필드)

```
id  title  body  short_description  thumbnail
is_markdown  is_temp  is_private
url_slug  fk_user_id  original_post_id
likes  views  comments_count            ← 통계 도구가 쓰는 것
created_at  updated_at  released_at  last_read_at
meta  user  comments  tags  series
is_liked  is_followed  linked_posts  recommended_posts
```

`likes` / `views` / `comments_count` 가 Post 에 직접 붙어 있어 별도 통계 API 없이
집계할 수 있다. `velog_blog_stats` 가 이걸 쓴다.

## User 타입 (14필드)

```
id  username  email  created_at  updated_at
is_certified  is_trusted  is_followed
profile(UserProfile)  velog_config(VelogConfig)
series_list  user_meta  followers_count  followings_count
```

## 공식 소스로 확인한 서버 동작

`velog-io/velog` 를 읽어 확인한 것들. 우리 대응 코드의 근거다.

### `updated_at` 이 왜 응답 전체를 죽이나

```graphql
# apps/server/src/graphql/Post.gql
type Post {
  created_at:  Date!    # non-null
  updated_at:  Date!    # non-null  ← 여기
  released_at: Date     # nullable
}
```

**스키마는 non-null 로 선언했는데 실제 DB 에 null 인 행이 있다.** GraphQL 규약상
non-null 필드에 null 이 오면 그 필드만 비우는 게 아니라 상위 객체를, 리스트 안이면
응답 전체를 무효화한다. 그래서 글 하나 때문에 검색 결과 전부가 날아간다.
`released_at` 은 nullable 이라 안전 — 우리가 이쪽만 쓰는 이유다.

### 커서가 고착되는 조건

```ts
// apps/server/src/services/PostService/index.ts
const cursorData = cursor ? await ...findUnique({ fk_post_id: cursor }) : null
const cursorQueryOption = cursorData
  ? { released_at: { lt: cursorData.created_at }, id: { not: cursorData.id } }
  : {}                                    // ★ 못 찾으면 필터 없음
take: limit
```

**커서 id 를 서버가 못 찾으면 필터가 통째로 빠져 1페이지를 다시 준다.**
그대로 두면 같은 50편을 무한히 재수집한다. `fetchAllPosts` 가 id 중복 제거와
커서 반복 감지를 하는 이유가 이것이다 (`src/tools/stats.ts`).

또한 서버가 `limit > 100` 을 `BadRequestError` 로 막는다. 우리 도구는 50 을
상한으로 두므로 걸리지 않는다.

## 스키마 변경 감지

```bash
npm run schema:dump          # 현재 스키마를 덤프
git diff docs/api-reference.md
```

깨졌을 때 "어디가" 바뀌었는지 이 diff 로 찾는다.
