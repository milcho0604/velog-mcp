/**
 * 쓰기 경로 안전장치 — 코덱스 교차검증에서 나온 [높음] 1건 포함.
 *
 * 근거가 된 벨로그 공식 구현(apps/server/src/services/PostApiService/index.mts):
 *
 *   private async isPostLimitReached(signedUserId) {
 *     const recentPostCount = await db.post.count({
 *       where: { fk_user_id, is_private: false, released_at: { gt: 5분전 } } })
 *     if (recentPostCount < 10) return false
 *     await db.post.updateMany({
 *       where: { fk_user_id, released_at: { gt: 5분전 } },   // is_private 필터 없음
 *       data: { is_private: true } })                        // 최근 5분 글 전부 비공개
 *   }
 *
 * 계수(count)에는 `is_private:false` 필터가 있어 우리 초안은 카운터를 올리지 않는다.
 * 하지만 쓸어내는 updateMany 에는 그 필터가 없어서, 이미 공개 글 10건이 쌓인 뒤에
 * 조치가 돌면 같은 5분 안의 글이 전부 비공개가 된다. 상한은 공개 발행 쪽에 건다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient, VelogApiError, VELOG_ENDPOINT } from '../client.ts';
import {
	PublishRateLimiter,
	PublishRateLimitError,
	PUBLIC_PUBLISH_LIMIT,
	VELOG_DESTRUCTIVE_THRESHOLD,
} from '../ratelimit.ts';

const authed = {
	kind: 'authenticated' as const,
	credentials: { accessToken: 'tok12345678', refreshToken: undefined },
};

describe('공개 발행 속도 제한', () => {
	test('우리 상한은 벨로그 파괴 임계보다 낮다', () => {
		assert.ok(
			PUBLIC_PUBLISH_LIMIT < VELOG_DESTRUCTIVE_THRESHOLD,
			`상한 ${PUBLIC_PUBLISH_LIMIT} 가 벨로그 임계 ${VELOG_DESTRUCTIVE_THRESHOLD} 이상이다`,
		);
	});

	test('상한까지는 통과한다', () => {
		const now = 0;
		const limiter = new PublishRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
		limiter.check();
		limiter.check();
		limiter.check();
		assert.equal(limiter.count, 3);
	});

	test('상한을 넘으면 막는다', () => {
		const now = 0;
		const limiter = new PublishRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
		limiter.check();
		limiter.check();
		assert.throws(() => { limiter.check(); }, PublishRateLimitError);
	});

	test('★ 막을 때 왜 막는지와 언제 풀리는지를 말한다', () => {
		const now = 0;
		const limiter = new PublishRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
		limiter.check();
		try {
			limiter.check();
			assert.fail('막히지 않았다');
		} catch (error) {
			const message = (error as Error).message;
			assert.match(message, /비공개/, '무슨 일이 생기는지 안 알렸다');
			assert.match(message, /초 뒤에/, '언제 풀리는지 안 알렸다');
			assert.ok((error as PublishRateLimitError).retryAfterMs > 0);
		}
	});

	test('창이 지나면 다시 통과한다', () => {
		let now = 0;
		const limiter = new PublishRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
		limiter.check();
		assert.throws(() => { limiter.check(); });
		now += 1001;
		limiter.check(); // 통과해야 한다
		assert.equal(limiter.count, 1);
	});
});

describe('★ mutation 은 재시도하지 않는다 (멱등하지 않음)', () => {
	function countingClient(status: number) {
		let calls = 0;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				calls++;
				return new Response(JSON.stringify({ errors: [{ message: 'busy' }] }), {
					status,
					headers: { 'Content-Type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		return { client, calls: () => calls };
	}

	test('mutate 는 5xx 여도 한 번만 친다', async () => {
		const { client, calls } = countingClient(503);
		await assert.rejects(() => client.mutate('mutation { x }'));
		assert.equal(
			calls(),
			1,
			`${calls()}회 호출했다 — 응답 유실 시 글이 중복 생성되고 벨로그 조치 시점을 앞당긴다`,
		);
	});

	test('읽기(request)는 종전대로 재시도한다', async () => {
		const { client, calls } = countingClient(503);
		await assert.rejects(() => client.request('{ x }'));
		assert.equal(calls(), 3, '읽기 재시도가 사라졌다');
	});
});

describe('자격증명 목적지 고정', () => {
	test('벨로그 정규 엔드포인트가 아니면 인증 요청을 거부한다', async () => {
		const client = new VelogClient({
			auth: authed,
			endpoint: 'https://evil.example.com/graphql',
			sleepImpl: async () => {},
			fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
		});
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => {
				assert.match(e.message, /토큰을 전송하지 않습니다/);
				return e instanceof VelogApiError;
			},
		);
	});

	test('무인증이면 다른 엔드포인트도 허용한다 — 보낼 자격증명이 없다', async () => {
		let hit = '';
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			endpoint: 'https://example.com/graphql',
			sleepImpl: async () => {},
			fetchImpl: (async (url: string) => {
				hit = url;
				return new Response(JSON.stringify({ data: { ok: 1 } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		await client.request('{ ok }');
		assert.equal(hit, 'https://example.com/graphql');
	});

	test('정규 엔드포인트에는 쿠키가 실린다', async () => {
		let cookie: string | undefined;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { headers: Record<string, string> }) => {
				cookie = init.headers['Cookie'];
				return new Response(JSON.stringify({ data: { ok: 1 } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		await client.request('{ ok }');
		assert.match(cookie ?? '', /access_token=/);
		assert.equal(VELOG_ENDPOINT, 'https://v3.velog.io/graphql');
	});
});

describe('오류 객체에 토큰이 남지 않는다', () => {
	test('detail 에 원본 GraphQL errors 를 담지 않는다', async () => {
		const TOKEN = 'supersecrettoken1234567890';
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: TOKEN, refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async () =>
				new Response(
					JSON.stringify({
						errors: [
							{ message: `bad access_token=${TOKEN}`, extensions: { code: 'BAD_USER_INPUT' } },
						],
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				)) as unknown as typeof fetch,
		});
		await assert.rejects(
			() => client.request('{ x }'),
			(error: VelogApiError) => {
				// message 뿐 아니라 객체 전체를 직렬화해도 토큰이 없어야 한다.
				const dump = JSON.stringify({ msg: error.message, detail: error.detail });
				assert.ok(!dump.includes(TOKEN), `토큰이 Error 객체에 남았다: ${dump.slice(0, 120)}`);
				assert.deepEqual(error.detail?.graphqlErrorCodes, ['BAD_USER_INPUT']);
				return true;
			},
		);
	});
});

describe('네트워크 오류 재시도 — cause 체인으로 판정한다', () => {
	// ★ Node 의 fetch 실패는 TypeError('fetch failed') 로 오고 진짜 원인은 cause 에
	//   있다. message 만 보면 'fetch failed' 라 재시도 정규식에 안 걸린다.
	//   AbortSignal.timeout 도 'aborted due to timeout' 이라 /timed out/ 과 안 맞는다.
	//   실측 결과 두 경우 모두 재시도가 0회였다.
	function throwingClient(error: unknown) {
		let calls = 0;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				calls++;
				throw error;
			}) as unknown as typeof fetch,
		});
		return { client, calls: () => calls };
	}

	const netError = (code: string) =>
		Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error(`socket ${code}`), { code }),
		});

	for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET']) {
		test(`${code} 는 재시도한다`, async () => {
			const { client, calls } = throwingClient(netError(code));
			await assert.rejects(() => client.request('{ x }'));
			assert.equal(calls(), 3, `${code} 가 재시도되지 않았다`);
		});
	}

	test('AbortSignal.timeout 도 재시도한다', async () => {
		const timeout = Object.assign(
			new Error('The operation was aborted due to timeout'),
			{ name: 'TimeoutError' },
		);
		const { client, calls } = throwingClient(timeout);
		await assert.rejects(() => client.request('{ x }'));
		assert.equal(calls(), 3);
	});

	test('원인 코드가 오류 메시지에 드러난다 — 진단할 수 있어야 한다', async () => {
		const { client } = throwingClient(netError('ECONNRESET'));
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => /ECONNRESET/.test(e.message),
		);
	});

	/**
	 * ★ 이 테스트도 근거가 뒤집혔다.
	 *
	 * 예전엔 `calls === 1` 을 'JSON 파싱 실패는 재시도 대상이 아니다'로 고정했다.
	 * 그런데 이 자리에 오는 건 대개 **우리 질의의 문제가 아니라** 상대가 HTTP 200
	 * 으로 흘린 502 HTML 이다(바로 위 주석이 "실제로 있다"고 적어둔 그 상황).
	 * 그걸 영구 오류로 분류하면 한 번 튄 인프라 장애가 그대로 사용자 실패가 된다.
	 * 실측: 200+HTML 한 번 뒤 정상 JSON 을 줘도 1회로 포기했다. 같은 조건의
	 * HTTP 503 은 정상적으로 재시도됐다 — 같은 성격인데 대우가 달랐다.
	 *
	 * ⚠️ 쓰기는 영향이 없다. `mutate()` 는 `#requestOnce` 를 직접 불러 이 재시도
	 *    루프를 아예 타지 않는다(응답 유실 시 중복 생성 방지). 아래에서 같이 고정한다.
	 */
	test('200 으로 온 HTML 은 일시 장애로 보고 다시 친다', async () => {
		let calls = 0;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				calls++;
				// 벨로그가 502 HTML 을 200 으로 주는 경우가 실제로 있다.
				return new Response('<html>502 Bad Gateway</html>', {
					status: 200,
					headers: { 'Content-Type': 'text/html' },
				});
			}) as unknown as typeof fetch,
		});
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => {
				assert.ok(e instanceof VelogApiError, 'SyntaxError 가 그대로 샜다');
				assert.match(e.message, /JSON/);
				return true;
			},
		);
		assert.equal(calls, 3, '일시 장애인데 한 번만 치고 포기했다');
	});

	test('빈 200 응답도 다시 친다 — 한 번 튄 인프라 장애다', async () => {
		let calls = 0;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				calls++;
				if (calls === 1) {
					return new Response(JSON.stringify({}), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return new Response(JSON.stringify({ data: { ok: true } }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		assert.deepEqual(await client.request('{ x }'), { ok: true });
		assert.equal(calls, 2, '빈 응답에서 재시도하지 않았다');
	});

	test('★ 쓰기는 그래도 다시 치지 않는다 — 중복 생성 방지', async () => {
		let calls = 0;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				calls++;
				return new Response('<html>502 Bad Gateway</html>', {
					status: 200,
					headers: { 'Content-Type': 'text/html' },
				});
			}) as unknown as typeof fetch,
		});
		await assert.rejects(() => client.mutate('mutation { writePost }'));
		assert.equal(calls, 1, 'mutation 이 재시도돼 글이 여러 번 만들어질 수 있다');
	});

	test('cause 체인이 순환해도 무한루프에 빠지지 않는다', async () => {
		const a: { name: string; cause?: unknown } = { name: 'A' };
		a.cause = a;
		const { client } = throwingClient(Object.assign(new Error('loop'), { cause: a }));
		await assert.rejects(() => client.request('{ x }'));
	});
});
