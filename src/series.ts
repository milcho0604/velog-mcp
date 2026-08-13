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

/** 목록을 사람이 고를 수 있게 줄로 만든다. */
function listLines(list: SeriesRow[]): string {
	const shown = list
		.slice(0, MAX_SHOWN)
		.map((s) => `   - ${s.name ?? '(이름 없음)'} (${s.posts_count ?? 0}편) — \`${s.id}\``)
		.join('\n');
	return list.length > MAX_SHOWN ? `${shown}\n   … 외 ${list.length - MAX_SHOWN}개` : shown;
}

/** 비교용 정규화 — 앞뒤 공백·대소문자·연속 공백 차이는 무시한다. */
function norm(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 시리즈 **이름**을 id 로 바꾼다. ★ 저장(mutation) **전에** 부른다.
 *
 * ★★ 왜 이름을 받나 — id 는 사람도 AI 도 모른다. 이름만 받을 수 있으면
 *   "저장하면서 시리즈에 넣기"가 **한 번의 호출로** 끝난다. 예전엔
 *   저장 → 목록 받기 → 다시 붙이기로 **세 번**이었다.
 *
 * ★ 못 찾으면 **던진다.** 이 시점엔 아직 아무것도 안 썼으므로 던지는 게 안전하고,
 *   조용히 시리즈 없이 저장하면 사용자는 들어간 줄 안다. 벨로그 API 로는 시리즈를
 *   만들 수 없으므로(뮤테이션 없음) 목록을 함께 보여주고 사람이 정하게 한다.
 */
export async function resolveSeriesId(
	client: VelogClient,
	username: string,
	seriesName: string,
	toolName: string,
	signal?: AbortSignal,
): Promise<string> {
	const data = await client.request<{ seriesList: SeriesRow[] | null }>(
		QUERY_SERIES_LIST,
		{ input: { username } },
		{ signal },
	);
	const list = data.seriesList ?? [];
	const want = norm(seriesName);
	const hit = list.filter((s) => typeof s.name === 'string' && norm(s.name) === want);

	if (hit.length === 1) {
		const id = hit[0]?.id;
		if (id) return id;
	}
	if (hit.length > 1) {
		throw new Error(
			`${toolName}: "${seriesName}" 과 이름이 같은 시리즈가 ${hit.length}개입니다. ` +
				`series_id 로 직접 지정하세요.\n${listLines(hit)}`,
		);
	}
	throw new Error(
		`${toolName}: "${seriesName}" 시리즈를 찾지 못했습니다. **글은 저장하지 않았습니다.**\n` +
			(list.length === 0
				? '   아직 만든 시리즈가 없습니다.'
				: `   있는 시리즈:\n${listLines(list)}`) +
			'\n   ⚠️ 벨로그 API 로는 시리즈를 **만들 수 없습니다**(조회만 열려 있습니다). ' +
			'벨로그 웹에서 만든 뒤 다시 시도하거나, 위 목록의 이름을 쓰세요.',
	);
}

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

	return (
		'\n\n📚 시리즈에 넣지 않았습니다. 넣으려면 **series_name** 에 아래 이름 중 하나를 주세요' +
		'(다음부터는 저장과 동시에 붙습니다).\n' +
		`${listLines(list)}\n` +
		'   맞는 시리즈가 없으면 벨로그 웹에서 새로 만드세요 — API 로는 만들 수 없습니다.'
	);
}

/**
 * 힌트를 만들되 **어떤 경우에도 던지지 않는다.**
 *
 * ★★ 이 함수는 **글이 이미 저장된 뒤에만** 불린다. 그래서 취소조차 삼킨다.
 *   여기서 던지면 저장이 끝난 호출이 '실패'로 보고되고, 사용자는 안 써진 줄 알고
 *   다시 부른다 → **글이 두 번 생긴다.** 취소를 존중하는 것보다 중복 생성을
 *   막는 게 크다. 취소는 mutation **전·중**에 이미 걸러진다.
 *   (코덱스 교차검증에서 잡혔다: mutation 성공 후 취소 시 wrote=true 인데
 *    최종 Promise 가 rejected 였다.)
 *
 * ★ username 을 **함수로 받는 이유** — 예전엔 `resolveMyUsername()` 을 인자
 *   위치에서 await 했는데, 그러면 **이 try 밖에서** 평가되어 그 조회가 실패하면
 *   똑같이 도구 호출이 통째로 실패했다. 안에서 부른다.
 */
export async function seriesHintSafely(
	client: VelogClient,
	resolveUsername: () => string | Promise<string>,
	requested: string | undefined,
	signal?: AbortSignal,
): Promise<string> {
	try {
		const username = await resolveUsername();
		return await describeSeriesOptions(client, username, requested, signal);
	} catch {
		return '';
	}
}
