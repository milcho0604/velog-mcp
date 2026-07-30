import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient, VelogApiError, isTransient } from '../client.ts';
import type { AuthState } from '../auth.ts';

const anon: AuthState = { kind: 'anonymous' };
const noSleep = async (): Promise<void> => {};

/** 정해진 응답을 순서대로 내주는 가짜 fetch. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
	let calls = 0;
	const impl = async (): Promise<Response> => {
		const r = responses[Math.min(calls++, responses.length - 1)]!;
		return new Response(JSON.stringify(r.body), {
			status: r.status ?? 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
	return { impl: impl as unknown as typeof fetch, count: () => calls };
}

describe('isTransient — 다시 쳐볼 가치가 있는 오류만 고른다', () => {
	test('벨로그 커넥션 풀 포화는 일시적이다', () => {
		assert.ok(
			isTransient(
				new VelogApiError(
					'벨로그 GraphQL 오류: Timed out fetching a new connection from the connection pool',
				),
			),
		);
	});

	test('5xx 는 일시적이다', () => {
		assert.ok(isTransient(new VelogApiError('서버 오류', { status: 503 })));
	});

	test('인증 만료는 재시도해도 소용없다', () => {
		assert.ok(!isTransient(new VelogApiError('벨로그 GraphQL 오류: Not logged in')));
	});

	test('4xx 는 재시도하지 않는다', () => {
		assert.ok(!isTransient(new VelogApiError('잘못된 요청', { status: 400 })));
	});

	test('우리 코드의 일반 오류는 대상이 아니다', () => {
		assert.ok(!isTransient(new Error('connection pool')));
	});
});

describe('재시도', () => {
	test('일시적 실패 뒤 성공하면 결과를 돌려준다', async () => {
		const f = fakeFetch([
			{ status: 500, body: { errors: [{ message: 'connection pool timeout' }] } },
			{ body: { data: { ok: true } } },
		]);
		const client = new VelogClient({
			auth: anon,
			fetchImpl: f.impl,
			sleepImpl: noSleep,
		});
		assert.deepEqual(await client.request('{ ok }'), { ok: true });
		assert.equal(f.count(), 2, '한 번 재시도했어야 한다');
	});

	test('영구 오류는 즉시 던진다 — 사용자를 기다리게 하지 않는다', async () => {
		const f = fakeFetch([{ body: { errors: [{ message: 'Not logged in' }] } }]);
		const client = new VelogClient({
			auth: anon,
			fetchImpl: f.impl,
			sleepImpl: noSleep,
		});
		await assert.rejects(() => client.request('{ x }'), VelogApiError);
		assert.equal(f.count(), 1, '재시도하면 안 된다');
	});

	test('상한을 넘으면 포기하고 던진다', async () => {
		const f = fakeFetch([{ status: 503, body: { errors: [{ message: 'busy' }] } }]);
		const client = new VelogClient({
			auth: anon,
			fetchImpl: f.impl,
			sleepImpl: noSleep,
			maxRetries: 2,
		});
		await assert.rejects(() => client.request('{ x }'), VelogApiError);
		assert.equal(f.count(), 3, '최초 1회 + 재시도 2회');
	});
});

describe('오류 메시지', () => {
	test('인증 만료에는 원인 힌트를 붙인다', async () => {
		const f = fakeFetch([
			{ body: { errors: [{ message: 'x', extensions: { code: 'UNAUTHENTICATED' } }] } },
		]);
		const client = new VelogClient({ auth: anon, fetchImpl: f.impl, sleepImpl: noSleep });
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => /1시간/.test(e.message),
		);
	});

	test('토큰이 오류 메시지로 새지 않는다', async () => {
		const TOKEN = 'supersecrettoken1234567890';
		const f = fakeFetch([
			{ status: 400, body: { errors: [{ message: `bad cookie access_token=${TOKEN}` }] } },
		]);
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: TOKEN, refreshToken: undefined },
			},
			fetchImpl: f.impl,
			sleepImpl: noSleep,
		});
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => {
				assert.ok(!e.message.includes(TOKEN), '토큰이 메시지에 남았다');
				return true;
			},
		);
	});
});

describe('requireAuth', () => {
	test('무인증 클라이언트는 쓰기 도구를 막는다', () => {
		const client = new VelogClient({ auth: anon });
		assert.equal(client.isAuthenticated, false);
		assert.throws(() => client.requireAuth('velog_create_draft'), /인증이 필요/);
	});
});
