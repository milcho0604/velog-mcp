/**
 * 안전 불변식 — PRD 의 성공기준을 코드로 고정한다.
 *
 * ★ v0.2 에서 모델이 바뀌었다.
 *   v0.1: "이 서버는 발행할 수 없다"            (기능 자체를 뺌)
 *   v0.2: "**사용자가 켜지 않으면** 공개 발행할 수 없다" (권한을 사용자에게)
 *
 *   바뀌지 않은 핵심은 이것이다 — **모델은 스스로 권한을 올릴 수 없다.**
 *   공개 발행 스위치는 환경변수이고, 도구 파라미터가 아니다.
 *
 * 이 파일이 깨지면 그 전제가 무너진 것이다.
 * 실패를 우회하지 말고 왜 깨졌는지부터 볼 것.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../index.ts';
import { VelogClient } from '../client.ts';
import { readCapabilities } from '../capabilities.ts';
import { __testing } from '../tools/drafts.ts';

const SRC = new URL('../', import.meta.url);

/**
 * 이름은 SRC 기준 **상대경로**로 준다 (`tools/publish.ts`, `render/index.ts`).
 * 파일명만 쓰면 `index.ts` 가 두 개라 예외 목록이 엉뚱한 파일까지 풀어준다.
 */
async function readAllSources(dir = SRC, prefix = ''): Promise<Array<[string, string]>> {
	const out: Array<[string, string]> = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__') continue;
		const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
		if (entry.isDirectory()) out.push(...(await readAllSources(url, `${prefix}${entry.name}/`)));
		else if (entry.name.endsWith('.ts')) {
			out.push([`${prefix}${entry.name}`, await readFile(url, 'utf8')]);
		}
	}
	return out;
}

/** 주석을 걷어낸 실제 코드. 문서용 예시가 오탐을 내지 않게 한다. */
function codeOnly(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
		.join('\n');
}

async function connect(publicPublish = false, editProfile = false): Promise<Client> {
	const server = createServer(new VelogClient({ auth: { kind: 'anonymous' } }), {
		publicPublish,
		editProfile,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'safety-test', version: '0' });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

describe('★ A1 — 공개 발행 권한은 사용자만 줄 수 있다', () => {
	test('기본값은 공개 발행 불가다', () => {
		assert.equal(readCapabilities({}).publicPublish, false);
	});

	test('설정이 꺼져 있으면 is_private 파라미터 자체가 없다', async () => {
		// 파라미터가 없으면 모델이 공개를 '요청'할 방법이 없다.
		const client = await connect(false);
		const { tools } = await client.listTools();
		for (const tool of tools) {
			const keys = Object.keys(tool.inputSchema?.properties ?? {});
			assert.ok(
				!keys.includes('is_private'),
				`${tool.name} 이 is_private 를 받는다 — 설정이 꺼졌는데 공개를 지정할 수 있다`,
			);
		}
		await client.close();
	});

	test('설정을 켜야 비로소 is_private 파라미터가 생긴다', async () => {
		const client = await connect(true);
		const { tools } = await client.listTools();
		const publish = tools.find((t) => t.name === 'velog_publish_post');
		assert.ok(
			Object.keys(publish?.inputSchema?.properties ?? {}).includes('is_private'),
			'설정을 켰는데도 공개 범위를 못 정한다',
		);
		await client.close();
	});

	test('환경변수는 좁게 해석한다 — 오타로 켜지면 안 된다', () => {
		for (const on of ['1', 'true', 'TRUE', 'yes', 'on']) {
			assert.equal(readCapabilities({ VELOG_ALLOW_PUBLIC: on }).publicPublish, true, on);
		}
		for (const off of ['0', 'false', '', ' ', 'no', 'off', 'y', 'enabled', 'public']) {
			assert.equal(
				readCapabilities({ VELOG_ALLOW_PUBLIC: off }).publicPublish,
				false,
				`'${off}' 로 켜졌다`,
			);
		}
	});
});

describe('A2 — 초안 도구는 어떤 설정에서도 발행하지 않는다', () => {
	test('DRAFT_ONLY 는 is_temp:true, is_private:true 다', () => {
		assert.equal(__testing.DRAFT_ONLY.is_temp, true);
		assert.equal(
			__testing.DRAFT_ONLY.is_private,
			true,
			'초안이 공개 상태면 벨로그 계수(is_private:false)에 잡혀 발행글을 비공개로 만든다',
		);
	});

	test('초안 도구는 is_temp 도 is_private 도 입력으로 받지 않는다', async () => {
		for (const enabled of [false, true]) {
			const client = await connect(enabled);
			const { tools } = await client.listTools();
			for (const name of ['velog_create_draft', 'velog_update_draft']) {
				const tool = tools.find((t) => t.name === name);
				const keys = Object.keys(tool?.inputSchema?.properties ?? {});
				assert.ok(!keys.includes('is_temp'), `${name} 이 is_temp 를 받는다`);
				assert.ok(
					!keys.includes('is_private'),
					`${name} 이 is_private 를 받는다 (publicPublish=${enabled})`,
				);
			}
			await client.close();
		}
	});

	test('drafts.ts 에는 is_temp:false 를 만드는 코드가 없다', async () => {
		const drafts = (await readAllSources()).find(([n]) => n === 'tools/drafts.ts');
		assert.ok(drafts, 'drafts.ts 를 못 찾았다');
		assert.ok(
			!/is_temp\s*:\s*false/.test(codeOnly(drafts[1])),
			'초안 도구에 발행 경로가 생겼다',
		);
	});
});

describe('A3 — 구현하지 않기로 한 mutation 은 여전히 없다', () => {
	// 되돌릴 수 없거나 남에게 영향을 주는 것들. **설정으로도 열지 않는다.**
	//
	// ★ 프로필 계열(updateProfile/About/VelogTitle/SocialInfo/Thumbnail)은 이 목록에서
	//   빠졌다. 되돌릴 수 있고 본인 계정에만 영향이며 배포도 안 되기 때문이다.
	//   대신 VELOG_ALLOW_PROFILE=1 게이트를 뒀다 — 아래 A10 이 그걸 검사한다.
	//   updateEmailRules 와 이메일 변경은 계속 금지다(계정 탈취 경로).
	const NEVER_CALLED = [
		'unregister', 'logout(', 'sendMail', 'createNotification',
		'removeAllNotifications', 'initiateChangeEmail', 'confirmChangeEmail',
		'likePost', 'unlikePost', 'follow(', 'unfollow(',
		'updateEmailRules', 'acceptIntegration',
	];

	test('소스가 이 mutation 들을 호출하지 않는다', async () => {
		for (const [name, src] of await readAllSources()) {
			for (const call of NEVER_CALLED) {
				assert.ok(!src.includes(call), `${name} 이 ${call} 를 호출한다`);
			}
		}
	});

	test('도구 이름에도 나타나지 않는다', async () => {
		const FORBIDDEN_WORDS = [
			'unregister', 'logout', 'delete', 'remove',
			'like', 'follow', 'sendmail', 'notification',
		];
		for (const enabled of [false, true]) {
			const client = await connect(enabled);
			const { tools } = await client.listTools();
			for (const tool of tools) {
				for (const word of FORBIDDEN_WORDS) {
					assert.ok(
						!tool.name.toLowerCase().includes(word),
						`${tool.name} 은 노출하면 안 되는 동작이다`,
					);
				}
			}
			await client.close();
		}
	});
});

describe('A4 — 도구 목록 스냅샷', () => {
	// 새 도구가 늘면 여기서 실패한다. 안전한지 확인하고 의식적으로 갱신할 것.
	const EXPECTED = [
		'velog_blog_stats',
		'velog_create_draft',
		'velog_export_posts',
		'velog_get_post',
		'velog_get_user',
		'velog_list_drafts',
		'velog_list_posts',
		'velog_list_series',
		'velog_publish_draft',
		'velog_publish_post',
		'velog_recent_posts',
		'velog_render_cover',
		'velog_render_diagram',
		'velog_render_sequence',
		'velog_search_posts',
		'velog_trending_posts',
		'velog_unpublish_post',
		'velog_update_draft',
		'velog_update_post',
		'velog_upload_image',
		'velog_user_tags',
		'velog_whoami',
	];

	test('설정과 무관하게 도구 구성은 같다 — 달라지는 건 파라미터뿐이다', async () => {
		for (const enabled of [false, true]) {
			const client = await connect(enabled);
			const { tools } = await client.listTools();
			assert.deepEqual(
				tools.map((t) => t.name).sort(),
				EXPECTED,
				`도구 목록이 바뀌었다 (publicPublish=${enabled})`,
			);
			await client.close();
		}
	});

	test('되돌릴 수 없는 도구는 destructiveHint 로 표시한다', async () => {
		const MUST_BE_DESTRUCTIVE = [
			'velog_publish_post',
			'velog_publish_draft',
			'velog_unpublish_post',
			'velog_update_draft',
			'velog_export_posts',
		];
		const client = await connect(true);
		const { tools } = await client.listTools();
		for (const name of MUST_BE_DESTRUCTIVE) {
			const tool = tools.find((t) => t.name === name);
			assert.equal(
				tool?.annotations?.destructiveHint,
				true,
				`${name} 이 destructive 로 표시되지 않았다`,
			);
		}
		await client.close();
	});
});

describe('A5 — 토큰이 디스크로 나가지 않는다', () => {
	// 파일 쓰기가 본업인 모듈이 둘 있다: 글 백업(export)과 그림 렌더(render).
	// 그냥 예외로 빼면 그 파일이 나중에 토큰을 만져도 아무도 모른다.
	// 그래서 "면제"가 아니라 **조건부 허용**으로 둔다 — 쓰되 토큰 경로를 참조하지 말 것.
	const ALLOWED_WRITERS = new Set(['tools/export.ts', 'render/index.ts']);
	const TOKEN_TOUCH =
		/TokenStore|buildCookieHeader|parseSetCookie|refreshToken|accessToken|VELOG_REFRESH_TOKEN|'Cookie'/;

	test('토큰을 다루는 모듈이 파일 쓰기 API 를 쓰지 않는다', async () => {
		const WRITERS = /writeFile|appendFile|createWriteStream|writeFileSync|mkdirSync|mkdtemp/;
		for (const [name, src] of await readAllSources()) {
			if (ALLOWED_WRITERS.has(name)) continue;
			assert.ok(!WRITERS.test(src), `${name} 이 파일을 쓴다 — 토큰 유출 경로가 될 수 있다`);
		}
	});

	test('파일을 쓰는 모듈은 토큰 경로를 참조하지 않는다', async () => {
		for (const [name, src] of await readAllSources()) {
			if (!ALLOWED_WRITERS.has(name)) continue;
			assert.ok(
				!TOKEN_TOUCH.test(codeOnly(src)),
				`${name} 은 파일을 쓰는 모듈인데 토큰 관련 심볼을 참조한다`,
			);
		}
	});
});

describe('A6 — 런타임 의존성을 늘리지 않는다', () => {
	test('dependencies 는 2개 이하다', async () => {
		const pkg = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
		) as { dependencies: Record<string, string> };
		const deps = Object.keys(pkg.dependencies);
		assert.ok(deps.length <= 2, `의존성이 ${deps.length}개다: ${deps.join(', ')}`);
	});
});

describe('A7 — 벨로그 외 호스트로 나가지 않는다', () => {
	test('소스의 http(s) URL 은 velog.io 뿐이다', async () => {
		for (const [name, rawSrc] of await readAllSources()) {
			// 템플릿 보간(`https://${x}`)은 고정 호스트가 아니라 검사 대상이 아니다.
			const src = codeOnly(rawSrc).replace(/https?:\/\/\$\{[^}]*\}/g, '');
			for (const url of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
				// ★ SVG 네임스페이스는 접속 주소가 아니라 규격이 정한 식별자다.
				//   createElementNS 에 넘기는 값일 뿐 아무 요청도 나가지 않는다.
				if (url === 'http://www.w3.org/2000/svg') continue;
				assert.ok(
					url.includes('velog.io') || url.includes('images.velog'),
					`${name} 에 벨로그 외 URL 이 있다: ${url}`,
				);
			}
		}
	});
});

describe('★★ A8 — editPost 를 부르는 모든 경로에 소유권 검증이 있다', () => {
	// 실제로 빠져 있었다. publish.ts 세 곳에만 넣고 drafts.ts 의 update_draft 를
	// 빠뜨렸는데, is_temp 사전확인이 '우연히' 막아주고 있었다.
	// 우연에 기대는 건 방어가 아니다 — 구조로 강제한다.
	test('editPost mutation 을 쓰는 파일은 반드시 assertOwned 를 import 한다', async () => {
		for (const [name, src] of await readAllSources()) {
			if (name === 'ownership.ts') continue;
			if (!/editPost\s*\(/.test(src)) continue;
			assert.match(
				src,
				/import\s*\{[^}]*assertOwned[^}]*\}\s*from\s*'[^']*ownership\.ts'/,
				`${name} 이 editPost 를 부르는데 assertOwned 를 가져오지 않는다`,
			);
		}
	});

	test('mutate() 호출 개수만큼 assertOwned 호출이 있다', async () => {
		for (const [name, rawSrc] of await readAllSources()) {
			const src = codeOnly(rawSrc);
			// editPost 를 실제로 보내는 mutate 호출 수
			const edits = (src.match(/mutate<[^>]*editPost[^>]*>/g) ?? []).length;
			if (edits === 0) continue;
			const guards = (src.match(/await assertOwned\(/g) ?? []).length;
			assert.ok(
				guards >= edits,
				`${name}: editPost 전송 ${edits}회인데 소유권 검증은 ${guards}회다`,
			);
		}
	});

	test('소유권 검증은 단일 구현이다 — 복사본이 생기면 한쪽만 고쳐진다', async () => {
		const defs = (await readAllSources()).filter(([, src]) =>
			/export\s+async\s+function\s+assertOwned/.test(src),
		);
		assert.equal(defs.length, 1, `assertOwned 구현이 ${defs.length}개다`);
		assert.equal(defs[0]?.[0], 'ownership.ts');
	});
});

describe('★★ A9 — editPost 는 기존 meta 를 보존한다', () => {
	// meta 에는 short_description 같은 표시 데이터가 들어간다. EditPostInput 에서
	// meta 는 필수이고 서버가 받은 값을 그대로 DB 에 넣으므로, {} 를 보내면 지워진다.
	//
	// ★ 이 규칙이 필요한 이유: 같은 실수를 두 번 했다. 소유권 검증도, meta 보존도
	//   publish.ts 에만 넣고 drafts.ts 를 빠뜨렸다. 파일이 둘이면 반드시 한쪽이 빠진다.
	test('id 를 함께 보내는(=수정) input 은 meta 를 빈 객체로 두지 않는다', async () => {
		for (const [name, rawSrc] of await readAllSources()) {
			const src = codeOnly(rawSrc);
			if (!/mutate<[^>]*editPost/.test(src)) continue;

			// editPost 를 보내는 파일에서 `meta: {}` 리터럴이 남아 있으면,
			// 그게 수정 경로인지 생성 경로인지 사람이 확인해야 한다.
			// 생성(writePost)은 보존할 게 없으므로 {} 가 맞다.
			const emptyMetaLines = src
				.split('\n')
				.map((line, i) => [i + 1, line] as const)
				.filter(([, line]) => /^\s*meta:\s*\{\}\s*,?\s*$/.test(line));

			for (const [lineNo, line] of emptyMetaLines) {
				// 해당 input 블록 앞쪽에 `id,` 가 있으면 수정 경로다.
				const block = src.split('\n').slice(Math.max(0, lineNo - 12), lineNo).join('\n');
				assert.ok(
					!/^\s*id,\s*$/m.test(block),
					`${name}:${lineNo} 수정 경로인데 meta 를 {} 로 보낸다 — ` +
						`기존 short_description 이 지워진다. (${line.trim()})`,
				);
			}
		}
	});

	test('editPost 를 보내는 파일은 meta 를 조회한다', async () => {
		for (const [name, src] of await readAllSources()) {
			if (!/mutate<[^>]*editPost/.test(codeOnly(src))) continue;
			assert.match(
				src,
				/query[\s\S]*?post\(input:[\s\S]*?\bmeta\b/,
				`${name} 이 editPost 를 보내는데 사전조회에 meta 가 없다 — 병합할 값이 없다`,
			);
		}
	});
});

describe('★ A10 — 프로필 수정은 VELOG_ALLOW_PROFILE 없이는 불가능하다', () => {
	const PROFILE_TOOLS = [
		'velog_update_profile',
		'velog_update_about',
		'velog_update_blog_title',
		'velog_update_social_links',
		'velog_update_profile_image',
	];

	test('기본값은 프로필 수정 불가다', () => {
		assert.equal(readCapabilities({}).editProfile, false);
	});

	test('설정이 꺼져 있으면 도구가 아예 등록되지 않는다', async () => {
		// 목록에 없으면 부를 수도 없다 — 파라미터를 막는 것보다 강하다.
		const client = await connect(false, false);
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const tool of PROFILE_TOOLS) {
			assert.ok(!names.includes(tool), `${tool} 이 설정 없이 노출됐다`);
		}
		await client.close();
	});

	test('설정을 켜면 5개가 등록된다', async () => {
		const client = await connect(false, true);
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const tool of PROFILE_TOOLS) {
			assert.ok(names.includes(tool), `${tool} 이 등록되지 않았다`);
		}
		await client.close();
	});

	test('환경변수는 좁게 해석한다', () => {
		assert.equal(readCapabilities({ VELOG_ALLOW_PROFILE: '1' }).editProfile, true);
		assert.equal(readCapabilities({ VELOG_ALLOW_PROFILE: 'yes' }).editProfile, true);
		for (const off of ['0', 'false', '', 'y', 'enabled']) {
			assert.equal(
				readCapabilities({ VELOG_ALLOW_PROFILE: off }).editProfile,
				false,
				`'${off}' 로 켜졌다`,
			);
		}
	});

	test('공개 발행 스위치와 독립이다', () => {
		assert.deepEqual(readCapabilities({ VELOG_ALLOW_PUBLIC: '1' }), {
			publicPublish: true,
			editProfile: false,
		});
		assert.deepEqual(readCapabilities({ VELOG_ALLOW_PROFILE: '1' }), {
			publicPublish: false,
			editProfile: true,
		});
	});

	test('프로필 도구도 destructive 로 표시한다 — 기존 값을 덮어쓴다', async () => {
		const client = await connect(false, true);
		const { tools } = await client.listTools();
		for (const tool of PROFILE_TOOLS) {
			assert.equal(
				tools.find((t) => t.name === tool)?.annotations?.destructiveHint,
				true,
				`${tool} 이 destructive 로 표시되지 않았다`,
			);
		}
		await client.close();
	});
});

describe('★★ A11 — 사용자가 준 series_id 는 소유권을 검사한다', () => {
	// ★ 이 테스트는 처음에 허술했다. '파일 안에 assertOwnsSeries 가 있나'만 봐서,
	//   한 도구에만 넣고 다른 도구에서 빼도 통과했다. 코덱스 4차가 잡아줬다.
	//   지금은 **도구를 실제로 호출해** 거부되는지 본다 — 텍스트 검사보다 강하다.
	//
	// 검사 대상은 '사용자가 준' series_id 뿐이다. 서버에서 읽어온 기존 시리즈
	// (post.series.id)를 그대로 되돌려 보내는 건 이미 내 글의 시리즈라 무관하다.

	/** series_id 를 파라미터로 받는 도구를 스키마에서 찾아낸다. */
	async function toolsTakingSeriesId(): Promise<string[]> {
		const client = await connect(true, false);
		const { tools } = await client.listTools();
		const names = tools
			.filter((t) => 'series_id' in (t.inputSchema?.properties ?? {}))
			.map((t) => t.name);
		await client.close();
		return names;
	}

	/**
	 * 도구마다 '시리즈 검사에 도달하는' 상태가 다르다.
	 *
	 * ★ 이걸 안 맞추면 테스트가 헛돈다 — update_post 는 초안이면 시리즈 검사
	 *   전에 거부되므로, 목이 늘 is_temp:true 를 주면 시리즈 가드를 지워도
	 *   통과한다. 코덱스 5차가 이 구멍을 잡아줬다.
	 */
	const STATE_FOR: Record<string, { is_temp: boolean; is_private: boolean }> = {
		velog_update_post: { is_temp: false, is_private: true }, // 발행글이어야 진행
		velog_publish_draft: { is_temp: true, is_private: true }, // 초안이어야 진행
		velog_update_draft: { is_temp: true, is_private: true },
		velog_create_draft: { is_temp: true, is_private: true },
		velog_publish_post: { is_temp: true, is_private: true },
	};

	/** 내 시리즈는 mine-1 뿐. 주어진 seriesId 로 도구를 부른다. */
	async function callWithSeries(tool: string, seriesId: string) {
		let mutated = false;
		const state = STATE_FOR[tool] ?? { is_temp: true, is_private: true };
		// 재조회는 '방금 저장된' 모습을 돌려줘야 사후검증이 통과한다.
		// 저장 전에는 시리즈가 없고, 저장 후에는 보낸 시리즈가 붙어 있다.
		const postFor = (afterMutation: boolean) => ({
			id: 'p1',
			title: 't',
			body: 'b',
			url_slug: 's',
			tags: [],
			meta: {},
			user: { username: 'me' },
			...(afterMutation ? { series: { id: seriesId } } : {}),
			...state,
		});
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { body: string }) => {
				const body = JSON.parse(init.body) as { query: string };
				const json = (data: unknown) =>
					new Response(JSON.stringify({ data }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				if (body.query.includes('currentUser')) {
					return json({ currentUser: { id: 'u1', username: 'me' } });
				}
				if (body.query.includes('seriesList')) {
					// 내 시리즈는 mine-1 뿐 — others-1 은 남의 것이다.
					return json({ seriesList: [{ id: 'mine-1', name: '내 시리즈' }] });
				}
				if (body.query.includes('mutation')) {
					mutated = true;
					// assertStayedDraft·verifyAfter 가 응답을 읽으므로 실제 형태로 준다.
					const saved = postFor(true);
					return json({ writePost: saved, editPost: saved });
				}
				return json({ post: postFor(mutated) });
			}) as unknown as typeof fetch,
		});
		const server = createServer(client, { publicPublish: true, editProfile: false });
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const mcp = new Client({ name: 'a11', version: '0' });
		await Promise.all([mcp.connect(ct), server.connect(st)]);
		const result = await mcp.callTool({
			name: tool,
			arguments: { id: 'p1', title: 't', body: 'b', series_id: seriesId },
		});
		await mcp.close();
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
		return { isError: result.isError === true, mutated, text };
	}

	test('series_id 를 받는 도구가 실제로 존재한다 — 없으면 이 테스트가 무의미하다', async () => {
		const names = await toolsTakingSeriesId();
		assert.ok(names.length > 0, 'series_id 파라미터를 가진 도구가 하나도 없다');
	});

	test('★ series_id 를 받는 모든 도구가 남의 시리즈를 거부한다', async () => {
		for (const tool of await toolsTakingSeriesId()) {
			const { isError, mutated, text } = await callWithSeries(tool, 'others-1');
			assert.equal(isError, true, `${tool} 이 남의 시리즈 id 를 통과시켰다`);
			assert.equal(
				mutated,
				false,
				`${tool} 이 mutation 을 실제로 보냈다 — 남의 시리즈가 변경된다`,
			);
			// ★ '어떤 이유로든 거부'가 아니라 '시리즈 소유권 때문에 거부'여야 한다.
			//   안 그러면 다른 사전검사가 대신 막아주는 걸 통과로 착각한다.
			assert.match(
				text,
				/시리즈가 아닙니다/,
				`${tool} 이 다른 이유로 거부했다 — 시리즈 가드가 동작했는지 알 수 없다: ${text.slice(0, 90)}`,
			);
		}
	});

	test('★ 내 시리즈는 통과해 mutation 까지 간다 — 무조건 거부는 안 된다', async () => {
		// 음성 경로만 보면 '모든 시리즈를 거부' 하는 구현도 통과한다.
		// 소유권 조회가 실제로 일어나고 판정이 값에 따라 갈리는지 확인한다.
		for (const tool of await toolsTakingSeriesId()) {
			const { isError, mutated, text } = await callWithSeries(tool, 'mine-1');
			assert.notEqual(
				isError,
				true,
				`${tool} 이 내 시리즈(mine-1)를 거부했다 — 무조건 거부하고 있다: ${text.slice(0, 90)}`,
			);
			assert.equal(mutated, true, `${tool} 이 내 시리즈인데 mutation 까지 안 갔다`);
		}
	});

	test('시리즈 소유권 구현은 단일하다 — 복사본이 생기면 한쪽만 고쳐진다', async () => {
		const defs = (await readAllSources()).filter(([, src]) =>
			/export\s+async\s+function\s+assertOwnsSeries/.test(src),
		);
		assert.equal(defs.length, 1);
		assert.equal(defs[0]?.[0], 'ownership.ts');
	});
});

/**
 * 부작용을 내는 호출은 **반드시** 취소 신호와 줄 세우기를 거친다.
 *
 * ★ 왜 구조 테스트인가 — 이 저장소는 같은 실수를 이미 두 번 했다. 소유권 확인을
 *   `drafts.ts` 에만 넣고 `publish.ts` 를 빠뜨렸고, `meta` 보존도 한쪽만 고쳤다.
 *   호출부가 열두 곳이면 "다음에 하나 더 늘 때 빠진다"가 아니라 **반드시 빠진다.**
 *   사람이 기억하는 대신 테스트가 세게 한다.
 */
describe('쓰기 경로는 빠짐없이 취소·직렬화를 거친다', () => {
	/** 도구 모듈만 본다. client.ts 자신은 대상이 아니다. */
	const isToolModule = (name: string): boolean => name.startsWith('tools/');

	test('client.mutate / uploadImage 호출에는 취소 신호가 실린다', async () => {
		const missing: string[] = [];
		for (const [name, src] of await readAllSources()) {
			if (!isToolModule(name)) continue;
			// 호출 시작부터 균형이 맞는 닫는 괄호까지를 한 호출로 본다.
			for (const match of src.matchAll(/client\.(mutate|uploadImage)\s*[<(]/g)) {
				const start = match.index;
				let depth = 0;
				let end = start;
				for (let i = start; i < src.length; i++) {
					const c = src[i];
					if (c === '(') depth++;
					else if (c === ')') {
						depth--;
						if (depth === 0) {
							end = i;
							break;
						}
					}
				}
				const call = src.slice(start, end + 1);
				// uploadImage 는 옵션 객체를 변수로 만들어 넘기므로 그 변수도 인정한다.
				if (!/signal/.test(call) && !/uploadOptions/.test(call)) {
					missing.push(`${name}: ${call.replace(/\s+/g, ' ').slice(0, 70)}`);
				}
			}
		}
		assert.deepEqual(
			missing,
			[],
			'취소 신호 없이 나가는 쓰기가 있다 — 클라이언트가 포기한 뒤에도 반영된다',
		);
	});

	test('uploadOptions 를 만드는 자리에는 signal 이 들어간다', async () => {
		for (const [name, src] of await readAllSources()) {
			if (!isToolModule(name)) continue;
			for (const match of src.matchAll(/const uploadOptions[\s\S]{0,400}?;\n/g)) {
				assert.match(
					match[0],
					/signal/,
					`${name}: uploadOptions 에 signal 이 빠졌다`,
				);
			}
		}
	});

	/**
	 * ★★ 줄은 **저장소 전체에 하나**여야 한다.
	 *
	 * 모듈마다 `makeKeyedSerializer()` 를 따로 만들면 키가 같아도 줄이 다르다.
	 * 그러면 `velog_update_draft` 와 `velog_publish_draft` 가 같은 글을 동시에
	 * 고칠 수 있다 — 앞의 문자열 검사(‘serializeWrite 가 앞에 나오는가’)만으로는
	 * 이걸 못 잡는다. 코덱스 교차검증에서 재현됐다.
	 */
	test('쓰기 줄은 저장소에 하나뿐이다 — 모듈이 따로 만들지 않는다', async () => {
		const owners: string[] = [];
		for (const [name, src] of await readAllSources()) {
			if (name === 'serial.ts') continue;
			if (/makeKeyedSerializer\s*\(/.test(src)) owners.push(name);
		}
		assert.deepEqual(
			owners,
			[],
			'모듈이 자기 줄을 따로 만든다 — serial.ts 의 serializeWrite 를 import 할 것',
		);
	});

	/**
	 * export 의 시간 예산은 **핸들러 시작 시점**부터 재야 한다.
	 * 목록 조회 뒤에 재면 그 앞의 계정 조회·페이지 4장이 예산 밖으로 새 나간다.
	 * (50초 예산 자체는 벽시계가 필요해 단위 테스트로 못 잡는다 — 여기서 위치만 고정한다.)
	 */
	test('export 예산 시계는 목록 조회보다 먼저 켜진다', async () => {
		const src = (await readAllSources()).find(([n]) => n === 'tools/export.ts')?.[1] ?? '';
		const deadlineAt = src.indexOf('const deadline =');
		const listAt = src.indexOf('await fetchAllPosts(');
		assert.ok(deadlineAt > 0 && listAt > 0, '기준 문구를 못 찾았다 — 테스트를 갱신할 것');
		assert.ok(deadlineAt < listAt, '예산 시계를 목록 조회 뒤에 켠다 — 앞 구간이 예산 밖이다');
	});

	test('쓰기 도구의 mutation 은 줄 세우기 안에서 일어난다', async () => {
		const outside: string[] = [];
		for (const [name, src] of await readAllSources()) {
			if (!isToolModule(name)) continue;
			if (!src.includes('client.mutate')) continue;
			// 이 모듈이 serializeWrite 를 아예 안 쓰면 그 자체가 누락이다.
			if (!src.includes('serializeWrite(')) {
				outside.push(`${name}: serializeWrite 를 쓰지 않는다`);
				continue;
			}
			// 각 mutate 호출 앞쪽에 같은 핸들러의 serializeWrite 가 있는지 본다.
			for (const match of src.matchAll(/client\.mutate/g)) {
				const before = src.slice(0, match.index);
				const lastSerialize = before.lastIndexOf('serializeWrite(');
				const lastRegister = before.lastIndexOf('server.registerTool(');
				if (lastSerialize < lastRegister) {
					outside.push(`${name}: 줄 세우기 밖에서 mutation 이 나간다 (offset ${match.index})`);
				}
			}
		}
		assert.deepEqual(outside, [], '동시 수정이 서로를 덮어쓸 수 있다 — src/serial.ts 참고');
	});
});
