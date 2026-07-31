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

	// ★ 처음엔 제목·라벨 몇 개에만 넣었다. 그러면 나머지 필드 하나만 JSON 밖으로
	//   직접 보간하도록 망가뜨려도 통과한다 — 코덱스가 정확히 그 점을 짚었다.
	//   **문자열이 들어가는 자리를 전부** 오염시킨다.
	test('문자열이 들어가는 모든 자리에 마크업을 넣어도 스크립트가 안 늘어난다', () => {
		const clean = scripts(buildDiagramHtml(SAMPLE)).length;
		const dirty = scripts(
			buildDiagramHtml({
				title: EVIL,
				subtitle: EVIL,
				planes: [{ key: 'p', name: EVIL, color: '#000', dash: EVIL }],
				nodes: [
					{ id: EVIL, x: 0, y: 0, title: EVIL, sub: EVIL, tag: EVIL, icon: EVIL, icon_tone: EVIL },
					{ id: `${EVIL}2`, x: 300, y: 0, title: EVIL },
				],
				groups: [{ name: EVIL, sub: EVIL, tone: EVIL, members: [EVIL] }],
				edges: [
					{ plane: EVIL, from: EVIL, to: `${EVIL}2`, label: EVIL, label_anchor: 'start' },
					{ points: [[0, 0], [10, 0]], label: EVIL },
				],
			}),
		).length;
		assert.equal(dirty, clean, '주입 문자열이 <script> 를 하나 더 만들었다');
	});

	// <script> 개수만 세면 iframe·이벤트 속성 같은 다른 실행 경로를 놓친다.
	//
	// ★ 처음엔 'onerror=' 같은 문자열이 HTML 에 있는지로 검사했는데, 그건 틀린
	//   검사였다 — 그 글자는 JSON 문자열 **안**에 있고 `<` 가 이스케이프돼 있어
	//   태그가 될 수 없다. 무해한 데이터를 보고 실패한 것이다.
	//   의미 있는 불변식은 이것이다: **입력이 태그를 하나도 만들지 못한다.**
	test('입력이 문서에 태그를 만들지 못한다', () => {
		const html = buildDiagramHtml({
			title: EVIL,
			subtitle: '" onload="alert(1)',
			nodes: [{ x: 0, y: 0, title: '<img src=x onerror=alert(1)>', sub: '</style><iframe>' }],
			groups: [{ name: '<object data=x>' }],
			edges: [{ points: [[0, 0], [10, 0]], label: '<embed src=x>' }],
		});
		const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) =>
			(m[1] ?? '').toLowerCase(),
		);
		const allowed = new Set([
			'html', 'head', 'meta', 'title', 'style', 'body', 'div', 'svg', 'script',
		]);
		const unexpected = [...new Set(tags)].filter((t) => !allowed.has(t));
		assert.deepEqual(unexpected, [], `입력이 태그를 만들었다: ${unexpected.join(', ')}`);
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
		const html = buildCoverHtml({
			title: EVIL, subtitle: EVIL, kicker: EVIL, tags: [EVIL], footer: EVIL, tone: EVIL,
		});
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
	const asBytes = (v: string): Uint8Array => new TextEncoder().encode(v);
	const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	// 규격상 첫 chunk 는 IHDR 이다 (8~11=길이, 12~15=타입). 끝만 보면 머리에 아무거나
	// 붙여도 통과하므로 fixture 도 구조를 갖춘 것으로 쓴다.
	const PNG_IHDR = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
	const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

	// ★ 예전엔 '머리 8바이트짜리 PNG' 를 통과해야 하는 사례로 고정하고 있었다.
	//   그건 이미지가 아니라 이미지처럼 시작하는 파일이다 — 그래서 시작 시그니처와
	//   끝맺음을 함께 본다. 이 테스트도 온전한 파일로 바꿨다.
	test('머리와 끝맺음이 모두 있어야 통과한다', () => {
		assert.equal(sniffImage(bytes(...PNG_HEAD, ...PNG_IHDR, 1, 2, 3, ...PNG_END))?.mime, 'image/png');
		assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9))?.mime, 'image/jpeg');
		assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 0x3b))?.mime, 'image/gif');
		assert.equal(
			sniffImage(
				bytes(0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4),
			)?.mime,
			'image/webp',
		);
	});

	test('머리만 베껴 붙인 파일은 막힌다', () => {
		// 코덱스가 지적한 그대로의 재현: PNG 머리 + 아무 텍스트
		assert.equal(sniffImage(bytes(...PNG_HEAD, ...asBytes('BEGIN PRIVATE KEY'))), null);
		assert.equal(sniffImage(bytes(...PNG_HEAD)), null, '잘린 PNG');
		// IEND 뒤에 데이터를 덧붙인 것도 정상 PNG 가 아니다 (polyglot 이 숨는 자리)
		assert.equal(
			sniffImage(bytes(...PNG_HEAD, ...PNG_IHDR, ...PNG_END, ...new Array(100).fill(65))),
			null,
		);
		// 머리와 끝은 맞는데 첫 chunk 가 IHDR 이 아닌 것
		assert.equal(sniffImage(bytes(...PNG_HEAD, 0, 0, 0, 13, 65, 65, 65, 65, ...PNG_END)), null);
		assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)), null, '끝나지 않은 JPEG');
		// 이미지 chunk 없는 빈 RIFF 껍데기
		assert.equal(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), null);
	});

	test('비밀키·텍스트·SVG·빈 파일은 막힌다', () => {
		assert.equal(sniffImage(asBytes('-----BEGIN OPENSSH PRIVATE KEY-----')), null);
		assert.equal(sniffImage(asBytes('root:x:0:0:root:/root:/bin/bash')), null);
		assert.equal(sniffImage(asBytes('<svg onload="fetch(1)"></svg>')), null, 'SVG 는 받지 않는다');
		assert.equal(sniffImage(asBytes('{"a":1}')), null);
		assert.equal(sniffImage(new Uint8Array(0)), null);
		// 시그니처가 한 칸 밀린 것도 통과하면 안 된다
		assert.equal(sniffImage(bytes(0x00, ...PNG_HEAD, ...PNG_IHDR, ...PNG_END)), null);
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

	// 표지 감사도 같은 규율을 받아야 한다.
	test('CoverAudit 의 배열 항목도 표지 clean 판정에 들어 있다', async () => {
		const cover = await readFile(new URL('../render/cover.ts', import.meta.url), 'utf8');
		const images = await readFile(new URL('../tools/images.ts', import.meta.url), 'utf8');
		const block = /export interface CoverAudit \{([\s\S]*?)\n\}/.exec(cover)?.[1] ?? '';
		const arrays = [...block.matchAll(/^\t(\w+): string\[\];/gm)].map((m) => m[1] ?? '');
		assert.ok(arrays.length >= 1, 'CoverAudit 에 배열 항목이 없다');
		for (const f of arrays) {
			assert.ok(
				images.includes(`result.audit.${f}.length === 0`),
				`표지 clean 판정에 ${f} 가 빠졌다`,
			);
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

	// ★ id 가 겹치면 관통 감사를 피할 수 있다 — NMAP 은 마지막 것만 남기는데
	//   '자기 노드 제외' 집합은 같은 id 를 전부 빼기 때문이다.
	test('노드 id 중복은 막힌다 (자동 부여되는 n0 과의 충돌 포함)', async () => {
		const client = await tools();
		for (const nodes of [
			[{ x: 0, y: 0, title: 'A', id: 'dup' }, { x: 200, y: 0, title: 'B', id: 'dup' }],
			[{ x: 0, y: 0, title: 'A' }, { x: 200, y: 0, title: 'B', id: 'n0' }],
		]) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { title: 't', nodes, upload: false },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${JSON.stringify(nodes)}`);
		}
		await client.close();
	});

	// 좌표를 안 묶으면 요청 하나로 4만×4만 캔버스를 요구할 수 있다.
	test('좌표·점 개수 상한을 넘으면 막힌다', async () => {
		const client = await tools();
		const cases: Array<Record<string, unknown>> = [
			{ title: 't', nodes: [{ x: 999999, y: 0, title: 'A' }] },
			{ title: 't', nodes: [{ x: 0, y: -999999, title: 'A' }] },
			{
				title: 't',
				nodes: [{ x: 0, y: 0, title: 'A' }],
				edges: [{ points: Array.from({ length: 41 }, (_, i) => [i, i]) }],
			},
			{
				title: 't',
				nodes: [{ x: 0, y: 0, title: 'A' }],
				edges: [{ points: [[0, 0], [99999, 0]] }],
			},
			{ title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: 'g', x: 999999, y: 0 }] },
		];
		for (const args of cases) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { ...args, upload: false },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${JSON.stringify(args).slice(0, 90)}`);
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
		assert.ok(
			r.audit.cross.some((v) => v.includes('가운데')),
			`가운데 노드의 관통이 빠졌다: ${JSON.stringify(r.audit.cross)}`,
		);
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
				{ id: 'hasOwnProperty', x: 320, y: 0, title: '두번째' },
			],
			edges: [{ from: '__proto__', to: 'hasOwnProperty', label: '연결' }],
			legend: false,
		});
		assert.deepEqual(
			r.audit.over.filter((v) => v.includes('없는 노드')),
			[],
			`노드를 못 찾았다: ${JSON.stringify(r.audit.over)}`,
		);
	});

	// ★ 'own'(자기 노드 제외 집합)이 보통 객체면 own['constructor'] 가 상속
	//   프로퍼티라 항상 참이라, id 가 constructor 인 노드는 관통 검사에서 통째로
	//   빠진다. 그걸 잡으려면 그 노드가 **엣지의 종점이 아니어야** 한다 —
	//   종점이면 원래도 제외 대상이라 변이를 넣어도 통과한다(코덱스 지적).
	test("경유 노드 id 가 'constructor' 여도 관통을 잡는다", async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '상속 프로퍼티 id',
			nodes: [
				{ id: 'a', x: 0, y: 0, w: 140, h: 60, title: '시작' },
				{ id: 'constructor', x: 200, y: 0, w: 160, h: 60, title: '가운데' },
				{ id: 'b', x: 460, y: 0, w: 140, h: 60, title: '끝' },
			],
			edges: [{ points: [[70, 30], [530, 30]] }], // 가운데를 관통
			legend: false,
		});
		// ★ cross.length > 0 만 보면 안 된다. 이 선은 시작·끝 노드도 지나가므로
		//   'constructor' 노드가 통째로 빠져도 그 조건은 만족된다(실제로 변이가
		//   통과했다). **그 노드가 지목됐는지**를 봐야 강제력이 생긴다.
		assert.ok(
			r.audit.cross.some((v) => v.includes('가운데')),
			`constructor id 노드의 관통이 빠졌다: ${JSON.stringify(r.audit.cross)}`,
		);
	});

	// collinearOverlap 을 항상 false 로 바꿔도 통과하던 구멍을 막는다.
	test('완전히 포개진 대각선 두 개를 잡는다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '대각선 겹침',
			nodes: [
				{ id: 'a', x: 0, y: 0, title: '시작' },
				{ id: 'b', x: 500, y: 300, title: '끝' },
			],
			edges: [
				{ points: [[40, 80], [420, 320]], label: '첫번째' },
				{ points: [[40, 80], [420, 320]], label: '두번째' },
			],
			legend: false,
		});
		assert.ok(r.audit.overlap.length > 0, `겹침을 못 잡았다: ${JSON.stringify(r.audit)}`);
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
	// ★ 처음엔 자식을 1.2초 뒤 스스로 끝내고 '고아 없음'만 봤다. 그건 두 가지가 약했다:
	//   ① 자식이 크롬을 띄우기 전에 끝났어도 통과한다 (프로필 폴더는 spawn 전에 생기니
	//      폴더 존재로도 증명이 안 된다)
	//   ② 종료 경로를 process.exit() 하나만 본다
	//   그래서 **크롬이 실제로 뜬 걸 확인한 뒤 SIGTERM 을 보내** 시그널 경로까지 본다.
	test('크롬이 뜬 것을 확인한 뒤 서버를 SIGTERM 해도 크롬이 남지 않는다', async (t) => {
		if (platform !== 'darwin' && platform !== 'linux') {
			t.skip('pgrep 이 있는 환경에서만 확인한다');
			return;
		}
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}

		const entry = new URL('../render/index.ts', import.meta.url).href;
		// 자식은 스스로 끝나지 않는다. 부모가 크롬을 확인한 뒤 신호를 보낸다.
		const script =
			`import { renderDiagram } from ${JSON.stringify(entry)};\n` +
			`renderDiagram({ title: '고아 확인', nodes: [{ x:0, y:0, title:'A' }], legend:false })\n` +
			`  .catch(() => {});\n` +
			`setInterval(() => {}, 1000);\n`;

		// 자식에게 전용 TMPDIR 을 준다 — 이 자식이 띄운 크롬만 보기 위해서다.
		// 전역으로 찾으면 같은 기계의 다른 렌더를 남의 고아로 오인한다.
		const sandbox = await mkdtemp(join(tmpdir(), 'velog-mcp-orphan-test-'));
		const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
			stdio: 'ignore',
			env: { ...process.env, TMPDIR: sandbox },
		});

		// ★ `pgrep -f <문자열>` 은 자기를 실행한 셸까지 잡는다 (그 셸 명령줄에 패턴이
		//   그대로 있다). 처음엔 그걸 모르고 잡힌 pid 를 kill 했다가 테스트가 자기
		//   프로세스 트리를 죽였다. `[-]` 로 쪼개면 대상에는 맞고 자신에는 안 맞는다.
		const marker = sandbox.replace('-orphan-test-', '[-]orphan-test-');
		const alive = (): string[] =>
			execFileSync('bash', ['-c', `pgrep -f "${marker}" || true`])
				.toString()
				.split('\n')
				.map((v) => v.trim())
				.filter((v) => /^\d+$/.test(v));

		// ① 크롬이 실제로 떴는가 — 이게 확인돼야 이 검사에 의미가 있다
		let up: string[] = [];
		for (let i = 0; i < 60 && up.length === 0; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 200));
			up = alive();
		}
		if (up.length === 0) {
			child.kill('SIGKILL');
			await rm(sandbox, { recursive: true, force: true }).catch(() => {});
			assert.fail('자식이 크롬을 띄우지 못했다 — 이 검사는 의미가 없다');
		}

		// ② 서버를 SIGTERM 으로 내린다 (exit 훅이 아니라 시그널 경로)
		child.kill('SIGTERM');
		await new Promise<void>((resolve) => child.on('exit', () => { resolve(); }));

		// ③ 사라질 때까지 본다. 본체는 즉시 죽지만 헬퍼 정리 시간은 부하에 따라 다르다.
		let left = alive();
		for (let i = 0; i < 40 && left.length > 0; i++) {
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			left = alive();
		}

		// 걸렸으면 치우고 실패시킨다 — 테스트가 쓰레기를 남기면 안 된다.
		// pid 만 믿고 죽이지 않는다. 크로미움 계열이 맞는지 명령줄로 한 번 더 본다.
		const stuck: string[] = [];
		for (const pid of left) {
			const cmd = execFileSync('bash', ['-c', `ps -o command= -p ${pid} || true`]).toString();
			if (!/chrom|Chrome|Edge|Brave/i.test(cmd)) continue;
			stuck.push(`${pid}: ${cmd.trim().slice(0, 60)}`);
			execFileSync('bash', ['-c', `kill -9 ${pid} || true`]);
		}
		await rm(sandbox, { recursive: true, force: true }).catch(() => {});
		assert.deepEqual(stuck, [], `10초를 기다려도 크롬이 남아 있다:\n${stuck.join('\n')}`);
	});
});

describe('★★ R14 — 감사에 걸린 그림은 실제로 업로드까지 가지 않는다 (크롬 필요)', () => {
	// R7 은 clean 판정식에 필드가 들어 있는지만 본다 — 텍스트 검사다.
	// 코덱스 지적대로 finish() 가 clean 을 무시해도 통과한다. 그래서 **실제로
	// 도구를 호출해** 업로드 요청이 나가는지 아닌지를 본다.
	// 음성만 보면 '무조건 안 올림'도 통과하므로 양성 경로를 함께 둔다.
	async function harness(): Promise<{ client: Client; uploads: () => number }> {
		let count = 0;
		const velog = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'a.b.c', refreshToken: undefined },
			},
			fetchImpl: (async () => {
				count += 1;
				return new Response(
					JSON.stringify({ path: 'https://velog.velcdn.com/images/x/y.png' }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}) as unknown as typeof fetch,
		});
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, velog);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'gate-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);
		return { client, uploads: () => count };
	}

	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	test('겹친 그림은 upload:true 여도 올라가지 않는다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const { client, uploads } = await harness();
		const r = await client.callTool({
			name: 'velog_render_diagram',
			arguments: {
				title: '일부러 겹치게',
				nodes: [
					{ id: 'x', x: 0, y: 0, w: 200, h: 90, title: '노드 하나' },
					{ id: 'y', x: 100, y: 40, w: 200, h: 90, title: '겹치는 노드' },
				],
				upload: true,
			},
		});
		const text = String((r.content as Array<{ text: string }>)[0]?.text);
		assert.match(text, /올리지 않았습니다/);
		assert.equal(uploads(), 0, '감사에 걸렸는데 업로드 요청이 나갔다');
		await client.close();
	});

	test('깨끗한 그림은 실제로 올라간다 (양성 경로)', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const { client, uploads } = await harness();
		const r = await client.callTool({
			name: 'velog_render_diagram',
			arguments: {
				title: '깨끗한 그림',
				nodes: [
					{ id: 'x', x: 0, y: 0, title: '왼쪽' },
					{ id: 'y', x: 320, y: 0, title: '오른쪽' },
				],
				edges: [{ from: 'x', to: 'y', label: '흐름' }],
				upload: true,
			},
		});
		const text = String((r.content as Array<{ text: string }>)[0]?.text);
		assert.match(text, /velcdn/, `업로드 결과가 안 왔다: ${text.slice(0, 200)}`);
		assert.equal(uploads(), 1, '깨끗한 그림인데 업로드가 안 됐다');
		await client.close();
	});

	// 모델이 스스로 차단을 풀 수 있으면 방어가 아니다 (ADR 0004 와 같은 이유).
	test('force_upload 같은 우회 파라미터가 존재하지 않는다', async () => {
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, new VelogClient({ auth: { kind: 'anonymous' } }));
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'gate-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		const tools = (await client.listTools()).tools;
		for (const name of ['velog_render_diagram', 'velog_render_cover']) {
			const tool = tools.find((v) => v.name === name);
			assert.ok(tool, `${name} 이 없다`);
			const props = Object.keys(
				(tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
			);
			for (const bad of props) {
				assert.ok(
					!/force|override|skip|ignore|bypass/i.test(bad),
					`${name} 에 감사를 우회할 수 있어 보이는 파라미터가 있다: ${bad}`,
				);
			}
		}
		await client.close();
	});
});


describe('★ R15 — 자원·우회 가드 (크롬 필요)', () => {
	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	// 좌표를 ±20000 으로 묶어도 그 안에서 4만×4만 캔버스가 나온다.
	// 감사와 무관하게 스크린샷 **전에** 막아야 한다.
	test('캔버스가 상한을 넘으면 스크린샷 전에 막힌다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		await assert.rejects(
			() =>
				renderDiagram({
					title: '초대형',
					nodes: [{ x: 0, y: 0, title: 'A' }],
					edges: [{ points: [[-20000, -20000], [20000, 20000]] }],
					legend: false,
				}),
			/너무 큽니다/,
		);
	});

	// force_upload 를 없앴더니 "감사 실패 → 그 경로를 velog_upload_image 에" 라는
	// 두 단계 우회가 남았다. 이 서버가 떨어뜨린 산출물은 이 서버로 못 올린다.
	test('감사에 걸린 산출물은 velog_upload_image 로도 못 올린다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		let uploads = 0;
		const velog = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'a.b.c', refreshToken: undefined },
			},
			fetchImpl: (async () => {
				uploads += 1;
				return new Response(JSON.stringify({ path: 'https://velog.velcdn.com/x.png' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}) as unknown as typeof fetch,
		});
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, velog);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'bypass-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		const rendered = await client.callTool({
			name: 'velog_render_diagram',
			arguments: {
				title: '일부러 겹치게',
				nodes: [
					{ id: 'x', x: 0, y: 0, w: 200, h: 90, title: '노드 하나' },
					{ id: 'y', x: 100, y: 40, w: 200, h: 90, title: '겹치는 노드' },
				],
				upload: true,
			},
		});
		const text = String((rendered.content as Array<{ text: string }>)[0]?.text);
		const png = /로컬 PNG: (\S+\.png)/.exec(text)?.[1];
		assert.ok(png, `PNG 경로를 못 찾았다: ${text.slice(0, 200)}`);
		assert.equal(uploads, 0, '감사에 걸렸는데 업로드가 나갔다');

		const retry = await client.callTool({
			name: 'velog_upload_image',
			arguments: { path: png },
		});
		assert.equal(retry.isError, true, '감사에 걸린 산출물이 다른 도구로 올라갔다');
		assert.equal(uploads, 0, '우회 경로로 업로드 요청이 나갔다');
		await client.close();
	});
});
