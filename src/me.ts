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

export async function fetchCurrentUser(client: VelogClient): Promise<CurrentUser> {
	const cached = cache.get(client);
	if (cached) return cached;

	const data = await client.request<{ currentUser: CurrentUser | null }>(
		QUERY_CURRENT_USER,
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
export async function resolveMyUsername(client: VelogClient): Promise<string> {
	const me = await fetchCurrentUser(client);
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

