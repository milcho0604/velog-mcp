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
