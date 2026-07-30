/**
 * 검증 과정에서 찾은 결함 4건의 회귀 테스트.
 *
 * 전부 '동작은 하지만 조용히 틀린' 종류라 테스트 없이는 다시 들어온다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { VelogClient } from '../client.ts';
import { fetchAllPosts } from '../tools/stats.ts';
import { isSafeImageUrl } from '../slug.ts';
import { formatPostList } from '../format.ts';
import { toMarkdown } from '../tools/export.ts';
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

describe('D5 — 썸네일 URL 스킴 검증 (코덱스 교차검증에서 발견)', () => {
	// zod 의 z.string().url() 은 형식만 보고 스킴은 안 따진다. 실측하면
	// javascript: / data: / file: 이 전부 통과한다. 썸네일은 남의 페이지에서
	// 렌더되므로 http/https 로 못 박아야 한다.
	test('위험한 스킴을 거부한다', () => {
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,<script>x</script>',
			'file:///etc/passwd',
			'ftp://x/a.png',
			'not-a-url',
			'',
		]) {
			assert.equal(isSafeImageUrl(bad), false, `${bad} 를 통과시켰다`);
		}
	});

	test('http/https 는 허용한다', () => {
		for (const ok of [
			'https://images.velog.io/x.png',
			'http://example.com/a.jpg',
			'https://cdn.example.com/path?query=1',
		]) {
			assert.equal(isSafeImageUrl(ok), true, `${ok} 를 막았다`);
		}
	});

	test('호스트 없는 형태는 URL 파싱 자체가 실패한다', () => {
		// 참고: 'http:///nohost' 는 실패하지 않는다 — URL 이 'http://nohost/' 로
		// 정규화한다(실측). 그래서 hostname 검사는 방어적 잔여물이고, 실제로
		// 걸러지는 건 파싱 실패 쪽이다.
		assert.equal(isSafeImageUrl('http://'), false);
		assert.equal(isSafeImageUrl('https://'), false);
	});

	test('도구 호출 단계에서 실제로 막힌다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({ body: { data: { writePost: {} } } })),
		});
		const server = createServer(client);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'u', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);

		// MCP 는 스키마 위반을 throw 가 아니라 isError:true 로 돌려준다(실측).
		const r = await mcp.callTool({
			name: 'velog_create_draft',
			arguments: { title: 't', body: 'b', thumbnail: 'javascript:alert(1)' },
		});
		assert.equal(r.isError, true, 'javascript: 썸네일이 통과했다');
		await mcp.close();
	});
});

describe('D6 — trending year 기간의 숨은 상한 (코덱스 교차검증)', () => {
	// 벨로그는 year + limit>20 이면 에러가 아니라 '빈 배열'을 준다.
	//   if (timeframe === 'year' && (offset > 1000 || limit > 20)) {
	//     console.log('Detected GraphQL Abuse', ip); return []
	//   }
	// 오류가 없으니 '올해 인기글이 없나보다'로 오독되고 서버는 abuse 로 기록한다.
	async function callTrending(args: Record<string, unknown>) {
		let sentLimit: unknown;
		const client = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch((body) => {
				sentLimit = (body as { variables: { input: { limit: number } } }).variables.input;
				return { body: { data: { trendingPosts: [] } } };
			}),
		});
		const server = createServer(client);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'y', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		const r = await mcp.callTool({ name: 'velog_trending_posts', arguments: args });
		await mcp.close();
		return { input: sentLimit as { limit: number; offset: number }, result: r };
	}

	test('year + limit>20 은 20 으로 깎아서 보낸다', async () => {
		const { input } = await callTrending({ timeframe: 'year', limit: 50 });
		assert.equal(input.limit, 20, `limit ${input.limit} 로 보냈다 — 빈 결과가 온다`);
	});

	test('깎았으면 조용히 넘어가지 않고 알린다', async () => {
		const { result } = await callTrending({ timeframe: 'year', limit: 50 });
		const text = String((result.content as Array<{ text: string }>)[0]?.text);
		assert.match(text, /낮췄습니다/, '깎은 사실을 안 알렸다');
	});

	test('year + offset>1000 도 깎는다', async () => {
		const { input } = await callTrending({
			timeframe: 'year',
			limit: 10,
			offset: 5000,
		});
		assert.equal(input.offset, 1000);
	});

	test('다른 기간은 손대지 않는다', async () => {
		const { input } = await callTrending({ timeframe: 'week', limit: 50 });
		assert.equal(input.limit, 50, 'week 인데 깎였다');
	});

	test('year 라도 상한 이내면 그대로 보낸다', async () => {
		const { input } = await callTrending({ timeframe: 'year', limit: 20 });
		assert.equal(input.limit, 20);
	});
});

describe('D7 — 초안 생성 시 series_id 가 버려지는 것을 알린다 (코덱스 교차검증)', () => {
	// write 경로:  if (series_id && !data.is_temp) appendToSeries(...)  ← 초안이면 무시
	// edit  경로:  is_temp 조건 없음                                    ← 초안이어도 붙음
	// 이 비대칭을 사용자가 알 방법이 없다.
	async function createDraft(args: Record<string, unknown>) {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({
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
			})),
		});
		const server = createServer(client);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 's', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		const r = await mcp.callTool({ name: 'velog_create_draft', arguments: args });
		await mcp.close();
		return String((r.content as Array<{ text: string }>)[0]?.text);
	}

	test('series_id 를 주면 적용 안 됐다고 경고한다', async () => {
		const text = await createDraft({ title: 't', body: 'b', series_id: 'sid' });
		assert.match(text, /적용되지 않았습니다/, '조용히 버려진 것을 안 알렸다');
		assert.match(text, /velog_update_draft/, '해결 방법을 안 알렸다');
	});

	test('series_id 를 안 주면 불필요한 경고를 붙이지 않는다', async () => {
		const text = await createDraft({ title: 't', body: 'b' });
		assert.ok(!/적용되지 않았습니다/.test(text));
	});
});

describe('D8 — 수집 결과를 3분류로 보고한다 (코덱스 교차검증)', () => {
	// truncated:boolean 하나로는 '다 봤다'와 '커서가 막혀 멈췄다'를 구분 못 한다.
	// 커서 고착인데 complete 로 보고하면 '첫 50편이 전부'라는 거짓말이 된다.
	const feeder = (handler: () => unknown[]) =>
		new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({ body: { data: { posts: handler() } } })),
		});

	test('커서 고착은 cursor_stalled 로 보고한다 — complete 가 아니다', async () => {
		const r = await fetchAllPosts(
			feeder(() => Array.from({ length: 50 }, (_, i) => ({ id: `same-${i}` }))),
			'u',
			5,
		);
		assert.equal(r.outcome, 'cursor_stalled');
		assert.equal(r.truncated, true, '더 있을 수 있는데 완료로 보고했다');
	});

	test('마지막 페이지까지 봤으면 complete', async () => {
		let n = 0;
		const r = await fetchAllPosts(
			feeder(() =>
				++n <= 1 ? Array.from({ length: 50 }, (_, i) => ({ id: `p${i}` })) : [{ id: 'last' }],
			),
			'u',
			5,
		);
		assert.equal(r.outcome, 'complete');
		assert.equal(r.truncated, false);
	});

	test('페이지 상한에 걸리면 page_limit', async () => {
		let m = 0;
		const r = await fetchAllPosts(
			feeder(() => Array.from({ length: 50 }, (_, i) => ({ id: `p${m++}-${i}` }))),
			'u',
			3,
		);
		assert.equal(r.outcome, 'page_limit');
		assert.equal(r.truncated, true);
	});
});

describe('D9 — nullable 필드에 null 이 와도 죽지 않는다 (코덱스 교차검증)', () => {
	// 공식 Post.gql 에서 title·url_slug·body 는 전부 nullable 이다.
	// updated_at 이 'non-null 선언인데 실데이터는 null' 이었던 전례가 있다.
	test('title 이 null 이어도 목록이 만들어진다', () => {
		const out = formatPostList([
			{ id: 'a', title: null, url_slug: 'x', user: { username: 'u' } },
		]);
		assert.match(out, /제목 없음/);
	});

	test('url_slug 가 null 이면 id 로 대체한다', () => {
		const out = formatPostList([{ id: 'abc-123', title: 't', url_slug: null }]);
		assert.match(out, /abc-123/);
		assert.ok(!out.includes('/null'), 'URL 에 null 이 박혔다');
	});

	test('백업 프론트매터가 null 로 깨지지 않는다', () => {
		const md = toMarkdown({ id: 'zz', title: null, url_slug: null, body: null }, 'me');
		assert.match(md, /title: "\(제목 없음\)"/);
		assert.match(md, /slug: "zz"/, 'slug 가 id 로 대체되지 않았다');
		assert.ok(!md.includes('null'), `프론트매터에 null 이 남았다:\n${md.slice(0, 200)}`);
	});
});
