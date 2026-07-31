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
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const ENTRY = new URL('dist/index.js', ROOT);

interface Outcome {
	readonly responses: Array<Record<string, unknown>>;
	readonly junk: string[];
	readonly stderr: string;
}

async function handshake(): Promise<Outcome> {
	const child = spawn(process.execPath, [ENTRY.pathname], {
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
		const done = (): void => {
			clearTimeout(timer);
			child.kill('SIGKILL');
			resolve({ responses, junk, stderr });
		};
		const timer = setTimeout(done, 20_000);

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					responses.push(JSON.parse(line) as Record<string, unknown>);
				} catch {
					junk.push(line);
				}
			}
			if (responses.length >= 2) done();
		});
		child.on('error', done);
		child.on('close', done);
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

const { responses, junk, stderr } = await handshake();

if (junk.length > 0) {
	fail(
		`dist 가 stdout 에 프로토콜 아닌 줄을 냈습니다(${junk.length}줄). ` +
			`stdout 은 MCP 전용입니다.\n   첫 줄: ${junk[0] ?? ''}`,
	);
}

const init = responses.find((r) => r['id'] === 1);
if (!init) fail(`dist 가 initialize 에 응답하지 않았습니다.\n   stderr: ${stderr.trim()}`);

const info = (init['result'] as { serverInfo?: { name?: string; version?: string } })?.serverInfo;
if (info?.version !== pkg.version) {
	fail(
		`빌드 산출물이 낡았습니다 — dist 는 ${String(info?.version)}, package.json 은 ${pkg.version}.\n` +
			'   `npm run build` 를 다시 도세요.',
	);
}

const list = responses.find((r) => r['id'] === 2);
const tools = (list?.['result'] as { tools?: Array<{ name: string }> })?.tools ?? [];
if (tools.length < 20) fail(`도구가 ${tools.length}개뿐입니다. 등록이 빠졌습니다.`);

process.stdout.write(
	`✅ dist 검증 통과 — ${pkg.name}@${pkg.version} · 도구 ${tools.length}개 · stdout 순수\n`,
);
