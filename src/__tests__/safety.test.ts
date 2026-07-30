/**
 * 안전 불변식 테스트 — PRD 의 성공기준 A1·A2·A5 를 코드로 고정한다.
 *
 * 이 파일이 깨지면 '발행할 수 없다'는 이 프로젝트의 전제가 무너진 것이다.
 * 실패를 우회하지 말고 왜 깨졌는지부터 볼 것.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../index.ts';
import { VelogClient } from '../client.ts';
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

async function connectedClient(): Promise<Client> {
	const server = createServer(new VelogClient({ auth: { kind: 'anonymous' } }));
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'safety-test', version: '0' });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

describe('A1 — 발행 경로가 존재하지 않는다', () => {
	test('DRAFT_ONLY 상수는 is_temp:true 다', () => {
		assert.equal(__testing.DRAFT_ONLY.is_temp, true);
	});

	test('소스 어디에도 is_temp 를 false 로 두는 코드가 없다', async () => {
		for (const [name, src] of await readAllSources()) {
			// 주석은 제외하고 실제 코드만 본다.
			const code = src
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.split('\n')
				.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
				.join('\n');
			assert.ok(
				!/is_temp\s*:\s*false/.test(code),
				`${name} 에 is_temp:false 가 있다 — 발행 경로가 생겼다`,
			);
		}
	});

	test('어떤 도구도 is_temp 를 입력으로 받지 않는다', async () => {
		const client = await connectedClient();
		const { tools } = await client.listTools();
		for (const tool of tools) {
			const keys = Object.keys(tool.inputSchema?.properties ?? {});
			assert.ok(
				!keys.includes('is_temp'),
				`${tool.name} 이 is_temp 를 입력으로 받는다 — 호출자가 발행할 수 있다`,
			);
		}
		await client.close();
	});
});

describe('A2 — 위험한 mutation 이 도구로 노출되지 않는다', () => {
	// introspection 으로 확인한 벨로그 mutation 중 구현하지 않기로 한 것들.
	const FORBIDDEN = [
		'unregister', 'logout', 'publish', 'delete', 'remove',
		'like', 'unlike', 'follow', 'unfollow',
		'sendmail', 'notification',
		'updateprofile', 'updateabout', 'updatethumbnail',
		'updatevelogtitle', 'updatesocial', 'updateemail',
		'changeemail', 'acceptintegration',
	];

	test('도구 이름에 금지 동사가 없다', async () => {
		const client = await connectedClient();
		const { tools } = await client.listTools();
		for (const tool of tools) {
			const name = tool.name.toLowerCase();
			for (const word of FORBIDDEN) {
				assert.ok(!name.includes(word), `${tool.name} 은 노출하면 안 되는 동작이다`);
			}
		}
		await client.close();
	});

	test('소스가 금지 mutation 을 호출하지 않는다', async () => {
		const CALLED = [
			'unregister', 'logout(', 'likePost', 'unlikePost',
			'follow(', 'unfollow(', 'sendMail', 'createNotification',
			'removeAllNotifications', 'updateProfile', 'initiateChangeEmail',
		];
		for (const [name, src] of await readAllSources()) {
			for (const call of CALLED) {
				assert.ok(!src.includes(call), `${name} 이 ${call} 를 호출한다`);
			}
		}
	});

	test('도구 목록 스냅샷 — 새 도구가 늘면 의식적으로 갱신하게 한다', async () => {
		const client = await connectedClient();
		const { tools } = await client.listTools();
		assert.deepEqual(
			tools.map((t) => t.name).sort(),
			[
				'velog_blog_stats',
				'velog_create_draft',
				'velog_export_posts',
				'velog_get_post',
				'velog_list_drafts',
				'velog_list_posts',
				'velog_recent_posts',
				'velog_search_posts',
				'velog_trending_posts',
				'velog_update_draft',
			],
			'도구 목록이 바뀌었다. 새 도구가 안전한지 확인하고 이 스냅샷을 갱신할 것.',
		);
		await client.close();
	});
});

describe('A3 — 토큰이 디스크로 나가지 않는다', () => {
	test('토큰을 다루는 모듈이 파일 쓰기 API 를 쓰지 않는다', async () => {
		const WRITERS = /writeFile|appendFile|createWriteStream|writeFileSync|mkdirSync/;
		for (const [name, src] of await readAllSources()) {
			if (name === 'export.ts') continue; // 글 백업은 의도적으로 파일을 쓴다
			assert.ok(!WRITERS.test(src), `${name} 이 파일을 쓴다 — 토큰 유출 경로가 될 수 있다`);
		}
	});
});

describe('A5 — 런타임 의존성을 늘리지 않는다', () => {
	test('dependencies 는 2개 이하다', async () => {
		const pkg = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
		) as { dependencies: Record<string, string> };
		const deps = Object.keys(pkg.dependencies);
		assert.ok(deps.length <= 2, `의존성이 ${deps.length}개다: ${deps.join(', ')}`);
	});
});

describe('네트워크 — 벨로그 외 호스트로 나가지 않는다', () => {
	test('소스의 http(s) URL 은 velog.io 뿐이다', async () => {
		for (const [name, src] of await readAllSources()) {
			for (const url of src.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
				assert.ok(
					url.includes('velog.io') || url.includes('images.velog'),
					`${name} 에 벨로그 외 URL 이 있다: ${url}`,
				);
			}
		}
	});
});
