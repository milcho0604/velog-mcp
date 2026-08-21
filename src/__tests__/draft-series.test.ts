/**
 * 초안 생성 직후 시리즈 붙이기.
 *
 * ★★ 배경 — 벨로그는 임시저장 **생성** 단계에서 `series_id` 를 버린다.
 *   서버 코드가 `if (series_id && !data.is_temp) await appendToSeries(...)` 이다.
 *   `edit` 에는 그 조건이 없으므로, 저장 직후 edit 을 한 번 더 쳐서 붙인다.
 *
 * ★★ 이 파일의 규율 — **각 단언은 기능을 끄면 반드시 깨져야 한다.**
 *   아래 가짜 서버는 벨로그의 그 버리는 동작을 그대로 흉내낸다. 후속 edit 을
 *   지우면 시리즈가 영영 안 붙으므로 테스트가 빨간불이 된다.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient } from '../client.ts';
import { createServer } from '../index.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';

const SERIES = [{ id: 's-pg', name: 'PostgreSQL', posts_count: 6 }];

interface Opts {
	/** editPost 를 실패시킨다 — 초안은 이미 저장된 뒤다. */
	editFails?: boolean;
	/** 수정 전 조회를 실패시킨다 — 아직 아무것도 안 보냈다. */
	readFails?: boolean;
	/** edit 은 성공했다고 답하지만 실제로는 안 붙인다 — 재조회 검증이 살아있나. */
	editLies?: boolean;
	/** 붙이는 사이에 글이 초안이 아니게 됐다. */
	becomesPublished?: boolean;
}

function fake(opts: Opts = {}) {
	const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
	// 벨로그가 생성 때 만들어 두는 표시 데이터. edit 이 {} 를 보내면 지워진다.
	const stored: { series: { id: string; name: string } | null; meta: unknown; is_temp: boolean } = {
		series: null,
		meta: { short_description: '벨로그가 만든 요약' },
		is_temp: true,
	};

	const client = new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async (_u: string, init: { body: string }) => {
			const b = JSON.parse(init.body) as {
				query: string;
				variables?: { input?: Record<string, unknown> };
			};
			const input = b.variables?.input ?? {};
			const json = (data: unknown): Response =>
				new Response(JSON.stringify({ data }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			if (b.query.includes('seriesList')) return json({ seriesList: SERIES });
			if (b.query.includes('currentUser')) {
				return json({ currentUser: { id: 'u1', username: 'me' } });
			}
			if (b.query.includes('writePost')) {
				calls.push({ op: 'writePost', input });
				// ★ 벨로그의 실제 동작: 임시저장 생성에서는 series_id 를 **버린다.**
				return json({
					writePost: { id: 'p1', title: 't', url_slug: 's', is_temp: true, user: { username: 'me' } },
				});
			}
			if (b.query.includes('editPost')) {
				calls.push({ op: 'editPost', input });
				if (opts.editFails) {
					return new Response(JSON.stringify({ errors: [{ message: '편집 실패' }] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				if (!opts.editLies) {
					const sid = input['series_id'];
					if (typeof sid === 'string') {
						stored.series = { id: sid, name: SERIES.find((s) => s.id === sid)?.name ?? sid };
					}
					stored.meta = input['meta'];
				}
				if (opts.becomesPublished) stored.is_temp = false;
				return json({
					editPost: { id: 'p1', title: 't', url_slug: 's', is_temp: true, user: { username: 'me' } },
				});
			}
			if (b.query.includes('post(')) {
				calls.push({ op: 'post', input });
				if (opts.readFails) {
					return new Response(JSON.stringify({ errors: [{ message: '조회 실패' }] }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
				return json({
					post: {
						id: 'p1',
						title: 't',
						is_temp: stored.is_temp,
						meta: stored.meta,
						series: stored.series,
						user: { username: 'me' },
					},
				});
			}
			return json({});
		}) as unknown as typeof fetch,
	});
	return { client, calls, stored };
}

async function connect(client: VelogClient): Promise<Client> {
	const server = createServer(client, { publicPublish: false, editProfile: false });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: 't', version: '0' });
	await Promise.all([mcp.connect(ct), server.connect(st)]);
	return mcp;
}

async function createDraft(
	f: ReturnType<typeof fake>,
	args: Record<string, unknown>,
): Promise<{ isError?: boolean | undefined; text: string }> {
	const mcp = await connect(f.client);
	const res = (await mcp.callTool({ name: 'velog_create_draft', arguments: args })) as {
		isError?: boolean;
		content?: Array<{ text?: string }>;
	};
	await mcp.close();
	return { isError: res.isError, text: res.content?.[0]?.text ?? '' };
}

describe('★ 초안을 만들면서 시리즈까지 붙는다', () => {
	test('이름을 주면 생성 뒤 edit 으로 실제로 붙는다', async () => {
		const f = fake();
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });

		assert.equal(
			f.stored.series?.id,
			's-pg',
			'벨로그가 생성 단계에서 series_id 를 버렸는데 아무도 다시 붙이지 않았다',
		);
		assert.match(out.text, /시리즈 \*\*PostgreSQL\*\* 에 넣었습니다/);
		assert.doesNotMatch(out.text, /적용되지 않았습니다/);
	});

	test('후속 edit 이 벨로그가 만든 meta 를 지우지 않는다', async () => {
		const f = fake();
		await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.deepEqual(
			f.stored.meta,
			{ short_description: '벨로그가 만든 요약' },
			'editPost 는 전체 교체다 — meta 를 다시 안 실으면 표시 데이터가 지워진다',
		);
	});

	test('후속 edit 도 is_temp 를 초안으로 유지한다', async () => {
		const f = fake();
		await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		const edit = f.calls.find((c) => c.op === 'editPost');
		assert.equal(edit?.input['is_temp'], true, '후속 edit 이 초안을 발행글로 바꾸면 사고다');
		assert.equal(edit?.input['is_private'], true);
	});

	/** ★★ 초안은 이미 저장됐다. 여기서 던지면 사용자가 재시도해 초안이 두 개 생긴다. */
	test('붙이기가 실패해도 도구 호출은 실패가 아니다', async () => {
		const f = fake({ editFails: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });

		assert.notEqual(out.isError, true, '저장이 끝난 호출을 실패로 보고하면 초안이 중복 생성된다');
		assert.match(out.text, /초안을 저장했습니다/);
		assert.match(out.text, /p1/, '이어서 붙일 수 있게 초안 id 를 줘야 한다');
	});

	/**
	 * ★★ 실패를 두 종류로 나눈다.
	 *   수정 요청을 **보낸 뒤** 실패했으면 반영됐을 수도 있다. 그걸 "적용되지
	 *   않았습니다"로 단정하면 사용자가 이미 붙어 있는 시리즈를 다시 붙이려 든다.
	 */
	test('보낸 뒤 실패는 「확인하지 못함」이지 「미적용」이 아니다', async () => {
		const f = fake({ editFails: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.match(out.text, /확인하지 못했습니다/);
		assert.doesNotMatch(out.text, /적용되지 않았습니다/, '보낸 뒤인데 미적용으로 단정했다');
	});

	test('보내기 전 실패는 「미적용」으로 확정한다', async () => {
		const f = fake({ readFails: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.equal(
			f.calls.filter((c) => c.op === 'editPost').length,
			0,
			'조회가 실패했는데 수정 요청이 나갔다',
		);
		assert.match(out.text, /적용되지 않았습니다/);
		assert.doesNotMatch(out.text, /확인하지 못했습니다/);
	});

	/** ★ 안내대로 따라할 수 있어야 한다. update_draft 는 title·body 가 필수다. */
	test('복구 안내가 실제로 실행 가능한 절차를 알려준다', async () => {
		const f = fake({ editFails: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.match(out.text, /velog_update_draft/);
		assert.match(out.text, /title/, 'title 을 다시 줘야 한다는 사실을 안 알려준다');
		assert.match(out.text, /body/, 'body 를 다시 줘야 한다는 사실을 안 알려준다');
		assert.match(out.text, /s-pg/, '붙일 series_id 를 안 알려준다');
	});

	/** ★★ edit 응답은 갱신 전 상태를 돌려준다 — 그걸 믿으면 거짓 성공을 보고한다. */
	test('edit 이 성공을 답해도 실제로 안 붙었으면 붙었다고 하지 않는다', async () => {
		const f = fake({ editLies: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });

		assert.doesNotMatch(out.text, /에 넣었습니다/, 'mutation 응답만 보고 성공을 단정했다');
		assert.match(out.text, /적용되지 않았습니다/);
	});

	test('붙이다가 초안이 아니게 되면 조용히 넘기지 않는다', async () => {
		const f = fake({ becomesPublished: true });
		const out = await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.match(out.text, /임시저장이 아니게 됐습니다/);
	});

	test('대조군 — 이름을 안 주면 edit 을 치지 않고 시리즈 목록만 안내한다', async () => {
		const f = fake();
		const out = await createDraft(f, { title: 't', body: 'b' });
		assert.equal(
			f.calls.filter((c) => c.op === 'editPost').length,
			0,
			'시리즈를 안 줬는데 수정 요청이 나갔다',
		);
		assert.match(out.text, /시리즈에 넣지 않았습니다/);
	});

	test('대조군 — 계측이 살아있다 (생성은 언제나 한 번)', async () => {
		const f = fake();
		await createDraft(f, { title: 't', body: 'b', series_name: 'PostgreSQL' });
		assert.equal(
			f.calls.filter((c) => c.op === 'writePost').length,
			1,
			'초안이 두 번 만들어졌다 — 붙이기가 생성을 다시 부르고 있다',
		);
	});
});

/**
 * ★★ 코덱스 교차검증 1차가 잡은 회귀.
 *   생성은 `post:new` 줄에서 돈다. 후속 edit 을 그 줄에 그대로 두면
 *   `publish_draft` 나 `update_draft` 의 `post:<id>` 줄과 **다른 줄**이 되어
 *   서로를 못 본다. 늦게 도착한 edit 이 방금 발행된 글을 초안으로 되돌린다.
 */
describe('★ 후속 edit 은 그 글의 줄에서 돈다', () => {
	test('후속 edit 은 post:new 가 아니라 post:<id> 줄을 쓴다', async () => {
		// 도구 경로로는 직렬화 키를 관찰할 주입 지점이 없어 소스에서 확인한다.
		// ⚠️ 철자 검사라 리팩터링에 썩는다 — 함수를 못 찾으면 통과가 아니라 실패다.
		const src = await readFile(new URL('../tools/drafts.ts', import.meta.url), 'utf8');
		const from = src.indexOf('async function attachSeriesToNewDraft');
		const to = src.indexOf('function draftResult');
		assert.ok(from >= 0 && to > from, '함수를 못 찾았다 — 이름이 바뀌었다');
		const fn = src.slice(from, to);
		assert.match(
			fn,
			/serializeWrite\(`post:\$\{postId\}`/,
			'후속 edit 이 그 글의 줄에서 돌지 않으면 발행된 글을 초안으로 되돌린다',
		);
		assert.doesNotMatch(fn, /serializeWrite\('post:new'/);
	});
});

/**
 * ★★ 이름으로 찾은 id 는 내 목록에서 고른 것이라 소유권 재조회를 뺐다.
 *   그 최적화가 **사용자가 준 id** 의 검사까지 없애지 않았는지 고정한다.
 */
describe('★ 소유권 검사 범위', () => {
	function ownServer() {
		const calls: string[] = [];
		let wrote = false;
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { body: string }) => {
				const b = JSON.parse(init.body) as { query: string };
				const J = (d: unknown): Response =>
					new Response(JSON.stringify({ data: d }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (b.query.includes('seriesList')) {
					calls.push('seriesList');
					return J({ seriesList: SERIES });
				}
				if (b.query.includes('currentUser')) return J({ currentUser: { id: 'u1', username: 'me' } });
				if (b.query.includes('writePost')) {
					wrote = true;
					calls.push('writePost');
					return J({
						writePost: { id: 'p1', title: 't', url_slug: 's', is_temp: true, user: { username: 'me' } },
					});
				}
				if (b.query.includes('editPost')) { calls.push('editPost'); return J({ editPost: { id: 'p1', is_temp: true, user: { username: 'me' } } }); }
				if (b.query.includes('post(')) {
					calls.push('post');
					return J({ post: { id: 'p1', is_temp: true, meta: {}, series: { id: 's-pg', name: 'PostgreSQL' }, user: { username: 'me' } } });
				}
				return J({});
			}) as unknown as typeof fetch,
		});
		return { client, calls, wrote: () => wrote };
	}

	test('이름 경로는 seriesList 를 한 번만 부른다', async () => {
		const f = ownServer();
		const mcp = await connect(f.client);
		await mcp.callTool({
			name: 'velog_create_draft',
			arguments: { title: 't', body: 'b', series_name: 'PostgreSQL' },
		});
		await mcp.close();
		assert.equal(
			f.calls.filter((c) => c === 'seriesList').length,
			1,
			'이름 해석과 소유권 검사가 같은 목록을 두 번 받아온다',
		);
	});

	/** ★★ 남의 시리즈 id 를 직접 주면 **여전히** 거부돼야 한다. */
	test('사용자가 준 남의 series_id 는 그대로 거부한다', async () => {
		const f = ownServer();
		const mcp = await connect(f.client);
		const res = (await mcp.callTool({
			name: 'velog_create_draft',
			arguments: { title: 't', body: 'b', series_id: 'not-mine' },
		})) as { isError?: boolean; content?: Array<{ text?: string }> };
		await mcp.close();
		assert.equal(f.wrote(), false, '남의 시리즈인데 글이 저장됐다');
		assert.match(res.content?.[0]?.text ?? '', /시리즈가 아닙니다/);
	});
});

/**
 * ★★ 코덱스 재검증이 잡은 구멍.
 *   `seriesFromName` 을 게으르게 `series_name !== undefined` 로 세우면
 *   **남의 series_id + 아무 이름**을 함께 줬을 때 직접 id 검사를 건너뛴다.
 *   기존 A11 은 이름 없이 id 만 주고, 앞의 테스트는 이름 단독만 봐서 둘 다 통과한다.
 *   그래서 네 도구 × 네 조합을 표로 고정한다.
 */
describe('★★ 소유권 계약 — 네 도구 × 네 입력 조합', () => {
	const MINE = { id: 's-mine', name: 'MCP', posts_count: 1 };

	function srv(state: { is_temp: boolean }) {
		const calls: string[] = [];
		let wroteSeries: unknown;
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { body: string }) => {
				const b = JSON.parse(init.body) as {
					query: string;
					variables?: { input?: Record<string, unknown> };
				};
				const input = b.variables?.input ?? {};
				const J = (d: unknown): Response =>
					new Response(JSON.stringify({ data: d }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (b.query.includes('seriesList')) {
					calls.push('seriesList');
					return J({ seriesList: [MINE] });
				}
				if (b.query.includes('currentUser')) {
					return J({ currentUser: { id: 'u1', username: 'me' } });
				}
				if (b.query.includes('writePost') || b.query.includes('editPost')) {
					const op = b.query.includes('writePost') ? 'writePost' : 'editPost';
					calls.push(op);
					if (input['series_id'] !== undefined) wroteSeries = input['series_id'];
					return J({
						[op]: {
							id: 'p1',
							title: 't',
							url_slug: 's',
							is_temp: state.is_temp,
							user: { username: 'me' },
						},
					});
				}
				if (b.query.includes('post(')) {
					calls.push('post');
					return J({
						post: {
							id: 'p1',
							title: 't',
							body: 'b',
							tags: [],
							url_slug: 's',
							thumbnail: null,
							is_temp: state.is_temp,
							is_private: true,
							meta: {},
							series: wroteSeries ? { id: wroteSeries, name: MINE.name } : null,
							user: { username: 'me' },
						},
					});
				}
				return J({});
			}) as unknown as typeof fetch,
		});
		return { client, calls, series: () => wroteSeries };
	}

	const TOOLS: Array<{ tool: string; is_temp: boolean; extra: Record<string, unknown> }> = [
		{ tool: 'velog_create_draft', is_temp: true, extra: { title: 't', body: 'b' } },
		{ tool: 'velog_update_draft', is_temp: true, extra: { id: 'p1', title: 't', body: 'b' } },
		{ tool: 'velog_publish_post', is_temp: false, extra: { title: 't', body: 'b' } },
		{ tool: 'velog_update_post', is_temp: false, extra: { id: 'p1' } },
	];

	async function call(tool: string, is_temp: boolean, args: Record<string, unknown>) {
		const f = srv({ is_temp });
		const server = createServer(f.client, { publicPublish: true, editProfile: false });
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 't', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		const res = (await mcp.callTool({ name: tool, arguments: args })) as {
			isError?: boolean;
			content?: Array<{ text?: string }>;
		};
		await mcp.close();
		return { ...f, text: res.content?.[0]?.text ?? '' };
	}

	for (const { tool, is_temp, extra } of TOOLS) {
		test(`${tool} — 남의 series_id 는 이름을 곁들여도 거부한다`, async () => {
			const r = await call(tool, is_temp, {
				...extra,
				series_id: 'not-mine',
				series_name: 'MCP',
			});
			assert.equal(r.series(), undefined, '남의 시리즈가 저장 요청에 실렸다');
			assert.match(r.text, /시리즈가 아닙니다/);
		});

		test(`${tool} — 남의 series_id 만 줘도 거부한다`, async () => {
			const r = await call(tool, is_temp, { ...extra, series_id: 'not-mine' });
			assert.equal(r.series(), undefined);
			assert.match(r.text, /시리즈가 아닙니다/);
		});

		test(`${tool} — 내 이름만 주면 붙고 목록은 한 번만 받는다`, async () => {
			const r = await call(tool, is_temp, { ...extra, series_name: 'MCP' });
			assert.equal(r.series(), 's-mine', '이름으로 찾은 시리즈가 안 실렸다');
			assert.equal(
				r.calls.filter((c) => c === 'seriesList').length,
				1,
				'같은 목록을 두 번 받아온다',
			);
		});

		test(`${tool} — 없는 이름이면 아무것도 쓰지 않는다`, async () => {
			const r = await call(tool, is_temp, { ...extra, series_name: '없는시리즈' });
			assert.equal(
				r.calls.filter((c) => c === 'writePost' || c === 'editPost').length,
				0,
				'못 찾았는데 저장 요청이 나갔다',
			);
		});
	}
});

/**
 * ★★ 코덱스 재검증 finding 1.
 *   생성은 `post:new` 줄을 잡지만 `post:<id>` 줄은 **생성 응답을 받은 뒤에야** 잡는다.
 *   그 틈에 `update_draft` 가 먼저 그 줄을 잡고 제목·본문을 고칠 수 있다. 그때 후속
 *   edit 이 **생성 당시 입력**을 다시 펼치면 그 수정이 통째로 되돌아가고, 두 호출 다
 *   성공을 보고한다. 그래서 후속 edit 은 반드시 **직전에 읽은 현재 값**을 실어야 한다.
 */
describe('★★ 후속 edit 은 생성 당시 입력이 아니라 현재 값을 싣는다', () => {
	function raced() {
		const sent: Array<Record<string, unknown>> = [];
		const current = { title: '남이-고친-제목', body: '남이-고친-본문', tags: ['keep'] };
		let series: unknown = null;
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { body: string }) => {
				const b = JSON.parse(init.body) as {
					query: string;
					variables?: { input?: Record<string, unknown> };
				};
				const input = b.variables?.input ?? {};
				const J = (d: unknown): Response =>
					new Response(JSON.stringify({ data: d }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (b.query.includes('seriesList')) return J({ seriesList: SERIES });
				if (b.query.includes('currentUser')) {
					return J({ currentUser: { id: 'u1', username: 'me' } });
				}
				if (b.query.includes('writePost')) {
					return J({
						writePost: {
							id: 'p1',
							title: '내가-만든-제목',
							url_slug: 's',
							is_temp: true,
							user: { username: 'me' },
						},
					});
				}
				if (b.query.includes('editPost')) {
					sent.push(input);
					if (typeof input['series_id'] === 'string') series = input['series_id'];
					return J({ editPost: { id: 'p1', is_temp: true, user: { username: 'me' } } });
				}
				if (b.query.includes('post(')) {
					return J({
						post: {
							id: 'p1',
							...current,
							url_slug: 's',
							thumbnail: null,
							is_temp: true,
							meta: { short_description: '유지되어야' },
							series: series ? { id: series, name: 'PostgreSQL' } : null,
							user: { username: 'me' },
						},
					});
				}
				return J({});
			}) as unknown as typeof fetch,
		});
		return { client, sent };
	}

	test('중간에 바뀐 제목과 본문을 되돌리지 않는다', async () => {
		const f = raced();
		const mcp = await connect(f.client);
		await mcp.callTool({
			name: 'velog_create_draft',
			arguments: { title: '내가-만든-제목', body: '내가-만든-본문', series_name: 'PostgreSQL' },
		});
		await mcp.close();

		const edit = f.sent[0];
		assert.ok(edit, '후속 edit 이 아예 안 나갔다');
		assert.equal(
			edit['title'],
			'남이-고친-제목',
			'생성 당시 제목을 다시 실었다 — 그 사이의 수정이 통째로 되돌아간다',
		);
		assert.equal(edit['body'], '남이-고친-본문', '생성 당시 본문을 다시 실었다');
		assert.deepEqual(edit['tags'], ['keep'], '현재 태그를 안 실어 태그가 지워진다');
		assert.deepEqual(
			edit['meta'],
			{ short_description: '유지되어야' },
			'meta 를 다시 안 실으면 표시 데이터가 지워진다',
		);
	});
});

/**
 * ★ 바깥은 `post:new` 줄이다. 서버가 id 로 하필 "new" 를 돌려주면 두 키가 같아져
 *   안쪽이 바깥쪽을 기다린다. 가드가 없으면 이 테스트는 **끝나지 않는다** —
 *   그래서 단언이 아니라 timeout 이 검출 장치다.
 */
describe('★ id 가 "new" 여도 멈추지 않는다', () => {
	test('교착 대신 안내로 빠진다', { timeout: 8000 }, async () => {
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { body: string }) => {
				const b = JSON.parse(init.body) as { query: string };
				const J = (d: unknown): Response =>
					new Response(JSON.stringify({ data: d }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (b.query.includes('seriesList')) return J({ seriesList: SERIES });
				if (b.query.includes('currentUser')) {
					return J({ currentUser: { id: 'u1', username: 'me' } });
				}
				if (b.query.includes('writePost')) {
					return J({
						writePost: {
							id: 'new',
							title: 't',
							url_slug: 's',
							is_temp: true,
							user: { username: 'me' },
						},
					});
				}
				if (b.query.includes('post(')) {
					return J({
						post: {
							id: 'new',
							title: 't',
							body: 'b',
							tags: [],
							url_slug: 's',
							thumbnail: null,
							is_temp: true,
							meta: {},
							series: null,
							user: { username: 'me' },
						},
					});
				}
				return J({});
			}) as unknown as typeof fetch,
		});
		const mcp = await connect(client);
		const res = (await mcp.callTool({
			name: 'velog_create_draft',
			arguments: { title: 't', body: 'b', series_name: 'PostgreSQL' },
		})) as { content?: Array<{ text?: string }> };
		await mcp.close();
		assert.match(res.content?.[0]?.text ?? '', /초안을 저장했습니다/);
	});
});
