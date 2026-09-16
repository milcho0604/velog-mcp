import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient, VelogApiError, isTransient } from '../client.ts';
import type { AuthState } from '../auth.ts';

const anon: AuthState = { kind: 'anonymous' };
const noSleep = async (): Promise<void> => {};

/**
 * ★★ **기다린 시간을 기록하는 가짜 잠.**
 *   `noSleep` 은 인자를 버린다. 그래서 `this.#sleep(backoff)` 를 `this.#sleep(0)`
 *   으로 바꾸는 변이가 11개 전부를 통과했다. 지수 후퇴가 통째로 사라져도 아무도
 *   모르는 상태였다 — 벨로그가 흔들릴 때 쉬지 않고 두들기게 된다.
 *   실제로 자지는 않되 **받은 값은 남긴다.**
 */
function recordingSleep(): { impl: (ms: number) => Promise<void>; waits: number[] } {
	const waits: number[] = [];
	return {
		impl: async (ms: number): Promise<void> => {
			waits.push(ms);
		},
		waits,
	};
}

/** 정해진 응답을 순서대로 내주는 가짜 fetch. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
	let calls = 0;
	const impl = async (): Promise<Response> => {
		const r = responses[Math.min(calls++, responses.length - 1)] ?? { body: {} };
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
		assert.throws(() => { client.requireAuth('velog_create_draft'); }, /인증이 필요/);
	});
});

describe('★★ 재시도 사이에 실제로 기다린다 — 지수 후퇴', () => {
	/** 503 을 계속 주는 서버. 재시도를 끝까지 소진시킨다. */
	const alwaysDown = (): Array<{ status: number; body: unknown }> =>
		Array.from({ length: 5 }, () => ({ status: 503, body: {} }));

	test('★ 대기 시간이 500ms → 1s 로 늘어난다', async () => {
		const sleep = recordingSleep();
		const f = fakeFetch(alwaysDown());
		const client = new VelogClient({ auth: anon, fetchImpl: f.impl, sleepImpl: sleep.impl });

		await assert.rejects(async () => client.request('query { x }'));

		assert.deepEqual(
			sleep.waits,
			[500, 1000],
			`후퇴가 사라졌다 — 실제 대기: [${sleep.waits.join(', ')}]`,
		);
	});

	test('★ 대기 시간은 시도마다 두 배가 된다 — 고정값이 아니다', async () => {
		const sleep = recordingSleep();
		const f = fakeFetch(alwaysDown());
		const client = new VelogClient({ auth: anon, fetchImpl: f.impl, sleepImpl: sleep.impl });
		await assert.rejects(async () => client.request('query { x }'));

		assert.ok(sleep.waits.length >= 2, '재시도가 한 번뿐이라 후퇴를 잴 수 없다');
		for (let i = 1; i < sleep.waits.length; i += 1) {
			const prev = sleep.waits[i - 1] ?? 0;
			const cur = sleep.waits[i] ?? 0;
			assert.equal(cur, prev * 2, `${i}번째 대기가 두 배가 아니다: ${prev} → ${cur}`);
		}
	});

	/**
	 * ☑ 대조군 — 위 둘이 「무조건 잔다」로 굳지 않게, **잘 필요가 없을 때는 안 자는지**
	 *   를 함께 잰다. 한 번에 성공하는 조회에서 잠이 들어가면 모든 호출이 느려진다.
	 */
	test('☑ 대조군 — 한 번에 성공하면 아예 기다리지 않는다', async () => {
		const sleep = recordingSleep();
		const f = fakeFetch([{ body: { data: { x: 1 } } }]);
		const client = new VelogClient({ auth: anon, fetchImpl: f.impl, sleepImpl: sleep.impl });

		assert.deepEqual(await client.request('query { x }'), { x: 1 });
		assert.deepEqual(sleep.waits, [], '성공한 호출에서 잠이 들어갔다');
	});

	test('☑ 대조군 — 다시 쳐도 소용없는 오류에서는 기다리지 않는다', async () => {
		const sleep = recordingSleep();
		// 4xx 는 다시 쳐도 같다. 자면 그만큼 사용자를 세워둘 뿐이다.
		const f = fakeFetch([{ status: 400, body: {} }]);
		const client = new VelogClient({ auth: anon, fetchImpl: f.impl, sleepImpl: sleep.impl });

		await assert.rejects(async () => client.request('query { x }'));
		assert.deepEqual(sleep.waits, [], '영구 오류인데 후퇴를 기다렸다');
	});
});
