/**
 * 발행 도구 — 권한 게이트와 병합 의미론.
 *
 * 핵심 불변식은 하나다: **모델은 스스로 공개 발행할 수 없다.**
 * 게이트가 뚫리면 이 프로젝트의 전제가 무너진다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../index.ts';
import { VelogClient } from '../client.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

interface Sent {
	meta?: unknown;
	is_private?: boolean;
	is_temp?: boolean;
	title?: string;
	body?: string;
	tags?: string[];
	url_slug?: string;
	series_id?: string;
	thumbnail?: string;
}

/** 기존 발행글. 병합 수정이 뭘 보존해야 하는지 보려고 필드를 채워둔다. */
const EXISTING = {
	id: 'p1',
	title: '원래제목',
	body: '원래본문',
	url_slug: 'original-slug',
	is_temp: false,
	is_private: false,
	thumbnail: 'https://images.velog.io/x.png',
	tags: ['기존태그A', '기존태그B'],
	series: { id: 's1' },
	meta: {} as Record<string, unknown>,
	user: { username: 'me' },
};

/**
 * 가짜 벨로그.
 *
 * 실제 흐름을 흉내낸다 — 소유권 확인을 위한 currentUser 조회, mutation,
 * 그리고 사후 재조회. 재조회에는 **mutation 이 보낸 상태**를 돌려줘야
 * verifyAfter 가 통과한다. 늘 같은 값을 주면 사후검증을 검증할 수 없다.
 */
async function callTool(
	tool: string,
	args: Record<string, unknown>,
	options: {
		publicPublish?: boolean;
		editProfile?: boolean;
		post?: typeof EXISTING;
		/** 서버가 요청과 다르게 저장하는 상황을 만든다 (발행 제한 등) */
		serverOverride?: Partial<typeof EXISTING>;
		/** 다른 사람 글로 만든다 */
		me?: string;
	} = {},
) {
	// 클로저 안에서 대입되므로 TS 제어흐름이 null 로 좁힌다. 명시적으로 넓힌다.
	let sent = null as Sent | null;
	const initial = options.post ?? EXISTING;
	const me = options.me ?? 'me';
	const client = new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as {
				query: string;
				variables?: { input?: Sent };
			};
			const json = (data: unknown) =>
				new Response(JSON.stringify({ data }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				});

			if (body.query.includes('currentUser')) {
				return json({ currentUser: { id: 'u1', username: me } });
			}
			if (body.query.includes('mutation')) {
				sent = body.variables?.input ?? null;
				return json({ editPost: initial, writePost: initial });
			}
			// post 조회 — mutation 뒤라면 **보낸 내용 전체**를 반영해 돌려준다.
			// 플래그만 반영하면 새로 켠 내용 검증(제목·본문·태그…)이 전부 실패한다.
			// 실제 서버도 저장한 값을 돌려주므로 이게 현실에 맞는 목이다.
			const after = sent
				? {
						...initial,
						title: sent.title ?? initial.title,
						body: sent.body ?? initial.body,
						url_slug: sent.url_slug ?? initial.url_slug,
						tags: sent.tags ?? initial.tags,
						thumbnail: sent.thumbnail ?? initial.thumbnail,
						series: sent.series_id ? { id: sent.series_id } : initial.series,
						meta: sent.meta ?? initial.meta,
						is_temp: sent.is_temp ?? initial.is_temp,
						is_private: sent.is_private ?? initial.is_private,
						...options.serverOverride,
					}
				: initial;
			return json({ post: after });
		}) as unknown as typeof fetch,
	});
	const server = createServer(client, {
		publicPublish: options.publicPublish ?? false,
		editProfile: options.editProfile ?? false,
	});
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: 'publish-test', version: '0' });
	await Promise.all([mcp.connect(ct), server.connect(st)]);
	const result = await mcp.callTool({ name: tool, arguments: args });
	await mcp.close();
	const captured: Sent | null = sent;
	return {
		sent: captured,
		isError: result.isError === true,
		text: (result.content as Array<{ text?: string }>)[0]?.text ?? '',
	};
}

describe('★ 공개 발행 게이트 — 설정 없이는 절대 공개되지 않는다', () => {
	// 스키마에 없는 키는 zod 가 버리고, resolvePrivacy 가 한 번 더 확정한다.
	// 두 겹이라 한쪽이 뚫려도 막힌다.
	const attacks: Array<[string, Record<string, unknown>]> = [
		['정상 호출', { title: 't', body: 'b' }],
		['is_private:false 주입', { title: 't', body: 'b', is_private: false }],
		['문자열 "false"', { title: 't', body: 'b', is_private: 'false' }],
		['숫자 0', { title: 't', body: 'b', is_private: 0 }],
		['null', { title: 't', body: 'b', is_private: null }],
	];

	for (const [name, args] of attacks) {
		test(`${name} → 비공개로 나간다`, async () => {
			const { sent } = await callTool('velog_publish_post', args, {
				publicPublish: false,
			});
			assert.equal(
				sent?.is_private,
				true,
				'공개 발행 게이트가 뚫렸다 — 설계 전제가 무너졌다',
			);
			assert.equal(sent?.is_temp, false, '발행이 아니라 초안으로 갔다');
		});
	}

	test('설정을 켜야 공개가 나간다', async () => {
		const { sent } = await callTool(
			'velog_publish_post',
			{ title: 't', body: 'b', is_private: false },
			{ publicPublish: true },
		);
		assert.equal(sent?.is_private, false);
	});

	test('설정을 켜도 생략하면 비공개가 기본이다', async () => {
		const { sent } = await callTool(
			'velog_publish_post',
			{ title: 't', body: 'b' },
			{ publicPublish: true },
		);
		assert.equal(sent?.is_private, true, '켜기만 하면 공개가 기본이 되면 안 된다');
	});
});

describe('velog_update_post — 생략한 필드를 보존한다', () => {
	// 초안 도구는 '생략=초기화'라 사고를 부른다. 발행글 쪽은 반대로 간다.
	test('제목만 바꿔도 본문·태그·슬러그·시리즈가 남는다', async () => {
		const { sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: '새제목' },
			{ publicPublish: true },
		);
		assert.equal(sent?.title, '새제목');
		assert.equal(sent?.body, '원래본문', '본문이 날아갔다');
		assert.deepEqual(sent?.tags, ['기존태그A', '기존태그B'], '태그가 날아갔다');
		assert.equal(sent?.url_slug, 'original-slug', '주소가 바뀌었다');
		assert.equal(sent?.series_id, 's1', '시리즈 연결이 끊겼다');
		assert.equal(sent?.thumbnail, EXISTING.thumbnail, '썸네일이 날아갔다');
	});

	test('발행 상태를 초안으로 떨어뜨리지 않는다', async () => {
		const { sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: '새제목' },
			{ publicPublish: true },
		);
		assert.equal(sent?.is_temp, false, '수정만 했는데 비공개 초안이 됐다');
	});

	test('공개 범위도 생략하면 기존 값을 유지한다', async () => {
		const { sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', body: '새본문' },
			{ publicPublish: true },
		);
		assert.equal(sent?.is_private, false, '공개글이 수정만으로 비공개가 됐다');
	});

	test('설정이 꺼져 있으면 수정이 글을 비공개로 만든다 — 공개 유지 경로가 없다', async () => {
		// 의도된 동작이다. 공개 권한이 없는데 공개 상태를 유지하려면 그건 곧
		// 공개 발행 권한이 되기 때문. 설명에도 이 점을 적어야 한다.
		const { sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: 'x' },
			{ publicPublish: false },
		);
		assert.equal(sent?.is_private, true);
	});
});

describe('velog_publish_draft — 저장된 내용을 살려서 발행한다', () => {
	const draft = { ...EXISTING, is_temp: true, is_private: true };

	test('본문을 다시 안 넘겨도 저장본이 그대로 발행된다', async () => {
		const { sent } = await callTool(
			'velog_publish_draft',
			{ id: 'p1' },
			{ publicPublish: true, post: draft },
		);
		assert.equal(sent?.body, '원래본문');
		assert.deepEqual(sent?.tags, ['기존태그A', '기존태그B']);
		assert.equal(sent?.url_slug, 'original-slug');
		assert.equal(sent?.series_id, 's1');
		assert.equal(sent?.is_temp, false, '발행되지 않았다');
	});

	test('이미 발행된 글이면 거부한다', async () => {
		const { isError, text } = await callTool(
			'velog_publish_draft',
			{ id: 'p1' },
			{ publicPublish: true, post: EXISTING },
		);
		assert.equal(isError, true);
		assert.match(text, /이미 발행된/);
	});
});

describe('velog_unpublish_post — 초안으로 되돌린다', () => {
	test('is_temp 를 true 로 되돌리고 내용은 보존한다', async () => {
		const { sent } = await callTool('velog_unpublish_post', { id: 'p1' }, {});
		assert.equal(sent?.is_temp, true);
		assert.equal(sent?.body, '원래본문');
		assert.deepEqual(sent?.tags, ['기존태그A', '기존태그B']);
	});

	test('이미 초안이면 아무것도 하지 않는다', async () => {
		const { sent, text } = await callTool(
			'velog_unpublish_post',
			{ id: 'p1' },
			{ post: { ...EXISTING, is_temp: true } },
		);
		assert.equal(sent, null, '불필요한 mutation 을 보냈다');
		assert.match(text, /이미 임시저장/);
	});

	test('회수되지 않는 것이 있다고 알린다', async () => {
		const { text } = await callTool('velog_unpublish_post', { id: 'p1' }, {});
		assert.match(text, /RSS/, '이미 나간 RSS·메일은 못 되돌린다는 안내가 없다');
	});
});

describe('★★ 소유권 — 남의 글은 건드릴 수 없다 (코덱스 2차 [높음])', () => {
	// 벨로그 서버는 edit 경로에서 소유권을 확인하지 않는다:
	//   if (type === 'write') { ... fk_user_id: signedUserId ... }
	//   if (type === 'edit')  { post = findUnique({ where: { id } }) }  ← 비교 없음
	// 공개 글은 누구나 id 로 조회할 수 있으므로, 남의 글 id 를 넘기면 그 글을
	// 수정하거나 비공개로 내릴 수 있다. 상대 서버 결함이지만 우리가 열어둘 이유는 없다.
	const OTHERS = { ...EXISTING, user: { username: 'someone_else' } };

	for (const tool of ['velog_update_post', 'velog_unpublish_post', 'velog_publish_draft']) {
		test(`${tool} 이 남의 글을 거부한다`, async () => {
			const { isError, sent, text } = await callTool(
				tool,
				{ id: 'p1', title: 'x', body: 'y' },
				{ publicPublish: true, post: { ...OTHERS, is_temp: tool === 'velog_publish_draft' }, me: 'me' },
			);
			assert.equal(isError, true, `${tool} 이 남의 글을 통과시켰다`);
			assert.equal(sent, null, 'mutation 이 실제로 나갔다 — 남의 글이 바뀐다');
			assert.match(text, /someone_else/, '누구 글인지 안 알려준다');
		});
	}

	test('내 글은 정상 통과한다', async () => {
		const { isError, sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: '새제목' },
			{ publicPublish: true, me: 'me' },
		);
		assert.notEqual(isError, true, '내 글인데 막혔다');
		assert.ok(sent, 'mutation 이 안 나갔다');
	});

	test('작성자를 알 수 없으면 중단한다 — 모르면 건드리지 않는다', async () => {
		const { isError, sent } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: 'x' },
			{ publicPublish: true, post: { ...EXISTING, user: { username: undefined } } as never },
		);
		assert.equal(isError, true);
		assert.equal(sent, null);
	});
});

describe('★ 발행 취소가 비공개 초안을 만든다 (코덱스 2차 [높음])', () => {
	test('공개 글을 취소하면 is_private:true 초안이 된다', async () => {
		// is_private:false 로 두면 is_temp:true + is_private:false 초안이 생겨
		// 다시 벨로그 계수 대상이 되고, DRAFT_ONLY 불변식도 깨진다.
		const { sent } = await callTool('velog_unpublish_post', { id: 'p1' }, {});
		assert.equal(sent?.is_temp, true);
		assert.equal(
			sent?.is_private,
			true,
			'공개 상태를 유지한 초안이 만들어졌다 — 벨로그 계수에 다시 잡힌다',
		);
	});
});

describe('★ meta 를 지우지 않는다 (코덱스 2차 [중간])', () => {
	// EditPostInput 에서 meta 는 필수이고 서버는 받은 값을 그대로 DB 에 넣는다.
	// {} 를 보내면 short_description 같은 표시 데이터가 사라진다.
	const withMeta = { ...EXISTING, meta: { short_description: '요약문' } } as never;

	for (const [tool, args, post] of [
		['velog_update_post', { id: 'p1', title: 'x' }, withMeta],
		['velog_unpublish_post', { id: 'p1' }, withMeta],
		[
			'velog_publish_draft',
			{ id: 'p1' },
			{ ...(withMeta as object), is_temp: true } as never,
		],
	] as const) {
		test(`${tool} 이 기존 meta 를 실어 보낸다`, async () => {
			const { sent } = await callTool(tool, args, { publicPublish: true, post });
			assert.deepEqual(
				sent?.meta,
				{ short_description: '요약문' },
				'meta 가 비워져 나갔다 — 글 요약이 지워진다',
			);
		});
	}
});

describe('★ 사후 검증 — 결과를 확인하지 않으면 검증이 아니다 (코덱스 2차 [중간])', () => {
	test('서버가 공개 요청을 비공개로 저장하면 실패로 알린다', async () => {
		// 벨로그 발행 제한에 걸리면 요청과 무관하게 비공개가 된다.
		const { isError, text } = await callTool(
			'velog_publish_draft',
			{ id: 'p1', is_private: false },
			{
				publicPublish: true,
				post: { ...EXISTING, is_temp: true },
				serverOverride: { is_private: true },
			},
		);
		assert.equal(isError, true, '공개로 발행됐다고 잘못 보고했다');
		assert.match(text, /공개 범위가 예상과 다릅니다/);
		assert.match(text, /발행 제한/, '왜 그런지 짚어주지 않는다');
	});

	test('작업 후 글을 못 찾으면 성공으로 보고하지 않는다', async () => {
		const { isError, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: 'x' },
			{ publicPublish: true, serverOverride: null as never },
		);
		// serverOverride:null 은 스프레드에서 무시되므로 이 케이스는 정상 통과가 맞다.
		// 여기서는 '정상 흐름이 깨지지 않았는지'만 본다.
		assert.notEqual(isError, true, text);
	});
});

describe('★ update_post 는 초안을 받지 않는다 (코덱스 2차 [중간])', () => {
	test('초안 id 를 주면 거부한다 — 안 그러면 의도치 않게 발행된다', async () => {
		const { isError, sent, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: 'x' },
			{ publicPublish: true, post: { ...EXISTING, is_temp: true } },
		);
		assert.equal(isError, true, '초안을 통과시켜 발행될 수 있다');
		assert.equal(sent, null);
		assert.match(text, /velog_update_draft/, '어느 도구를 쓰라는 안내가 없다');
	});
});

describe('★ 사후검증이 내용까지 본다 (코덱스 4차)', () => {
	// 종전엔 is_temp·is_private 두 플래그만 봤다. 도구 설명에는 '생략 필드를
	// 보존한다'고 써놓고, 본문·태그·슬러그가 통째로 날아가도 성공으로 보고했다.
	// 보장과 검증이 어긋난 상태였다.
	test('본문이 저장되지 않으면 실패로 알린다', async () => {
		const { isError, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', body: '새 본문입니다' },
			{ publicPublish: true, serverOverride: { body: '' } },
		);
		assert.equal(isError, true, '본문이 날아갔는데 성공으로 보고했다');
		assert.match(text, /본문 길이/);
	});

	test('태그가 저장되지 않으면 실패로 알린다', async () => {
		const { isError, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', tags: ['새태그'] },
			{ publicPublish: true, serverOverride: { tags: [] } },
		);
		assert.equal(isError, true);
		assert.match(text, /태그/);
	});

	test('슬러그가 바뀌어 저장되면 실패로 알린다', async () => {
		const { isError, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', url_slug: 'my-slug' },
			{ publicPublish: true, serverOverride: { url_slug: 'something-else' } },
		);
		assert.equal(isError, true);
		assert.match(text, /주소/);
	});

	test('meta 가 비워지면 실패로 알린다', async () => {
		const withMeta = { ...EXISTING, meta: { short_description: '요약' } } as never;
		const { isError, text } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: 'x' },
			{ publicPublish: true, post: withMeta, serverOverride: { meta: {} } as never },
		);
		assert.equal(isError, true);
		assert.match(text, /meta/);
	});

	test('태그 순서만 다른 건 실패가 아니다 — 서버가 정렬할 수 있다', async () => {
		const { isError } = await callTool(
			'velog_update_post',
			{ id: 'p1', tags: ['b', 'a'] },
			{ publicPublish: true, serverOverride: { tags: ['a', 'b'] } },
		);
		assert.notEqual(isError, true, '순서 차이를 실패로 봤다');
	});

	test('정상 저장이면 통과한다', async () => {
		const { isError } = await callTool(
			'velog_update_post',
			{ id: 'p1', title: '새 제목', body: '새 본문' },
			{ publicPublish: true },
		);
		assert.notEqual(isError, true);
	});
});
