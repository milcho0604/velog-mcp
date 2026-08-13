/**
 * 시리즈 힌트 — `series_id` 를 안 준 글에 "어디에 넣을 수 있는지" 알려준다.
 *
 * ★★ 벨로그 API 는 시리즈를 **만들 수 없다.** 2026-08-13 인트로스펙션으로 확인:
 *    뮤테이션 23개 중 시리즈 관련이 0개이고, `WritePostInput` 도 `series_id` 만
 *    받는다(이름으로 만들어 붙이는 입력이 없다). 조회(`seriesList`)만 열려 있다.
 *    그래서 "없으면 만든다"는 불가능하고, **"없으면 알려준다"**가 최선이다.
 *    새 시리즈는 벨로그 웹에서 한 번 만들면 그 뒤부터 이 도구가 붙일 수 있다.
 *
 * ★ 이 모듈의 실패는 **글쓰기를 막지 않는다.** 힌트를 못 만든 것뿐인데 저장이
 *   실패하면 배보다 배꼽이다. 호출부는 반드시 실패를 삼켜야 한다.
 */

import type { VelogClient } from './client.ts';

const QUERY_SERIES_LIST = `
  query SeriesListHint($input: GetSeriesListInput!) {
    seriesList(input: $input) { id name posts_count }
  }
`;

interface SeriesRow {
	id: string;
	name?: string | null;
	posts_count?: number | null;
}

/** 힌트에 보여줄 최대 개수. 시리즈가 수십 개인 사람도 있다. */
const MAX_SHOWN = 12;

/**
 * 내 시리즈 목록을 사람이 읽을 안내문으로 만든다.
 *
 * @param requested 호출자가 준 series_id. 있으면 힌트를 만들지 않는다.
 * @returns 결과 메시지에 이어붙일 문자열. 붙일 말이 없으면 빈 문자열.
 */
export async function describeSeriesOptions(
	client: VelogClient,
	username: string,
	requested: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	// 이미 지정했으면 참견하지 않는다.
	if (requested !== undefined && requested !== '') return '';

	const data = await client.request<{ seriesList: SeriesRow[] | null }>(
		QUERY_SERIES_LIST,
		{ input: { username } },
		{ signal },
	);
	const list = data.seriesList ?? [];

	if (list.length === 0) {
		return (
			'\n\n📚 시리즈에 넣지 않았습니다. 아직 만든 시리즈가 없습니다.\n' +
			'   ⚠️ 벨로그 API 로는 시리즈를 **만들 수 없습니다**(조회만 열려 있습니다). ' +
			'벨로그 웹에서 시리즈를 한 번 만들면 그 뒤부터 이 도구로 붙일 수 있습니다.'
		);
	}

	const shown = list
		.slice(0, MAX_SHOWN)
		.map((s) => `   - ${s.name ?? '(이름 없음)'} (${s.posts_count ?? 0}편) — \`${s.id}\``)
		.join('\n');
	const more = list.length > MAX_SHOWN ? `\n   … 외 ${list.length - MAX_SHOWN}개` : '';

	return (
		'\n\n📚 시리즈에 넣지 않았습니다. 넣으려면 series_id 에 아래 중 하나를 주세요.\n' +
		`${shown}${more}\n` +
		'   맞는 시리즈가 없으면 벨로그 웹에서 새로 만드세요 — API 로는 만들 수 없습니다.'
	);
}

/**
 * 힌트를 만들되 **절대 던지지 않는다.**
 *
 * ⚠️ 취소(AbortError)는 그대로 올린다. 사용자가 멈추라고 한 것을 삼키면
 *   취소가 안 먹는 것처럼 보인다.
 */
export async function seriesHintSafely(
	client: VelogClient,
	username: string,
	requested: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	try {
		return await describeSeriesOptions(client, username, requested, signal);
	} catch (error) {
		if (signal?.aborted === true) throw error;
		return '';
	}
}
