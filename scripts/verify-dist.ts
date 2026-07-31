#!/usr/bin/env node
/**
 * 발행 직전 관문 — **실제로 npm 에 실릴 `dist/index.js` 를 띄워본다.**
 *
 * ★ 왜 테스트로는 부족한가
 *   테스트(P18)는 `src/index.ts` 를 띄운다. 그런데 사용자가 실행하는 건 `dist/index.js` 다.
 *   `dist/` 는 `.gitignore` 대상이라 lint 도 테스트도 닿지 않는다.
 *   그래서 `dist` 에서만 깨진 상태 — 예를 들어 빌드 산출물이 낡아 `server.connect()`
 *   이전 버전인 경우 — 는 267개 테스트가 전부 통과해도 잡히지 않는다.
 *
 * ★ 왜 `prepublishOnly` 인가
 *   `npm publish` 가 **반드시** 이걸 거친다. 사람이 건너뛸 수 없다.
 *   테스트 스위트에 넣으면 빌드 없이 돌릴 때 건너뛰게 되고, 건너뛰는 검사는 검사가 아니다.
 *
 * 확인하는 것:
 *   1. dist 가 뜨고 MCP `initialize` 에 응답한다
 *   2. 서버 이름·버전이 package.json 과 같다 (낡은 산출물 탐지)
 *   3. 도구가 다 등록된다
 *   4. **stdout 에 프로토콜 아닌 줄이 없다** — 한 줄만 섞여도 클라이언트가 프레이밍을 잃는다
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanFiles } from './shipping-checks.ts';
import { SERVER_NAME, CHROME_TOOLS } from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const ENTRY = new URL('dist/index.js', ROOT);

/** 핸드셰이크 뒤에도 얼마간 지켜본다. 지연 오염·조기 종료는 그 뒤에 온다. */
const WATCH_MS = 2_000;

/** 기본 등록 도구 수. 프로필 게이트를 켜면 늘어난다. */
const MIN_TOOLS = 21;

interface Outcome {
	readonly responses: Array<Record<string, unknown>>;
	readonly junk: string[];
	readonly stderr: string;
	/** 지켜보는 동안 스스로 죽었나. 죽었으면 그 코드/시그널. */
	readonly died: string | null;
}

async function handshake(binLink: string): Promise<Outcome> {
	// ★★ **npm 이 실제로 쓰는 모양으로 띄운다 — 심볼릭 링크.**
	//   `npx`·`npm i -g` 는 `node_modules/.bin/velog-mcp` 링크를 만들어 실행한다.
	//   정규화된 실제 경로로만 검증하면 **링크에서만 죽는 버그를 못 본다.**
	//   실제로 그런 버그가 있었다(argv[1] 이 링크라 `isDirectRun()` 이 false →
	//   출력 0줄·코드 0). 관문이 실물과 다른 모양을 보고 있었던 것이다.
	//
	// ⚠️ `ENTRY.pathname` 은 공백을 `%20` 으로 남긴다(실측) → `fileURLToPath`.
	const child = spawn(process.execPath, [binLink], {
		stdio: ['pipe', 'pipe', 'pipe'],
		// 토큰 없이 띄운다. 발행 검증이 실제 계정을 건드릴 이유가 없다.
		env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
	});

	const requests = [
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'verify-dist', version: '0' },
			},
		},
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	];
	for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

	const responses: Array<Record<string, unknown>> = [];
	const junk: string[] = [];
	let buffer = '';
	let stderr = '';

	return await new Promise<Outcome>((resolve) => {
		let died: string | null = null;
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(hardTimer);
			clearTimeout(watchTimer);
			// 줄바꿈 없이 끝난 꼬리도 버리지 않는다 — 그것도 오염이다.
			if (buffer.trim()) junk.push(buffer.trim());
			child.kill('SIGKILL');
			resolve({ responses, junk, stderr, died });
		};

		const hardTimer = setTimeout(finish, 30_000);
		let watchTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				// ⚠️ JSON 이면 무조건 MCP 응답으로 인정했었다. 그러면 JSON 로거 한 줄이
				//    섞여도 "stdout 순수"라고 판정한다 — 실제 프로토콜은 이미 오염됐는데.
				//    형태(`jsonrpc: '2.0'` + id 또는 method)까지 본다.
				let parsed: Record<string, unknown> | null;
				try {
					parsed = JSON.parse(line) as Record<string, unknown>;
				} catch {
					parsed = null;
				}
				if (parsed && parsed['jsonrpc'] === '2.0' && ('id' in parsed || 'method' in parsed)) {
					responses.push(parsed);
				} else {
					junk.push(line);
				}
			}
			// 응답을 다 받아도 **바로 죽이지 않는다.** 지연 stdout 과 조기 종료를
			// 보려면 잠깐 살려둬야 한다 — 즉시 죽이면 둘 다 못 본다(코덱스 지적).
			if (responses.length >= 2) {
				clearTimeout(watchTimer);
				// 응답이 늦게 오면 hard timer 가 감시창을 잘라 "2초 지켜봤다"가 거짓이 된다.
				// 감시창을 확보하도록 hard timer 를 미룬다.
				hardTimer.refresh?.();
				watchTimer = setTimeout(finish, WATCH_MS);
			}
		});
		child.on('error', finish);
		child.on('exit', (code, signal) => {
			// 우리가 죽이기 전에 스스로 끝났다면 그것 자체가 문제다.
			if (!settled) died = signal ? `시그널 ${signal}` : `종료코드 ${String(code)}`;
			finish();
		});
	});
}

function fail(message: string): never {
	process.stderr.write(`\n❌ 발행 중단 — ${message}\n`);
	process.exit(1);
}

const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as {
	name: string;
	version: string;
};

/**
 * npm 이 만드는 것과 같은 모양의 링크를 임시로 만든다.
 * 이걸 안 하면 "링크에서만 죽는" 버그를 관문이 영원히 못 본다.
 */
const linkDir = await mkdtemp(join(tmpdir(), 'velog-mcp-verify-'));
const binLink = join(linkDir, 'velog-mcp');
await symlink(fileURLToPath(ENTRY), binLink);

const { responses, junk, stderr, died } = await handshake(binLink).finally(async () => {
	await rm(linkDir, { recursive: true, force: true });
});

if (died) {
	fail(
		`dist 가 스스로 종료했습니다(${died}). MCP 서버는 클라이언트가 끊을 때까지 살아 있어야 합니다.\n` +
			`   stderr: ${stderr.trim()}`,
	);
}

if (junk.length > 0) {
	fail(
		`dist 가 stdout 에 프로토콜 아닌 줄을 냈습니다(${junk.length}줄). ` +
			`stdout 은 MCP 전용입니다.\n   첫 줄: ${junk[0] ?? ''}`,
	);
}

const init = responses.find((r) => r['id'] === 1);
if (!init) fail(`dist 가 initialize 에 응답하지 않았습니다.\n   stderr: ${stderr.trim()}`);

const info = (init['result'] as { serverInfo?: { name?: string; version?: string } })?.serverInfo;
// ⚠️ 주석에는 '이름·버전'이라 적어놓고 버전만 봤다(코덱스 지적). 둘 다 본다.
if (info?.name !== SERVER_NAME) {
	fail(`서버 이름이 ${String(info?.name)} 입니다. ${SERVER_NAME} 이어야 합니다.`);
}
if (info?.version !== pkg.version) {
	fail(
		`빌드 산출물이 낡았습니다 — dist 는 ${String(info?.version)}, package.json 은 ${pkg.version}.\n` +
			'   `npm run build` 를 다시 도세요.',
	);
}

const list = responses.find((r) => r['id'] === 2);
const tools = (list?.['result'] as { tools?: Array<{ name: string }> })?.tools ?? [];
if (tools.length < MIN_TOOLS) {
	fail(`도구가 ${tools.length}개뿐입니다(최소 ${MIN_TOOLS}). 등록이 빠졌습니다.`);
}
for (const required of CHROME_TOOLS) {
	if (!tools.some((tool) => tool.name === required)) {
		fail(`${required} 이 등록되지 않았습니다.`);
	}
}

// ── 실제로 tarball 에 실리는 것들을 훑는다 ────────────────────────────────
//
// P21 은 **git 이 추적하는 것**을 본다. 그런데 `dist/` 는 gitignore 대상이라
// 거기 안 잡히고, `tsc` 는 기존 산출물을 지우지 않아 삭제된 소스의 낡은 파일이
// 남을 수 있다. 그 둘이 겹치면 옛 코드나 개인 경로가 npm 에 영구히 올라간다.
async function walk(dir: URL, prefix = ''): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
		if (entry.isDirectory()) out.push(...(await walk(child, `${prefix}${entry.name}/`)));
		else out.push(`${prefix}${entry.name}`);
	}
	return out;
}

const shipped: Array<[string, URL]> = [];
for (const [label, base] of [
	['dist', new URL('dist/', ROOT)],
	['docs', new URL('docs/', ROOT)],
] as const) {
	for (const relative of await walk(base)) {
		shipped.push([`${label}/${relative}`, new URL(relative, base)]);
	}
}
for (const name of ['package.json', 'README.md', 'README.ko.md', 'LICENSE', 'npm-shrinkwrap.json']) {
	shipped.push([name, new URL(name, ROOT)]);
}

const loaded: Array<[string, Uint8Array]> = [];
for (const [label, url] of shipped) loaded.push([label, await readFile(url)]);

const { leaks, skipped } = scanFiles(loaded);
if (leaks.length > 0) {
	fail(
		`발행물에 나가면 안 되는 것이 있습니다(${leaks.length}건):\n` +
			leaks.map((leak) => `   ${leak.file}: ${leak.kind} ${leak.value}`).join('\n'),
	);
}
// ⚠️ 검사하지 못한 파일을 조용히 넘기면 그게 구멍이다. 지금 발행물에 바이너리는 없다.
if (skipped.length > 0) {
	fail(
		`텍스트로 못 읽어 **검사하지 못한** 발행물이 있습니다(${skipped.length}개): ` +
			`${skipped.join(', ')}\n   눈으로 확인하고 예외로 넣든지 빼든지 정하세요.`,
	);
}

// 삭제된 소스의 낡은 산출물이 남았는지.
// ⚠️ 처음엔 `.js` 만 봤다. `.d.ts`·`.js.map` 만 남기면 그냥 통과한다(실측) —
//    낡은 타입 정의와 소스맵이 그대로 발행된다. 확장자를 벗겨 짝을 본다.
const sources = new Set(
	(await walk(new URL('src/', ROOT)))
		.filter((f) => f.endsWith('.ts') && !f.startsWith('__tests__/'))
		.map((f) => f.replace(/\.ts$/, '')),
);
const orphans = shipped
	.map(([label]) => label)
	.filter((label) => label.startsWith('dist/'))
	.map((label) => label.slice('dist/'.length))
	.filter((relative) => !sources.has(relative.replace(/\.(d\.ts|js\.map|js|mjs|cjs|map)$/, '')));
if (orphans.length > 0) {
	fail(
		`dist 에 소스가 없는 산출물이 남아 있습니다(${orphans.length}개): ${orphans.join(', ')}\n` +
			'   `npm run build` 는 dist 를 비우고 시작합니다 — 수동으로 지우고 다시 도세요.',
	);
}

process.stdout.write(
	`✅ dist 검증 통과 — ${pkg.name}@${pkg.version} · 도구 ${tools.length}개 · ` +
		`stdout 순수 · ${String(WATCH_MS / 1000)}초 생존(심볼릭 링크 실행) · 발행물 ${shipped.length}개 개인정보 0건\n`,
);
