/**
 * 검증 과정에서 찾은 결함 4건의 회귀 테스트.
 *
 * 전부 '동작은 하지만 조용히 틀린' 종류라 테스트 없이는 다시 들어온다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VelogClient } from '../client.ts';
import { fetchAllPosts } from '../tools/stats.ts';
import { isSafeImageUrl } from '../slug.ts';
import { formatPostList } from '../format.ts';
import { toMarkdown } from '../tools/export.ts';
import { createServer } from '../index.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const anonAuth = { kind: 'anonymous' as const };

const authed = {
	kind: 'authenticated' as const,
	credentials: { accessToken: 'tok12345678', refreshToken: undefined },
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

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
		// ⚠️ 예전에는 `expired(400)` 을 썼는데, 그 픽스처의 본문이 'Not logged in' 이라
		//   «무관한 4xx» 가 아니었다. 상태 코드로만 판정하던 시절에는 통과했지만,
		//   2026-09-14 에 비정상 HTTP 응답도 GraphQL 오류 본문을 읽게 바꾸면서
		//   본문이 근거가 됐다. 본문이 로그인 얘기를 하면 안내를 붙이는 쪽이 맞다.
		//   그래서 픽스처를 **진짜 무관한** 오류로 바꾼다. 가드의 의도는 그대로다.
		const unrelated = new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({
				status: 400,
				body: { errors: [{ message: 'Max limit is 100' }] },
			})),
		});
		await assert.rejects(
			() => unrelated.request('{ x }'),
			(e: Error) => !/1시간/.test(e.message),
		);
	});

	test('★ 본문이 로그인 얘기를 하면 상태가 4xx 여도 안내가 붙는다', async () => {
		// 상태 코드보다 본문이 정확하다. 벨로그는 같은 원인에 다른 상태를 준다.
		await assert.rejects(
			() => expired(400).request('{ x }'),
			(e: Error) => /1시간/.test(e.message),
		);
	});

	/**
	 * ★★ 여기가 «상태 기반» 안내의 가드다.
	 *
	 * 위 세 테스트는 본문이 로그인 얘기를 하는 픽스처라, 상태 기반 판정을 통째로
	 * 지워도 본문 판정이 받아내 전부 통과한다. 실제로 그 변이를 넣어 보니
	 * hardening 31/31 이 그대로 초록이었다(코덱스 지적, 2026-09-14 변이로 확인).
	 * 검출력은 «본문이 도와주지 않는» 픽스처로만 생긴다.
	 */
	const opaque = (status: number) =>
		new VelogClient({
			auth: { kind: 'anonymous' },
			sleepImpl: async () => {},
			fetchImpl: jsonFetch(() => ({
				status,
				body: { errors: [{ message: 'Invalid token' }] },
			})),
		});

	test('★★ 401·403 은 본문이 안 도와줘도 상태만으로 안내가 붙는다', async () => {
		for (const status of [401, 403]) {
			await assert.rejects(
				() => opaque(status).request('{ x }'),
				(e: Error) => {
					assert.match(e.message, /1시간/, `HTTP ${status} 에서 안내가 빠졌다`);
					return true;
				},
			);
		}
	});

	test('★ 429 는 상태만으로 붙이지 않는다 — 원인이 다르다', async () => {
		await assert.rejects(
			() => opaque(429).request('{ x }'),
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
		// 소유권 검증이 currentUser 를 조회하므로 목도 그걸 답해야 한다.
		// 대상 글의 작성자를 같은 계정으로 두어 '소유권은 통과, is_temp 로만 판정'
		// 하는 상황을 만든다.
		const owned = postState ? { ...postState, user: { username: 'me' } } : null;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch((body) => {
				const query = (body as { query: string }).query;
				if (query.includes('currentUser')) {
					return { body: { data: { currentUser: { id: 'u1', username: 'me' } } } };
				}
				calls.push(query.includes('PostState') ? 'check' : 'edit');
				if (query.includes('PostState')) return { body: { data: { post: owned } } };
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
		// 클로저 안에서 대입되므로 TS 제어흐름이 null 로 좁힌다. 명시적으로 넓힌다.
		let sent = null as { variables: { input: Record<string, unknown> } } | null;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: async () => {},
			fetchImpl: jsonFetch((body) => {
				// ★ **writePost 요청만** 붙잡는다. 예전엔 마지막 요청을 무조건 담았는데,
				//   초안 저장 뒤에 시리즈 힌트 조회가 한 번 더 나가면서 그 조회가
				//   mutation 을 밀어냈다 — is_temp 를 검사한다면서 seriesList 의
				//   variables 를 보고 있었다. "마지막 = 내가 보려던 것"은 가정일 뿐이다.
				const q = (body as { query?: string }).query ?? '';
				if (q.includes('writePost')) sent = body as typeof sent;
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
		if (!sent) throw new Error('mutation 이 전송되지 않았다');
		return sent.variables.input;
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
			// 시리즈 소유권 검증이 currentUser 와 seriesList 를 조회하므로
			// 목도 그걸 답해야 한다. 주어진 series_id 를 '내 것'으로 둔다.
			fetchImpl: jsonFetch((body) => {
				const query = (body as { query: string }).query;
				if (query.includes('currentUser')) {
					return { body: { data: { currentUser: { id: 'u1', username: 'u' } } } };
				}
				if (query.includes('seriesList')) {
					return { body: { data: { seriesList: [{ id: 'sid', name: 's' }] } } };
				}
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

describe('★★ 9차 — 클라이언트에서 코덱스가 짚은 결함들', () => {
	const noSleep = async (): Promise<void> => {};

	test('★★ 부분 성공의 id 도 마스킹을 거친다 — 조각별로 가리면 새 조각이 샌다', async () => {
		// 서버가 돌려준 id 에 토큰이 들어 있으면 그대로 나갔다. 조립이 끝난 전체를 가려야 한다.
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 500,
				body: {
					data: { writePost: { id: 'tok12345678' } },
					errors: [{ message: '하위 필드가 깨졌습니다' }],
				},
			})),
		});
		await assert.rejects(
			() => client.request('mutation { writePost { id } }'),
			(error: Error) => {
				assert.ok(!error.message.includes('tok12345678'), `토큰이 그대로 나왔다: ${error.message}`);
				assert.match(error.message, /이미 반영/);
				return true;
			},
		);
	});

	test('★★ 주석으로 시작하는 mutation 을 «읽기라 안전» 이라 하지 않는다', async () => {
		// GraphQL 은 `#` 주석을 공백처럼 다룬다. /^\s*mutation/ 만 보면 쓰기를 읽기로 읽는다.
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { writePost: { id: 'created-9' } }, errors: [{ message: '깨졌습니다' }] },
			})),
		});
		await assert.rejects(
			() => client.request('# 이 질의는 글을 만든다\nmutation { writePost { id } }'),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, '쓰기를 읽기로 읽었다');
				assert.doesNotMatch(error.message, /읽기라 바뀐 것은 없지만/);
				return true;
			},
		);
	});

	test('★★ 800자 뒤에 있는 일시 장애 문구도 재시도된다 — 표시용 절단이 판정을 바꾸면 안 된다', async () => {
		let calls = 0;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 2,
			fetchImpl: jsonFetch(() => {
				calls += 1;
				if (calls === 1) {
					return {
						status: 200,
						body: {
							data: null,
							errors: [{ message: `${'x'.repeat(900)} connection pool timeout` }],
						},
					};
				}
				return { status: 200, body: { data: { posts: [] } } };
			}),
		});
		const data = await client.request<{ posts: unknown[] }>('{ posts { id } }');
		assert.deepEqual(data.posts, []);
		assert.equal(calls, 2, `재시도하지 않았다 (호출 ${calls}회)`);
	});
});

describe('★★ 10차 — 9차 수정이 만든 결함들', () => {
	const noSleep = async (): Promise<void> => {};

	test('★★ 800자 경계에 걸친 토큰도 온전히 가려진다 — 자른 뒤 가리면 앞부분이 남는다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: null, errors: [{ message: `${'x'.repeat(790)}tok12345678 뒤쪽` }] },
			})),
		});
		await assert.rejects(
			() => client.request('{ posts { id } }'),
			(error: Error) => {
				assert.ok(!error.message.includes('tok123456'), `토큰 조각이 남았다: ${error.message.slice(770, 830)}`);
				return true;
			},
		);
	});

	test('★★ 주석이 101줄이어도 mutation 은 쓰기다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { writePost: { id: 'created-10' } }, errors: [{ message: '깨졌습니다' }] },
			})),
		});
		await assert.rejects(
			() => client.request('# c\n'.repeat(101) + 'mutation { writePost { id } }'),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, '주석이 많으면 읽기로 읽었다');
				return true;
			},
		);
	});

	test('★★ CR 로 끝나는 주석 뒤의 mutation 도 쓰기다 — GraphQL 줄바꿈은 셋이다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { writePost: { id: 'created-11' } }, errors: [{ message: '깨졌습니다' }] },
			})),
		});
		await assert.rejects(
			() => client.request('# c\rmutation { writePost { id } }'),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, 'CR 주석을 못 걷어냈다');
				return true;
			},
		);
	});
});

describe('★★ 11차 — 10차 수정이 만든 결함들', () => {
	const noSleep = async (): Promise<void> => {};
	const partialWrite = () =>
		new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { writePost: { id: 'created-12' } }, errors: [{ message: '깨졌습니다' }] },
			})),
		});

	test('★★ fragment 가 앞에 오는 mutation 도 쓰기다 — 문서 맨 앞만 보면 안 된다', async () => {
		await assert.rejects(
			() => partialWrite().request('fragment F on Post { id }\nmutation M { writePost { ...F } }'),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, 'fragment 가 앞서면 읽기로 읽었다');
				return true;
			},
		);
	});

	test('★ 문자열 리터럴 안의 mutation 은 쓰기가 아니다 — 본문에 그 낱말을 쓴 글이 있다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { posts: [{ id: 'p1' }] }, errors: [{ message: '하위가 깨졌습니다' }] },
			})),
		});
		await assert.rejects(
			() => client.request('query Q { posts(where: "mutation") { id } }'),
			(error: Error) => {
				assert.doesNotMatch(error.message, /두 번 적용/, '문자열 안의 낱말을 쓰기로 읽었다');
				return true;
			},
		);
	});

	test('★★ 800자 뒤에 있는 만료 문구에도 토큰 갱신 안내가 붙는다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: null, errors: [{ message: `${'x'.repeat(900)} Not logged in` }] },
			})),
		});
		await assert.rejects(
			() => client.request('{ posts { id } }'),
			(error: Error) => {
				assert.match(error.message, /토큰|VELOG_REFRESH_TOKEN/, `만료 안내가 없다: ${error.message.slice(-160)}`);
				return true;
			},
		);
	});
});

describe('★★ 12차 — 11차 수정이 만든 결함들', () => {
	const noSleep = async (): Promise<void> => {};
	const partialWrite = () =>
		new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { writePost: { id: 'created-13' } }, errors: [{ message: '깨졌습니다' }] },
			})),
		});
	const partialRead = () =>
		new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { posts: [{ id: 'p1' }] }, errors: [{ message: '하위가 깨졌습니다' }] },
			})),
		});

	test('★★ 블록 문자열 안의 이스케이프된 종료자를 «끝» 으로 읽지 않는다', async () => {
		// `\"""` 는 문자열의 끝이 아니다. 끝으로 읽으면 뒤의 mutation 까지 문자열로 삼킨다.
		const query = 'fragment F on Post { title(format: """\\""" """) }\nmutation M { writePost { ...F } }';
		await assert.rejects(
			() => partialWrite().request(query),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, '이스케이프된 종료자에 속아 쓰기를 놓쳤다');
				return true;
			},
		);
	});

	test('★★ 연산 이름이 mutation 인 읽기를 쓰기로 읽지 않는다', async () => {
		// `query mutation { … }` 는 이름이 mutation 인 **읽기**다. 정의의 첫 낱말만 키워드다.
		await assert.rejects(
			() => partialRead().request('query mutation { posts { id } }'),
			(error: Error) => {
				assert.doesNotMatch(error.message, /두 번 적용/, '연산 이름을 키워드로 읽었다');
				return true;
			},
		);
	});

	test('★ fragment 이름이 mutation 이어도 읽기다', async () => {
		await assert.rejects(
			() => partialRead().request('fragment mutation on Post { id }\nquery Q { posts { ...mutation } }'),
			(error: Error) => {
				assert.doesNotMatch(error.message, /두 번 적용/, 'fragment 이름을 키워드로 읽었다');
				return true;
			},
		);
	});

	test('★★ 문자열 안의 중괄호를 세면 안 된다 — 깊이가 어긋나 뒤가 통째로 오판된다', async () => {
		// ⚠️ 이 입력이 핵심이다. 문자열을 건너뛰지 않으면 `"{"` 때문에 깊이가 안 닫혀
		//   뒤의 mutation 이 깊이 0 이 아니게 되고, 쓰기를 놓친다. 문자열 처리를 빼면 깨진다.
		const query = 'query Q { posts(where: "a{b") { id } }\nmutation M { writePost { id } }';
		await assert.rejects(
			() => partialWrite().request(query),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/, '문자열 안 중괄호를 세서 깊이가 어긋났다');
				return true;
			},
		);
	});
});

describe('★★ 13차 — 12차 수정이 만든 결함들', () => {
	const noSleep = async (): Promise<void> => {};

	test('★★ 500 + 부분 읽기 값 + 일시 장애는 다시 친다 — 읽기는 아무것도 안 바꾼다', async () => {
		// 기준 커밋 9267bf7 A/B: 기준은 2회째 성공, 이 코드는 1회 실패였다.
		// 비정상 HTTP 응답을 GraphQL 경로로 보내면서 «부분 성공» 표식이 읽기까지 막았다.
		let calls = 0;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 2,
			fetchImpl: jsonFetch(() => {
				calls += 1;
				if (calls === 1) {
					return {
						status: 500,
						body: {
							data: { post: { id: 'p1', title: 't', body: null } },
							errors: [{ message: 'Timed out fetching a new connection from the connection pool' }],
						},
					};
				}
				return { status: 200, body: { data: { post: { id: 'p1', title: 't', body: 'ok' } } } };
			}),
		});
		const data = await client.request<{ post: { body: string } }>('{ post(id: "p1") { id title body } }');
		assert.equal(data.post.body, 'ok');
		assert.equal(calls, 2, `읽기를 다시 치지 않았다 (호출 ${calls}회)`);
	});

	test('★★ 쓰기의 부분 성공은 여전히 다시 치지 않는다 — 두 번 만들면 안 된다', async () => {
		let calls = 0;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 2,
			fetchImpl: jsonFetch(() => {
				calls += 1;
				return {
					status: 500,
					body: {
						data: { writePost: { id: 'created-14' } },
						errors: [{ message: 'Timed out fetching a new connection from the connection pool' }],
					},
				};
			}),
		});
		await assert.rejects(
			() => client.request('mutation { writePost { id } }'),
			(error: Error) => {
				assert.match(error.message, /두 번 적용/);
				return true;
			},
		);
		assert.equal(calls, 1, `쓰기를 ${calls}회 쳤다 — 글이 여러 개 생긴다`);
	});

	test('★★ 변수 정의의 ) 를 «정의 끝» 으로 읽지 않는다 — 뒤의 지시어 이름이 키워드가 된다', async () => {
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { posts: [{ id: 'p1' }] }, errors: [{ message: '하위가 깨졌습니다' }] },
			})),
		});
		await assert.rejects(
			() => client.request('query Q($x: Int = 1) @mutation { posts(limit: $x) { id } }'),
			(error: Error) => {
				assert.doesNotMatch(error.message, /두 번 적용/, '지시어 이름을 키워드로 읽었다');
				return true;
			},
		);
	});
});

/**
 * ★★ 14~17차 교차검증에서 고친 것들의 회귀 테스트.
 *
 * 규율 하나: **결함 케이스와 정상 케이스를 짝으로 둔다.**
 * 「깨진 입력을 막는다」만 시험하면, 막느라 정상까지 막아도 초록이 뜬다.
 * 실제로 이번에 그 사고를 냈다 — 관통 감사를 넓혔다가 노드 둘짜리 기본 그림이
 * 「관통 2건」이 됐다. 대조군이 있어야 그게 보인다.
 */
describe('★★ 14~17차 회귀 — 고친 것과 «정상이 그대로인가»', () => {
	const noSleep = async (): Promise<void> => {};

	/** YAML 이중따옴표 스칼라를 되돌린다. 「지워버리는」 구현을 가려내려고 쓴다. */
	const unescapeYamlDouble = (line: string): string => {
		const body = /^title: "(.*)"$/s.exec(line)?.[1] ?? '';
		return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
			if (esc.startsWith('u') || esc.startsWith('x')) {
				return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
			}
			const map: Record<string, string> = {
				n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"',
			};
			return map[esc] ?? esc;
		});
	};

	describe('내보내기 YAML — 제어문자는 막고, 평범한 제목은 그대로', () => {
		const front = (title: string): string =>
			toMarkdown(
				{ id: 'p1', title, url_slug: 's', body: 'x', tags: [], released_at: '2026-01-01' } as never,
				'me',
			)
				.split('\n')
				.find((l) => l.startsWith('title:')) ?? '';

		test('★ 줄바꿈이 프론트매터를 쪼개지 않는다', () => {
			const line = front(`첫째${String.fromCharCode(10)}둘째`);
			assert.equal(line, 'title: "첫째\\n둘째"');
		});

		test('★ 제어문자는 탈출되고, 되읽으면 **원문 그대로**다', () => {
			// ⚠️ 「그대로 나가지 않는다」만 보면 **지워버리는** 구현도 통과한다
			//   (코덱스 19차: C1 분기를 `return ''` 로 바꿔도 초록이었다).
			//   YAML 이중따옴표 탈출을 되돌려 **입력과 같은지**까지 본다.
			// ⚠️ 목록에 빠진 코드포인트는 «지워버려도» 안 잡힌다. U+0085(NEL)가 그랬다.
			//   탈출 대상으로 정한 구간을 **전부** 훑는다.
			// ⚠️ 표본을 뽑으면 **뽑히지 않은 코드포인트만 지우는** 변이를 놓친다.
			//   소스가 정한 구간(U+0000–001F, U+007F–009F, LS/PS, 비문자)을 **전부** 훑는다.
			const targets: number[] = [];
			for (let cp = 0x00; cp <= 0x1f; cp += 1) targets.push(cp);
			for (let cp = 0x7f; cp <= 0x9f; cp += 1) targets.push(cp);
			targets.push(0x2028, 0x2029, 0xfffe, 0xffff);
			for (const cp of targets) {
				const original = `앞${String.fromCharCode(cp)}뒤`;
				const line = front(original);
				assert.ok(
					!line.includes(String.fromCharCode(cp)),
					`U+${cp.toString(16)} 가 그대로 나갔다`,
				);
				assert.equal(unescapeYamlDouble(line), original, `U+${cp.toString(16)} 가 왕복에서 달라졌다`);
			}
		});

		test('☑ 대조군 — 한글·영문·이모지·따옴표는 원래대로 실린다', () => {
			assert.equal(front('평범한 제목'), 'title: "평범한 제목"');
			assert.equal(front('Hello, world'), 'title: "Hello, world"');
			assert.equal(front('이모지 🎉 포함'), 'title: "이모지 🎉 포함"');
			// 따옴표와 역슬래시만 탈출되고 나머지는 손대지 않는다.
			assert.equal(front('그가 "안녕" 했다'), 'title: "그가 \\"안녕\\" 했다"');
		});

		test('☑ 대조군 — 서로게이트 쌍이 쪼개지지 않는다', () => {
			const line = front('𠀀 글자');
			assert.ok(line.includes('𠀀'), `이모지가 탈출돼 버렸다: ${line}`);
		});
	});

	describe('whoami — 만료를 잡고, 다른 경로의 캐시는 살린다', () => {
		const makeClient = (state: { expired: boolean; calls: number }) =>
			new VelogClient({
				auth: authed,
				sleepImpl: noSleep,
				maxRetries: 0,
				fetchImpl: jsonFetch(() => {
					state.calls += 1;
					if (state.expired) {
						return { status: 401, body: { errors: [{ message: 'User is not logged in' }] } };
					}
					return { status: 200, body: { data: { currentUser: { id: 'u1', username: 'me', profile: {} } } } };
				}),
			});

		const callWhoami = async (client: VelogClient): Promise<string> => {
			const server = createServer(client);
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			const mcp = new Client({ name: 't', version: '0' });
			await mcp.connect(b);
			const res = (await mcp.callTool({ name: 'velog_whoami', arguments: {} })) as {
				content: Array<{ text?: string }>;
			};
			await mcp.close();
			return res.content.map((c) => c.text ?? '').join('\n');
		};

		test('★ 토큰이 만료되면 «인증됨» 이라고 하지 않는다 — 캐시를 건너뛴다', async () => {
			const state = { expired: false, calls: 0 };
			const client = makeClient(state);
			assert.match(await callWhoami(client), /인증됨/);
			const afterFirst = state.calls;
			state.expired = true;
			const second = await callWhoami(client);
			assert.doesNotMatch(second, /✅ 인증됨/, '만료된 뒤에도 인증됨이라고 했다');
			assert.ok(state.calls > afterFirst, '서버에 다시 묻지 않았다 (캐시를 돌려줬다)');
		});

		test('☑ 대조군 — username 을 푸는 경로는 캐시를 그대로 쓴다', async () => {
			const state = { expired: false, calls: 0 };
			const client = makeClient(state);
			const { resolveMyUsername } = await import('../me.ts');
			assert.equal(await resolveMyUsername(client), 'me');
			const afterFirst = state.calls;
			assert.equal(await resolveMyUsername(client), 'me');
			assert.equal(state.calls, afterFirst, '캐시가 있는데 또 물었다');
		});
	});

	describe('오류 코드 — 토큰은 가리고, 평범한 코드는 남긴다', () => {
		const codesFor = async (code: string): Promise<readonly string[]> => {
			const client = new VelogClient({
				auth: authed,
				sleepImpl: noSleep,
				maxRetries: 0,
				fetchImpl: jsonFetch(() => ({
					status: 200,
					body: { data: null, errors: [{ message: '거부', extensions: { code } }] },
				})),
			});
			try {
				await client.request('{ posts { id } }');
				return [];
			} catch (error) {
				return (error as { detail?: { graphqlErrorCodes?: readonly string[] } }).detail
					?.graphqlErrorCodes ?? [];
			}
		};

		test('★ 오류 코드에 되비친 토큰은 detail 에도 남지 않는다', async () => {
			const codes = await codesFor('tok12345678');
			assert.ok(!codes.join(',').includes('tok12345678'), `토큰이 남았다: ${codes.join(',')}`);
		});

		test('☑ 대조군 — 평범한 코드는 그대로 보존된다 (진단에 쓴다)', async () => {
			assert.deepEqual(await codesFor('UNAUTHENTICATED'), ['UNAUTHENTICATED']);
			assert.deepEqual(await codesFor('BAD_USER_INPUT'), ['BAD_USER_INPUT']);
		});
	});

	describe('통계 페이지네이션 — 끝과 고착을 가른다', () => {
		const run = async (pages: Array<Array<{ id: string }>>) => {
			let i = 0;
			const client = new VelogClient({
				auth: anonAuth,
				sleepImpl: noSleep,
				maxRetries: 0,
				fetchImpl: jsonFetch(() => ({ status: 200, body: { data: { posts: pages[i++] ?? [] } } })),
			});
			return fetchAllPosts(client, 'me', 10);
		};
		const page = (n: number, from = 0) =>
			Array.from({ length: n }, (_, k) => ({ id: `p${from + k}` }));

		test('★ 꽉 찬 마지막 페이지 뒤의 빈 페이지는 «다 봤다» 다', async () => {
			const r = await run([page(50), []]);
			assert.equal(r.outcome, 'complete');
			assert.equal(r.truncated, false);
			assert.equal(r.posts.length, 50);
		});

		test('☑ 대조군 — 같은 페이지를 되풀이하면 여전히 «고착» 으로 잡는다', async () => {
			const r = await run([page(50), page(50)]);
			assert.equal(r.outcome, 'cursor_stalled', '커서 고착 탐지가 약해졌다');
			assert.equal(r.truncated, true);
		});

		test('☑ 대조군 — 덜 찬 페이지에서 끝나는 평범한 경우', async () => {
			const r = await run([page(50), page(10, 50)]);
			assert.equal(r.outcome, 'complete');
			assert.equal(r.posts.length, 60);
		});
	});

	describe('슬러그 — 서로게이트를 쪼개지 않고, 평범한 건 안 건드린다', () => {
		test('★ 상한 자리가 서로게이트 쌍 한가운데면 한 글자 물러선다', async () => {
			const { toUrlSlug } = await import('../slug.ts');
			const s = toUrlSlug(`${'a'.repeat(119)}\u{20000}`);
			assert.equal(s.isWellFormed(), true, '짝 잃은 서로게이트가 남았다');
		});

		test('☑ 대조군 — 상한 안쪽 제목은 글자 하나 안 잃는다', async () => {
			const { toUrlSlug } = await import('../slug.ts');
			assert.equal(toUrlSlug('hello world'), 'hello-world');
			assert.equal(toUrlSlug('한글 제목입니다'), '한글-제목입니다');
		});
	});

	describe('플러그인 환경 안내 — 인증된 설정을 «읽기 전용» 이라 하지 않는다', () => {
		test('★ 한쪽 토큰만 비었고 인증은 되는 경우', async () => {
			const { describeAnomalies } = await import('../plugin-env.ts');
			const text = describeAnomalies({ blanked: ['VELOG_ACCESS_TOKEN'], literal: [] }, true);
			assert.doesNotMatch(text, /읽기 전용/, '인증됐는데 읽기 전용이라고 했다');
		});

		test('☑ 대조군 — 진짜 인증이 안 되면 여전히 읽기 전용이라고 말한다', async () => {
			const { describeAnomalies } = await import('../plugin-env.ts');
			const text = describeAnomalies({ blanked: ['VELOG_REFRESH_TOKEN'], literal: [] }, false);
			assert.match(text, /읽기 전용/, '안내가 조용해졌다');
		});
	});
});

describe('★★ 16~17차 회귀 — 내보내기 구조 변경과 쓰기 도구 경계', () => {
	const noSleep = async (): Promise<void> => {};

	describe('백업 파일 이름 — 글마다 한 곳으로 정해진다', () => {
		test('★ 앞 100자가 같은 두 글이 서로를 덮어쓰지 않는다', async () => {
			const { safeFileName } = await import('../tools/export.ts');
			const long = 'a'.repeat(100);
			const a = safeFileName(`${long}-A`, 'id-A');
			const b = safeFileName(`${long}-B`, 'id-B');
			assert.notEqual(a, b, '서로 다른 글이 같은 파일로 간다');
		});

		test('★ 목록 순서가 바뀌어도 같은 글은 같은 파일로 간다 — 실제로 두 번 내보낸다', async () => {
			// ⚠️ 예전엔 `safeFileName(a) === safeFileName(a)` 를 비교했다. 그건 동어반복이라
			//   **호출부**가 이름에 순번을 도로 붙여도 통과했다(코덱스 19차가 변이로 증명).
			//   그래서 핸들러를 실제로 돌려 «디스크에 생긴 이름» 을 본다.
			const runExport = async (order: Array<{ id: string; url_slug: string }>): Promise<string[]> => {
				const dir = await mkdtemp(join(tmpdir(), 'velog-order-'));
				const client = new VelogClient({
					auth: authed,
					sleepImpl: noSleep,
					maxRetries: 0,
					fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
						const body = JSON.parse(init?.body ?? '{}') as {
							query?: string;
							variables?: { input?: { url_slug?: string } };
						};
						const q = body.query ?? '';
						if (q.includes('currentUser')) {
							return jsonResponse({ data: { currentUser: { id: 'u', username: 'me' } } });
						}
						if (/posts\s*\(/.test(q)) return jsonResponse({ data: { posts: order } });
						const slug = body.variables?.input?.url_slug;
						const found = order.find((p) => p.url_slug === slug) ?? order[0];
						return jsonResponse({
							data: { post: { ...found, title: found?.id, body: 'b', tags: [], released_at: '2026-01-01' } },
						});
					}) as unknown as typeof fetch,
				});
				const server = createServer(client);
				const [a, b] = InMemoryTransport.createLinkedPair();
				await server.connect(a);
				const mcp = new Client({ name: 't', version: '0' });
				await mcp.connect(b);
				await mcp.callTool({ name: 'velog_export_posts', arguments: { out_dir: dir, limit: 2 } });
				await mcp.close();
				return (await readdir(dir)).sort();
			};

			const first = { id: 'id-1', url_slug: 'my-post' };
			const second = { id: 'id-2', url_slug: 'other-post' };
			const forward = await runExport([first, second]);
			const reversed = await runExport([second, first]);
			assert.deepEqual(forward, reversed, '목록 순서가 바뀌자 파일 이름이 달라졌다');
			assert.equal(forward.length, 2);
		});

		test('☑ 대조군 — 이름이 읽을 수 있고 .md 로 끝난다', async () => {
			const { safeFileName } = await import('../tools/export.ts');
			const name = safeFileName('hello-world', 'abc123');
			assert.match(name, /^hello-world--abc123\.md$/);
		});

		test('☑ 대조군 — 슬러그가 비거나 id 가 이상해도 쓸 수 있는 이름이 나온다', async () => {
			const { safeFileName } = await import('../tools/export.ts');
			for (const [slug, id] of [['', 'id1'], ['!!!', 'id2'], ['ok', '../../etc/passwd']]) {
				const name = safeFileName(slug ?? '', id ?? '');
				assert.ok(!name.includes('/') && !name.includes('\\'), `경로 문자가 남았다: ${name}`);
				assert.ok(name.endsWith('.md') && name.length > 3, `쓸 수 없는 이름: ${name}`);
			}
		});
	});

	describe('제목 길이 — 잘리기 전에 거절하고, 상한 안쪽은 통과시킨다', () => {
		const createDraft = async (title: string) => {
			const client = new VelogClient({
				auth: authed,
				sleepImpl: noSleep,
				maxRetries: 0,
				// ⚠️ 이 도구는 저장 뒤에 «정말 임시저장으로 들어갔나» 를 확인한다.
				//   is_temp 를 빼면 도구가 «예상치 못한 상태» 로 막는다 — 그게 맞는 동작이다.
				//   대조군이 그 사실을 잡아 줬다. 픽스처를 실제 응답 모양으로 맞춘다.
				fetchImpl: jsonFetch(() => ({
					status: 200,
					body: {
						data: {
							writePost: {
								id: 'new-1',
								url_slug: 's',
								title: title.slice(0, 255),
								is_temp: true,
								is_private: true,
							},
						},
					},
				})),
			});
			const server = createServer(client);
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			const mcp = new Client({ name: 't', version: '0' });
			await mcp.connect(b);
			try {
				const res = (await mcp.callTool({
					name: 'velog_create_draft',
					arguments: { title, body: '본문' },
				})) as { isError?: boolean };
				return res.isError === true ? 'error' : 'ok';
			} catch {
				return 'error';
			} finally {
				await mcp.close();
			}
		};

		test('★ 256자 제목은 저장 전에 거절한다 — 서버는 말없이 자른다', async () => {
			assert.equal(await createDraft('가'.repeat(256)), 'error');
		});

		test('☑ 대조군 — 정확히 255자는 통과한다', async () => {
			assert.equal(await createDraft('가'.repeat(255)), 'ok');
		});

		test('☑ 대조군 — 평범한 길이의 제목은 통과한다', async () => {
			assert.equal(await createDraft('평범한 글 제목'), 'ok');
		});
	});

	describe('MCP annotations — 실제 동작과 맞는다', () => {
		const annotationsOf = async (): Promise<Map<string, Record<string, unknown>>> => {
			const client = new VelogClient({
				auth: authed,
				sleepImpl: noSleep,
				fetchImpl: jsonFetch(() => ({ status: 200, body: { data: {} } })),
			});
			const server = createServer(client, { publicPublish: true, editProfile: true });
			const [a, b] = InMemoryTransport.createLinkedPair();
			await server.connect(a);
			const mcp = new Client({ name: 't', version: '0' });
			await mcp.connect(b);
			const list = await mcp.listTools();
			await mcp.close();
			return new Map(
				list.tools.map((t) => [t.name, (t.annotations ?? {}) as Record<string, unknown>]),
			);
		};

		test('★ 초안 생성은 destructive 다 — 서버가 기존 글을 비공개로 바꿀 수 있다', async () => {
			// 근거는 capabilities.ts 의 실측: 최근 5분 공개 글 검사가 공개 여부보다 먼저 돈다.
			const ann = await annotationsOf();
			assert.equal(ann.get('velog_create_draft')?.['destructiveHint'], true);
		});

		test('★ 수정 도구는 idempotent 가 아니다 — 슬러그가 겹치면 주소가 매번 달라진다', async () => {
			const ann = await annotationsOf();
			for (const name of ['velog_update_draft', 'velog_update_post']) {
				assert.equal(ann.get(name)?.['idempotentHint'], false, `${name} 이 idempotent 라고 한다`);
			}
		});

		test('☑ 대조군 — 읽기 도구는 readOnly 로 남아 있다', async () => {
			const ann = await annotationsOf();
			for (const name of ['velog_list_posts', 'velog_get_post', 'velog_diagnose', 'velog_whoami']) {
				assert.equal(ann.get(name)?.['readOnlyHint'], true, `${name} 이 읽기 전용이 아니다`);
			}
		});

		test('☑ 대조군 — 모든 쓰기 도구가 readOnlyHint:false 를 단다', async () => {
			const ann = await annotationsOf();
			for (const name of ['velog_create_draft', 'velog_publish_post', 'velog_upload_image']) {
				assert.equal(ann.get(name)?.['readOnlyHint'], false, `${name} 이 읽기 전용이라 한다`);
			}
		});
	});

	describe('발행 상한 안내 — 경계를 정확히 말한다', () => {
		test('★ 「10건 이상」이라고 말한다 — 서버는 정확히 10건에서 이미 동작한다', async () => {
			const { PublishRateLimitError } = await import('../ratelimit.ts');
			const message = new PublishRateLimitError(1000).message;
			assert.match(message, /10건 이상/);
			assert.doesNotMatch(message, /10건을 넘으면/, '한 건 차이를 잘못 안내한다');
		});
	});
});

describe('★★ 19차 회귀 — 결과 보고가 사실과 맞는가', () => {
	const noSleep = async (): Promise<void> => {};

	let firstDetailDone = false;

	const exportWith = async (
		handler: (body: { query?: string }) => { status?: number; body: unknown },
	): Promise<{ text: string; isError: boolean; files: string[] }> => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-report-'));
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(handler as never),
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_export_posts',
			arguments: { out_dir: dir, limit: 2 },
		})) as { content: Array<{ text?: string }>; isError?: boolean };
		await mcp.close();
		return {
			text: res.content.map((c) => c.text ?? '').join('\n'),
			isError: res.isError === true,
			files: (await readdir(dir)).sort(),
		};
	};

	test('★ 한 편도 못 받았으면 오류로 보고한다 — «✅ 0편» 은 거짓말이다', async () => {
		const r = await exportWith((body) => {
			const q = body.query ?? '';
			if (q.includes('currentUser')) return { body: { data: { currentUser: { id: 'u', username: 'me' } } } };
			if (/posts\s*\(/.test(q)) {
				return { body: { data: { posts: [{ id: 'p1', url_slug: 's1' }] } } };
			}
			return { body: { data: { post: null } } }; // 본문 조회 실패
		});
		assert.equal(r.isError, true, `전건 실패인데 성공으로 보고했다: ${r.text.slice(0, 80)}`);
		assert.deepEqual(r.files, [], '파일이 없어야 한다');
	});

	test('☑ 대조군 — 정상 내보내기는 오류가 아니고 파일이 생긴다', async () => {
		const r = await exportWith((body) => {
			const q = body.query ?? '';
			if (q.includes('currentUser')) return { body: { data: { currentUser: { id: 'u', username: 'me' } } } };
			if (/posts\s*\(/.test(q)) return { body: { data: { posts: [{ id: 'p1', url_slug: 's1' }] } } };
			return {
				body: {
					data: { post: { id: 'p1', url_slug: 's1', title: 'T', body: 'B', tags: [], released_at: '2026-01-01' } },
				},
			};
		});
		assert.equal(r.isError, false, `정상인데 오류로 보고했다: ${r.text.slice(0, 120)}`);
		assert.equal(r.files.length, 1);
		assert.ok(r.files[0]?.includes('p1'), `파일 이름에 글 id 가 없다: ${r.files[0]}`);
	});

	test('☑ 대조군 — **부분 성공**은 오류가 아니다 (한 편 성공 + 한 편 실패)', async () => {
		// ⚠️ 전건 실패와 전건 성공만 보면, `nothingSaved` 조건을 빼는 변이가 통과한다.
		//   부분 성공까지 오류가 되면 모델은 받은 것마저 못 받은 줄 안다.
		const r = await exportWith((body) => {
			const q = body.query ?? '';
			if (q.includes('currentUser')) return { body: { data: { currentUser: { id: 'u', username: 'me' } } } };
			if (/posts\s*\(/.test(q)) {
				return { body: { data: { posts: [{ id: 'p1', url_slug: 's1' }, { id: 'p2', url_slug: 's2' }] } } };
			}
			// 첫 글만 성공시킨다.
			if (firstDetailDone) return { body: { data: { post: null } } };
			firstDetailDone = true;
			return {
				body: {
					data: {
						post: { id: 'p1', url_slug: 's1', title: 'T', body: 'B', tags: [], released_at: '2026-01-01' },
					},
				},
			};
		});
		assert.equal(r.isError, false, `부분 성공을 오류로 보고했다: ${r.text.slice(0, 120)}`);
		assert.equal(r.files.length, 1);
	});

	test('☑ 대조군 — 실패해도 임시 파일(.part)을 남기지 않는다', async () => {
		const r = await exportWith((body) => {
			const q = body.query ?? '';
			if (q.includes('currentUser')) return { body: { data: { currentUser: { id: 'u', username: 'me' } } } };
			if (/posts\s*\(/.test(q)) return { body: { data: { posts: [{ id: 'p1', url_slug: 's1' }] } } };
			return { body: { data: { post: null } } };
		});
		assert.deepEqual(r.files.filter((f) => f.endsWith('.part')), [], '임시 파일이 남았다');
	});

	test('★ 소개글을 조회할 때 앞뒤 공백을 지우지 않는다 — 합치면 코드블록이 망가진다', async () => {
		const about = '    console.log("indented");\n\n';
		const client = new VelogClient({
			auth: anonAuth,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { user: { id: 'u', username: 'me', profile: { about, display_name: 'N' } } } },
			})),
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_get_user',
			arguments: { username: 'me' },
		})) as { content: Array<{ text?: string }> };
		await mcp.close();
		const text = res.content.map((c) => c.text ?? '').join('\n');
		// ⚠️ `includes` 로 앞 공백만 보면 **끝 개행을 지우는** 변이(trimEnd)가 통과한다.
		//   소개글 구간을 떼어 **원문 그대로인지** 본다.
		const section = text.slice(text.indexOf('## 소개글') + '## 소개글\n'.length);
		assert.equal(section, about, `소개글이 원문과 다르다: ${JSON.stringify(section)}`);
	});

	test('☑ 대조군 — 20,000자 경계에서 서로게이트가 반으로 갈리지 않는다', async () => {
		const about = `${'a'.repeat(19_999)}😀`;
		const client = new VelogClient({
			auth: anonAuth,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: jsonFetch(() => ({
				status: 200,
				body: { data: { user: { id: 'u', username: 'me', profile: { about, display_name: 'N' } } } },
			})),
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_get_user',
			arguments: { username: 'me' },
		})) as { content: Array<{ text?: string }> };
		await mcp.close();
		const text = res.content.map((c) => c.text ?? '').join('\n');
		assert.equal(text.isWellFormed(), true, '짝 잃은 서로게이트가 남았다');
		// ⚠️ 길이만 보면 안 된다. 뒤에 붙는 «잘랐습니다» 경고문까지 세어져서,
		//   본문을 두 글자 더 지워도 총 길이는 넘는다(코덱스 22차: cut-=2 가 통과).
		//   **경고문을 뺀 본문**을 기대값과 글자 그대로 견준다.
		// ⚠️ 경고문 앞에는 빈 줄이 하나 있다. `\n⚠️` 로 자르면 그 빈 줄이 본문에 붙어
		//   길이가 한 글자 늘어난다 — 그만큼 «더 지우는» 변이를 가려 준다.
		const body = (
			text.slice(text.indexOf('## 소개글') + '## 소개글\n'.length).split('\n⚠️')[0] ?? ''
		).replace(/\n+$/, '');
		assert.equal(body, 'a'.repeat(19_999), `본문이 기대와 다르다 (${body.length}자)`);
	});
});

describe('★★ 21차 — 못 잡던 변이 셋을 잡는 픽스처', () => {
	const noSleep = async (): Promise<void> => {};

	/**
	 * ⚠️ 이 셋은 **쓰기 경로에 실제로 도달해야** 잡힌다. 지금까지는 본문 조회를
	 *   실패시켜 그 앞에서 끝났고, 그래서 `.part` 정리·취소 확인·rename 을 지워도
	 *   초록이었다(코덱스 20차). 조회는 성공시키고 **쓰기 자체를 실패·취소**시킨다.
	 */
	const exportInto = async (
		dir: string,
		opts: { cancelAfterDetail?: boolean; posts?: number } = {},
	): Promise<{ isError: boolean; text: string }> => {
		const count = opts.posts ?? 1;
		const list = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, url_slug: `s${i}` }));
		const controller = new AbortController();
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as { query?: string };
				const q = body.query ?? '';
				if (q.includes('currentUser')) {
					return jsonResponse({ data: { currentUser: { id: 'u', username: 'me' } } });
				}
				if (/posts\s*\(/.test(q)) return jsonResponse({ data: { posts: list } });
				// 상세 조회는 성공시킨다 — 쓰기 경로까지 가야 한다.
				if (opts.cancelAfterDetail) controller.abort();
				return jsonResponse({
					data: {
						post: { id: 'p0', url_slug: 's0', title: 'T', body: 'B', tags: [], released_at: '2026-01-01' },
					},
				});
			}) as unknown as typeof fetch,
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool(
			{ name: 'velog_export_posts', arguments: { out_dir: dir, limit: count } },
			undefined,
			{ signal: controller.signal },
		).catch((error: unknown) => ({
			content: [{ text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		}))) as { content: Array<{ text?: string }>; isError?: boolean };
		await mcp.close();
		return { isError: res.isError === true, text: res.content.map((c) => c.text ?? '').join('\n') };
	};

	test('★ 취소되면 최종 파일을 확정하지 않는다', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-cancel-'));
		await exportInto(dir, { cancelAfterDetail: true });
		const files = await readdir(dir);
		assert.deepEqual(
			files.filter((f) => f.endsWith('.md')),
			[],
			`취소했는데 최종 파일이 생겼다: ${files.join(', ')}`,
		);
	});

	test('★ **쓰기가 끝난 뒤 실패**해도 임시 파일을 남기지 않는다', async () => {
		// ⚠️ 취소로는 이 경로에 못 간다 — SDK 가 쓰기 **전에** 먼저 끊는다(실측).
		//   그래서 «쓰기는 성공하고 rename 만 실패하는» 상황을 만든다:
		//   목표 이름 자리에 **디렉터리**를 미리 만들어 두면 rename 이 반드시 실패한다.
		//   여기가 `.part` 정리를 지나는 유일한 결정적 경로다.
		const { safeFileName } = await import('../tools/export.ts');
		const { mkdir } = await import('node:fs/promises');
		const dir = await mkdtemp(join(tmpdir(), 'velog-rename-'));
		await mkdir(join(dir, safeFileName('s0', 'p0')));

		const r = await exportInto(dir);
		const files = await readdir(dir);
		assert.deepEqual(
			files.filter((f) => f.endsWith('.part')),
			[],
			`rename 실패 뒤 임시 파일이 남았다: ${files.join(', ')}`,
		);
		assert.equal(r.isError, true, '한 편도 못 받았는데 성공으로 보고했다');
	});

	test('☑ 대조군 — 취소하지 않으면 최종 파일이 생기고 임시 파일은 없다', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-ok-'));
		const r = await exportInto(dir);
		const files = await readdir(dir);
		assert.equal(r.isError, false, `정상인데 오류로 끝났다: ${r.text.slice(0, 120)}`);
		assert.equal(files.filter((f) => f.endsWith('.md')).length, 1, '최종 파일이 없다');
		assert.deepEqual(files.filter((f) => f.endsWith('.part')), [], '임시 파일이 남았다');
	});

	test('★ 프로필 저장 뒤 재조회가 실패해도 «저장 실패» 라고 하지 않는다', async () => {
		// ⚠️ readBack 의 .catch(() => null) 을 지우면 여기가 깨진다.
		let mutated = false;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as { query?: string };
				const q = body.query ?? '';
				if (/updateProfile/.test(q)) {
					mutated = true;
					return jsonResponse({ data: { updateProfile: { id: 'u1' } } });
				}
				if (mutated) {
					// 저장 뒤의 조회만 깨뜨린다.
					return jsonResponse({ errors: [{ message: 'readback boom' }] });
				}
				return jsonResponse({
					data: {
						currentUser: { id: 'u1', username: 'me', profile: { display_name: 'N', short_bio: 'B' } },
						user: { id: 'u1', username: 'me', profile: { display_name: 'N', short_bio: 'B' } },
					},
				});
			}) as unknown as typeof fetch,
		});
		const server = createServer(client, { publicPublish: false, editProfile: true });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_update_profile',
			arguments: { short_bio: '새 소개' },
		})) as { content: Array<{ text?: string }>; isError?: boolean };
		await mcp.close();
		const text = res.content.map((c) => c.text ?? '').join('\n');
		assert.equal(res.isError !== true, true, `저장은 됐는데 실패로 보고했다: ${text.slice(0, 120)}`);
		assert.match(text, /저장/, '저장됐다는 말이 없다');
		assert.match(text, /다시 부르지 마세요|확인/, '다시 부르지 말라는 안내가 없다');
	});
});

describe('★★ 21차 — 읽기 도구가 취소를 HTTP 까지 넘긴다', () => {
	/**
	 * ⚠️ 이 계약은 **MCP 경계에서 확인하지 못했다.**
	 *   `callTool(..., { signal })` 로 취소해도 서버 쪽 `extra.signal` 이 그 요청 안에서
	 *   끊기지 않았다(InMemoryTransport 로 100ms 까지 기다려 봤다). 통지가 왕복하기 전에
	 *   클라이언트가 먼저 호출을 접는 것으로 보인다.
	 *
	 *   그래서 차선으로 **프로덕션 소스를 직접 읽어** 다섯 핸들러가 요청에 신호를
	 *   싣는지 본다. 복제본이 아니라 실제 파일을 보므로, 배선을 지우면 여기가 깨진다.
	 *   한계는 분명하다 — 「싣는다」는 보지만 「끊긴다」는 못 본다. 그건 못 했다고 적는다.
	 */
	test('★ 읽기 핸들러가 request 에 **호출자 신호 그대로** 를 싣는다 (소스 대조)', async () => {
		const { readFile } = await import('node:fs/promises');
		// 파일 → 그 파일의 client.request 호출 수. 하나라도 신호가 없으면 깨진다.
		for (const [file, calls] of [
			['../tools/posts.ts', 2],
			['../tools/discover.ts', 3],
			['../tools/profile.ts', 3],
		] as const) {
			const src = await readFile(new URL(file, import.meta.url), 'utf8');
			const requests = src.match(/client\.request</g)?.length ?? 0;
			assert.equal(requests, calls, `${file} 의 request 호출이 ${requests}개다 — 배선을 다시 보라`);
			// ⚠️ 「signal 이라는 글자가 몇 번 나오나」로 세면 안 된다.
			//   `signal: extra.signal.aborted ? extra.signal : undefined` 같은 변이가
			//   글자 수로는 통과한다(코덱스 22차). **인자 모양 그대로** 를 본다.
			const wired = src.match(/\{ signal: extra\.signal \}/g)?.length ?? 0;
			assert.equal(
				wired,
				calls,
				`${file} 의 요청 ${calls}개 중 ${wired}개만 «{ signal: extra.signal }» 를 싣는다`,
			);
		}

		// ⚠️ whoami 는 `client.request` 가 아니라 `fetchCurrentUser` 를 쓴다.
		//   위 세기에서 빠져 **배선을 지워도 안 걸렸다**(코덱스 23차). 따로 본다.
		const profileSrc = await readFile(new URL('../tools/profile.ts', import.meta.url), 'utf8');
		assert.match(
			profileSrc,
			/fetchCurrentUser\(client,\s*extra\.signal\s*,/,
			'velog_whoami 가 fetchCurrentUser 에 취소 신호를 안 넘긴다',
		);
	});
});

describe('★★ 23차 — 백업이 다른 글로 덮이지 않는다 (발행 차단이었던 결함)', () => {
	const noSleep = async (): Promise<void> => {};

	/** 목록은 A 를 주고 상세는 detailId 를 주는 서버. 그 사이 슬러그 주인이 바뀐 상황이다. */
	const exportWithDetailId = async (
		detailId: string,
	): Promise<{ isError: boolean; text: string; files: string[] }> => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-mismatch-'));
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as { query?: string };
				const q = body.query ?? '';
				if (q.includes('currentUser')) {
					return jsonResponse({ data: { currentUser: { id: 'u', username: 'me' } } });
				}
				if (/posts\s*\(/.test(q)) {
					return jsonResponse({ data: { posts: [{ id: 'A', url_slug: 's', title: 'A글' }] } });
				}
				return jsonResponse({
					data: {
						post: {
							id: detailId,
							url_slug: 's',
							title: '받은 글',
							body: '본문',
							tags: [],
							released_at: '2026-01-01',
						},
					},
				});
			}) as unknown as typeof fetch,
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_export_posts',
			arguments: { out_dir: dir, limit: 1 },
		})) as { content: Array<{ text?: string }>; isError?: boolean };
		await mcp.close();
		return {
			isError: res.isError === true,
			text: res.content.map((c) => c.text ?? '').join('\n'),
			files: (await readdir(dir)).sort(),
		};
	};

	test('★ 상세 응답의 글 id 가 목록과 다르면 저장하지 않는다', async () => {
		// ⚠️ 이게 발행을 막았던 결함이다. A 의 id 가 붙은 파일에 B 의 본문이 저장되고
		//   「✅ 1편」이 나갔다. 덜 받는 것이 낫다.
		const r = await exportWithDetailId('B');
		assert.deepEqual(r.files, [], `다른 글을 저장했다: ${r.files.join(', ')}`);
		assert.equal(r.isError, true, '다른 글을 받았는데 성공으로 보고했다');
		assert.match(r.text, /받은 글이 다릅니다/, '왜 못 받았는지 말하지 않는다');
	});

	test('☑ 대조군 — id 가 같으면 평소대로 저장한다', async () => {
		const r = await exportWithDetailId('A');
		assert.equal(r.isError, false, `정상인데 오류로 보고했다: ${r.text.slice(0, 120)}`);
		assert.equal(r.files.length, 1, '정상 백업이 안 생겼다');
		assert.ok(r.files[0]?.includes('A'), `파일 이름에 글 id 가 없다: ${r.files[0]}`);
	});
});

describe('★★ 23차 — 통계 «값» 을 검사한다 (취소만 보고 있었다)', () => {
	const noSleep = async (): Promise<void> => {};

	/** 주어진 글 목록으로 velog_blog_stats 를 부르고 출력 문자열을 돌려준다. */
	const statsFor = async (
		posts: Array<{ id: string; views: number; likes: number; tags: string[]; released_at: string }>,
	): Promise<string> => {
		let served = false;
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as { query?: string };
				const q = body.query ?? '';
				if (q.includes('currentUser')) {
					return jsonResponse({ data: { currentUser: { id: 'u', username: 'me' } } });
				}
				// 첫 페이지만 주고 그 뒤는 빈 페이지 — 정상 종료 경로다.
				if (served) return jsonResponse({ data: { posts: [] } });
				served = true;
				// ⚠️ 픽스처를 통째로 돌려주면 **질의가 고르지 않은 필드도** 채워진다.
				//   실제로 `likes·views·comments_count` 선택을 전부 지워도 테스트가 통과했다
				//   (코덱스 25차: 진짜 서버였다면 합계가 전부 0이 된다). 질의가 고른 것만 준다.
				const wanted = (field: string): boolean => new RegExp(`\\b${field}\\b`).test(q);
				return jsonResponse({
					data: {
						posts: posts.map((p) => {
							const row: Record<string, unknown> = { id: p.id };
							if (wanted('title')) row['title'] = `글 ${p.id}`;
							if (wanted('views')) row['views'] = p.views;
							if (wanted('likes')) row['likes'] = p.likes;
							if (wanted('comments_count')) row['comments_count'] = 3;
							if (wanted('tags')) row['tags'] = p.tags;
							if (wanted('released_at')) row['released_at'] = p.released_at;
							return row;
						}),
					},
				});
			}) as unknown as typeof fetch,
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_blog_stats',
			arguments: { username: 'me' },
		})) as { content: Array<{ text?: string }> };
		await mcp.close();
		return res.content.map((c) => c.text ?? '').join('\n');
	};

	// ⚠️ 합계가 다른 숫자와 **우연히 겹치면** 변이를 놓친다. 실제로 좋아요 합계 10 이
	//   다른 자리 숫자에 걸려 「안 더하는」 변이를 통과시켰다(코덱스 24차 지적 뒤 실측).
	//   자릿수가 크고 서로 안 겹치는 값으로 둔다.
	const sample = [
		{ id: 'p1', views: 1_000, likes: 111, tags: ['a'], released_at: '2026-01-01' },
		{ id: 'p2', views: 2_500, likes: 222, tags: ['a', 'b'], released_at: '2026-02-01' },
		{ id: 'p3', views: 7, likes: 333, tags: ['b'], released_at: '2025-03-01' },
	];

	test('★ 조회수·좋아요 합계가 맞는다', async () => {
		// ⚠️ 지금까지 통계는 «취소가 루프를 멈추나» 만 봤다. 합계를 틀리게 만들어도
		//   아무도 안 잡았다(코덱스 24차). 값 자체를 본다.
		const text = await statsFor(sample);
		// ⚠️ 전체에서 숫자만 찾으면 **값이 엉뚱한 항목에 있어도** 통과한다.
		//   실제로 views 와 comments 를 맞바꿔도 초록이었다(코덱스 25차).
		//   «항목 이름이 있는 그 줄» 에서 값을 짚는다.
		const line = (label: string): string =>
			text.split('\n').find((l) => l.includes(label)) ?? `(${label} 줄 없음)`;
		assert.match(line('총 조회수'), /3,?507\b/, `조회수 줄이 틀리다: ${line('총 조회수')}`);
		assert.match(line('총 좋아요'), /666\b/, `좋아요 줄이 틀리다: ${line('총 좋아요')}`);
		assert.match(line('총 댓글'), /\b9\b/, `댓글 줄이 틀리다: ${line('총 댓글')}`);
		assert.match(line('글 '), /\b3\b/, `글 수 줄이 틀리다: ${line('글 ')}`);
	});

	test('★ 태그별 집계가 맞는다 — 한 글이 여러 태그에 들어간다', async () => {
		const text = await statsFor(sample);
		// a: 1000 + 2500 = 3500(2편) · b: 2500 + 7 = 2507(2편)
		assert.match(text, /#a[^\n]*2편[^\n]*3,?500\b/, `태그 a 줄이 틀리다:\n${text.slice(0, 600)}`);
		assert.match(text, /#b[^\n]*2편[^\n]*2,?507\b/, `태그 b 줄이 틀리다:\n${text.slice(0, 600)}`);
		// 연도별도 본다 — 출력을 통째로 지우는 변이를 잡는다.
		assert.match(text, /2026[^\n]*2편/, '연도별 2026 이 2편이 아니다');
		assert.match(text, /2025[^\n]*1편/, '연도별 2025 가 1편이 아니다');
		// 상위 글 순위가 조회수 내림차순인지.
		const rankHead = text.slice(text.indexOf('## 조회수 상위')).split('\n')[1] ?? '';
		assert.match(rankHead, /p2|글 p2/, `1위가 p2 가 아니다: ${rankHead}`);
	});

	test('☑ 대조군 — 글이 없으면 «0편» 이라 말한다 (999편이라 하지 않는다)', async () => {
		// 빈 계정은 통계표 대신 «공개 글이 없습니다» 를 낸다. 999편이라 하지 않는지만 본다.
		const text = await statsFor([]);
		assert.match(text, /공개 글이 없습니다/, `빈 계정 안내가 아니다: ${text.slice(0, 120)}`);
		assert.doesNotMatch(text, /총 조회수/, '글이 없는데 통계표를 냈다');
	});
});

describe('★★ 25차 — 트렌딩 안내의 «적용값» 이 실제 전송값과 같다', () => {
	const noSleep = async (): Promise<void> => {};

	/** 도구를 부르고 (실제 전송된 limit/offset, 응답 첫 줄) 을 돌려준다. */
	const trending = async (
		args: Record<string, unknown>,
	): Promise<{ sent: { limit?: number; offset?: number }; head: string }> => {
		let sent: { limit?: number; offset?: number } = {};
		const client = new VelogClient({
			auth: anonAuth,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as {
					query?: string;
					variables?: { input?: { limit?: number; offset?: number } };
				};
				if (/trendingPosts/.test(body.query ?? '')) sent = body.variables?.input ?? {};
				return jsonResponse({ data: { trendingPosts: [] } });
			}) as unknown as typeof fetch,
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		const res = (await mcp.callTool({
			name: 'velog_trending_posts',
			arguments: args,
		})) as { content: Array<{ text?: string }> };
		await mcp.close();
		return { sent, head: res.content.map((c) => c.text ?? '').join('\n').split('\n')[0] ?? '' };
	};

	test('★ 보정이 없을 때도, 있을 때도 첫 줄의 값이 전송값과 같다', async () => {
		// ⚠️ 안내는 「응답에 적힌 적용된 limit 만큼 더하라」고 한다. 그 값이 없거나
		//   **보정 전 값**이면 모델이 페이지를 건너뛰거나 겹쳐 읽는다(코덱스 24·25차).
		for (const args of [
			{ timeframe: 'year', limit: 5 },
			{ timeframe: 'year', limit: 50 },
			{ timeframe: 'week', limit: 30 },
			{ timeframe: 'year', limit: 50, offset: 5000 },
		]) {
			const { sent, head } = await trending(args);
			assert.match(
				head,
				new RegExp(`적용:\\s*limit\\s*${sent.limit}\\b`),
				`${JSON.stringify(args)} → 전송 limit ${sent.limit} 인데 안내는 「${head}」`,
			);
			assert.match(
				head,
				new RegExp(`offset\\s*${sent.offset}\\b`),
				`${JSON.stringify(args)} → 전송 offset ${sent.offset} 인데 안내는 「${head}」`,
			);
		}
	});
});

describe('★★ 26차 — 변이를 한 번도 안 댔던 자리들', () => {
	test('★ 슬러그 절단 자리에 하이픈이 오면 지운다', async () => {
		// ⚠️ 기존 검사는 절단 위치가 늘 «가» 라서 `.replace(/-+$/,'')` 를 지워도 통과했다
		//   (코덱스 26차). 경계에 하이픈이 놓이는 입력으로 본다.
		const { toUrlSlug, MAX_SLUG_LENGTH } = await import('../slug.ts');
		const s = toUrlSlug(`${'a'.repeat(MAX_SLUG_LENGTH - 1)} b`);
		assert.ok(!s.endsWith('-'), `절단 자리에 하이픈이 남았다: …${s.slice(-5)}`);
		assert.ok(s.length <= MAX_SLUG_LENGTH);
	});

	test('★ 물결표 코드블록 안의 이미지는 썸네일 후보가 아니다', async () => {
		// ⚠️ 기존 검사는 백틱 펜스만 써서 `~{3,}` 를 지워도 통과했다(코덱스 26차).
		const { chooseThumbnail } = await import('../thumbnail.ts');
		const body = ['~~~md', '![예제](https://example.com/in-code.png)', '~~~', '', '![진짜](https://example.com/real.png)'].join('\n');
		const chosen = chooseThumbnail(undefined, body);
		assert.equal(chosen.url, 'https://example.com/real.png', `코드블록 안 이미지를 골랐다: ${chosen.url}`);
	});

	test('★ 재시도 대기 시간이 실제로 늘어난다 (0 으로 바꾸면 깨진다)', async () => {
		// ⚠️ noSleep 이 인자를 안 보면 `sleep(backoff)` 를 `sleep(0)` 으로 바꿔도 통과한다.
		const waited: number[] = [];
		const client = new VelogClient({
			auth: anonAuth,
			sleepImpl: async (ms: number) => {
				waited.push(ms);
			},
			maxRetries: 2,
			fetchImpl: jsonFetch(() => ({ status: 503, body: { errors: [{ message: '잠시 뒤' }] } })),
		});
		await client.request('{ posts { id } }').catch(() => undefined);
		assert.ok(waited.length >= 2, `재시도가 안 일어났다: ${waited.join(',')}`);
		assert.ok(
			waited.every((ms) => ms > 0),
			`대기 시간이 0 이다 — 상대를 몰아친다: ${waited.join(',')}`,
		);
		assert.ok(
			(waited[1] ?? 0) > (waited[0] ?? 0),
			`백오프가 늘지 않는다: ${waited.join(',')}`,
		);
	});

	test('★ 발행 상한의 **기본** 시간창이 5분이다', async () => {
		// ⚠️ 기존 검사는 windowMs 를 직접 넣어서, 기본값을 1초로 바꿔도 통과했다.
		const { PublishRateLimiter } = await import('../ratelimit.ts');
		let now = 0;
		const limiter = new PublishRateLimiter({ now: () => now });
		// check() 가 «통과하면 기록» 이다. 다섯 번 통과시켜 창을 채운다.
		for (let i = 0; i < 5; i += 1) limiter.check();
		now = 1001; // 1초 뒤 — 기본값이 1초로 바뀌었다면 여기서 풀린다
		assert.throws(
			() => {
				limiter.check();
			},
			/공개 발행을 잠시 멈춥니다/,
			'1초 만에 상한이 풀렸다',
		);
		now = 5 * 60 * 1000 + 1; // 5분 뒤
		assert.doesNotThrow(() => {
			limiter.check();
		}, '5분이 지났는데 안 풀린다');
	});
});

describe('★★ 26차 — 사후 검증이 제목·썸네일·시리즈 손실도 잡는다', () => {
	const noSleep = async (): Promise<void> => {};

	/**
	 * 발행 뒤 재조회에서 한 필드만 다르게 돌려주는 서버.
	 * ⚠️ 기존 검사는 본문·태그·슬러그·meta 만 다뤄서, 이 세 비교를 꺼도 통과했다
	 *   (코덱스 26차: 각각 40/40 초록).
	 */
	const publishWithDrift = async (
		drift: 'title' | 'thumbnail' | 'series' | 'none',
	): Promise<{ isError: boolean; text: string }> => {
		const sent = {
			title: '보낸 제목',
			thumbnail: 'https://cdn.example.com/sent.png',
			series_id: 'sid-1',
		};
		const client = new VelogClient({
			auth: authed,
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
				const body = JSON.parse(init?.body ?? '{}') as { query?: string };
				const q = body.query ?? '';
				if (q.includes('currentUser')) {
					return jsonResponse({ data: { currentUser: { id: 'u', username: 'me' } } });
				}
				if (/writePost|editPost/.test(q)) {
					return jsonResponse({
						data: {
							writePost: { id: 'p1', url_slug: 's', is_temp: false, is_private: true },
							editPost: { id: 'p1', url_slug: 's', is_temp: false, is_private: true },
						},
					});
				}
				// 사후 재조회 — 한 필드만 어긋나게 돌려준다.
				return jsonResponse({
					data: {
						post: {
							id: 'p1',
							// 소유권 확인이 먼저 돈다 — 내 글이어야 사후 비교까지 간다.
							user: { username: 'me' },
							id_check: true,
							title: drift === 'title' ? '서버가 바꾼 제목' : sent.title,
							body: '본문',
							url_slug: 's',
							tags: [],
							is_temp: false,
							is_private: true,
							thumbnail:
								drift === 'thumbnail' ? 'https://cdn.example.com/other.png' : sent.thumbnail,
							series: { id: drift === 'series' ? 'sid-OTHER' : sent.series_id },
							meta: {},
						},
					},
				});
			}) as unknown as typeof fetch,
		});
		const server = createServer(client);
		const [a, b] = InMemoryTransport.createLinkedPair();
		await server.connect(a);
		const mcp = new Client({ name: 't', version: '0' });
		await mcp.connect(b);
		// ⚠️ `velog_create_draft` 는 사후 «내용 비교» 를 하지 않는다(플래그만 본다).
		//   비교가 있는 `velog_update_post` 로 시험해야 이 검사가 의미가 있다.
		const res = (await mcp.callTool({
			name: 'velog_update_post',
			arguments: { id: 'p1', title: sent.title, thumbnail: sent.thumbnail },
		})) as { content: Array<{ text?: string }>; isError?: boolean };
		await mcp.close();
		return { isError: res.isError === true, text: res.content.map((c) => c.text ?? '').join('\n') };
	};

	// ⚠️ `series` 는 여기서 시험하지 않는다. 시리즈 소유권 검사가 **쓰기 전에** 막아서
	//   사후 검증까지 가지 않는다(실측: 「@me 의 시리즈가 아닙니다」). 그건 더 나은 동작이다.
	for (const [field, label] of [
		['title', '제목'],
		['thumbnail', '썸네일'],
	] as const) {
		test(`★ 저장된 ${label}이 보낸 값과 다르면 잡는다`, async () => {
			const r = await publishWithDrift(field);
			assert.equal(r.isError, true, `${label} 손실을 성공으로 보고했다: ${r.text.slice(0, 140)}`);
			assert.match(r.text, new RegExp(label), `어느 필드가 어긋났는지 말하지 않는다: ${r.text.slice(0, 200)}`);
		});
	}
});

describe('★★ 27차 — 코드 예제 이미지가 표지가 되지 않는다', () => {
	const pick = async (body: string): Promise<string | undefined> => {
		const { chooseThumbnail } = await import('../thumbnail.ts');
		return chooseThumbnail(undefined, body).url;
	};

	test('★ 들여쓰기 코드블록(4칸)의 이미지는 후보가 아니다', async () => {
		// ⚠️ 펜스와 인라인 코드는 막고 있었는데 **이것만 빠져 있었다**(코덱스 27차).
		//   코드 예제가 블로그 표지가 되면 목록 카드만 조용히 이상해진다.
		assert.equal(
			await pick('    ![예제](https://e.com/code.png)\n\n![진짜](https://e.com/real.png)'),
			'https://e.com/real.png',
		);
	});

	test('★ 탭으로 들여쓴 코드블록도 같다', async () => {
		assert.equal(
			await pick('\t![예제](https://e.com/code.png)\n\n![진짜](https://e.com/real.png)'),
			'https://e.com/real.png',
		);
	});

	test('☑ 대조군 — 목록 안의 들여쓴 이미지는 **버리지 않는다**', async () => {
		// ⚠️ 너무 많이 지우면 「이미지가 있는데 없다」가 된다. 목록은 코드가 아니다.
		assert.equal(
			await pick('- 항목\n    ![목록](https://e.com/inlist.png)\n'),
			'https://e.com/inlist.png',
		);
	});

	test('☑ 대조군 — 문단에 이어지는 들여쓴 줄도 버리지 않는다', async () => {
		assert.equal(
			await pick('문단\n    ![이어짐](https://e.com/cont.png)\n'),
			'https://e.com/cont.png',
		);
	});

	test('☑ 대조군 — 목록 항목 **뒤에 빈 줄**이 와도 그 이미지는 살린다', async () => {
		// ⚠️ 여기서 내가 과잉 삭제를 했다. `- item` 다음 빈 줄 뒤의 들여쓴 줄은
		//   «느슨한 목록의 이어지는 문단» 이지 코드가 아니다(코덱스 28차).
		//   지우는 쪽으로 틀리면 «이미지가 있는데 없다» 가 된다.
		assert.equal(
			await pick('- item\n\n    ![real](https://e.com/real.png)\n'),
			'https://e.com/real.png',
		);
		assert.equal(
			await pick('1. item\n\n    ![real](https://e.com/real.png)\n'),
			'https://e.com/real.png',
		);
	});

	test('☑ 대조군 — 목록이 끝난 뒤의 들여쓰기 코드는 다시 막는다', async () => {
		assert.equal(
			await pick('- item\n\n문단\n\n    ![code](https://e.com/code.png)\n\n![real](https://e.com/real.png)'),
			'https://e.com/real.png',
		);
	});

	test('☑ 대조군 — 평범한 본문은 첫 이미지를 그대로 고른다', async () => {
		assert.equal(
			await pick('글입니다.\n\n![첫](https://e.com/first.png)\n\n![둘](https://e.com/second.png)'),
			'https://e.com/first.png',
		);
	});
});

describe('★★ 28차 — refresh 토큰이 실제로 교체된다', () => {
	const noSleep = async (): Promise<void> => {};

	test('★ 서버가 refresh 만 새로 주면 그 값으로 바뀌고, 다음 요청 쿠키에 실린다', async () => {
		// ⚠️ 기존 검사는 access 갱신만 봤다. `incoming.refreshToken` 을 무시하는 변이가
		//   16/16 을 통과했고, 실제로는 **옛 refresh 가 계속 나갔다**(코덱스 27차).
		const cookies: string[] = [];
		let call = 0;
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'A_FIXED', refreshToken: 'R_OLD' },
			},
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
				call += 1;
				cookies.push(init?.headers?.['cookie'] ?? init?.headers?.['Cookie'] ?? '');
				const headers: Record<string, string> = { 'content-type': 'application/json' };
				// 첫 응답에서만 refresh 를 갈아 준다. access 는 그대로다.
				if (call === 1) headers['set-cookie'] = 'refresh_token=R_NEW; Path=/; HttpOnly';
				return new Response(JSON.stringify({ data: { posts: [] } }), { status: 200, headers });
			}) as unknown as typeof fetch,
		});

		await client.request('{ posts { id } }');
		await client.request('{ posts { id } }');

		assert.equal(cookies.length, 2, '두 번 호출되지 않았다');
		assert.match(cookies[0] ?? '', /refresh_token=R_OLD/, '첫 요청이 옛 refresh 를 안 썼다');
		assert.match(cookies[1] ?? '', /refresh_token=R_NEW/, '새 refresh 로 안 바뀌었다');
		assert.doesNotMatch(cookies[1] ?? '', /R_OLD/, '옛 refresh 가 아직 남아 있다');
		assert.match(cookies[1] ?? '', /access_token=A_FIXED/, 'access 가 사라졌다');
	});

	test('☑ 대조군 — 서버가 아무것도 안 주면 기존 값이 그대로 유지된다', async () => {
		const cookies: string[] = [];
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'A_FIXED', refreshToken: 'R_OLD' },
			},
			sleepImpl: noSleep,
			maxRetries: 0,
			fetchImpl: (async (_u: unknown, init?: { headers?: Record<string, string> }) => {
				cookies.push(init?.headers?.['cookie'] ?? init?.headers?.['Cookie'] ?? '');
				return jsonResponse({ data: { posts: [] } });
			}) as unknown as typeof fetch,
		});
		await client.request('{ posts { id } }');
		await client.request('{ posts { id } }');
		assert.match(cookies[1] ?? '', /refresh_token=R_OLD/, '주지도 않았는데 값이 바뀌었다');
		assert.match(cookies[1] ?? '', /access_token=A_FIXED/, 'access 가 사라졌다');
	});
});
