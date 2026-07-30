/**
 * 검증 과정에서 찾은 결함 4건의 회귀 테스트.
 *
 * 전부 '동작은 하지만 조용히 틀린' 종류라 테스트 없이는 다시 들어온다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient } from '../client.ts';
import { fetchAllPosts } from '../tools/stats.ts';
import { createServer } from '../index.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const authed = {
	kind: 'authenticated' as const,
	credentials: { accessToken: 'tok12345678', refreshToken: undefined },
};

function jsonFetch(handler: (body: unknown) => { status?: number; body: unknown }) {
	return (async (_url: string, init: { body: string }) => {
		const r = handler(JSON.parse(init.body));
		return new Response(JSON.stringify(r.body), {
			status: r.status ?? 200,
			headers: { 'Content-Type': 'application/json' },
		});
	}) as unknown as typeof fetch;
}

describe('D1 — 만료 안내가 HTTP 401 경로에도 붙는다', () => {
	// 벨로그는 만료 토큰에 GraphQL errors 가 아니라 HTTP 401 을 준다(실측).
	// 실사용 최빈 오류인데 힌트가 없으면 사용자가 원인을 못 찾는다.
	const expired = (status: number) =>
		new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({
				status,
				body: { errors: [{ message: 'Not logged in' }] },
			})),
		});

	test('HTTP 401 에 만료 안내가 붙는다', async () => {
		await assert.rejects(
			() => expired(401).request('{ x }'),
			(e: Error) => /1시간/.test(e.message),
		);
	});

	test('HTTP 403 에도 붙는다', async () => {
		await assert.rejects(
			() => expired(403).request('{ x }'),
			(e: Error) => /1시간/.test(e.message),
		);
	});

	test('무관한 4xx 에는 안 붙는다 — 잘못된 원인을 짚어주면 더 나쁘다', async () => {
		await assert.rejects(
			() => expired(400).request('{ x }'),
			(e: Error) => !/1시간/.test(e.message),
		);
	});
});

describe('D2 — 커서가 고착돼도 집계가 부풀지 않는다', () => {
	test('같은 id 가 반복돼도 한 번만 센다', async () => {
		// 재현: 커서를 무시하고 늘 같은 50편을 주는 서버.
		const stuck = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({
				body: {
					data: {
						posts: Array.from({ length: 50 }, (_, i) => ({
							id: `fixed-${i}`,
							title: `t${i}`,
						})),
					},
				},
			})),
		});
		const { posts } = await fetchAllPosts(stuck, 'u', 5);
		assert.equal(posts.length, 50, `중복 수집됨 (${posts.length}편). 통계가 배수로 부푼다`);
	});

	test('커서가 제자리면 즉시 멈춘다 — 낭비 요청을 안 한다', async () => {
		let calls = 0;
		const stuck = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => {
				calls++;
				return {
					body: {
						data: {
							posts: Array.from({ length: 50 }, (_, i) => ({ id: `f-${i}`, title: 't' })),
						},
					},
				};
			}),
		});
		await fetchAllPosts(stuck, 'u', 10);
		assert.ok(calls <= 2, `커서 고착에도 ${calls}회 요청했다`);
	});

	test('정상 페이지네이션은 그대로 동작한다', async () => {
		let page = 0;
		const paging = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => {
				const base = page * 50;
				page++;
				return {
					body: {
						data: {
							posts:
								page <= 2
									? Array.from({ length: 50 }, (_, i) => ({
											id: `p-${base + i}`,
											title: 't',
										}))
									: [{ id: 'last', title: 't' }],
						},
					},
				};
			}),
		});
		const { posts, truncated } = await fetchAllPosts(paging, 'u', 10);
		assert.equal(posts.length, 101, '정상 페이지네이션이 깨졌다');
		assert.equal(truncated, false);
	});

	test('posts 가 null 이어도 터지지 않는다', async () => {
		const nullish = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({ body: { data: { posts: null } } })),
		});
		const { posts } = await fetchAllPosts(nullish, 'u', 3);
		assert.deepEqual(posts, []);
	});
});

describe('D4 — 발행된 글을 임시저장으로 끌어내리지 않는다', () => {
	async function serverWith(postState: { is_temp?: boolean } | null) {
		const calls: string[] = [];
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch((body) => {
				const query = (body as { query: string }).query;
				calls.push(query.includes('PostState') ? 'check' : 'edit');
				if (query.includes('PostState')) return { body: { data: { post: postState } } };
				return {
					body: {
						data: {
							editPost: {
								id: 'x',
								title: 't',
								url_slug: 's',
								is_temp: true,
								user: { username: 'u' },
							},
						},
					},
				};
			}),
		});
		const server = createServer(client);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'h', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		return { mcp, calls };
	}

	const args = { id: 'some-id', title: 't', body: 'b' };

	test('발행글 id 를 주면 수정하지 않고 거부한다', async () => {
		const { mcp, calls } = await serverWith({ is_temp: false });
		const r = await mcp.callTool({ name: 'velog_update_draft', arguments: args });
		assert.equal(r.isError, true, '발행글인데 통과했다');
		assert.ok(!calls.includes('edit'), 'editPost 가 실제로 호출됐다 — 글이 비공개가 된다');
		await mcp.close();
	});

	test('없는 id 는 명확히 알린다', async () => {
		const { mcp, calls } = await serverWith(null);
		const r = await mcp.callTool({ name: 'velog_update_draft', arguments: args });
		assert.equal(r.isError, true);
		assert.ok(!calls.includes('edit'));
		await mcp.close();
	});

	test('진짜 초안은 정상 수정된다', async () => {
		const { mcp, calls } = await serverWith({ is_temp: true });
		const r = await mcp.callTool({ name: 'velog_update_draft', arguments: args });
		assert.notEqual(r.isError, true, '정상 초안인데 막혔다');
		assert.ok(calls.includes('edit'));
		await mcp.close();
	});
});

describe('★ 발행 차단 — 실제 전송 payload 로 검증한다', () => {
	// 도구 스키마 검사만으로는 부족하다. 벨로그로 나가는 variables 를 직접 본다.
	async function captureDraftPayload(args: Record<string, unknown>) {
		let sent: { variables: { input: Record<string, unknown> } } | null = null;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch((body) => {
				sent = body as typeof sent;
				return {
					body: {
						data: {
							writePost: {
								id: 'x',
								title: 't',
								url_slug: 's',
								is_temp: true,
								user: { username: 'u' },
							},
						},
					},
				};
			}),
		});
		const server = createServer(client);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'p', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		await mcp.callTool({ name: 'velog_create_draft', arguments: args });
		await mcp.close();
		return sent!.variables.input;
	}

	test('정상 호출은 is_temp:true 로 나간다', async () => {
		const input = await captureDraftPayload({ title: '제목', body: '본문' });
		assert.equal(input['is_temp'], true);
	});

	test('is_temp:false 를 주입해도 true 로 나간다', async () => {
		const input = await captureDraftPayload({
			title: '제목',
			body: '본문',
			is_temp: false,
		});
		assert.equal(input['is_temp'], true, '발행 우회 가능 — 설계 전제가 무너졌다');
	});

	test('url_slug 경로탈출이 정규화된다', async () => {
		const input = await captureDraftPayload({
			title: '제목',
			body: '본문',
			url_slug: '../../etc/passwd',
		});
		assert.ok(!String(input['url_slug']).includes('/'), '슬러그에 경로 구분자가 남았다');
		assert.ok(!String(input['url_slug']).includes('..'));
	});
});
