/**
 * 그림 기능의 안전 불변식 R1~R8.
 *
 * 이 기능은 다른 도구와 성격이 다르다. **브라우저를 띄우고**, **로컬 파일을 읽고**,
 * **공개 CDN 으로 바이트를 내보낸다.** 그래서 지켜야 할 것도 다르다:
 *
 *   - 페이지에 들어가는 것은 데이터뿐이어야 한다 (마크업·스크립트가 아니라)
 *   - 렌더 페이지는 네트워크를 못 써야 한다
 *   - 올라가는 건 진짜 이미지여야 한다
 *   - 감사에 걸린 그림은 올라가면 안 된다
 *
 * R1 은 실제로 겪은 사고에서 나왔다. 페이지 스크립트에 식별자 충돌
 * (`var hit` 과 `function hit`)이 생겨 문법 오류로 통째로 안 돌았는데,
 * 바깥에서는 "결과를 못 읽었다"는 말밖에 못 했다. 문법은 그리기 전에 검사한다.
 */

import { test, describe } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildDiagramHtml } from '../render/page.ts';
import { buildCoverHtml } from '../render/cover.ts';
import { ICONS } from '../render/icons.ts';
import { isHexColor, TONES } from '../render/tones.ts';
import { sniffImage, registerImageTools } from '../tools/images.ts';
import { findChrome } from '../render/chrome.ts';
import { renderDiagram } from '../render/index.ts';
import { VelogClient, VELOG_UPLOAD_ENDPOINT } from '../client.ts';

/**
 * 주석을 걷어낸 실제 코드.
 * ★ 이걸 안 하면 "innerHTML 은 쓰지 않는다" 같은 **설명 문장**이 금지어 검사에
 *   걸린다 (실제로 처음에 그렇게 실패했다). 검사 대상은 코드지 문서가 아니다.
 */
function codeOnly(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
		.join('\n');
}

/** fetch 목이 받는 첫 인자를 문자열 주소로 바꾼다. */
function urlOf(u: string | URL | Request): string {
	if (typeof u === 'string') return u;
	return u instanceof URL ? u.href : u.url;
}

/** HTML 안의 `<script>…</script>` 조각을 전부 꺼낸다. */
function scripts(html: string): Array<{ attrs: string; body: string }> {
	const out: Array<{ attrs: string; body: string }> = [];
	const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) out.push({ attrs: m[1] ?? '', body: m[2] ?? '' });
	return out;
}

const SAMPLE = {
	title: '표본',
	nodes: [
		{ id: 'a', x: 0, y: 0, title: 'A', sub: '가', icon: 'server', tag: ':80' },
		{ id: 'b', x: 300, y: 200, title: 'B' },
	],
	groups: [{ name: '묶음', members: ['a'] }],
	edges: [{ from: 'a', to: 'b', label: '흐름' }],
};

describe('★ R1 — 페이지 스크립트는 문법이 맞는다', () => {
	// 실패 사례: `var hit` 과 `function hit` 충돌 → 스크립트 전체가 안 돌았다.
	// 브라우저를 띄우기 전에 여기서 걸린다.
	test('다이어그램 페이지', () => {
		const found = scripts(buildDiagramHtml(SAMPLE));
		const code = found.filter((s) => !s.attrs.includes('application/json'));
		assert.equal(code.length, 1, '실행 스크립트는 정확히 하나여야 한다');
		const body = code[0]?.body ?? '';
		assert.doesNotThrow(() => new Script(body), '페이지 스크립트에 문법 오류가 있다');
	});

	test('표지 페이지', () => {
		const found = scripts(buildCoverHtml({ title: '표지', subtitle: '부제', tags: ['가'] }));
		const code = found.filter((s) => !s.attrs.includes('application/json'));
		assert.equal(code.length, 1);
		const body = code[0]?.body ?? '';
		assert.doesNotThrow(() => new Script(body));
	});
});

describe('★ R2 — 입력은 데이터로만 들어간다 (스크립트 탈출 불가)', () => {
	const EVIL = '</script><script>globalThis.pwned=1</script><!--';

	test('제목·라벨에 마크업을 넣어도 스크립트가 늘어나지 않는다', () => {
		const clean = scripts(buildDiagramHtml(SAMPLE)).length;
		const dirty = scripts(
			buildDiagramHtml({
				title: EVIL,
				nodes: [{ id: 'a', x: 0, y: 0, title: EVIL, sub: EVIL, tag: EVIL }],
				groups: [{ name: EVIL, sub: EVIL }],
				edges: [{ points: [[0, 0], [10, 0]], label: EVIL }],
			}),
		).length;
		assert.equal(dirty, clean, '주입 문자열이 <script> 를 하나 더 만들었다');
	});

	test('JSON 블록에는 < 가 남아 있지 않다', () => {
		const html = buildDiagramHtml({
			title: EVIL,
			nodes: [{ x: 0, y: 0, title: EVIL }],
		});
		const json = scripts(html).find((s) => s.attrs.includes('application/json'));
		assert.ok(json, 'JSON 블록이 있어야 한다');
		assert.ok(!json.body.includes('<'), 'JSON 블록에 원문 < 가 남아 있다');
		// 그래도 데이터는 보존돼야 한다 — 이스케이프지 삭제가 아니다.
		assert.equal(
			(JSON.parse(json.body) as { title: string }).title,
			EVIL,
			'이스케이프 뒤에도 원래 문자열이 그대로 나와야 한다',
		);
	});

	test('표지도 같다', () => {
		const html = buildCoverHtml({ title: EVIL, subtitle: EVIL, kicker: EVIL, tags: [EVIL] });
		const json = scripts(html).find((s) => s.attrs.includes('application/json'));
		assert.ok(json && !json.body.includes('<'));
		assert.equal(scripts(html).length, 2);
	});
});

describe('★ R3 — 렌더 페이지는 네트워크를 못 쓴다', () => {
	test('크롬 인자에 DNS 차단이 있고 보안 완화 플래그가 없다', async () => {
		const src = codeOnly(await readFile(new URL('../render/chrome.ts', import.meta.url), 'utf8'));
		assert.match(
			src,
			/--host-resolver-rules=MAP \* ~NOTFOUND/,
			'DNS 차단 플래그가 사라졌다 — 렌더 페이지가 외부로 나갈 수 있다',
		);
		for (const bad of ['--disable-web-security', '--allow-file-access-from-files', '--no-sandbox']) {
			assert.ok(!src.includes(bad), `보안 완화 플래그가 들어갔다: ${bad}`);
		}
		assert.match(src, /--user-data-dir=/, '임시 프로필을 안 쓰면 사용자 크롬 프로필을 건드린다');
	});

	test('렌더 모듈이 외부 리소스를 참조하지 않는다', async () => {
		for (const name of ['page.ts', 'cover.ts', 'icons.ts', 'tones.ts', 'index.ts', 'chrome.ts']) {
			const src = codeOnly(await readFile(new URL(`../render/${name}`, import.meta.url), 'utf8'));
			const urls = src.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
			for (const url of urls) {
				// SVG 네임스페이스는 식별자일 뿐 실제로 받아오지 않는다.
				assert.ok(
					url.startsWith('http://www.w3.org/2000/svg'),
					`${name} 에 외부 URL 이 있다: ${url}`,
				);
			}
		}
	});

	test('DOM 은 innerHTML 이 아니라 노드 API 로 만든다', async () => {
		for (const name of ['page.ts', 'cover.ts']) {
			const src = codeOnly(await readFile(new URL(`../render/${name}`, import.meta.url), 'utf8'));
			for (const bad of ['innerHTML', 'outerHTML', 'document.write', 'insertAdjacentHTML']) {
				assert.ok(!src.includes(bad), `${name} 이 ${bad} 를 쓴다`);
			}
			assert.match(src, /createElementNS/, `${name} 이 노드 API 를 안 쓴다`);
			assert.match(src, /textContent/, `${name} 이 textContent 를 안 쓴다`);
		}
	});
});

describe('★ R4 — 색은 입력 단계에서 좁혀져 있다', () => {
	test('#rgb / #rrggbb 만 통과한다', () => {
		for (const ok of ['#fff', '#0f172a', '#ABCDEF']) assert.ok(isHexColor(ok), ok);
		for (const ng of [
			'url(#x)', 'var(--c)', 'red', '#12', '#1234567',
			'javascript:alert(1)', ' #fff', '#fff ', 'rgb(0,0,0)',
		]) {
			assert.ok(!isHexColor(ng), `막아야 하는데 통과했다: ${ng}`);
		}
	});

	test('톤 팔레트의 색도 전부 hex 다', () => {
		for (const [name, t] of Object.entries(TONES)) {
			for (const v of [t.fill, t.stroke, t.solid]) {
				assert.ok(isHexColor(v), `${name} 톤에 hex 아닌 값: ${v}`);
			}
		}
	});
});

describe('★ R5 — 이미지가 아닌 것은 올라가지 않는다', () => {
	const bytes = (...v: number[]): Uint8Array => new Uint8Array(v);

	test('진짜 시그니처만 통과한다', () => {
		assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.mime, 'image/png');
		assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))?.mime, 'image/jpeg');
		assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))?.mime, 'image/gif');
		assert.equal(
			sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))?.mime,
			'image/webp',
		);
	});

	test('비밀키·텍스트·SVG·빈 파일은 막힌다', () => {
		const asBytes = (s: string): Uint8Array => new TextEncoder().encode(s);
		assert.equal(sniffImage(asBytes('-----BEGIN OPENSSH PRIVATE KEY-----')), null);
		assert.equal(sniffImage(asBytes('root:x:0:0:root:/root:/bin/bash')), null);
		assert.equal(sniffImage(asBytes('<svg onload="fetch(1)"></svg>')), null, 'SVG 는 받지 않는다');
		assert.equal(sniffImage(asBytes('{"a":1}')), null);
		assert.equal(sniffImage(new Uint8Array(0)), null);
		// 시그니처가 한 칸 밀린 것도 통과하면 안 된다
		assert.equal(sniffImage(bytes(0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), null);
	});
});

describe('★ R6 — 자격증명은 벨로그 업로드 주소로만 나간다', () => {
	const auth = {
		kind: 'authenticated' as const,
		credentials: { accessToken: 'AAA.BBB.CCC', refreshToken: undefined },
	};

	test('다른 주소면 요청 자체를 거부한다', async () => {
		const client = new VelogClient({
			auth,
			uploadEndpoint: 'https://evil.example/upload',
			fetchImpl: () => {
				throw new Error('여기까지 오면 안 된다 — 요청이 나갔다');
			},
		});
		await assert.rejects(
			() => client.uploadImage(new Uint8Array([1]), 'a.png', { type: 'post', contentType: 'image/png' }),
			/velog\.io/,
		);
	});

	test('정규 주소로는 image 필드로 보낸다', async () => {
		let seen: { url: string; hasCookie: boolean; form?: FormData | undefined } | null = null;
		const client = new VelogClient({
			auth,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				seen = {
					url: urlOf(url),
					hasCookie: 'Cookie' in headers,
					form: init?.body instanceof FormData ? init.body : undefined,
				};
				return new Response(JSON.stringify({ path: 'https://velog.velcdn.com/images/x/y.png' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});

		const url = await client.uploadImage(new Uint8Array([1, 2, 3]), 'a.png', {
			type: 'post',
			contentType: 'image/png',
			refId: 'post-1',
		});

		assert.equal(url, 'https://velog.velcdn.com/images/x/y.png');
		assert.ok(seen, '요청이 나가지 않았다');
		const sent = seen as unknown as { url: string; hasCookie: boolean; form?: FormData | undefined };
		assert.equal(sent.url, VELOG_UPLOAD_ENDPOINT);
		assert.ok(sent.hasCookie, '쿠키가 실리지 않았다');
		// 필드 이름이 틀리면 서버가 파일을 못 찾는다 (multer.single('image'))
		assert.ok(sent.form?.has('image'), "폼에 'image' 필드가 없다");
		assert.equal(sent.form?.get('type'), 'post');
		assert.equal(sent.form?.get('ref_id'), 'post-1');
	});
});

describe('★ R7 — 감사 항목이 늘면 업로드 차단 조건도 같이 늘어야 한다', () => {
	// 감사 종류를 하나 추가해 놓고 clean 판정에서 빠뜨리면, 결함이 있는 그림이
	// 조용히 올라간다. 실제로 label 항목을 새로 만들 때 이 실수를 할 뻔했다.
	test('AuditReport 의 모든 항목이 clean 판정에 들어 있다', async () => {
		const page = await readFile(new URL('../render/page.ts', import.meta.url), 'utf8');
		const images = await readFile(new URL('../tools/images.ts', import.meta.url), 'utf8');

		const block = /export interface AuditReport \{([\s\S]*?)\n\}/.exec(page)?.[1];
		assert.ok(block, 'AuditReport 를 못 찾았다');
		const fields = [...block.matchAll(/^\t(\w+):/gm)]
			.map((m) => m[1] ?? '')
			.filter((f) => f !== '' && f !== 'w' && f !== 'h');
		assert.ok(fields.length >= 5, `감사 항목이 너무 적다: ${fields.join(',')}`);

		const clean = /const clean =([\s\S]*?);/.exec(images)?.[1] ?? '';
		for (const f of fields) {
			assert.ok(clean.includes(`a.${f}.length === 0`), `clean 판정에 a.${f} 가 빠졌다`);
		}
	});
});

describe('★ R8 — 아이콘은 전부 내장 도형이다', () => {
	test('path 는 허용 문자만 쓰고 외부 참조가 없다', () => {
		for (const [name, prims] of Object.entries(ICONS)) {
			assert.ok(prims.length > 0, `${name} 이 비어 있다`);
			for (const p of prims) {
				if (p[0] !== 'p') continue;
				const d = p[1];
				assert.match(d, /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/, `${name} path 에 이상한 문자: ${d}`);
			}
		}
	});
});

describe('R9 — 그림 도구는 인증 없이는 올리지 않는다', () => {
	test('무인증이면 upload:true 요청이 거부된다', async () => {
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, new VelogClient({ auth: { kind: 'anonymous' } }));
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'render-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		const r = await client.callTool({
			name: 'velog_render_diagram',
			arguments: { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], upload: true },
		});
		assert.equal(r.isError, true, '무인증인데 렌더가 진행됐다');
		// 크롬을 띄우기 **전에** 막혀야 한다. 인증 확인이 렌더 뒤에 있으면
		// 올리지도 못할 그림을 몇 초씩 그리게 된다.
		assert.match(String((r.content as Array<{ text: string }>)[0]?.text), /인증|토큰/);
		await client.close();
	});
});


describe('★ R10 — 도형 이름·평면 key 는 좁혀져 있다', () => {
	async function tools(): Promise<Client> {
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, new VelogClient({ auth: { kind: 'anonymous' } }));
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'render-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);
		return client;
	}

	// plane.key 는 SVG marker 의 id 가 되고 url(#arr-<key>) 로 참조된다.
	// dash 는 stroke-dasharray 로 들어간다. 둘 다 자유 문자열이면 안 된다.
	test('이상한 plane key / dash 는 스키마에서 막힌다', async () => {
		const client = await tools();
		for (const planes of [
			[{ key: 'x) url(http://evil/', name: 'n', color: '#000' }],
			[{ key: 'a b', name: 'n', color: '#000' }],
			[{ key: 'r', name: 'n', color: '#000', dash: 'url(#x)' }],
			[{ key: 'r', name: 'n', color: 'red' }],
		]) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], planes, upload: false },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${JSON.stringify(planes)}`);
		}
		await client.close();
	});

	test('없는 아이콘·톤 이름도 막힌다', async () => {
		const client = await tools();
		for (const bad of [{ icon: 'nope' }, { icon_tone: 'neon' }, { tag_tone: '#fff' }]) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { title: 't', nodes: [{ x: 0, y: 0, title: 'A', ...bad }], upload: false },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${JSON.stringify(bad)}`);
		}
		await client.close();
	});
});

describe('★ R11 — 자가감사 실동작 (크롬 필요)', () => {
	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	// 처음엔 직각 선분만 검사해서, points 로 준 대각선이 노드를 관통해도 통과했다.
	test('노드를 가로지르는 대각선을 잡는다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '대각선 관통',
			nodes: [
				{ id: 'a', x: 0, y: 0, w: 140, h: 60, title: 'A' },
				{ id: 'mid', x: 200, y: 120, w: 160, h: 80, title: '가운데' },
				{ id: 'b', x: 460, y: 300, w: 140, h: 60, title: 'B' },
			],
			edges: [{ points: [[70, 60], [530, 300]] }], // mid 를 관통하는 대각선
			legend: false,
		});
		assert.ok(r.audit.cross.length > 0, `관통을 못 잡았다: ${JSON.stringify(r.audit)}`);
	});

	// 양성만 보면 '무조건 걸린다'도 통과한다. 안 걸리는 경우도 확인한다.
	test('비껴가는 대각선은 잡지 않는다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '대각선 비껴감',
			nodes: [
				{ id: 'a', x: 0, y: 0, w: 140, h: 60, title: 'A' },
				{ id: 'mid', x: 200, y: 400, w: 160, h: 80, title: '가운데' },
				{ id: 'b', x: 460, y: 0, w: 140, h: 60, title: 'B' },
			],
			edges: [{ points: [[140, 30], [460, 30]] }],
			legend: false,
		});
		assert.deepEqual(r.audit.cross, [], `없는 관통을 만들어냈다: ${JSON.stringify(r.audit)}`);
	});

	// 같은 두 열 사이를 지나는 선은 중간 꺾임 좌표가 같아서 한 줄로 겹쳤다.
	// 노드를 규칙적으로 놓을수록(= 보기 좋게 그릴수록) 더 잘 생기는 문제였다.
	test('나란한 경로들의 중간선이 겹치지 않는다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '나란한 경로',
			nodes: [
				{ id: 'l1', x: 0, y: 0, title: '왼쪽1' },
				{ id: 'l2', x: 0, y: 140, title: '왼쪽2' },
				{ id: 'l3', x: 0, y: 280, title: '왼쪽3' },
				{ id: 'r1', x: 420, y: 40, title: '오른쪽1' },
				{ id: 'r2', x: 420, y: 180, title: '오른쪽2' },
				{ id: 'r3', x: 420, y: 320, title: '오른쪽3' },
			],
			edges: [
				{ from: 'l1', to: 'r1' },
				{ from: 'l2', to: 'r2' },
				{ from: 'l3', to: 'r3' },
			],
			legend: false,
		});
		assert.deepEqual(r.audit.overlap, [], `중간선이 겹쳤다: ${JSON.stringify(r.audit.overlap)}`);
	});

	// 노드 id 가 '__proto__' 여도 사전 조회가 어긋나면 안 된다.
	test("id 가 '__proto__' 여도 엣지가 연결된다", async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '프로토타입 키',
			nodes: [
				{ id: '__proto__', x: 0, y: 0, title: '첫번째' },
				{ id: 'constructor', x: 320, y: 0, title: '두번째' },
			],
			edges: [{ from: '__proto__', to: 'constructor', label: '연결' }],
			legend: false,
		});
		assert.deepEqual(
			r.audit.over.filter((v) => v.includes('없는 노드')),
			[],
			`노드를 못 찾았다: ${JSON.stringify(r.audit.over)}`,
		);
	});
});


describe('★ R12 — 페이지에 URL 을 받는 자리가 없다', () => {
	// 이게 1차 방어다. 크롬의 DNS 차단은 2차이고, 그 플래그는 이름 풀이를 막는 것이라
	// IP 를 직접 적은 주소까지 막아주지 않는다. 그러니 '구멍이 없다'가 본질이다.
	test('href/src/fetch 가 없고 url() 은 문서 내부 참조뿐이다', async () => {
		for (const name of ['page.ts', 'cover.ts']) {
			const src = codeOnly(await readFile(new URL(`../render/${name}`, import.meta.url), 'utf8'));
			for (const sink of ['href', "'src'", '"src"', 'xlink', 'fetch(', 'XMLHttpRequest', 'import(']) {
				assert.ok(!src.includes(sink), `${name} 에 URL 을 받는 자리가 생겼다: ${sink}`);
			}
			for (const use of src.match(/url\([^)]*/g) ?? []) {
				assert.ok(use.startsWith('url(#'), `${name} 의 url() 이 문서 밖을 가리킨다: ${use})`);
			}
		}
	});
});


describe('★★ R13 — 서버가 죽으면 크롬도 같이 죽는다', () => {
	// 실제로 고아를 만들었다. MCP 클라이언트가 타임아웃으로 연결을 끊자 서버가 죽었고,
	// 렌더 중이던 크롬이 PPID=1 로 살아남아 23분을 돌고 있었다 (ps 로 확인).
	// POSIX 에서 부모가 죽어도 자식은 안 죽는다 — 아무도 안 죽이면 그냥 남는다.
	//
	// 변이 검증: 종료 훅을 빼고 돌리면 크롬 4개가 남는다. 이 검사는 강제력이 있다.
	test('렌더 도중 프로세스를 끝내도 크롬이 남지 않는다', async (t) => {
		if (platform !== 'darwin' && platform !== 'linux') {
			t.skip('pgrep 이 있는 환경에서만 확인한다');
			return;
		}
		const has = await findChrome().then(() => true, () => false);
		if (!has) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}

		const entry = new URL('../render/index.ts', import.meta.url).href;
		const script =
			`import { renderDiagram } from ${JSON.stringify(entry)};\n` +
			`renderDiagram({ title: '고아 확인', nodes: [{ x:0, y:0, title:'A' }], legend:false });\n` +
			`setTimeout(() => process.exit(0), 1200);\n`;

		// ★ 자식에게 전용 TMPDIR 을 준다. 렌더러는 os.tmpdir() 아래에 프로필을 만들므로
		//   이 검사가 **이 자식이 띄운 크롬만** 보게 된다. 전역으로 찾으면 같은 기계에서
		//   돌고 있는 다른 렌더를 남의 고아로 오인한다.
		const sandbox = await mkdtemp(join(tmpdir(), 'velog-mcp-orphan-test-'));
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: 'ignore',
			env: { ...process.env, TMPDIR: sandbox },
		});
		await new Promise<void>((resolve) => child.on('exit', () => { resolve(); }));

		// ★ 고정 대기로 두면 안 된다. 브라우저 본체는 SIGKILL 로 즉시 죽지만 헬퍼
		//   프로세스(gpu·network·storage)가 뒤따라 정리되는 데 걸리는 시간은 부하에
		//   따라 달라진다 — 1.5초 고정이었을 때 단독 실행은 통과하고 전체 스위트에서는
		//   실패했다. '언젠가 사라진다'가 보장이므로 사라질 때까지 본다.
		// ★ `pgrep -f "velog-mcp-chrome-"` 는 **자기를 실행한 셸까지 잡는다** —
		//   그 셸의 명령줄에 패턴 문자열이 그대로 들어 있기 때문이다. 처음엔 그걸
		//   모르고 잡힌 pid 를 kill 했더니 테스트가 자기 프로세스 트리를 죽였다.
		//   `velog[-]mcp` 로 쓰면 찾는 대상(`velog-mcp`)에는 맞고 명령줄 자신에는
		//   안 맞는다. 거기에 더해 죽이기 전에 '정말 크롬인지' 한 번 더 본다.
		// `pgrep -f <문자열>` 은 **자기를 실행한 셸까지 잡는다** (그 셸 명령줄에 패턴이
		// 그대로 들어 있다). 처음엔 그걸 모르고 잡힌 pid 를 kill 했더니 테스트가 자기
		// 프로세스 트리를 죽였다. `[-]` 로 쪼개면 대상에는 맞고 자신에는 안 맞는다.
		const marker = sandbox.replace('-orphan-test-', '[-]orphan-test-');
		const alive = (): string[] =>
			execFileSync('bash', ['-c', `pgrep -f "${marker}" || true`])
				.toString()
				.split('\n')
				.map((v) => v.trim())
				.filter((v) => /^\d+$/.test(v));
		let left = alive();
		for (let i = 0; i < 40 && left.length > 0; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			left = alive();
		}
		// 걸렸으면 치우고 실패시킨다 — 테스트가 쓰레기를 남기면 안 된다.
		// 다만 pid 만 믿고 죽이지 않는다. 명령줄에 크롬이 보이는 것만 죽인다.
		const stuck: string[] = [];
		for (const pid of left) {
			const cmd = execFileSync('bash', ['-c', `ps -o command= -p ${pid} || true`]).toString();
			if (!cmd.includes('Chrome') && !cmd.includes('chrom')) continue;
			stuck.push(`${pid}: ${cmd.trim().slice(0, 60)}`);
			execFileSync('bash', ['-c', `kill -9 ${pid} || true`]);
		}
		await rm(sandbox, { recursive: true, force: true }).catch(() => {});
		assert.deepEqual(stuck, [], `10초를 기다려도 크롬이 남아 있다:\n${stuck.join('\n')}`);
	});
});
