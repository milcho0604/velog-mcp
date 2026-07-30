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

async function readAllSources(dir = SRC): Promise<Array<[string, string]>> {
	const out: Array<[string, string]> = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__') continue;
		const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
		if (entry.isDirectory()) out.push(...(await readAllSources(url)));
		else if (entry.name.endsWith('.ts')) out.push([entry.name, await readFile(url, 'utf8')]);
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

async function connect(publicPublish = false): Promise<Client> {
	const server = createServer(new VelogClient({ auth: { kind: 'anonymous' } }), {
		publicPublish,
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
		const drafts = (await readAllSources()).find(([n]) => n === 'drafts.ts');
		assert.ok(drafts, 'drafts.ts 를 못 찾았다');
		assert.ok(
			!/is_temp\s*:\s*false/.test(codeOnly(drafts[1])),
			'초안 도구에 발행 경로가 생겼다',
		);
	});
});

describe('A3 — 구현하지 않기로 한 mutation 은 여전히 없다', () => {
	// 되돌릴 수 없거나 남에게 영향을 주는 것들. 설정으로도 열지 않는다.
	const NEVER_CALLED = [
		'unregister', 'logout(', 'sendMail', 'createNotification',
		'removeAllNotifications', 'initiateChangeEmail', 'confirmChangeEmail',
		'likePost', 'unlikePost', 'follow(', 'unfollow(',
		'updateProfile', 'updateAbout', 'updateVelogTitle', 'updateSocialInfo',
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
		'velog_search_posts',
		'velog_trending_posts',
		'velog_unpublish_post',
		'velog_update_draft',
		'velog_update_post',
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
	test('토큰을 다루는 모듈이 파일 쓰기 API 를 쓰지 않는다', async () => {
		const WRITERS = /writeFile|appendFile|createWriteStream|writeFileSync|mkdirSync/;
		for (const [name, src] of await readAllSources()) {
			if (name === 'export.ts') continue; // 글 백업은 의도적으로 파일을 쓴다
			assert.ok(!WRITERS.test(src), `${name} 이 파일을 쓴다 — 토큰 유출 경로가 될 수 있다`);
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
			for (const url of codeOnly(rawSrc).match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
				assert.ok(
					url.includes('velog.io') || url.includes('images.velog'),
					`${name} 에 벨로그 외 URL 이 있다: ${url}`,
				);
			}
		}
	});
});
