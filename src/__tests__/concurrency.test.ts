/**
 * 동시성·취소·예산 — 2026-08-07 감사에서 나온 결함들의 회귀 테스트.
 *
 * 공통 성격: **혼자 부르면 안 보이고, 오래 켜두거나 동시에 부르면 보인다.**
 * 그래서 손으로 만져봐서는 못 잡고, 여기서 고정해야 한다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../index.ts';
import { VelogClient } from '../client.ts';
import { TokenStore } from '../auth.ts';
import { makeKeyedSerializer, makeSerializer } from '../serial.ts';

describe('serial — 줄 세우기', () => {
	test('같은 키는 겹치지 않는다', async () => {
		const serialize = makeKeyedSerializer();
		let running = 0;
		let maxRunning = 0;
		const task = async (): Promise<void> => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
		};
		await Promise.all([
			serialize('a', task),
			serialize('a', task),
			serialize('a', task),
		]);
		assert.equal(maxRunning, 1, '같은 대상에 동시에 두 개가 돌았다');
	});

	test('다른 키는 함께 돈다 — 무관한 글까지 줄 세우지 않는다', async () => {
		const serialize = makeKeyedSerializer();
		let running = 0;
		let maxRunning = 0;
		const task = async (): Promise<void> => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 5));
			running--;
		};
		await Promise.all([serialize('a', task), serialize('b', task)]);
		assert.equal(maxRunning, 2, '서로 다른 대상인데 줄을 섰다');
	});

	test('앞 작업이 실패해도 줄이 끊기지 않는다', async () => {
		const serialize = makeKeyedSerializer();
		const boom = serialize('a', () => Promise.reject(new Error('boom')));
		await assert.rejects(() => boom);
		assert.equal(await serialize('a', () => Promise.resolve('ok')), 'ok');
	});

	/**
	 * ★ 처음엔 '새 작업이 즉시 시작되는가'를 시간으로 재서 정리를 확인하려 했다.
	 *   그건 `lanes.delete()` 를 통째로 지워도 통과한다 — 이미 끝난 tail 에는
	 *   어차피 즉시 붙기 때문이다. 코덱스가 잡았다. 그래서 줄 개수를 직접 본다.
	 */
	test('빈 줄은 치운다 — 오래 켜둬도 자라지 않는다', async () => {
		const serialize = makeKeyedSerializer();
		for (let i = 0; i < 50; i++) {
			await serialize(`key-${i}`, () => Promise.resolve(i));
		}
		// 정리는 마이크로태스크로 돈다. 한 틱 준 뒤에 센다.
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(serialize.laneCount(), 0, '다 끝났는데 줄이 남아 있다');
	});

	test('진행 중인 줄은 남아 있다 — 대조군', async () => {
		const serialize = makeKeyedSerializer();
		let release = (): void => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const running = serialize('busy', () => held);
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(serialize.laneCount(), 1, '도는 중인데 줄이 사라졌다 — 계측 실패');
		release();
		await running;
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(serialize.laneCount(), 0);
	});

	test('단일 줄도 겹치지 않는다 (업로드·렌더용)', async () => {
		const serialize = makeSerializer();
		let running = 0;
		let maxRunning = 0;
		await Promise.all(
			[1, 2, 3].map(() =>
				serialize(async () => {
					running++;
					maxRunning = Math.max(maxRunning, running);
					await new Promise((r) => setTimeout(r, 5));
					running--;
				}),
			),
		);
		assert.equal(maxRunning, 1);
	});
});

describe('TokenStore — 마스킹 대상이 무한히 자라지 않는다', () => {
	test('토큰을 오래 갱신해도 기억하는 개수에 상한이 있다', () => {
		const store = new TokenStore({
			kind: 'authenticated',
			credentials: { accessToken: `${'A'.repeat(40)}0`, refreshToken: `${'R'.repeat(40)}0` },
		});
		for (let i = 1; i <= 500; i++) {
			store.update({
				accessToken: `${'A'.repeat(40)}${i}`,
				refreshToken: `${'R'.repeat(40)}${i}`,
			});
		}
		// 현재 토큰은 반드시 가려져야 한다 — 상한을 두면서 이걸 잃으면 최악이다.
		const masked = store.mask(`access_token 값은 ${'A'.repeat(40)}500 입니다`);
		assert.ok(!masked.includes(`${'A'.repeat(40)}500`), '현재 토큰이 그대로 샜다');

		// 아주 오래된 토큰까지 붙들고 있지는 않는다.
		const old = store.mask(`옛 토큰 ${'A'.repeat(40)}1`);
		assert.ok(old.includes(`${'A'.repeat(40)}1`), '상한이 없어 옛 토큰이 전부 남아 있다');
	});

	/**
	 * ★★ 위 테스트는 access·refresh 를 **매번 같이** 바꾼다. 그러면 현재 토큰이
	 *   항상 가장 최근 항목이라 축출 대상이 안 된다 — 진짜 위험을 못 본다.
	 *   벨로그는 access_token 만 재발급하고 refresh_token 은 그대로 두는 일이 흔한데,
	 *   `Set.add()` 는 이미 있는 값의 순서를 바꾸지 않으므로 **지금 쓰는
	 *   refresh_token 이 가장 오래된 항목이 되어 지워진다.** 코덱스가 잡았다.
	 */
	test('★ access 만 갱신돼도 현재 refresh_token 은 계속 가려진다', () => {
		const refresh = `${'R'.repeat(40)}-fixed`;
		const store = new TokenStore({
			kind: 'authenticated',
			credentials: { accessToken: `${'A'.repeat(40)}0`, refreshToken: refresh },
		});
		// ★★ **매 회차**를 본다. 축출은 주기적이라 마지막 한 번만 보면 운에 맡기는
		//   테스트가 된다 — 실제로 200회 시점만 확인했다가 통과해버렸다.
		//   옛 동작에서의 실측 노출 회차: 40·81·122·163 (주기 41).
		//   ★ `refresh_token=...` 꼴로 쓰면 안 된다. mask() 에는 이름=값 정규식
		//     폴백이 있어 축출됐어도 가려진다 — 그것도 거짓 초록이 된다.
		//     누적 목록이 일하는지 보려면 **맨 토큰 문자열**로 물어야 한다.
		const exposed: number[] = [];
		for (let i = 1; i <= 200; i++) {
			store.update({ accessToken: `${'A'.repeat(40)}${i}` });
			const masked = store.mask(`벨로그 응답 본문에 ${refresh} 가 섞여 나왔습니다`);
			if (masked.includes(refresh)) exposed.push(i);
		}
		assert.deepEqual(
			exposed,
			[],
			'살아 있는 refresh_token 이 축출돼 오류 문자열에 그대로 드러나는 회차가 있다',
		);
	});
});

/** 진짜 서버처럼 '보낸 대로 저장하는' 가짜 벨로그. lost update 는 이게 있어야 보인다. */
function statefulServer(options: { publicPublish?: boolean } = {}) {
	const stored: Record<string, unknown> = {
		id: 'p1',
		title: '원래제목',
		body: '원래본문',
		url_slug: 'original-slug',
		is_temp: false,
		is_private: false,
		thumbnail: null,
		tags: [],
		series: null,
		meta: {},
		user: { username: 'me' },
	};
	/** 읽기와 쓰기 사이에 틈을 만든다 — 경합은 이 틈에서 생긴다. */
	let readDelayMs = 0;
	/** 같은 글의 사전 조회가 겹치는지 센다. 줄이 제대로면 1 을 넘지 않는다. */
	let inflightReads = 0;
	let maxConcurrentReads = 0;

	const client = new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as {
				query: string;
				variables?: { input?: Record<string, unknown> };
			};
			const json = (data: unknown): Response =>
				new Response(JSON.stringify({ data }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			if (body.query.includes('currentUser')) {
				return json({ currentUser: { id: 'u1', username: 'me' } });
			}
			if (body.query.includes('editPost')) {
				const input = body.variables?.input ?? {};
				for (const [k, v] of Object.entries(input)) {
					if (k === 'series_id') stored['series'] = { id: v };
					else stored[k] = v;
				}
				return json({ editPost: { ...stored } });
			}
			if (body.query.includes('post(input')) {
				// ★ 스냅샷을 **지연 전에** 뜬다. 진짜 DB 는 질의가 실행되는 시점의
				//   행을 읽는다. 지연 뒤에 뜨면 그 사이의 남의 쓰기가 반영되어
				//   '둘 다 옛 값을 읽는' 경합이 사라진다 — 처음에 그렇게 만들었다가
				//   직렬화를 꺼도 테스트가 통과하는 거짓 초록을 봤다.
				const snapshot = { ...stored };
				inflightReads++;
				maxConcurrentReads = Math.max(maxConcurrentReads, inflightReads);
				if (readDelayMs > 0) await new Promise((r) => setTimeout(r, readDelayMs));
				inflightReads--;
				return json({ post: snapshot });
			}
			return json({});
		}) as unknown as typeof fetch,
	});

	return {
		client,
		stored,
		setReadDelay: (ms: number) => {
			readDelayMs = ms;
		},
		maxConcurrentReads: () => maxConcurrentReads,
		async connect() {
			const server = createServer(client, {
				publicPublish: options.publicPublish ?? true,
				editProfile: false,
			});
			const [a, b] = InMemoryTransport.createLinkedPair();
			const mcp = new Client({ name: 'test', version: '1' });
			await Promise.all([server.connect(b), mcp.connect(a)]);
			return mcp;
		},
	};
}

describe('★ 같은 글을 동시에 고쳐도 서로를 덮어쓰지 않는다', () => {
	test('제목만 바꾸는 요청과 본문만 바꾸는 요청이 겹쳐도 둘 다 남는다', async () => {
		const fake = statefulServer();
		// 읽기를 느리게 만들어 '둘 다 옛 값을 읽는' 창을 넓힌다.
		fake.setReadDelay(20);
		const mcp = await fake.connect();

		await Promise.all([
			mcp.callTool({
				name: 'velog_update_post',
				arguments: { id: 'p1', title: '새제목' },
			}),
			mcp.callTool({
				name: 'velog_update_post',
				arguments: { id: 'p1', body: '새본문' },
			}),
		]);
		await mcp.close();

		assert.equal(fake.stored['title'], '새제목', '제목 변경이 덮어씌워져 사라졌다');
		assert.equal(fake.stored['body'], '새본문', '본문 변경이 덮어씌워져 사라졌다');
	});
});

describe('★ 취소하면 더 이상 부작용을 만들지 않는다', () => {
	test('취소된 뒤에는 mutation 이 나가지 않는다', async () => {
		const fake = statefulServer();
		// 사전 조회를 느리게 해 그 사이에 취소가 도착하게 한다.
		fake.setReadDelay(300);
		const mcp = await fake.connect();

		const controller = new AbortController();
		const call = mcp.callTool(
			{ name: 'velog_update_post', arguments: { id: 'p1', title: '이건 나가면 안 된다' } },
			undefined,
			{ signal: controller.signal },
		);
		setTimeout(() => { controller.abort(); }, 30);
		await assert.rejects(() => call);

		// 서버 쪽에서 mutation 이 처리될 틈을 넉넉히 준 뒤 확인한다.
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(
			fake.stored['title'],
			'원래제목',
			'취소했는데 글이 바뀌었다 — 클라이언트 화면과 실제가 어긋난다',
		);
		await mcp.close();
	});
});

describe('★ 재시도 총예산 — 아무도 안 보는 시도에 시간을 쓰지 않는다', () => {
	/** 벽시계 없이 재현한다. fetch 가 부를 때마다 가짜 시계를 20초씩 민다. */
	function budgetClient(retryBudgetMs: number) {
		let clock = 0;
		let calls = 0;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			timeoutMs: 20_000,
			retryBudgetMs,
			nowImpl: () => clock,
			sleepImpl: async (ms: number) => {
				clock += ms;
			},
			fetchImpl: (async () => {
				calls++;
				clock += 20_000;
				throw Object.assign(new TypeError('fetch failed'), {
					cause: { code: 'ECONNRESET' },
				});
			}) as unknown as typeof fetch,
		});
		return { client, calls: () => calls };
	}

	test('예산이 모자라면 마지막 시도를 시작하지 않는다', async () => {
		// 시도당 20초 × 3회 + 백오프 1.5초 = 61.5초. MCP 클라이언트 기본 타임아웃은
		// 60초라(shared/protocol.js) 마지막 20초는 결과를 아무도 못 본다.
		const { client, calls } = budgetClient(35_000);
		await assert.rejects(() => client.request('{ x }'));
		assert.equal(calls(), 2, '예산을 넘겨 세 번째 시도까지 갔다');
	});

	test('예산이 넉넉하면 종전대로 세 번 친다 — 무조건 줄이는 게 아니다', async () => {
		const { client, calls } = budgetClient(120_000);
		await assert.rejects(() => client.request('{ x }'));
		assert.equal(calls(), 3);
	});
});

describe('★ velog_export_posts — 취소하면 파일 쓰기를 멈춘다', () => {
	test('취소 뒤에는 더 이상 파일이 생기지 않고, 어디서 멈췄는지 보고한다', async () => {
		const POSTS = Array.from({ length: 30 }, (_, i) => ({
			id: `p${i}`,
			title: `글 ${i}`,
			url_slug: `slug-${i}`,
			tags: [],
			likes: 0,
			views: 0,
		}));

		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { query: string };
				const json = (data: unknown): Response =>
					new Response(JSON.stringify({ data }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (body.query.includes('currentUser')) {
					return json({ currentUser: { id: 'u1', username: 'me' } });
				}
				if (body.query.includes('GetPosts')) return json({ posts: POSTS });
				if (body.query.includes('post(input')) {
					await new Promise((r) => setTimeout(r, 30));
					return json({ post: { id: 'x', title: 't', body: '본문', url_slug: 's' } });
				}
				return json({});
			}) as unknown as typeof fetch,
		});

		const server = createServer(client, { publicPublish: false, editProfile: false });
		const [a, b] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'export-test', version: '1' });
		await Promise.all([server.connect(b), mcp.connect(a)]);

		const dir = await mkdtemp(join(tmpdir(), 'velog-mcp-export-test-'));
		try {
			const controller = new AbortController();
			const call = mcp.callTool(
				{
					name: 'velog_export_posts',
					arguments: { username: 'me', out_dir: dir, limit: 30 },
				},
				undefined,
				{ signal: controller.signal },
			);
			setTimeout(() => { controller.abort(); }, 150);
			await assert.rejects(() => call);

			const atCancel = (await readdir(dir)).length;
			assert.ok(atCancel < 30, `취소했는데 ${atCancel}편이 전부 저장됐다`);

			// ★ 핵심 — 취소한 **뒤에도** 계속 쓰고 있었는지 본다.
			await new Promise((r) => setTimeout(r, 500));
			assert.equal(
				(await readdir(dir)).length,
				atCancel,
				'취소한 뒤에도 파일이 계속 쌓였다 — 화면은 실패인데 디스크는 채워진다',
			);
		} finally {
			await mcp.close();
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe('★ 부분 성공 판정 — 아무것도 안 된 실패까지 막으면 안 된다', () => {
	function client(responses: readonly unknown[]) {
		let calls = 0;
		const c = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				const payload = responses[Math.min(calls, responses.length - 1)];
				calls++;
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		return { c, calls: () => calls };
	}

	test('data 에 값이 있으면 부분 성공 — 다시 치지 않는다', async () => {
		const { c, calls } = client([
			{
				data: { writePost: { id: 'created-1' } },
				errors: [{ message: 'Timed out fetching a new connection from the connection pool' }],
			},
		]);
		await assert.rejects(
			() => c.request('{ x }'),
			(e: Error) => /이미 반영/.test(e.message) && /created-1/.test(e.message),
		);
		assert.equal(calls(), 1, '이미 반영됐을 수 있는데 다시 쳤다');
	});

	test('★ data 가 전부 null 이면 완전 실패 — 종전대로 재시도한다', async () => {
		// GraphQL 은 resolver 가 깨지면 { data: { post: null }, errors } 를 준다.
		// 벨로그의 커넥션 풀 고갈이 정확히 이 모양이라, 여기서 막으면 멀쩡히
		// 재시도되던 읽기가 죽는다. (코덱스 교차검증에서 잡았다.)
		const { c, calls } = client([
			{
				data: { post: null },
				errors: [{ message: 'Timed out fetching a new connection from the connection pool' }],
			},
			{ data: { post: { id: 'p1' } } },
		]);
		assert.deepEqual(await c.request('{ x }'), { post: { id: 'p1' } });
		assert.equal(calls(), 2, '완전 실패인데 재시도하지 않았다');
	});
});

/**
 * ★★ 쓰기 줄은 도구가 아니라 **대상** 기준이다.
 *
 * 처음엔 모듈마다 `makeKeyedSerializer()` 를 따로 만들었다. 그러면 키가 같아도
 * 줄이 달라서, 같은 글에 `velog_update_draft` 와 `velog_publish_draft` 를 동시에
 * 부르면 서로를 못 본다 — 코덱스 교차검증에서 사전 조회가 실제로 겹쳤고(2),
 * 발행 뒤에 초안 수정이 덮어써 최종 상태가 다시 초안이 됐다.
 */
describe('★ 다른 도구라도 같은 글이면 같은 줄에 선다', () => {
	test('update_draft 와 publish_draft 를 같은 글에 동시에 불러도 겹치지 않는다', async () => {
		const fake = statefulServer();
		fake.stored['is_temp'] = true;
		fake.stored['is_private'] = true;
		fake.setReadDelay(40);
		const mcp = await fake.connect();

		await Promise.allSettled([
			mcp.callTool({
				name: 'velog_update_draft',
				arguments: { id: 'p1', title: '초안 제목', body: '초안 본문' },
			}),
			mcp.callTool({ name: 'velog_publish_draft', arguments: { id: 'p1' } }),
		]);
		await mcp.close();

		assert.equal(
			fake.maxConcurrentReads(),
			1,
			'같은 글인데 두 도구의 사전 조회가 겹쳤다 — 줄이 모듈마다 따로 있다',
		);
	});
});
