/**
 * 소유권 확인. `editPost` 를 부르기 전에 **반드시** 통과시킨다.
 *
 * 이유가 되는 서버 쪽 동작은 벨로그에 비공개로 보고했고 처리 중이라 여기 적지 않는다.
 * 우리 입장에서 필요한 사실만 적으면, 모델이 검색으로 얻은 남의 글 id 를 실수로
 * 넘기는 것만으로 사고가 날 수 있으므로 그 경로를 우리가 먼저 막는다.
 *
 * 이 파일이 따로 있는 이유: drafts.ts 와 publish.ts 가 둘 다 editPost 를 부른다.
 * 한쪽에만 넣으면 반드시 다른 쪽이 빠진다. 실제로 그렇게 빠져 있었다.
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
 * 시리즈 쪽도 우리가 먼저 확인한다:
 *
 *   // apps/server/src/services/PostApiService/index.mts (edit 경로)
 * 시리즈 쪽도 같은 이유로 우리가 먼저 확인한다. `velog_list_series` 로 남의 공개
 * 시리즈 id 를 얻을 수 있으므로, 글 소유권(assertOwned)만으로는 못 막는다.
 * 글은 내 것이기 때문이다.
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
