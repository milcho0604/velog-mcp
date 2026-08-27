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
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildDiagramHtml } from '../render/page.ts';
import { buildCoverHtml } from '../render/cover.ts';
import { ICONS } from '../render/icons.ts';
import { isHexColor, TONES } from '../render/tones.ts';
import { sniffImage, registerImageTools } from '../tools/images.ts';
import { dumpDom, findChrome, runForTest } from '../render/chrome.ts';
import { renderCover, renderDiagram, renderSequence } from '../render/index.ts';
import {
	type SequenceAudit,
	type SequenceSpec,
	buildSequenceHtml,
	parseSequenceAudit,
} from '../render/sequence.ts';
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
		for (const name of ['page.ts', 'sequence.ts', 'cover.ts', 'icons.ts', 'tones.ts', 'index.ts', 'chrome.ts']) {
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
		for (const name of ['page.ts', 'sequence.ts', 'cover.ts']) {
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
	const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	// 문자열 spread 는 lint 가 막는다(이모지·결합문자 문제). 여기 값은 ASCII 뿐이지만
	// 규칙을 우회하지 않고 인덱스로 순회한다.
	const ascii = (v: string): number[] => {
		const out: number[] = [];
		for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i));
		return out;
	};

	/**
	 * IHDR 데이터 13바이트: 폭4·높이4·비트깊이·컬러타입·압축·필터·인터레이스.
	 * ★ 예전엔 전부 0 으로 뒀는데, 폭·높이 0 은 규격상 무효다.
	 *   '정상 fixture' 가 사실은 무효인 파일이었다 (코덱스 5차 지적).
	 */
	const IHDR_DATA = [0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0]; // 8×8, RGBA

	/** PNG 청크: [길이4 BE][타입4][데이터][CRC4]. CRC 값은 검사하지 않으므로 0 으로 둔다. */
	const png = (type: string, data: number[] = []): number[] => [
		(data.length >>> 24) & 255,
		(data.length >>> 16) & 255,
		(data.length >>> 8) & 255,
		data.length & 255,
		...ascii(type),
		...data,
		0, 0, 0, 0,
	];

	/**
	 * WebP 컨테이너. ★ RIFF 크기 필드는 **파일 크기 - 8** 이다.
	 *   이걸 손으로 적다가 두 번 틀렸다(정상 파일을 거부로 착각했다). 계산해서 넣는다.
	 */
	const webp = (...chunks: number[][]): Uint8Array => {
		const body = chunks.flat();
		const size = 4 + body.length; // 'WEBP' + 청크들
		return new Uint8Array([
			...ascii('RIFF'),
			size & 255, (size >>> 8) & 255, (size >>> 16) & 255, (size >>> 24) & 255,
			...ascii('WEBP'),
			...body,
		]);
	};
	const wchunk = (type: string, data: number[]): number[] => [
		...ascii(type),
		data.length & 255, (data.length >>> 8) & 255, (data.length >>> 16) & 255, (data.length >>> 24) & 255,
		...data,
		...(data.length % 2 ? [0] : []),
	];

	// ★ 시그니처만, 그다음엔 끝맺음까지 봤는데도 부족했다. IDAT 을 **파일 전체에서
	//   바이트열로** 찾았더니 'IHDR 의 payload 안에 IDAT 이라는 글자' 가 통과했다.
	//   지금은 청크 구조를 실제로 걸어간다.
	test('구조를 갖춘 이미지만 통과한다', () => {
		assert.equal(
			sniffImage(bytes(...PNG_SIG, ...png('IHDR', IHDR_DATA), ...png('IDAT', [1, 2, 3]), ...png('IEND')))?.mime,
			'image/png',
		);
		assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9))?.mime, 'image/jpeg');
		assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 0x3b))?.mime, 'image/gif');
		assert.equal(sniffImage(webp(wchunk('VP8 ', [1, 2, 3, 4])))?.mime, 'image/webp');
		// 확장·애니메이션 WebP: VP8X 뒤에 실제 프레임이 있으면 정상이다
		assert.equal(
			sniffImage(webp(wchunk('VP8X', new Array(10).fill(0)), wchunk('ANMF', new Array(24).fill(1))))?.mime,
			'image/webp',
		);
	});

	test('이미지처럼 생기기만 한 파일은 막힌다', () => {
		// ★ 코덱스 4차 재현: IHDR payload 안에 'IDAT' 글자를 심은 것
		assert.equal(
			sniffImage(bytes(...PNG_SIG, ...png('IHDR', [...ascii('IDAT'), ...new Array(9).fill(0)]), ...png('IEND'))),
			null,
			'IDAT 청크가 없는데 글자만 있는 PNG',
		);
		// ★ 코덱스 4차 재현: 화소 청크 없이 VP8X 만 있는 WebP
		assert.equal(sniffImage(webp(wchunk('VP8X', new Array(10).fill(0)))), null, '프레임 없는 WebP');
		assert.equal(sniffImage(bytes(...PNG_SIG, ...asBytes('BEGIN PRIVATE KEY'))), null);
		assert.equal(sniffImage(bytes(...PNG_SIG)), null, '잘린 PNG');
		assert.equal(
			sniffImage(bytes(...PNG_SIG, ...png('IHDR', IHDR_DATA), ...png('IDAT', [1]), ...png('IEND'), ...new Array(100).fill(65))),
			null,
			'IEND 뒤에 데이터를 덧붙인 것',
		);
		assert.equal(
			sniffImage(bytes(...PNG_SIG, ...png('IHDR', new Array(99).fill(0)), ...png('IDAT', [1]), ...png('IEND'))),
			null,
			'IHDR 길이가 13 이 아님',
		);
		assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3)), null, '끝나지 않은 JPEG');
	});

	test('비밀키·텍스트·SVG·빈 파일은 막힌다', () => {
		assert.equal(sniffImage(asBytes('-----BEGIN OPENSSH PRIVATE KEY-----')), null);
		assert.equal(sniffImage(asBytes('root:x:0:0:root:/root:/bin/bash')), null);
		assert.equal(sniffImage(asBytes('<svg onload="fetch(1)"></svg>')), null, 'SVG 는 받지 않는다');
		assert.equal(sniffImage(asBytes('{"a":1}')), null);
		assert.equal(sniffImage(new Uint8Array(0)), null);
		// 시그니처가 한 칸 밀린 것도 통과하면 안 된다
		assert.equal(
			sniffImage(bytes(0x00, ...PNG_SIG, ...png('IHDR', IHDR_DATA), ...png('IDAT', [1]), ...png('IEND'))),
			null,
		);
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

	// 중복 id 는 관통 감사를 통째로 피할 수 있는 구멍이었다 —
	// NMAP 은 마지막 것만 남기는데 '자기 노드 제외' 집합은 id 문자열로 전부 뺀다.
	test('중복 노드 id 는 막힌다 (자동 부여되는 n0 과의 충돌 포함)', async () => {
		const client = await tools();
		const cases: Array<[string, unknown]> = [
			[
				'명시 id 끼리 중복',
				[
					{ id: 'dup', x: 0, y: 0, title: 'A' },
					{ id: 'dup', x: 200, y: 0, title: 'B' },
				],
			],
			[
				'자동 id(n1) 와 명시 id 충돌',
				[
					{ id: 'n1', x: 0, y: 0, title: 'A' },
					{ x: 200, y: 0, title: 'B' },
				],
			],
		];
		for (const [why, nodes] of cases) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { title: 't', nodes, upload: false },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${why}`);
		}
		// 겹치지 않으면 통과해야 한다 — '무조건 거부' 가 아님을 확인한다.
		const ok = (await client.callTool({
			name: 'velog_render_diagram',
			arguments: {
				title: 't',
				nodes: [
					{ id: 'a', x: 0, y: 0, title: 'A' },
					{ x: 200, y: 0, title: 'B' },
				],
				upload: false,
			},
		})) as { isError?: boolean; content?: Array<{ text?: string }> };
		await client.close();

		// ★★ 이 대조군이 확인하려는 것은 **검증 규칙이 정상 입력을 안 막는다**는 것 하나다.
		//   그런데 이 호출은 실제로 크롬을 띄운다. CI 에서 크롬이 30초 상한에 걸리면
		//   `isError` 가 서고, 예전 단언은 그걸 "정상 입력까지 막혔다"로 보고했다 —
		//   원인은 렌더 타임아웃인데 증상은 검증 버그로 읽힌다. 실제로 main CI 가
		//   30,036ms 로 그렇게 빨간불이 났다(chrome.ts 의 기본 상한이 30,000ms).
		//   그래서 **거부 사유로 판정한다.** 중복 규칙에 걸린 것만 실패로 본다.
		const text = ok.content?.[0]?.text ?? '';
		assert.doesNotMatch(text, /노드 id 가 겹칩니다/, '정상 입력이 중복 규칙에 막혔다');
		if (ok.isError === true) {
			// 렌더 자체가 실패한 것은 이 테스트의 관심사가 아니다. 다만 **조용히 넘기지 않는다** —
			// 무슨 이유였는지 남겨야 다음 사람이 "왜 초록인데 렌더가 깨졌지"를 겪지 않는다.
			assert.match(
				text,
				/크롬이 \d+ms 안에 결과를 내지 못했습니다|크롬을 실행하지 못했습니다|크롬이 결과 없이 종료했습니다/,
				`검증도 렌더도 아닌 알 수 없는 실패다: ${text.slice(0, 200)}`,
			);
			console.error(`[render.test] 대조군이 렌더 단계에서 실패했다(검증은 통과): ${text.slice(0, 120)}`);
		}
	});

	// 좌표 상한이 없으면 요청 하나로 수억 픽셀 캔버스를 요구할 수 있다.
	test('좌표·점 개수 상한을 넘으면 막힌다', async () => {
		const client = await tools();
		const cases: Array<[string, Record<string, unknown>]> = [
			['노드 좌표', { nodes: [{ x: 999999, y: 0, title: 'A' }] }],
			[
				'points 좌표',
				{
					nodes: [{ x: 0, y: 0, title: 'A' }],
					edges: [{ points: [[-999999, 0], [10, 10]] }],
				},
			],
			[
				'points 개수',
				{
					nodes: [{ x: 0, y: 0, title: 'A' }],
					edges: [{ points: Array.from({ length: 60 }, (_, i) => [i, i]) }],
				},
			],
			['그룹 좌표', { nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: 'g', x: 999999 }] }],
			[
				'label_at',
				{
					nodes: [{ x: 0, y: 0, title: 'A' }],
					edges: [{ points: [[0, 0], [10, 0]], label: 'x', label_at: [999999, 0] }],
				},
			],
		];
		for (const [why, extra] of cases) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { title: 't', upload: false, ...extra },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${why}`);
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
		for (const name of ['page.ts', 'sequence.ts', 'cover.ts']) {
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

	// ★ force_upload 를 없앴더니 "감사 실패 → 그 PNG 경로를 velog_upload_image 로"
	//   라는 두 단계 우회가 남았다. 같은 인증으로 바로 되므로 사실상 차단이 아니었다.
	//   그래서 이 서버가 떨어뜨린 산출물은 이 서버로 못 올린다.
	test('감사에서 떨어진 PNG 는 velog_upload_image 로도 못 올린다', async (t) => {
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
		const png = /- 로컬 PNG: (.+)/.exec(text)?.[1]?.trim();
		assert.ok(png, `PNG 경로를 못 찾았다: ${text.slice(0, 200)}`);
		assert.equal(uploads(), 0, '감사에 걸렸는데 업로드가 나갔다');

		// 안내문이 우회 방법을 알려주면 안 된다
		assert.ok(
			!text.includes('velog_upload_image'),
			'차단 안내문이 우회 방법을 그대로 알려준다',
		);

		const retry = await client.callTool({
			name: 'velog_upload_image',
			arguments: { path: png },
		});
		assert.equal(retry.isError, true, '떨어진 산출물이 그대로 올라갔다');
		assert.equal(uploads(), 0, '거부했다면서 요청은 나갔다');
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
		for (const name of ['velog_render_diagram', 'velog_render_sequence', 'velog_render_cover']) {
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


describe('★ R15 — 초대형 캔버스는 스크린샷 전에 막는다 (크롬 필요)', () => {
	// 좌표를 ±20000 으로 묶어도 points 하나로 40,000×40,000 캔버스가 나온다.
	// 2배율이면 64억 픽셀·RGBA 약 25GB — 요청 한 번으로 기기를 재울 수 있다.
	// 감사 결과와 무관하게, 그리고 **찍기 전에** 막아야 한다.
	test('좌표를 멀리 벌리면 렌더가 거부된다', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
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

	test('평범한 크기는 그대로 통과한다 (양성 경로)', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '평범한 크기',
			nodes: [
				{ id: 'a', x: 0, y: 0, title: 'A' },
				{ id: 'b', x: 400, y: 200, title: 'B' },
			],
			edges: [{ from: 'a', to: 'b' }],
			legend: false,
		});
		assert.ok(r.width > 0 && r.height > 0);
		assert.ok(r.width * r.height < 9_000_000, `상한 근처다: ${r.width}×${r.height}`);
	});
});


describe('★★ R16 — 렌더는 한 번에 하나만 돈다 (크롬 필요)', () => {
	// ★ 실측이 시켰다. 렌더 1회 = 크롬 9개 · 약 1GB. 동시 2회면 17개 · 1.9GB 로
	//   선형으로 늘어난다. MCP 클라이언트는 도구를 병렬로 부르므로 그림 다섯 장을
	//   한 번에 시키면 크롬 45개가 뜬다 — 사용자 기기에서 도는 물건이 그러면 안 된다.
	test('동시에 3장을 요청해도 크롬은 한 판만 뜬다', async (t) => {
		if (platform !== 'darwin' && platform !== 'linux') {
			t.skip('ps 가 있는 환경에서만 확인한다');
			return;
		}
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}

		const count = (): number =>
			Number(
				execFileSync('bash', [
					'-c',
					`ps -axo command= | grep -c "velog[-]mcp-chrome" || true`,
				])
					.toString()
					.trim(),
			) || 0;

		// ★ 이 검사는 **전역 프로세스 수**를 센다. 그래서 앞 시험이 남긴 크롬이
		//   그대로 섞인다 — 렌더러는 SIGKILL 만 보내고 종료를 기다리지 않기 때문이다
		//   (그건 의도된 설계다. 산출물이 나오면 기다릴 이유가 없다).
		//   실제로 CI 에서 17 이 찍혀 빨간불이 났는데, 9(앞판 잔여) + 8(이번 판)이었다.
		//   재실행하면 통과했다. 「빨간불이면 재실행」이 습관이 되면 진짜 실패도
		//   플레이키로 넘기게 되므로, 잔여를 먼저 걷어내고 **늘어난 만큼**으로 잰다.
		const settle = Date.now() + 8000;
		while (count() > 0 && Date.now() < settle) {
			await new Promise((r) => setTimeout(r, 100));
		}
		const base = count();

		let peak = 0;
		const timer = setInterval(() => {
			const n = count();
			if (n > peak) peak = n;
		}, 60);

		const spec = (title: string): Parameters<typeof renderDiagram>[0] => ({
			title,
			legend: false,
			nodes: [
				{ x: 0, y: 0, title: 'A' },
				{ x: 300, y: 0, title: 'B' },
			],
		});
		// ★ 다이어그램만 3장 돌리면 '표지가 큐를 우회하는' 변이를 못 잡는다(코덱스 4차).
		//   두 도구를 섞어서 같은 큐를 쓰는지 본다.
		const results = await Promise.all([
			renderDiagram(spec('동시 1')),
			renderCover({ title: '동시 표지' }),
			renderDiagram(spec('동시 3')),
		]);
		clearInterval(timer);

		assert.ok(
			results.every((r) => r.width > 0),
			'동시 요청 중 실패한 것이 있다',
		);
		// 한 판이 9개다. 앞판 정리와 뒷판 기동이 겹칠 수 있어 여유를 둔다.
		assert.ok(peak > base, '크롬 프로세스를 한 번도 못 봤다 — 이 검사는 의미가 없다');
		assert.ok(
			peak - base <= 14,
			`동시에 크롬이 ${peak - base}개까지 늘었다(바닥 ${base}, 최고 ${peak}) — 직렬화가 풀렸다`,
		);
	});

	// 줄을 세우면 '앞 작업이 실패했을 때 줄이 끊기는' 실수를 하기 쉽다.
	test('앞 렌더가 실패해도 다음 렌더가 이어진다', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		// 일부러 상한을 넘겨 실패시킨다
		await assert.rejects(
			() =>
				renderDiagram({
					title: '실패할 것',
					nodes: [
						{ id: 'a', x: 0, y: 0, title: 'A' },
						{ id: 'b', x: 6900, y: 0, title: 'B' },
					],
					legend: false,
				}),
			/너무 큽니다/,
		);
		// 큐가 끊겼다면 여기서 영원히 안 끝난다
		const after = await renderDiagram({
			title: '그 다음',
			nodes: [{ x: 0, y: 0, title: 'A' }],
			legend: false,
		});
		assert.ok(after.width > 0, '실패 뒤 큐가 멈췄다');
	});
});

describe('★ R19 — 모서리 라운딩이 원래 선을 벗어나지 않는다 (크롬 필요)', () => {
	// ★ rpath 는 여태 어떤 테스트에도 안 묶여 있었다(코덱스 2·3·4차 연속 지적).
	//   감사가 원본 points 를 보기 때문에, 그려진 path 가 선을 벗어나도 아무도 모른다.
	//   실제로 축별 Math.sign 방식일 때 거의 수평인 대각선이 y 로 ±9 벌어졌다.
	//   렌더된 HTML 을 다시 열어 **그려진 d 속성**을 직접 본다.
	test('대각선에서도 그려진 경로가 원래 선 근처에 머문다', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const r = await renderDiagram({
			title: '라운딩 검사',
			nodes: [
				{ id: 'a', x: 0, y: 0, title: 'A' },
				{ id: 'b', x: 400, y: 200, title: 'B' },
			],
			// 거의 수평인 대각선 — 축별 sign 으로 물리면 여기서 크게 벌어진다.
			// ★ 시작 좌표를 0,0 으로 두면 화살촉 마커 path(M0,0 L10,5 L0,10 z)가 먼저
			//   걸린다. 겹치지 않는 좌표를 쓴다.
			edges: [{ points: [[7, 103], [107, 104], [207, 105]] }],
			legend: false,
		});

		const profileDir = await mkdtemp(join(tmpdir(), 'velog-mcp-rpath-test-'));
		const dom = await dumpDom(pathToFileURL(r.htmlPath).href, { profileDir });
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});

		// 우리가 준 좌표로 그려진 path 를 찾는다
		const drawn = [...dom.matchAll(/\sd="(M7,103[^"]*)"/g)].map((m) => m[1] ?? '');
		assert.ok(drawn.length > 0, `그려진 경로를 못 찾았다`);
		// ★ 처음엔 M·L 만 읽었다. 그러면 Q 의 제어점·끝점이 벗어나도 못 잡는다
		//   (코덱스 5차: 나가는 쪽만 망가진 경로가 통과한다). d 안의 **모든 좌표쌍**을 본다.
		const path = drawn[0] ?? '';
		const ys = [...path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2]));
		assert.ok(ys.length >= 4, `좌표를 못 읽었다: ${path}`);
		// 원래 선은 y 가 103~105 다. 정상 라운딩이면 그 근처에 머문다.
		// 축별 sign 방식이면 y 가 95 아래·113 위까지 벌어진다.
		const lo = Math.min(...ys);
		const hi = Math.max(...ys);
		assert.ok(
			lo >= 99 && hi <= 109,
			`라운딩이 원래 선(103~105)을 벗어났다: ${lo}~${hi} · ${path}`,
		);
	});
});


describe('★ R17 — 코덱스가 "변이가 통과한다"고 지목한 자리들', () => {
	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	// ① 배지 경계 감사: 배지가 있는 fixture 자체가 없어서 감사를 지워도 통과했다.
	test('좁은 카드에서 배지가 밖으로 나가면 잡는다', async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		const r = await renderDiagram({
			title: '배지 경계',
			nodes: [{ x: 0, y: 0, w: 60, h: 54, title: 'A', tag: 'XXXXXXXXXXXXXXXXXXXXXXXX' }],
			legend: false,
		});
		assert.ok(
			r.audit.collide.some((v) => v.includes('배지')),
			`배지가 카드를 벗어난 걸 못 잡았다: ${JSON.stringify(r.audit.collide)}`,
		);
	});

	test('정상 배지는 잡지 않는다 (양성 경로)', async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		const r = await renderDiagram({
			title: '정상 배지',
			nodes: [{ x: 0, y: 0, title: '노드', sub: '부제', icon: 'server', tag: ':6820' }],
			legend: false,
		});
		assert.deepEqual(r.audit.collide, [], `없는 문제를 만들어냈다: ${JSON.stringify(r.audit.collide)}`);
	});

	// ② 표지 kicker/footer: 도구가 표지로 넘기는 걸 지워도 통과했다.
	test('표지의 상단 라벨·서명이 길면 잡는다', async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		const r = await renderCover({
			title: '짧은 제목',
			kicker: 'K'.repeat(60),
			footer: 'F'.repeat(60),
		});
		assert.ok(
			r.audit.truncated.some((v) => v.includes('상단 라벨')),
			`겹침을 못 잡았다: ${JSON.stringify(r.audit.truncated)}`,
		);
	});

	// ③ MAX_DIM / MAX_AREA
	//    ⓐ 기존 fixture 가 두 조건을 동시에 넘어서 한쪽만 지워도 다른 쪽이 잡았다
	//       → 각각 하나만 넘기는 입력을 쓴다.
	//    ⓑ 그래도 바깥 2차 방어(index.ts)가 대신 잡아 페이지 쪽 변이가 가려졌다
	//       → **페이지가 낸 오류인지**를 문구로 가린다. 페이지 경로만
	//         '좌표 간격을 줄이세요' 를 덧붙인다(바깥 경로는 안 붙인다).
	test('가로만 상한을 넘는 경우도 막힌다 (MAX_DIM 단독)', async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		// 7000×170 → 면적 119만(상한 900만 이하)이라 MAX_DIM 만 걸린다
		await assert.rejects(
			() =>
				renderDiagram({
					title: '가로만 초과',
					nodes: [
						{ id: 'a', x: 0, y: 0, title: 'A' },
						{ id: 'b', x: 6900, y: 0, title: 'B' },
					],
					legend: false,
				}),
			/좌표 간격을 줄이세요/,
		);
	});

	test('면적만 상한을 넘는 경우도 막힌다 (MAX_AREA 단독)', async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		// 5000×3000 → 각 변은 6000 이하지만 면적 1,500만으로 상한 초과
		await assert.rejects(
			() =>
				renderDiagram({
					title: '면적만 초과',
					nodes: [
						{ id: 'a', x: 0, y: 0, title: 'A' },
						{ id: 'b', x: 4900, y: 0, title: 'B' },
						{ id: 'c', x: 0, y: 2800, title: 'C' },
					],
					legend: false,
				}),
			/좌표 간격을 줄이세요/,
		);
	});

	// ④ 노드 id 가 ':side' 문법과 충돌하면 엉뚱한 데로 연결된다.
	//    ★ '없는 노드 참조' 로는 못 잡는다 — 잘못 해석해도 그 노드(svc)는 실재해서
	//      오류가 안 난다. 그래서 **잘못 연결되면 관통이 생기도록** 배치했다.
	//      맞게 연결되면 아래쪽을 수평으로 지나가고, 'svc' 로 잘못 붙으면 위쪽
	//      가로막이를 뚫고 간다.
	test("id 에 ':right' 가 들어가도 그 노드로 연결된다", async (t) => {
		if (!(await hasChrome())) { t.skip('크롬이 없어 건너뜀'); return; }
		const r = await renderDiagram({
			title: '콜론 id',
			nodes: [
				{ id: 'svc', x: 0, y: 0, w: 140, h: 60, title: '위' },
				{ id: 'svc:right', x: 0, y: 300, w: 140, h: 60, title: '아래' },
				{ id: 'blocker', x: 250, y: 0, w: 200, h: 60, title: '가로막이' },
				{ id: 'dst', x: 600, y: 300, w: 140, h: 60, title: '목적지' },
			],
			edges: [{ from: 'svc:right', to: 'dst' }],
			legend: false,
		});
		assert.deepEqual(
			r.audit.over.filter((v) => v.includes('없는 노드')),
			[],
			`노드를 못 찾았다: ${JSON.stringify(r.audit.over)}`,
		);
		assert.deepEqual(
			r.audit.cross,
			[],
			`'svc' 로 잘못 연결돼 가로막이를 뚫었다: ${JSON.stringify(r.audit.cross)}`,
		);
	});
});

describe('★ R18 — 업로드 실패 문구가 결과 불명을 알린다', () => {
	const auth = {
		kind: 'authenticated' as const,
		credentials: { accessToken: 'a.b.c', refreshToken: undefined },
	};

	// 5xx 는 서버가 저장한 뒤 실패했을 수도 있다. '실패 확정'처럼 보이면
	// 사용자가 그대로 다시 올려 중복이 생긴다 (삭제 API 가 없다).
	test('5xx 에는 중복 위험 경고가 붙는다', async () => {
		const client = new VelogClient({
			auth,
			fetchImpl: (async () =>
				new Response('oops', { status: 500 })) as unknown as typeof fetch,
		});
		await assert.rejects(
			() =>
				client.uploadImage(new Uint8Array([1]), 'a.png', {
					type: 'post',
					contentType: 'image/png',
				}),
			/중복/,
		);
	});

	test('통신 단절도 결과 불명으로 알린다', async () => {
		const client = new VelogClient({
			auth,
			fetchImpl: (() => {
				throw new Error('socket hang up');
			}) as unknown as typeof fetch,
		});
		await assert.rejects(
			() =>
				client.uploadImage(new Uint8Array([1]), 'a.png', {
					type: 'post',
					contentType: 'image/png',
				}),
			/알 수 없습니다/,
		);
	});
});


describe('★ R20 — 실제 형식 변형을 잘못 거부하지 않는다', () => {
	// ★ 검사를 조일수록 위험해지는 건 '정상 파일을 거부하는 것'이다.
	//   실제 도구(sips·cwebp)로 만든 PNG·JPEG·GIF·WebP 4종과, 규격상 정상인
	//   변형들(확장 WebP·APNG·메타데이터 선행 청크·홀수 패딩)을 모두 통과시켜야 한다.
	//   실측 참고: 우리 렌더 산출물 PNG 는 IDAT 청크가 103개다.
	const A = (v: string): number[] => {
		const out: number[] = [];
		for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i));
		return out;
	};
	const le = (n: number): number[] => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
	const be = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
	const wch = (t: string, d: number[]): number[] => [
		...A(t), ...le(d.length), ...d, ...(d.length % 2 ? [0] : []),
	];
	// RIFF 크기 필드 = 파일크기 - 8. 손으로 적다가 두 번 틀렸으므로 계산해서 넣는다.
	const webp = (...cs: number[][]): Uint8Array => {
		const body = cs.flat();
		return new Uint8Array([...A('RIFF'), ...le(4 + body.length), ...A('WEBP'), ...body]);
	};
	const pch = (t: string, d: number[] = []): number[] => [...be(d.length), ...A(t), ...d, 0, 0, 0, 0];
	const png = (...cs: number[][]): Uint8Array =>
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...cs.flat()]);
	// 폭·높이 0 은 규격상 무효다. 실제 크기를 넣는다 (8×8 RGBA).
	const ihdr = (): number[] => pch('IHDR', [0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0]);

	test('규격상 정상인 변형은 전부 통과한다', () => {
		const ok: Array<[string, Uint8Array]> = [
			['확장 WebP (VP8X+ALPH+VP8)', webp(wch('VP8X', new Array(10).fill(0)), wch('ALPH', [1, 2, 3]), wch('VP8 ', [9, 9, 9, 9]))],
			['메타데이터 선행 (ICCP+VP8)', webp(wch('ICCP', [1, 2, 3, 4, 5]), wch('VP8 ', [9, 9, 9, 9]))],
			['홀수 길이 청크 패딩', webp(wch('ICCP', [1, 2, 3]), wch('VP8 ', [9, 9, 9, 9]))],
			['APNG (acTL+fcTL+IDAT+fdAT)', png(ihdr(), pch('acTL', new Array(8).fill(0)), pch('fcTL', new Array(26).fill(0)), pch('IDAT', [1, 2]), pch('fdAT', [3, 4]), pch('IEND'))],
			['tEXt 가 섞인 PNG', png(ihdr(), pch('tEXt', A('Comment')), pch('IDAT', [1]), pch('IEND'))],
			['IDAT 이 여러 개', png(ihdr(), pch('IDAT', [1]), pch('IDAT', [2]), pch('IDAT', [3]), pch('IEND'))],
		];
		for (const [name, v] of ok) {
			assert.notEqual(sniffImage(v), null, `정상 파일을 거부했다: ${name}`);
		}
	});

	test('구조가 어긋난 것은 거부한다 (음성 경로)', () => {
		const ng: Array<[string, Uint8Array]> = [
			['프레임 없이 메타만 있는 WebP', webp(wch('ICCP', [1, 2, 3, 4]), wch('EXIF', [5, 6, 7, 8]))],
			['IDAT 없이 fdAT 만', png(ihdr(), pch('fdAT', [1, 2]), pch('IEND'))],
			['길이 필드가 파일을 넘어감', png(ihdr(), [...be(999999), ...A('IDAT'), 1, 2, 0, 0, 0, 0], pch('IEND'))],
			['IHDR 이 첫 청크가 아님', png(pch('tEXt', A('x')), ihdr(), pch('IDAT', [1]), pch('IEND'))],
			// 폭·높이 0 (규격상 무효)
			['0×0 PNG', png(pch('IHDR', new Array(13).fill(0)), pch('IDAT', [1]), pch('IEND'))],
			// 화소가 없는 빈 IDAT
			['빈 IDAT', png(ihdr(), pch('IDAT', []), pch('IEND'))],
			// ANMF 가 프레임 헤더도 못 채움
			['ANMF 가 너무 짧음', webp(wch('VP8X', new Array(10).fill(0)), wch('ANMF', [1, 2]))],
			// 정상 프레임 뒤에 경계가 깨진 청크
			['프레임 뒤 깨진 청크', webp(wch('VP8 ', [1, 2, 3, 4]), [...A('EXIF'), ...le(9999), 1, 2])],
			// ★ 청크가 되지 못하는 자투리(8바이트 미만)가 남는 경우.
			//   루프 안 경계 검사로는 못 잡고 '끝까지 걸었는가' 로만 잡힌다.
			['프레임 뒤 자투리 4바이트', webp(wch('VP8 ', [1, 2, 3, 4]), [1, 2, 3, 4])],
		];
		for (const [name, v] of ng) {
			assert.equal(sniffImage(v), null, `비정상 파일이 통과했다: ${name}`);
		}
	});
});

describe('★ R21 — 글자 길이 상한', () => {
	// 좌표만 묶고 글자를 열어두면 제목 하나로 HTML·SVG·getBBox·stdout 을 동시에 부풀린다.
	test('상한을 넘는 문자열은 스키마에서 막힌다', async () => {
		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, new VelogClient({ auth: { kind: 'anonymous' } }));
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'len-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		// ★ 5,000자로만 시험하면 `.max(120)` 을 `.max(4999)` 로 완화하는 변이가 통과한다
		//   (코덱스 5차). **상한 바로 위** 값으로 시험해야 상한 자체가 묶인다.
		const over = (limit: number): string => 'ㄱ'.repeat(limit + 1);
		const cases: Array<[string, Record<string, unknown>]> = [
			['제목(200)', { title: over(200), nodes: [{ x: 0, y: 0, title: 'A' }] }],
			['부제(300)', { title: 't', subtitle: over(300), nodes: [{ x: 0, y: 0, title: 'A' }] }],
			['노드 제목(120)', { title: 't', nodes: [{ x: 0, y: 0, title: over(120) }] }],
			['노드 부제(120)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A', sub: over(120) }] }],
			['노드 id(64)', { title: 't', nodes: [{ id: over(64), x: 0, y: 0, title: 'A' }] }],
			['태그(40)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A', tag: over(40) }] }],
			['엣지 라벨(120)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], edges: [{ points: [[0, 0], [10, 0]], label: over(120) }] }],
			['엣지 from(80)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], edges: [{ from: over(80), to: 'x' }] }],
			['그룹 이름(80)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: over(80) }] }],
			['그룹 부제(80)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: 'g', sub: over(80) }] }],
			['members 항목(64)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: 'g', members: [over(64)] }] }],
			['plane 이름(40)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], planes: [{ key: 'r', name: over(40), color: '#000000' }] }],
			['plane dash(40)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], planes: [{ key: 'r', name: 'n', color: '#000000', dash: '6 '.repeat(30) }] }],
			['alt(300)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], alt: over(300) }],
			['post_id(64)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], post_id: over(64) }],
			// 배열 개수 상한도 함께 (코덱스: 개수 상한 제거 변이가 통과한다)
			['노드 개수(60)', { title: 't', nodes: Array.from({ length: 61 }, (_, i) => ({ x: i, y: 0, title: `A${String(i)}` })) }],
			['그룹 개수(12)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: Array.from({ length: 13 }, (_, i) => ({ name: `g${String(i)}` })) }],
			['엣지 개수(120)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], edges: Array.from({ length: 121 }, () => ({ points: [[0, 0], [10, 0]] })) }],
			['plane 개수(6)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], planes: Array.from({ length: 7 }, (_, i) => ({ key: `k${String(i)}`, name: 'n', color: '#000000' })) }],
			['members 개수(60)', { title: 't', nodes: [{ x: 0, y: 0, title: 'A' }], groups: [{ name: 'g', members: Array.from({ length: 61 }, (_, i) => `m${String(i)}`) }] }],
		];
		for (const [why, args] of cases) {
			const r = await client.callTool({
				name: 'velog_render_diagram',
				arguments: { upload: false, ...args },
			});
			assert.equal(r.isError, true, `막았어야 한다: ${why}`);
		}

		// 표지도 같다
		for (const [field, limit] of [
			['title', 200], ['subtitle', 300], ['kicker', 60], ['footer', 60],
		] as Array<[string, number]>) {
			const r = await client.callTool({
				name: 'velog_render_cover',
				arguments: { title: 't', upload: false, [field]: over(limit) },
			});
			assert.equal(r.isError, true, `표지 ${field} 를 막았어야 한다`);
		}
		// 태그 개수·길이
		for (const tags of [Array.from({ length: 7 }, () => 'x'), [over(40)]]) {
			const r = await client.callTool({
				name: 'velog_render_cover',
				arguments: { title: 't', upload: false, tags },
			});
			assert.equal(r.isError, true, '표지 태그 상한을 막았어야 한다');
		}
		// 업로드 경로 상한
		const up = await client.callTool({
			name: 'velog_upload_image',
			arguments: { path: over(4096) },
		});
		assert.equal(up.isError, true, '업로드 경로 상한을 막았어야 한다');
		await client.close();
	});
});


describe("★★ R22 — 'exit' 이 아니라 'close' 를 본다 (가짜 자식 프로세스)", () => {
	// ★ Node 는 'exit' 시점에 stdio 가 아직 열려 있을 수 있다고 명시한다.
	//   마지막 출력이 그 뒤에 도착하면 멀쩡한 결과를 실패로 처리하게 된다.
	//   실제 크롬으로는 이 타이밍을 안정적으로 못 만들어 오래 안 묶여 있었는데,
	//   가짜 자식을 넣으면 벽시계 대기 없이 정확히 재현된다 (코덱스 5차 제안).
	function fakeChild(): {
		child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
		stdout: PassThrough;
	} {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			kill: (): boolean => true,
		});
		return { child, stdout };
	}

	const spawnFake = (child: unknown): typeof spawn =>
		(() => child) as unknown as typeof spawn;

	test('exit 뒤에 도착한 마지막 출력도 성공으로 받는다', async () => {
		const { child, stdout } = fakeChild();
		const promise = runForTest(
			'/fake/chrome',
			[],
			{ profileDir: '/tmp/none', spawnImpl: spawnFake(child), timeoutMs: 5000 },
			(out) => out.includes('</html>'),
		);

		// 프로세스는 먼저 끝나고…
		child.emit('exit', 0);
		await new Promise<void>((r) => setImmediate(r));
		// …마지막 출력이 그 뒤에 도착한다
		stdout.write('<html>ok</html>');
		await new Promise<void>((r) => setImmediate(r));
		child.emit('close', 0);

		assert.match(await promise, /<\/html>/);
	});

	test('출력 없이 끝나면 실패로 처리한다 (음성 경로)', async () => {
		const { child } = fakeChild();
		const promise = runForTest(
			'/fake/chrome',
			[],
			{ profileDir: '/tmp/none', spawnImpl: spawnFake(child), timeoutMs: 5000 },
			(out) => out.includes('</html>'),
		);
		child.emit('exit', 1);
		await new Promise<void>((r) => setImmediate(r));
		child.emit('close', 1);
		await assert.rejects(() => promise, /결과 없이 종료/);
	});

	test('stdout 상한을 넘으면 끊는다', async () => {
		const { child, stdout } = fakeChild();
		const promise = runForTest(
			'/fake/chrome',
			[],
			{ profileDir: '/tmp/none', spawnImpl: spawnFake(child), timeoutMs: 5000, maxStdoutBytes: 64 },
			(out) => out.includes('</html>'),
		);
		stdout.write('x'.repeat(65));
		await assert.rejects(() => promise, /넘었습니다/);
	});
});


describe('★ R23 — 상한을 넘는 파일은 읽는 단계에서 거부한다', () => {
	// ★ 예전엔 stat 로 한 번, read 에서 또 봤다. 검사가 둘이면 하나를 지워도 다른
	//   하나가 가려서 테스트가 못 잡는다(실제로 변이가 통과했다). 지금은 '실제로 읽은
	//   바이트' 하나로만 판정하므로 이 테스트가 그 검사를 직접 묶는다.
	test('11MB 파일은 너무 큰 파일로 거부된다', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-mcp-big-upload-'));
		const big = join(dir, 'big.png');
		// PNG 시그니처로 시작하지만 상한(10MB)을 넘는다
		const buf = Buffer.alloc(11 * 1024 * 1024);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
		await writeFile(big, buf);

		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(
			server,
			new VelogClient({
				auth: {
					kind: 'authenticated',
					credentials: { accessToken: 'a.b.c', refreshToken: undefined },
				},
				fetchImpl: (() => {
					throw new Error('업로드까지 가면 안 된다');
				}) as unknown as typeof fetch,
			}),
		);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'big-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		const r = await client.callTool({ name: 'velog_upload_image', arguments: { path: big } });
		assert.equal(r.isError, true, '상한을 넘는 파일이 통과했다');
		assert.match(String((r.content as Array<{ text: string }>)[0]?.text), /너무 큽니다/);

		await client.close();
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	test('상한 이하 파일은 크기 때문에 막히지 않는다 (양성 경로)', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'velog-mcp-big-upload-'));
		const small = join(dir, 'small.png');
		await writeFile(small, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

		const server = new McpServer({ name: 't', version: '0' });
		registerImageTools(server, new VelogClient({ auth: { kind: 'anonymous' } }));
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'big-test', version: '0' });
		await Promise.all([client.connect(a), server.connect(b)]);

		const r = await client.callTool({ name: 'velog_upload_image', arguments: { path: small } });
		// 인증이 없어 어차피 실패하지만, **크기 때문**은 아니어야 한다
		const text = String((r.content as Array<{ text: string }>)[0]?.text);
		assert.ok(!/너무 큽니다/.test(text), `크기로 막혔다: ${text}`);

		await client.close();
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	});
});

/**
 * 실패한 렌더가 임시 폴더를 남기지 않는다.
 *
 * ★ 예전엔 `finally` 가 크롬 프로필 두 개만 지우고 결과 폴더는 성공·실패 가리지
 *   않고 남겼다. 청소(sweepOld)는 **다음 렌더가 돌 때** 그것도 24시간 지난 것만
 *   거둬가므로, 실패한 뒤 다시 안 그리면 영영 남는다.
 *   실측(2026-08-07): 개발 중인 이 기기의 임시폴더에 velog-mcp-render-* 가
 *   396개 쌓여 있었다. 그게 이 버그의 잔해다.
 */
describe('★ 실패한 렌더는 뒤를 남기지 않는다 (크롬 필요)', () => {
	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	/**
	 * ⚠️ 개수를 세면 안 된다 — 이 검사는 그것 때문에 한 번 깨졌다.
	 *
	 * 렌더는 시작할 때마다 24시간 지난 폴더를 치운다(sweepOld). 그래서 임시폴더에
	 * 그런 잔여가 있으면 **개수가 늘면서 동시에 줄어든다.** 실측(2026-08-27):
	 * 113개 중 24~48시간짜리가 섞여 있어 '하나 늘어야 한다'가 0 으로 나왔다.
	 * 소스는 그대로였고 깨끗한 main 에서도 같은 실패가 났다.
	 *
	 * 그래서 **이름 집합의 차이**를 본다. 새로 생긴 것만 세면 남이 지우는 것과
	 * 무관해진다. R16 과 같은 교훈이다 — 전역 자원은 총량이 아니라 내 몫의 증분으로.
	 */
	const listRenderDirs = async (): Promise<Set<string>> =>
		new Set((await readdir(tmpdir())).filter((n) => n.startsWith('velog-mcp-render-')));
	const addedSince = (before: Set<string>, after: Set<string>): string[] =>
		[...after].filter((n) => !before.has(n));

	test('성공은 남기고 실패는 지운다', async (t) => {
		if (!(await hasChrome())) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const before = await listRenderDirs();

		// 대조군 — 성공한 렌더는 반드시 남아야 한다. 사용자가 PNG·HTML 을 쓴다.
		await renderDiagram({ title: 'ok', nodes: [{ id: 'a', x: 0, y: 0, title: 'A' }] });
		const afterOk = await listRenderDirs();
		const kept = addedSince(before, afterOk);
		assert.equal(kept.length, 1, `성공한 렌더의 결과까지 지웠다 (새로 생긴 것: ${kept.length}개)`);

		// 실패 — HTML 을 쓴 뒤 감사 해석에서 던지는 경로.
		await assert.rejects(() =>
			renderDiagram({
				title: 'ng',
				nodes: [{ id: 'a', x: 0, y: 0, title: 'A' }],
				// 노드 id 는 문자열이어야 한다. 도구 스키마는 막지만 여기선 직접 부른다.
				edges: [{ from: 0 as unknown as string, to: 1 as unknown as string }],
			}),
		);
		const afterNg = addedSince(afterOk, await listRenderDirs());
		assert.equal(afterNg.length, 0, `실패한 렌더의 폴더가 남았다: ${afterNg.join(', ')}`);
	});
});

/**
 * S1~S5 — 시퀀스 다이어그램.
 *
 * 이 도구는 좌표를 안 받는다. 그래서 "겹치지 않는다"의 책임이 전부 렌더러에 있고,
 * 자가감사는 **내 배치 계산이 틀렸을 때 걸리라고** 있는 것이다.
 * 그러니 '감사가 통과했다'만으로는 아무것도 증명되지 않는다 —
 * 일부러 망가뜨렸을 때 **걸리는지**를 같이 봐야 검출력이 증명된다(S4).
 */

/** 다섯 가지 배치 계산을 모두 건드리는 표본. S4 의 변이가 이 위에서 돈다. */
const SEQ_SAMPLE: SequenceSpec = {
	title: '표본',
	participants: [
		{ id: 'a', name: '사용자', icon: 'user' },
		{ id: 'b', name: 'flow-was', sub: 'JSP', icon: 'server' },
		{ id: 'c', name: 'PostgreSQL', sub: 'condurealdb', icon: 'database' },
		{ id: 'd', name: 'FCM', icon: 'cloud' },
	],
	messages: [
		{ from: 'a', to: 'b', label: '글 작성 요청을 보낸다' },
		{ kind: 'note', from: 'b', label: '여기서부터트랜잭션이열린다띄어쓰기없는긴토큰' },
		{ from: 'b', to: 'c', label: 'INSERT INTO flow_post' },
		{ kind: 'return', from: 'c', to: 'b', label: 'srno' },
		{ from: 'b', to: 'b', label: '수신자 목록을 만든다' },
		{ from: 'b', to: 'd', label: '푸시 발송 요청 (수신자 1,204명)' },
		{ kind: 'return', from: 'd', to: 'b', label: '성공 3,842 / 실패 39' },
		{ kind: 'return', from: 'b', to: 'a', label: '200 OK' },
		// ★ 옆 열끼리 붙은 긴 라벨. 열 넓히기가 없으면 반드시 구간을 벗어난다 —
		//   이게 없으면 S4 의 첫 변이가 결함을 못 만들고 조용히 통과한다(실제로 겪었다).
		{ from: 'c', to: 'd', label: '옆 열에 붙은 제법 긴 라벨이라 열을 넓혀야 들어간다' },
	],
	fragments: [{ kind: 'tx', label: 'COMMIT 까지 열려 있다', from: 2, to: 6 }],
};

describe('★ S1 — 그릴 수 없는 입력은 그리기 전에 막는다', () => {
	// 없는 참가자나 뒤집힌 범위는 그려봐야 의미가 없다. 그림 대신 무엇이 틀렸는지
	// 말해주는 편이 낫다 — 감사로 넘기면 '그려놓고 실패'가 된다.
	const base = {
		title: 't',
		participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
	};

	test('없는 참가자를 가리키면 있는 참가자를 알려주며 막는다', () => {
		assert.throws(
			() => buildSequenceHtml({ ...base, messages: [{ from: 'a', to: '없는놈' }] }),
			/없는 참가자 '없는놈'[\s\S]*a, b/,
		);
	});

	test('note 가 아닌데 to 가 없으면 막는다', () => {
		assert.throws(
			() => buildSequenceHtml({ ...base, messages: [{ from: 'a' }] }),
			/to 가 필요합니다/,
		);
	});

	test('참가자 id 가 겹치면 막는다', () => {
		assert.throws(
			() =>
				buildSequenceHtml({
					title: 't',
					participants: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
					messages: [{ from: 'a', to: 'a' }],
				}),
			/참가자 id 가 겹칩니다: a/,
		);
	});

	test('프래그먼트 범위가 뒤집히거나 밖으로 나가면 막는다', () => {
		const msgs = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
		assert.throws(
			() => buildSequenceHtml({ ...base, messages: msgs, fragments: [{ kind: 'x', from: 1, to: 0 }] }),
			/보다 뒤입니다/,
		);
		assert.throws(
			() => buildSequenceHtml({ ...base, messages: msgs, fragments: [{ kind: 'x', from: 0, to: 9 }] }),
			/메시지 범위\(0~1\) 밖입니다/,
		);
	});

	test('서로 어긋나게 겹친 프래그먼트를 막는다', () => {
		// 상자 둘이 서로를 반씩 물면 어느 쪽을 안쪽에 그려도 한쪽이 제 메시지를 못 감싼다.
		const msgs = [
			{ from: 'a', to: 'b' }, { from: 'b', to: 'a' },
			{ from: 'a', to: 'b' }, { from: 'b', to: 'a' },
		];
		assert.throws(
			() =>
				buildSequenceHtml({
					...base,
					messages: msgs,
					fragments: [{ kind: 'alt', from: 0, to: 2 }, { kind: 'opt', from: 1, to: 3 }],
				}),
			/어긋나게 겹칩니다/,
		);
		// 완전히 포갠 것과 완전히 떨어진 것은 통과해야 한다 (대조군).
		assert.ok(
			buildSequenceHtml({
				...base,
				messages: msgs,
				fragments: [{ kind: 'alt', from: 0, to: 3 }, { kind: 'opt', from: 1, to: 2 }],
			}),
		);
	});
});

describe('★ S2 — 페이지에 들어가는 것은 데이터뿐이다', () => {
	// R1·R2 와 같은 규율. 시퀀스도 같은 통로를 쓰므로 같이 본다.
	test('스크립트는 둘뿐이고 데이터에 마크업이 들어가지 않는다', () => {
		const EVIL = '</script><script>alert(1)</script>';
		const html = buildSequenceHtml({
			title: EVIL,
			subtitle: EVIL,
			participants: [{ id: 'a', name: EVIL, sub: EVIL, tag: EVIL }],
			messages: [{ from: 'a', to: 'a', label: EVIL }],
			fragments: [{ kind: EVIL.slice(0, 16), label: EVIL, from: 0, to: 0 }],
		});
		const found = scripts(html);
		assert.equal(found.length, 2, '스크립트가 둘이 아니다');
		const json = found.find((v) => v.attrs.includes('application/json'));
		assert.ok(json && !json.body.includes('<'), '데이터에 < 가 살아 있다');
	});

	test('페이지 스크립트가 문법으로 성립한다', () => {
		const html = buildSequenceHtml(SEQ_SAMPLE);
		const body = scripts(html).find((v) => !v.attrs.includes('application/json'))?.body ?? '';
		assert.ok(body.length > 0, '페이지 스크립트를 못 찾았다');
		// 문법 오류면 페이지가 통째로 안 돌고, 바깥에서는 '결과를 못 읽었다'만 남는다.
		new Script(body);
	});
});

describe('★★ S3 — 감사 항목이 늘면 업로드 차단 조건도 같이 늘어야 한다', () => {
	// R7 과 같은 이유. 항목만 늘리고 clean 판정에서 빠뜨리면 결함 있는 그림이
	// 조용히 올라간다.
	test('SequenceAudit 의 모든 배열 항목이 clean 판정에 들어 있다', async () => {
		const src = await readFile(new URL('../render/sequence.ts', import.meta.url), 'utf8');
		const images = await readFile(new URL('../tools/images.ts', import.meta.url), 'utf8');
		const block = /export interface SequenceAudit \{([\s\S]*?)\n\}/.exec(src)?.[1];
		assert.ok(block, 'SequenceAudit 를 못 찾았다');
		const fields = [...block.matchAll(/^\t(\w+): string\[\];/gm)].map((m) => m[1] ?? '');
		assert.ok(fields.length >= 5, `감사 항목이 너무 적다: ${fields.join(',')}`);
		const clean = /const seqClean =([\s\S]*?);/.exec(images)?.[1] ?? '';
		assert.ok(clean.length > 0, 'seqClean 판정을 못 찾았다');
		for (const f of fields) {
			assert.ok(clean.includes(`q.${f}.length === 0`), `clean 판정에 q.${f} 가 빠졌다`);
		}
	});
});

describe('★★ S4 — 자가감사 검출력 (크롬 필요)', () => {
	const hasChrome = async (): Promise<boolean> => findChrome().then(() => true, () => false);

	/** 만들어진 HTML 을 그대로(또는 한 줄 바꿔) 크롬에 태우고 감사만 받아온다. */
	async function auditOf(html: string): Promise<SequenceAudit> {
		const dir = await mkdtemp(join(tmpdir(), 'velog-mcp-seqtest-'));
		const profileDir = await mkdtemp(join(tmpdir(), 'velog-mcp-seqprof-'));
		try {
			const file = join(dir, 'x.html');
			await writeFile(file, html, 'utf8');
			return parseSequenceAudit(await dumpDom(pathToFileURL(file).href, { profileDir }));
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
			await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	const count = (a: SequenceAudit): number =>
		a.over.length + a.collide.length + a.label.length + a.cross.length + a.frame.length;

	// ★ 배치 계산 다섯 갈래를 하나씩 망가뜨린다. 각 변이는 서로 다른 감사 항목이
	//   걸려야 한다 — 한 항목이 전부를 대신 잡으면 나머지는 죽은 검사라는 뜻이다.
	/** 배지만 있고 아이콘이 없는 카드. 이때 제목이 배지와 같은 높이로 올라온다. */
	const TAG_SAMPLE: SequenceSpec = {
		title: '배지',
		legend: false,
		participants: [
			{ id: 'a', name: 'A' },
			{ id: 'b', name: 'FCM googleapis', tag: 'v1' },
		],
		messages: [{ from: 'a', to: 'b', label: 'x' }],
	};

	/** 이모지는 같은 font-size 라도 글리프가 높다. 줄높이를 상수로 두면 줄이 물린다. */
	const EMOJI_SAMPLE: SequenceSpec = {
		title: '이모지',
		legend: false,
		participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
		messages: [
			{ from: 'a', to: 'b', label: '👨‍👩‍👧‍👦 가족 이모지가 들어간아주긴토큰🎉🎊🥳🚀✨💡🔥⚡️🌈🍀' },
		],
	};

	/** 조건이 상자보다 넓은 프래그먼트. */
	const CHIP_SAMPLE: SequenceSpec = {
		title: '긴 조건',
		legend: false,
		participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
		messages: [{ from: 'a', to: 'b', label: '짧다' }],
		fragments: [
			{
				kind: 'critical',
				label: '조건이 아주 길게 적혀 있어서 상자보다 라벨이 넓어지는 경우를 본다',
				from: 0,
				to: 0,
			},
		],
	};

	const MUTATIONS: Array<{
		what: string;
		from: string;
		to: string;
		field: 'over' | 'collide' | 'label' | 'cross' | 'frame';
		spec?: SequenceSpec;
	}> = [
		{
			what: '열 넓히기를 끈다',
			from: 'if (cur < sp.need) {',
			to: 'if (false) {',
			field: 'label',
		},
		{
			what: '행 높이에서 라벨 줄 수를 뺀다',
			from: 'mr.h = mr.th + 12;',
			to: 'mr.h = 12;',
			field: 'label',
		},
		{
			what: '카드 폭을 글자보다 좁게 만든다',
			from: 'p.w = Math.ceil(need);',
			to: 'p.w = 70;',
			field: 'over',
		},
		{
			// ⚠️ 처음엔 '+300 밀기'였다. 그건 **내 기계의 열 폭**에 기댄 값이라
			//    폰트가 다른 CI 에서는 빈 자리에 떨어져 아무것도 안 걸렸다.
			//    마지막 참가자의 생명선 좌표를 직접 겨냥해 환경과 무관하게 만든다.
			what: '노트를 남의 열 위로 민다',
			from: 'mx.box = {x:P[mx.a].cx + nOff,',
			to: 'mx.box = {x:P[P.length - 1].cx - 20,',
			field: 'collide',
		},
		{
			what: '프래그먼트 아래 여유를 없앤다',
			from: 'fr.y2 = M[fr.to].top + M[fr.to].h + 16 + fr.tailOff;',
			to: 'fr.y2 = M[fr.to].top;',
			field: 'frame',
		},
		// ★ 아래 셋은 험한 입력을 돌려보다 **실제로 나온 결함**이다. 고친 뒤 여기에 남긴다.
		{
			what: '배지 몫을 카드 폭에서 뺀다',
			from: 'if (p.tag && !p.icon) need = Math.max(need, Math.max(tw, sw) + 2 * p.tagW + 34);',
			to: '',
			field: 'collide',
			spec: TAG_SAMPLE,
		},
		{
			what: '프래그먼트 칩 넓히기를 끈다',
			from: 'if (fr.x2 - fr.x < chipNeed) fr.x2 = fr.x + chipNeed;',
			to: '',
			field: 'over',
			spec: CHIP_SAMPLE,
		},
	];

	// ★ 대조군을 표본마다 다 돌린다. 변이가 걸렸다는 사실만으로는 부족하다 —
	//   원래부터 걸리는 표본이었으면 그 시험은 아무것도 증명하지 않는다.
	for (const [name, spec] of [
		['기본', SEQ_SAMPLE],
		['배지', TAG_SAMPLE],
		['이모지', EMOJI_SAMPLE],
		['긴 조건', CHIP_SAMPLE],
	] as const) {
		test(`대조군(${name})은 통과한다`, async (t) => {
			if (!(await hasChrome())) {
				t.skip('크롬이 없어 건너뜀');
				return;
			}
			const a = await auditOf(buildSequenceHtml(spec));
			assert.equal(count(a), 0, `대조군이 걸렸다: ${JSON.stringify(a)}`);
		});
	}

	for (const m of MUTATIONS) {
		test(`변이: ${m.what} → ${m.field} 가 걸린다`, async (t) => {
			if (!(await hasChrome())) {
				t.skip('크롬이 없어 건너뜀');
				return;
			}
			const html = buildSequenceHtml(m.spec ?? SEQ_SAMPLE);
			// ★ 치환이 조용히 빗나가면 '원본을 원본과 비교'하게 된다 — 그러면 이 시험은
			//   아무것도 증명하지 않으면서 초록이 된다. 실제로 한 번 그렇게 당했다.
			assert.ok(html.includes(m.from), `변이 대상이 코드에 없다: ${m.from}`);
			const broken = html.replace(m.from, m.to);
			assert.notEqual(broken, html, '치환이 적용되지 않았다');

			const a = await auditOf(broken);
			assert.ok(
				a[m.field].length > 0,
				`${m.what} 를 했는데 ${m.field} 가 비었다 — 그 검사에 검출력이 없다.\n` +
					'⚠️ 코드가 맞아서가 아니라 **환경 때문**일 수 있다. 이 기계에 없는 글자는 ' +
					'보통 높이로 그려져서, 그걸 전제한 변이가 아무 일도 못 한다. ' +
					'이모지가 걸린 변이라면 러너에 이모지 폰트가 있는지부터 볼 것.\n' +
					`감사: ${JSON.stringify(a)}`,
			);
		});
	}
});

describe('★ S6 — 캔버스 상한은 크기를 설정하기 전에 걸린다 (크롬 필요)', () => {
	// ★ page.ts 와 같은 이유다. 브라우저는 width/height 를 받는 순간 그만한 표면을
	//   잡는다 — 실측으로 40068×40150 을 설정했더니 0.2초 만에 43GB 를 잡았다.
	//   그래서 바깥이 아니라 **페이지 안에서** 거른다. 여기서 보는 건 그 순서가
	//   지켜지는지다: 막힌 그림은 렌더 결과가 아니라 **예외**로 나와야 한다.
	test('메시지가 너무 많으면 그리지 않고 막는다', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		await assert.rejects(
			renderSequence({
				title: '너무 김',
				legend: false,
				participants: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
				messages: Array.from({ length: 200 }, (_, i) => ({
					from: 'a',
					to: 'b',
					label: `m${i}`,
				})),
			}),
			/그림이 너무 큽니다/,
		);
	});
});

describe('★ S5 — 글자를 줄이는 대신 자리를 넓힌다 (크롬 필요)', () => {
	test('긴 라벨을 넣어도 통과하고, 라벨이 길수록 그림이 넓어진다', async (t) => {
		if (!(await findChrome().then(() => true, () => false))) {
			t.skip('크롬이 없어 건너뜀');
			return;
		}
		const make = (label: string): SequenceSpec => ({
			title: '폭 시험',
			legend: false,
			// ★ 캔버스에는 최소 폭 720 이 있다. 참가자가 둘뿐이면 짧은 쪽도 긴 쪽도
			//   바닥에 걸려 폭이 같게 나온다 — 비교 자체가 성립하지 않는다(처음에 그렇게 틀렸다).
			participants: ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => ({ id: n, name: n })),
			messages: [{ from: 'A', to: 'B', label }],
		});
		const short = await renderSequence(make('짧다'));
		const long = await renderSequence(make('열을 넓혀야 들어가는 제법 긴 라벨'));
		assert.ok(short.width > 720, `최소 폭에 걸려 비교가 성립하지 않는다: ${short.width}`);
		for (const r of [short, long]) {
			const a = r.audit;
			assert.equal(
				a.over.length + a.collide.length + a.label.length + a.cross.length + a.frame.length,
				0,
				`감사에 걸렸다: ${JSON.stringify(a)}`,
			);
		}
		assert.ok(
			long.width > short.width,
			`라벨이 긴데 그림이 안 넓어졌다 — 글자를 줄였을 수 있다 (${short.width} → ${long.width})`,
		);
	});
});

describe('★★ S7 — 줄높이는 상수가 아니라 잰 값에서 온다', () => {
	/**
	 * ⚠️ 이 검사는 **두 번 실패하고 나서** 이 모양이 됐다.
	 *
	 * 처음엔 이모지 라벨을 렌더해서 잡았다. 이모지 글리프가 11.5px 글꼴에서도
	 * 15px 보다 높아 줄이 물리기 때문이다. 맥에서는 잡혔고 CI 에서는 안 잡혔다.
	 * 러너에 이모지 폰트가 없어서라고 보고 `fonts-noto-color-emoji` 를 깔았다.
	 * **그래도 안 잡혔다.** 폰트는 확실히 깔렸는데(fc-list 로 확인) 변이가 여전히
	 * 무반응이었다 — 리눅스의 NotoColorEmoji 는 같은 글꼴 크기에서 bbox 가 낮아
	 * 15px 바닥값을 못 넘는다는 뜻이다.
	 *
	 * 그래서 렌더로 잡기를 그만뒀다. 어느 글자가 얼마나 높은지는 기계마다 다르고,
	 * 그걸 전제한 시험은 **한쪽에서 조용히 헛돈다.** 대신 계산식을 소스에서 꺼내
	 * 재기 함수를 가짜로 물린다. 이러면 폰트가 무엇이든 답이 같다.
	 */
	const SRC = new URL('../render/sequence.ts', import.meta.url);

	/** 페이지 스크립트에서 계산식만 떼어내 가짜 측정값으로 돌린다. */
	async function lineHeightWith(heights: number[], floor = 15): Promise<number> {
		const src = await readFile(SRC, 'utf8');
		const fn = /function lineHeightOf\(lines, cls\)\{[\s\S]*?\n\}/.exec(src)?.[0];
		assert.ok(fn, 'lineHeightOf 를 소스에서 못 찾았다 — 이름이 바뀌었으면 이 검사도 고칠 것');
		const ctx = createContext({
			LH: floor,
			box: (s: string) => ({ w: 0, h: Number(s) }),
			lines: heights.map(String),
			out: 0,
		});
		new Script(`${fn}
out = lineHeightOf(lines, 'm-label');`).runInContext(ctx);
		return (ctx as { out: number }).out;
	}

	test('가장 높은 줄을 따라간다 (상수면 이 값이 안 변한다)', async () => {
		assert.equal(await lineHeightWith([30]), 33, '잰 값 30 이면 33 이어야 한다');
		assert.equal(await lineHeightWith([12, 30, 9]), 33, '여러 줄이면 가장 높은 것을 쓴다');
		assert.equal(await lineHeightWith([80]), 83, '높을수록 그만큼 벌어져야 한다');
	});

	test('바닥값 아래로는 안 내려간다', async () => {
		assert.equal(await lineHeightWith([1]), 15, '작아도 15 아래로는 안 간다');
		assert.equal(await lineHeightWith([]), 15, '줄이 없어도 바닥값');
	});

	// ★ 계산식이 맞아도 **부르지 않으면** 소용이 없다. 배선을 따로 본다.
	//   렌더로 잡을 수 없게 된 규칙이라 이 검사가 유일한 자물쇠다.
	test('메시지마다 그 계산식을 실제로 부른다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/m\.lh = lineHeightOf\(m\.lines, m\.cls\);/,
			'줄높이를 상수로 되돌렸다 — 이모지처럼 글리프가 높은 글자에서 줄이 물린다',
		);
		assert.match(
			src,
			/m\.th = m\.lines\.length \* m\.lh;/,
			'행 높이가 그 줄높이를 안 쓰고 있다',
		);
	});
});

describe('★★ S8 — 긴 라벨은 글자 단위보다 구분 기호를 먼저 본다', () => {
	/**
	 * 왜 있나. 사내 구성도를 그려보니 `…&keyversion=v3&USE_INTT_ID=PSNM_1` 이
	 * `USE` 와 `_INTT_ID` 로 갈라졌다. 원인은 `wrapText` 가 **공백으로만** 자르고,
	 * 공백 없는 토큰은 곧장 글자 단위로 내려간 것이었다.
	 *
	 * ⚠️ 이건 자가감사가 못 잡는다. 줄이 제 상자 안에 있고 겹치지도 않으므로
	 * 기하로는 결함이 아니다. 그래서 이 검사가 유일한 자물쇠다.
	 *
	 * 렌더로 잡지 않는 이유는 S7 과 같다 — 어느 글자가 몇 px 인지는 기계마다 달라서
	 * 폰트를 전제한 시험은 한쪽에서 조용히 헛돈다. 계산식만 떼어내 가짜 자로 잰다.
	 */
	const SRC = new URL('../render/sequence.ts', import.meta.url);

	/** 페이지 스크립트에서 줄바꿈 계산식만 떼어내 '한 글자 = 폭 1' 자로 돌린다. */
	async function wrapWith(text: string, maxW: number, breakAfter?: string): Promise<string[]> {
		const src = await readFile(SRC, 'utf8');
		const decl = /var BREAK_AFTER = '[^']*';/.exec(src)?.[0];
		const chunk = /function chunkLong\(word\)\{[\s\S]*?\n\}/.exec(src)?.[0];
		const wrap = /function wrapText\(s, cls, maxW\)\{[\s\S]*?\n\}/.exec(src)?.[0];
		assert.ok(decl, 'BREAK_AFTER 를 소스에서 못 찾았다 — 이름이 바뀌었으면 이 검사도 고칠 것');
		assert.ok(chunk, 'chunkLong 을 소스에서 못 찾았다');
		assert.ok(wrap, 'wrapText 를 소스에서 못 찾았다');
		const ctx = createContext({
			measure: (s: string) => Array.from(s).length,
			text,
			maxW,
			out: [] as string[],
		});
		new Script(`${breakAfter === undefined ? decl : `var BREAK_AFTER = ${JSON.stringify(breakAfter)};`}
${chunk}
${wrap}
out = wrapText(text, 'm-label', maxW);`).runInContext(ctx);
		return (ctx as { out: string[] }).out;
	}

	const QUERY = '/push?PUSH_DATA=..&keyversion=v3&USE_INTT_ID=PSNM_1';

	test('식별자 한가운데가 갈라지지 않는다', async () => {
		const lines = await wrapWith(QUERY, 20);
		assert.ok(lines.length > 1, '이 폭이면 여러 줄이어야 한다 — 시험이 헛돌고 있다');
		for (const line of lines.slice(0, -1)) {
			assert.ok(
				"&?=/,;|".includes(line[line.length - 1] ?? ''),
				`줄이 구분 기호가 아닌 데서 끊겼다: ${JSON.stringify(line)}\n전체: ${JSON.stringify(lines)}`,
			);
		}
	});

	test('글자를 하나도 잃거나 더하지 않는다', async () => {
		for (const w of [12, 20, 33, 200]) {
			assert.equal(
				(await wrapWith(QUERY, w)).join(''),
				QUERY,
				`폭 ${w} 에서 원문이 안 맞는다 — 줄바꿈이 글자를 먹었다`,
			);
		}
	});

	test('어느 줄도 정해준 폭을 넘지 않는다', async () => {
		for (const w of [12, 20, 33]) {
			for (const line of await wrapWith(QUERY, w)) {
				assert.ok(line.length <= w, `폭 ${w} 인데 ${line.length} 짜리 줄이 나왔다: ${line}`);
			}
		}
	});

	test('구분 기호가 없는 한글은 예전대로 글자 단위로 접는다', async () => {
		const ko = '띄어쓰기가없는아주긴한국어토큰이라낱말단위로는절대안접힌다';
		const lines = await wrapWith(ko, 10);
		assert.ok(lines.length > 1, '한글이 안 접혔다 — 조각이 하나뿐인 경로가 깨졌다');
		assert.equal(lines.join(''), ko, '한글에서 글자를 잃었다');
		for (const line of lines) assert.ok(line.length <= 10, `${line.length} 짜리 줄: ${line}`);
	});

	// ★ 변이 — 구분 기호 목록을 비우면 예전 동작(글자 단위)으로 돌아간다.
	//   이게 실패하면 위 검사들이 규칙이 아니라 우연을 보고 있다는 뜻이다.
	test('구분 기호를 지우면 식별자가 갈라진다 (검출력)', async () => {
		const lines = await wrapWith(QUERY, 20, '');
		const broke = lines.slice(0, -1).some((l) => !"&?=/,;|".includes(l[l.length - 1] ?? ''));
		assert.ok(
			broke,
			'구분 기호를 지웠는데도 결과가 같다 — 이 검사는 구분 기호 규칙을 안 보고 있다',
		);
	});
});

describe('★★ S9 — 번호는 접기에 참여하지 않는다', () => {
	/**
	 * 왜 있나. 라벨이 공백 없는 긴 토큰이면 번호가 **혼자 한 줄**을 차지했다.
	 *
	 *   1.
	 *   /push?PUSH_DATA=..&keyversion=v3&
	 *   USE_INTT_ID=PSNM_1
	 *
	 * 번호를 라벨에 이어 붙인 뒤 통째로 접었기 때문이다. 행 하나를 통째로 잃고,
	 * 세로는 그 아래 행을 전부 민다. 실측으로 1429×1027 → 1441×993 이었다
	 * (세로 34 줄고 가로 12 늘어남).
	 *
	 * ⚠️ 자가감사는 이것도 통과한다. 줄이 제 상자 안에 있고 겹치지도 않는다.
	 */
	const SRC = new URL('../render/sequence.ts', import.meta.url);

	test('번호가 첫 줄에 붙고 줄 수가 안 늘어난다', async () => {
		const src = await readFile(SRC, 'utf8');
		const glue = /if \(num\) m\.lines = [^\n]*\n/.exec(src)?.[0];
		assert.ok(glue, '번호를 첫 줄에 붙이는 줄을 소스에서 못 찾았다');
		const ctx = createContext({ num: '7.', m: { lines: ['가나다', '라마바'] } });
		new Script(glue).runInContext(ctx);
		// vm 안에서 만들어진 배열이라 realm 이 다르다 — 네이티브로 옮겨 비교한다.
		const got = Array.from((ctx as { m: { lines: string[] } }).m.lines);
		assert.deepEqual(got, ['7. 가나다', '라마바'], '번호가 첫 줄에 안 붙었다');
		assert.equal(got.length, 2, '번호 때문에 줄이 늘어났다 — 고아 줄이 되살아났다');
	});

	test('라벨이 비어도 번호만 남는다', async () => {
		const src = await readFile(SRC, 'utf8');
		const glue = /if \(num\) m\.lines = [^\n]*\n/.exec(src)?.[0] as string;
		const ctx = createContext({ num: '3.', m: { lines: [] as string[] } });
		new Script(glue).runInContext(ctx);
		assert.deepEqual(Array.from((ctx as { m: { lines: string[] } }).m.lines), ['3.']);
	});

	// ★ 계산이 맞아도 **번호를 다시 접기에 넣어버리면** 소용이 없다. 배선을 따로 본다.
	test('접을 때는 번호 없는 라벨을 넘긴다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/m\.lines = wrapText\(body, m\.cls, WRAP_W\);/,
			'접기에 번호 붙은 문자열을 넘기고 있다 — 고아 줄이 되살아난다',
		);
		assert.doesNotMatch(
			src,
			/body = body \? \(seq \+ '\. ' \+ body\)/,
			'번호를 라벨에 이어 붙이는 옛 코드가 되살아났다',
		);

		// ★ 코덱스 지적 — 붙이는 것만 보면 부족하다. 번호를 붙이면 첫 줄이
		//   WRAP_W 를 넘는데, 폭(m.tw)을 **붙이기 전에** 재면 열이 그만큼 안 넓어진다.
		//   순서를 바꿔도 위 검사들은 전부 통과했다. 그래서 순서를 따로 못 박는다.
		const glueAt = src.indexOf("if (num) m.lines = m.lines.length ?");
		const twAt = src.indexOf('m.tw = widest(m.lines, m.cls);');
		assert.ok(glueAt > 0 && twAt > 0, '기준점을 소스에서 못 찾았다 — 이 검사가 헛돈다');
		assert.ok(
			glueAt < twAt,
			'폭을 번호 붙이기 전에 재고 있다 — 번호만큼 열이 덜 넓어져 라벨이 제 구간을 넘는다',
		);
	});
});

describe('★★ S10 — 한 열짜리 설명은 덜 벌리는 쪽에 붙는다', () => {
	/**
	 * 왜 있나. 설명 상자를 늘 생명선 **오른쪽**에만 붙였다. 그래서 왼쪽 간격이
	 * 이미 넓어 자리가 남아도 안 쓰고 오른쪽 열을 밀었다. 같은 그림 실측으로
	 * 가로 1441 → 1331 (110 줄어듦), 세로는 그대로였다.
	 *
	 * ⚠️ 자가감사는 이것도 통과했다. 상자가 제 자리에 있고 겹치지도 않는다 —
	 * 그냥 넓을 뿐이다. 그래서 이 검사가 유일한 자물쇠다.
	 */
	const SRC = new URL('../render/sequence.ts', import.meta.url);

	/** 배치 결정식만 떼어내 가짜 열 폭과 간격으로 돌린다. */
	async function sideOf(
		a: number,
		tw: number,
		widths: number[],
		gaps: number[],
		inset = 0,
	): Promise<boolean> {
		const src = await readFile(SRC, 'utf8');
		const blk = /var npadR = NOTE_OFF[\s\S]*?mm\.left = defL < defR;/.exec(src)?.[0];
		assert.ok(blk, '배치 결정식을 소스에서 못 찾았다 — 이름이 바뀌었으면 이 검사도 고칠 것');
		const ctx = createContext({
			NOTE_OFF: 26,
			mm: { a, tw, left: false, inset },
			P: widths.map((w) => ({ w })),
			gaps,
		});
		new Script(blk).runInContext(ctx);
		return (ctx as { mm: { left: boolean } }).mm.left;
	}

	// 노트가 차지하는 폭 = 26 + tw + 28 + 16. tw=100 이면 170 에 옆 카드 절반이 더해진다.
	const W = [120, 120, 120, 120];

	test('왼쪽이 이미 넓으면 왼쪽에 붙는다', async () => {
		assert.equal(await sideOf(2, 100, W, [600, 600, 100]), true, '왼쪽에 자리가 남는데 오른쪽을 밀었다');
	});

	test('오른쪽이 넓으면 오른쪽에 붙는다', async () => {
		assert.equal(await sideOf(1, 100, W, [100, 600, 100]), false, '오른쪽에 자리가 남는데 왼쪽을 밀었다');
	});

	test('양쪽이 같으면 오른쪽 — 읽는 방향과 같다', async () => {
		assert.equal(await sideOf(1, 100, W, [300, 300, 300]), false, '같은 조건에서 왼쪽으로 갔다');
	});

	test('첫 열은 왼쪽에 열이 없으므로 오른쪽', async () => {
		assert.equal(await sideOf(0, 100, W, [10, 10, 10]), false, '왼쪽에 열이 없는데 왼쪽으로 갔다');
	});

	test('마지막 열은 흡수할 간격이 없어 왼쪽이 유리하다', async () => {
		// 오른쪽으로 가면 캔버스가 npad 만큼 통째로 늘어난다. 왼쪽 간격이 넉넉하면 왼쪽.
		assert.equal(await sideOf(3, 100, W, [100, 100, 600]), true, '캔버스를 늘리는 쪽을 골랐다');
	});

	// ★ 결정이 맞아도 **상자를 그때 안 옮기면** 소용이 없다. 배선을 따로 본다.
	test('상자 x 와 연결선이 그 결정을 실제로 쓴다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/var nOff = mx\.left \? -\(NOTE_OFF \+ bw0\) : NOTE_OFF \+ \(mx\.inset \|\| 0\);/,
			'상자 x 가 좌우 결정이나 막대 몫을 안 쓰고 있다',
		);
		assert.match(
			src,
			/' H'\+\(mn\.left \? bx \+ bw : bx\)/,
			'연결선이 먼 변까지 간다 — 상자 밑을 가로지르는 선이 생긴다',
		);
	});
});

describe('★★ S11 — 열 넓히기가 활성 막대 몫을 뺀다', () => {
	/**
	 * 왜 있나. 화살표는 생명선 한가운데가 아니라 **막대 가장자리**에서 끊는다.
	 * 그래서 막대가 쌓인 구간은 라벨이 쓸 수 있는 가로가 그만큼 줄어드는데,
	 * 열 넓히기가 그 몫을 안 뺐다. `call` 만 12개 이어 붙이고 긴 라벨을 주면
	 * **감사에 걸려 업로드가 거부됐다**(실측, v0.7.4 부터 있던 결함).
	 *
	 *   label: '12. /v1/resource?token=…' 가 제 구간 밖으로 나감
	 *
	 * 짝을 맞춰 막대를 닫으면 통과했고 번호와는 무관했다 — 그래서 막대가 범인이다.
	 *
	 * ⚠️ 렌더로 잡지 않는다. 어느 폭에서 넘치는지는 글꼴이 정하므로 다른 기계에서
	 * 조용히 헛돈다(S7 과 같은 이유). 계산식과 배선만 본다.
	 */
	const SRC = new URL('../render/sequence.ts', import.meta.url);

	async function insetWith(depth: number, step = 6, barW = 10): Promise<number> {
		const src = await readFile(SRC, 'utf8');
		const fn = /function insetOf\(depth\)\{[^}]*\}/.exec(src)?.[0];
		assert.ok(fn, 'insetOf 를 소스에서 못 찾았다 — 이름이 바뀌었으면 이 검사도 고칠 것');
		const ctx = createContext({ BAR_STEP: step, BAR_W: barW, out: 0, d: depth });
		new Script(`${fn}\nout = insetOf(d);`).runInContext(ctx);
		return (ctx as { out: number }).out;
	}

	test('막대가 없으면 0, 있으면 깊이만큼 들어간다', async () => {
		assert.equal(await insetWith(0), 0, '막대가 없는데 자리를 뺐다');
		assert.equal(await insetWith(1), 5, '막대 하나면 반폭(5)만 들어간다');
		assert.equal(await insetWith(2), 11, '두 겹이면 한 계단(6) 더');
		assert.equal(await insetWith(5), 29, '깊을수록 그만큼 더');
	});

	test('spans 가 그 몫을 실제로 더한다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/need:ms\.tw \+ \(ms\.note \? 34 : 30\) \+ \(ms\.inset \|\| 0\)/,
			'열 넓히기가 막대 몫을 안 더한다 — 막대가 쌓이면 라벨이 제 구간을 넘는다',
		);
		assert.match(
			src,
			/mb\.inset = insetOf\(preOpen\[mb\.a\]\) \+ insetOf\(preOpen\[mb\.b\]\)/,
			'호출 쪽 막대 몫 계산이 사라졌다',
		);
	});

	// ★ 아래 셋은 «막대 몫» 을 spans 에만 넣고 끝냈다가 **나중에 따로 터진 것**이다.
	//   spans 를 안 타는 경로가 둘 더 있었다. 감사가 못 보던 자리도 하나 있었다.
	test('자기호출 넓히기도 막대 몫을 더한다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/widenOne\(mm\.a, \(mm\.inset \|\| 0\) \+ SELF_W \+ 10 \+ mm\.tw/,
			'자기호출은 spans 를 안 탄다 — 여기서 직접 안 더하면 깊은 막대 위에서 라벨이 넘친다',
		);
	});

	test('노트도 막대 몫을 세고, 오른쪽에 붙을 때만 비켜준다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/if \(mb\.note\) \{ if \(mb\.a === mb\.b\) mb\.inset = insetOf\(preOpen\[mb\.a\]\); continue; \}/,
			'노트가 막대 몫 계산에서 통째로 빠졌다',
		);
		assert.match(
			src,
			/var npadR = NOTE_OFF \+ \(mm\.inset \|\| 0\) \+ mm\.tw/,
			'오른쪽 노트가 막대 몫만큼 안 비켜난다',
		);
		assert.doesNotMatch(
			src,
			/var npadL = NOTE_OFF \+ \(mm\.inset/,
			'왼쪽에도 막대 몫을 더하고 있다 — 막대는 오른쪽으로만 밀리므로 헛되이 벌린다',
		);
	});

	test('감사가 노트와 활성막대의 겹침을 본다', async () => {
		const src = await readFile(SRC, 'utf8');
		assert.match(
			src,
			/의 활성막대를 덮음/,
			'감사에 노트 대 막대 검사가 없다 — 카드, 노트, 생명선은 보면서 막대만 안 봤다',
		);
	});
});

describe('★★ S12 — 한 열짜리 넓히기는 spans 뒤에 온다', () => {
	/**
	 * 왜 있나. 노트를 어느 쪽에 붙일지는 **그때의 간격**을 보고 정한다.
	 * 그런데 그 결정을 `spans` 앞에서 하면, 곧 넓어질 쪽을 모르고 골라 반대쪽을
	 * 쓸데없이 벌린다. 실측으로 859 → 720 (139 줄어듦).
	 *
	 * `spans` 는 간격을 **늘리기만** 하므로 뒤에서 더 넓혀도 그 조건은 그대로
	 * 성립한다. 그래서 순서를 바꾸는 것이 안전하다.
	 */
	test('소스에서 spans 루프가 노트·자기호출 넓히기보다 앞에 있다', async () => {
		const src = await readFile(new URL('../render/sequence.ts', import.meta.url), 'utf8');
		const spans = src.indexOf('spans.sort(function(x, y)');
		const single = src.indexOf('if (mm.note && mm.a === mm.b) {');
		const cx = src.indexOf('var CX = [0];');
		assert.ok(spans > 0 && single > 0 && cx > 0, '기준점을 소스에서 못 찾았다 — 이 검사가 헛돈다');
		assert.ok(
			spans < single,
			'한 열짜리 넓히기가 spans 보다 앞에 있다 — 노트가 곧 넓어질 쪽을 모르고 방향을 고른다',
		);
		assert.ok(single < cx, '한 열짜리 넓히기가 열 좌표를 잡은 뒤로 밀렸다 — 그러면 반영이 안 된다');
	});
});
