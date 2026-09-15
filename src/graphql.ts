/**
 * GraphQL 질의문 모음.
 *
 * 필드 선택은 docs/api-reference.md 의 실측 스키마를 따른다.
 *
 * ★ 한 요청에 쿼리를 여러 개 묶지 않는다.
 *   벨로그는 Prisma 커넥션 풀이 작아(limit 5 / timeout 10s) 묶어 보내면
 *   "Timed out fetching a new connection from the connection pool" 이 뜬다.
 *   2026-07-30 실측: searchPosts + trendingPosts 동시 요청 시 재현됨.
 */

/**
 * 목록에 쓰는 최소 필드. body 를 빼서 응답 크기를 줄인다.
 *
 * ★ `updated_at` 과 `created_at` 을 목록에서 일부러 뺐다.
 *   스키마상 non-nullable(`DateTimeISO!`)인데 **검색 경로가 이 둘을 채우지 않는다.**
 *   그래서 결과에 하나라도 걸리면 GraphQL 이 응답 전체를 거부한다:
 *     "Cannot return null for non-nullable field Post.updated_at."
 *
 *   ⚠️ 한때 "null 인 글이 섞여서" 라고 적어뒀는데 **틀렸다.** 글의 문제가 아니라
 *   경로의 문제다. 2026-09-14 실측: docker·react·nodejs·postgresql·kubernetes
 *   다섯 키워드가 **서로 다른 글**을 첫 결과로 주는데 전부 index 0 에서 터졌고,
 *   그 다섯 글을 `post` 단건으로 조회하면 **5/5 가 값이 온다.**
 *   `posts`(사용자별 목록)도 정상이다. 터지는 건 `searchPosts` 쪽이다.
 *
 *   `released_at` 은 nullable 이라 안전하다. 필드 하나를 잃는 것보다 글을 통째로
 *   못 읽는 쪽이 나쁘다. 이 판단은 drift.ts 의 자가진단 처방과 같은 규율이다.
 */
export const POST_SUMMARY_FIELDS = `
  id
  title
  url_slug
  short_description
  thumbnail
  likes
  views
  comments_count
  released_at
  is_private
  tags
  user { username profile { display_name thumbnail } }
  series { id name url_slug }
`;

/** 단건 조회 — 본문 포함. */
export const POST_DETAIL_FIELDS = `
  ${POST_SUMMARY_FIELDS}
  body
  is_markdown
  is_temp
  created_at
`;

export const QUERY_POST = `
  query GetPost($input: ReadPostInput!) {
    post(input: $input) { ${POST_DETAIL_FIELDS} }
  }
`;

export const QUERY_POSTS = `
  query GetPosts($input: GetPostsInput!) {
    posts(input: $input) { ${POST_SUMMARY_FIELDS} }
  }
`;

export const QUERY_SEARCH_POSTS = `
  query SearchPosts($input: GetSearchPostsInput!) {
    searchPosts(input: $input) {
      count
      posts { ${POST_SUMMARY_FIELDS} }
    }
  }
`;

export const QUERY_TRENDING_POSTS = `
  query TrendingPosts($input: TrendingPostsInput!) {
    trendingPosts(input: $input) { ${POST_SUMMARY_FIELDS} }
  }
`;

export const QUERY_RECENT_POSTS = `
  query RecentPosts($input: RecentPostsInput!) {
    recentPosts(input: $input) { ${POST_SUMMARY_FIELDS} }
  }
`;

export const QUERY_CURRENT_USER = `
  query CurrentUser {
    currentUser {
      id
      username
      email
      profile { display_name short_bio thumbnail }
    }
  }
`;
