/**
 * "나는 누구인가" 해석.
 *
 * 토큰이 있으면 서버가 이미 계정을 안다. 사용자가 자기 username 을 매번
 * 타이핑할 이유가 없다. 도구들이 username 을 선택 인자로 두고 생략 시 여기를 쓴다.
 *
 * 한 프로세스 안에서는 계정이 바뀌지 않으므로 한 번만 조회하고 캐시한다.
 */

import type { VelogClient } from './client.ts';
import { QUERY_CURRENT_USER } from './graphql.ts';

export interface CurrentUser {
	id?: string;
	username?: string;
	email?: string | null;
	profile?: { display_name?: string | null; short_bio?: string | null } | null;
}

const cache = new WeakMap<VelogClient, CurrentUser>();

export async function fetchCurrentUser(
	client: VelogClient,
	signal?: AbortSignal,
	/**
	 * 캐시를 건너뛰고 서버에 다시 묻는다.
	 *
	 * ★★ `velog_whoami` 는 설명에 「토큰이 살아있는지 점검하는 용도로도 쓴다」고
	 *   적어 놓고 캐시를 돌려줬다. 그러면 토큰이 만료된 뒤에 불러도 «✅ 인증됨» 이다
	 *   (실측: 추가 조회 0회). 점검이라고 해놓고 점검을 안 하는 것이라,
	 *   사용자가 제일 믿으면 안 될 때 믿게 된다.
	 *   username 을 푸는 용도(resolveMyUsername)는 계정이 안 바뀌므로 캐시 그대로 쓴다.
	 */
	options: { bypassCache?: boolean } = {},
): Promise<CurrentUser> {
	// ★ 캐시 적중도 취소를 존중한다. 여기서 빼면 '취소했는데 어떤 호출은 그냥
	//   진행되는' 비일관이 생긴다 — 취소 규약은 경로마다 달라지면 안 된다.
	signal?.throwIfAborted();
	const cached = cache.get(client);
	if (cached && options.bypassCache !== true) return cached;

	const data = await client.request<{ currentUser: CurrentUser | null }>(
		QUERY_CURRENT_USER,
		{},
		{ signal },
	);
	if (!data.currentUser) {
		throw new Error(
			'현재 로그인한 계정을 확인할 수 없습니다. 토큰이 만료됐거나 잘못됐습니다. ' +
				'(access_token 1시간 / refresh_token 30일)',
		);
	}
	cache.set(client, data.currentUser);
	return data.currentUser;
}

/** username 을 생략한 도구들이 쓴다. */
export async function resolveMyUsername(
	client: VelogClient,
	signal?: AbortSignal,
): Promise<string> {
	const me = await fetchCurrentUser(client, signal);
	if (!me.username) {
		throw new Error(
			'계정에 username 이 없습니다. 도구 인자로 username 을 직접 지정하세요.',
		);
	}
	return me.username;
}

/** 프로필을 바꾼 뒤 캐시를 비운다. 테스트에서도 쓴다. */
export function invalidateMe(client: VelogClient): void {
	cache.delete(client);
}

