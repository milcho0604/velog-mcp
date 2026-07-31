/**
 * 소유권 확인. `editPost` 를 부르기 전에 **반드시** 통과시킨다.
 *
 * ★ 벨로그 서버는 edit 경로에서 소유권을 확인하지 않는다:
 *
 *   // apps/server/src/services/PostApiService/index.mts (initializePostProcess)
 *   if (type === 'write') { ... fk_user_id: signedUserId ... }    // 생성은 내 것으로
 *   if (type === 'edit')  { post = findUnique({ where: { id } }) } // ← 소유자 비교 없음
 *
 * 공개 글은 누구나 id 로 조회할 수 있으므로, 남의 글 id 를 넘기면 그 글이 수정되거나
 * 비공개로 내려간다. 상대 서버의 결함이지만 우리가 그 경로를 열어둘 이유는 없다 —
 * 모델이 검색으로 얻은 남의 글 id 를 실수로 넘기는 것만으로 사고가 난다.
 *
 * 이 파일이 따로 있는 이유: drafts.ts 와 publish.ts 가 둘 다 editPost 를 부른다.
 * 한쪽에만 넣으면 반드시 다른 쪽이 빠진다 — 실제로 그렇게 빠져 있었다.
 */

import type { VelogClient } from './client.ts';
import { resolveMyUsername } from './me.ts';

export interface OwnedPost {
	id: string;
	user?: { username?: string } | null;
}

export async function assertOwned(
	client: VelogClient,
	post: OwnedPost,
	toolName: string,
): Promise<void> {
	const owner = post.user?.username;
	const me = await resolveMyUsername(client);

	// 작성자를 못 읽었으면 통과가 아니라 중단이다. 모르면 건드리지 않는다.
	if (!owner) {
		throw new Error(
			`${toolName}: 글의 작성자를 확인할 수 없어 중단했습니다 (id=${post.id}).`,
		);
	}
	if (owner !== me) {
		throw new Error(
			`${toolName}: 이 글은 @${owner} 의 글입니다 (현재 계정 @${me}). ` +
				'남의 글은 수정할 수 없습니다.',
		);
	}
}

const QUERY_MY_SERIES = `
  query MySeries($input: GetSeriesListInput!) {
    seriesList(input: $input) { id name }
  }
`;

/**
 * ★ 시리즈 소유권. `series_id` 를 보내기 전에 반드시 통과시킨다.
 *
 * 벨로그 서버는 **처음 시리즈에 붙일 때** 소유권을 확인하지 않는다:
 *
 *   // apps/server/src/services/PostApiService/index.mts (edit 경로)
 *   if (!prevSeriesPost && series_id) {
 *     await this.seriesService.appendToSeries(series_id, post.id)   // ← 검사 없음
 *   }
 *   if (prevSeriesPost && prevSeriesPost.fk_series_id !== series_id) {
 *     if (series_id) {
 *       await this.checkSeriesOwnership(series_id, userId)          // ← 여기만 검사
 *
 * `velog_list_series` 로 남의 공개 시리즈 id 를 얻을 수 있으므로, 내 글을 남의
 * 시리즈에 붙이고 그 시리즈의 updated_at 까지 건드릴 수 있다.
 * 글 소유권(assertOwned)만으로는 못 막는다 — 글은 내 것이기 때문이다.
 */
export async function assertOwnsSeries(
	client: VelogClient,
	seriesId: string,
	toolName: string,
): Promise<void> {
	const me = await resolveMyUsername(client);
	const data = await client.request<{ seriesList: Array<{ id: string }> | null }>(
		QUERY_MY_SERIES,
		{ input: { username: me } },
	);
	const mine = data.seriesList ?? [];
	if (!mine.some((s) => s.id === seriesId)) {
		throw new Error(
			`${toolName}: series_id=${seriesId} 는 @${me} 의 시리즈가 아닙니다. ` +
				'velog_list_series 로 내 시리즈 id 를 확인하세요. ' +
				'(남의 시리즈에 글을 붙이면 그 시리즈가 변경됩니다.)',
		);
	}
}
