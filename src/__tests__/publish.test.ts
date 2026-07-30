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
	user: { username: 'me' },
};

async function callTool(
	tool: string,
	args: Record<string, unknown>,
	options: { publicPublish?: boolean; post?: typeof EXISTING } = {},
) {
	let sent: Sent | null = null;
	const post = options.post ?? EXISTING;
	const client = new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as {
				query: string;
				variables: { input: Sent };
			};
			if (body.query.includes('mutation')) sent = body.variables.input;
			return new Response(
				JSON.stringify({ data: { post, editPost: post, writePost: post } }),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		}) as unknown as typeof fetch,
	});
	const server = createServer(client, { publicPublish: options.publicPublish ?? false });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const mcp = new Client({ name: 'publish-test', version: '0' });
	await Promise.all([mcp.connect(ct), server.connect(st)]);
	const result = await mcp.callTool({ name: tool, arguments: args });
	await mcp.close();
	return {
		sent,
		isError: result.isError === true,
		text: String((result.content as Array<{ text?: string }>)?.[0]?.text ?? ''),
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
