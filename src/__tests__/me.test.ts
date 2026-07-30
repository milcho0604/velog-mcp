/**
 * username 자동 해석.
 *
 * 토큰이 있으면 서버가 이미 계정을 안다. 사용자가 자기 username 을 매번
 * 타이핑하는 마찰을 없앤다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient } from '../client.ts';
import { fetchCurrentUser, resolveMyUsername, __clearCache } from '../me.ts';

function clientReturning(currentUser: unknown, onCall?: () => void) {
	return new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async () => {
			onCall?.();
			return new Response(JSON.stringify({ data: { currentUser } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as unknown as typeof fetch,
	});
}

describe('resolveMyUsername', () => {
	test('토큰의 계정 username 을 돌려준다', async () => {
		const client = clientReturning({ id: '1', username: 'milcho0604' });
		assert.equal(await resolveMyUsername(client), 'milcho0604');
	});

	test('★ 한 번만 조회하고 캐시한다 — 도구마다 다시 물으면 낭비다', async () => {
		let calls = 0;
		const client = clientReturning({ id: '1', username: 'me' }, () => calls++);
		await resolveMyUsername(client);
		await resolveMyUsername(client);
		await fetchCurrentUser(client);
		assert.equal(calls, 1, `${calls}번 조회했다`);
	});

	test('캐시는 클라이언트별로 분리된다', async () => {
		const a = clientReturning({ username: 'aaa' });
		const b = clientReturning({ username: 'bbb' });
		assert.equal(await resolveMyUsername(a), 'aaa');
		assert.equal(await resolveMyUsername(b), 'bbb');
	});

	test('currentUser 가 null 이면 토큰 문제임을 알린다', async () => {
		const client = clientReturning(null);
		await assert.rejects(
			() => resolveMyUsername(client),
			(e: Error) => /토큰이 만료|잘못/.test(e.message),
		);
	});

	test('username 이 없으면 직접 지정하라고 안내한다', async () => {
		const client = clientReturning({ id: '1' });
		await assert.rejects(
			() => resolveMyUsername(client),
			(e: Error) => /직접 지정/.test(e.message),
		);
	});

	test('캐시를 비우면 다시 조회한다', async () => {
		let calls = 0;
		const client = clientReturning({ username: 'me' }, () => calls++);
		await resolveMyUsername(client);
		__clearCache(client);
		await resolveMyUsername(client);
		assert.equal(calls, 2);
	});
});
