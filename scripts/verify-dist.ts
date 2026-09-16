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
import { readFile, readdir, mkdtemp, symlink, stat, chmod } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanFiles } from './shipping-checks.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
	JSONRPCMessageSchema,
	InitializeResultSchema,
	ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { SERVER_NAME, CHROME_TOOLS } from '../src/index.ts';

const ROOT = new URL('../', import.meta.url);
const ENTRY = new URL('dist/index.js', ROOT);

/** 핸드셰이크 뒤에도 얼마간 지켜본다. 지연 오염·조기 종료는 그 뒤에 온다. */
const WATCH_MS = 2_000;

/**
 * 무슨 일이 있어도 여기서 끝낸다.
 *
 * ⚠️ 한때 감시창을 확보하려고 `hardTimer.refresh()` 를 호출했다. 그런데 그건
 *   **stdout 이 올 때마다** 불렸다. 유효한 JSON-RPC 알림을 300ms 마다 뱉는 서버를
 *   넣어보니 관문이 **끝나지 않았다**(120초에 손으로 끊음). 발행이 멈추는 게 아니라
 *   그냥 매달린다 — 실패보다 나쁘다.
 *   그래서 **절대 시한은 절대 연장하지 않는다.** 감시창도 한 번만 건다.
 *
 * ⚠️ 이 시한은 **handshake 한 번**에만 걸린다(관문 전체가 아니다). 뒤의 SDK 탐침은
 *   SDK 의 요청별 timeout(기본 60초)이 각각 지킨다. 전부 실패 방향(발행을 막음)이라
 *   잘못된 발행을 허용하는 구멍은 아니다 — 10차에서 확인.
 */
const DEADLINE_MS = 45_000;

/** 기본 등록 도구 수. 프로필 게이트를 켜면 늘어난다. */
const MIN_TOOLS = 21;

interface Outcome {
	readonly responses: Array<Record<string, unknown>>;
	readonly junk: string[];
	readonly stderr: string;
	/** 지켜보는 동안 스스로 죽었나. 죽었으면 그 코드/시그널. */
	readonly died: string | null;
}

async function handshake(
	binLink: string,
	extraEnv: Record<string, string> = {},
): Promise<Outcome> {
	// ★★ **npm 이 실제로 쓰는 모양 그대로 띄운다 — 링크를 '직접 실행'한다.**
	//
	//   `npx`·`npm i -g` 는 `node_modules/.bin/velog-mcp` 링크를 만들고 대상에
	//   **실행 권한을 붙인 뒤**, 그 링크를 **직접 실행**한다. 그러면 커널이
	//   **shebang** 을 읽어 node 를 띄운다.
	//
	//   ⚠️ 한때 `spawn(process.execPath, [link])` 로 열었다. 그건 node 를 우리가
	//      직접 부르는 것이라 **shebang 을 안 탄다** — 즉 `#!/usr/bin/env node` 를
	//      지워도 관문이 통과한다. 실제 `npx` 는 그때 기동에 실패한다.
	//      실측: tarball 안 `dist/index.js` 는 `-rw-r--r--` 이고, 실행 권한은
	//      npm 이 **설치할 때** 붙인다. 그래서 여기서도 붙여 재현한다.
	// spawn 자체가 던질 수 있다 — shebang 이 없거나 실행 권한이 없으면 `ENOEXEC`.
	// 그냥 두면 스택 트레이스로 터진다. 막기는 하지만 **왜** 막혔는지는 안 알려준다.
	let child;
	try {
		child = spawn(binLink, [], {
		stdio: ['pipe', 'pipe', 'pipe'],
			// 토큰 없이 띄운다. 발행 검증이 실제 계정을 건드릴 이유가 없다.
			env: {
				PATH: process.env['PATH'] ?? '',
				HOME: process.env['HOME'] ?? '',
				...extraEnv,
			},
		});
	} catch (error: unknown) {
		const code = (error as { code?: string }).code ?? '';
		fail(
			`npm 방식(링크 직접 실행)으로 띄우지 못했습니다 — ${code || String(error)}\n` +
				'   `dist/index.js` 첫 줄의 `#!/usr/bin/env node` 가 있는지, 실행 권한이 붙는지 보세요.\n' +
				'   이 상태로 발행하면 `npx` 가 서버를 못 띄웁니다.',
		);
	}

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

		let hardTimer = setTimeout(finish, DEADLINE_MS);
		let watchTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
		let watching = false;

		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) continue;
				// ⚠️ 두 번 약했다.
				//    ① JSON 이면 무조건 MCP 응답으로 인정 → JSON 로거 한 줄이 섞여도
				//       "stdout 순수"라고 판정했다.
				//    ② 그다음엔 `jsonrpc:'2.0'` + id/method 만 봤다. 그것도 부족했다 —
				//       `{"jsonrpc":"2.0","id":999,"level":"debug"}` 는 그 검사를 통과하지만
				//       **SDK 의 `deserializeMessage()` 는 거부한다**(실측). 실제 클라이언트는
				//       파싱 오류로 연결을 끊는다.
				//    그래서 **SDK 가 쓰는 바로 그 스키마**로 판정한다. 우리가 흉내 낼 이유가 없다.
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					parsed = undefined;
				}
				if (parsed !== undefined && JSONRPCMessageSchema.safeParse(parsed).success) {
					responses.push(parsed as Record<string, unknown>);
				} else {
					junk.push(line);
				}
			}
			// 응답을 다 받아도 **바로 죽이지 않는다.** 지연 stdout 과 조기 종료를
			// 보려면 잠깐 살려둬야 한다 — 즉시 죽이면 둘 다 못 본다(코덱스 지적).
			// 감시창은 **한 번만** 건다. 매 청크마다 다시 걸면 수다스러운 서버에서
			// 영원히 안 끝난다(실측으로 그렇게 만들었다가 고쳤다).
			if (responses.length >= 2 && !watching) {
				watching = true;
				clearTimeout(watchTimer);
				// 응답이 시한 직전에 오면 감시창이 잘려 "2초 지켜봤다"가 거짓이 된다.
				// **딱 한 번만** 시한을 밀어 감시창을 확보한다 — 무한 연장이 아니다.
				clearTimeout(hardTimer);
				hardTimer = setTimeout(finish, WATCH_MS + 1_000);
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

/** 스키마 오류는 개수가 많다. 앞 세 개만 보이고 나머지는 세어서 말한다. */
function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
	const head = issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`);
	const rest = issues.length - head.length;
	return head.join(' / ') + (rest > 0 ? ` (외 ${rest}건)` : '');
}

/** 자식 프로세스를 끝까지 돌리고 결과를 모은다. 발행물 기동 검사에서만 쓴다. */
async function run(
	command: string,
	args: readonly string[],
	cwd: string,
	timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		// ★ 서버는 stdio 를 잡고 계속 산다. 기동만 보면 되므로 시간을 정해 끊는다.
		//   끊어서 죽인 것과 스스로 죽은 것을 가르려고 killed 를 따로 본다.
		const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
		child.on('close', (code, signal) => {
			clearTimeout(timer);
			// SIGTERM 으로 우리가 끊었으면 '살아 있었다' 는 뜻이라 성공으로 본다.
			resolve({ code: signal === 'SIGTERM' ? 0 : (code ?? 1), stdout, stderr });
		});
		child.on('error', (error) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: stderr + String(error) });
		});
	});
}

function fail(message: string): never {
	process.stderr.write(`\n❌ 발행 중단 — ${message}\n`);
	// ⚠️ exit 1 은 node 크래시(구문 오류·미처리 예외)와 구분이 안 된다 — 관문 변이
	//    검증이 "검사가 잡았다"와 "관문이 죽었다"를 가르려면 코드가 달라야 한다.
	process.exit(2);
}

const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as {
	name: string;
	version: string;
	files?: string[];
};

/**
 * npm 이 만드는 것과 같은 모양의 링크를 임시로 만든다.
 * 이걸 안 하면 "링크에서만 죽는" 버그를 관문이 영원히 못 본다.
 */
const linkDir = await mkdtemp(join(tmpdir(), 'velog-mcp-verify-'));
const binLink = join(linkDir, 'velog-mcp');
// ⚠️ 한때 여기서 `chmod(ENTRY, 0o755)` 를 했다. 그러면 **검증이 검증 대상을 바꾼다** —
//    실측으로 tarball 안 모드가 `-rw-r--r--` 에서 `-rwxr-xr-x` 로 달라졌다.
//    실행 권한은 `postbuild` 가 붙인다. 관문은 **확인만** 한다.
const entryMode = (await stat(fileURLToPath(ENTRY))).mode;
if ((entryMode & 0o111) === 0) {
	fail(
		`dist/index.js 에 실행 권한이 없습니다(${(entryMode & 0o777).toString(8)}).\n` +
			'   `bin` 은 실행 파일입니다 — `npm run build` 의 postbuild 가 붙입니다.',
	);
}
await symlink(fileURLToPath(ENTRY), binLink);

// ⚠️ 한때 여기서 바로 지웠는데, 아래 **실제 클라이언트 연결**도 이 링크를 쓴다.
//    그래서 그 검사가 `ENOENT` 로 죽었다. 링크는 둘 다 끝난 뒤에 지운다.
//    프로세스가 어떻게 끝나든 치우도록 종료 훅에도 건다.
const cleanupLink = (): void => {
	rmSync(linkDir, { recursive: true, force: true });
};
process.on('exit', cleanupLink);

const { responses, junk, stderr, died } = await handshake(binLink);

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

// ⚠️ `JSONRPCMessageSchema` 는 **전송 외피만** 본다. 실제 SDK 클라이언트는 그 위에
//    결과 스키마를 한 번 더 적용한다 — `protocolVersion`·`capabilities` 가 없거나
//    도구에 `inputSchema` 가 없어도 외피 검사는 통과한다(실측).
//    그러면 관문은 통과하는데 진짜 클라이언트가 초기화에서 연결을 거부한다.
//    **클라이언트가 쓰는 그 스키마를 그대로 쓴다.**
const initResult = InitializeResultSchema.safeParse(init['result']);
if (!initResult.success) {
	fail(
		`initialize 응답이 MCP 규격에 안 맞습니다 — 실제 클라이언트는 연결을 거부합니다.\n` +
			`   ${describeIssues(initResult.error.issues)}`,
	);
}

const info = initResult.data.serverInfo;
if (info.name !== SERVER_NAME) {
	fail(`서버 이름이 ${info.name} 입니다. ${SERVER_NAME} 이어야 합니다.`);
}
if (info.version !== pkg.version) {
	fail(
		`빌드 산출물이 낡았습니다 — dist 는 ${info.version}, package.json 은 ${pkg.version}.\n` +
			'   `npm run build` 를 다시 도세요.',
	);
}

const list = responses.find((r) => r['id'] === 2);
const listResult = ListToolsResultSchema.safeParse(list?.['result']);
if (!listResult.success) {
	fail(
		`tools/list 응답이 MCP 규격에 안 맞습니다 — 도구에 inputSchema 가 빠졌을 수 있습니다.\n` +
			`   ${describeIssues(listResult.error.issues)}`,
	);
}

const tools = listResult.data.tools;
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

// ★★ 손으로 나열하면 `files` 에 새 파일을 추가할 때마다 여기가 조용히 뒤처진다.
//   실제로 CHANGELOG.md 를 넣었을 때 npm 은 107개를 싣는데 이 검사는 106개만 봤다.
//   검사에서 빠진 파일은 **개인정보 검사를 안 받고 나간다.** 그래서 package.json 의
//   `files` 에서 읽고, npm 이 항상 싣는 것들을 더한다.
//
//   ⚠️ 그래놓고 디렉터리는 `dist`·`docs` 로 **하드코딩돼 있었다.** 2026-09-14 에
//   `schema` 를 더했을 때 이 자리가 그대로 뒤처졌다. 같은 실수라 아예 없앤다 —
//   `files` 의 각 항목이 디렉터리면 훑고, 파일이면 그대로 담는다.
// ★★ **npm 에게 직접 묻는다.** 우리가 `files` 를 해석하지 않는다.
//
//   한때 여기서 `files` 를 훑었다. 그러다 세 번 갈라졌다 —
//   ① 손으로 나열해서 CHANGELOG.md 를 빠뜨렸고(107개 중 106개만 검사),
//   ② 디렉터리를 `dist`·`docs` 로 하드코딩해서 `schema` 를 빠뜨렸고,
//   ③ `!dist/**/*.map` 같은 **부정 패턴을 통째로 무시**해서(`entry.includes('/')` 에서
//      continue) 실제로는 84개가 나가는데 관문은 117개를 봤다.
//   검사에서 빠진 파일은 **개인정보 검사를 안 받고 나간다.** 그게 이 블록의 존재 이유다.
//
//   `npm pack --dry-run --json` 이 곧 정답이다. 우리가 규칙을 다시 구현하는 순간
//   또 어긋난다.
const packList = await run('npm', ['pack', '--dry-run', '--json'], fileURLToPath(ROOT));
if (packList.code !== 0) fail(`npm pack --dry-run 이 실패했습니다:\n${packList.stderr}`);
let packEntries: Array<{ path: string }>;
try {
	const parsed = JSON.parse(packList.stdout) as Array<{ files?: Array<{ path: string }> }>;
	packEntries = parsed[0]?.files ?? [];
} catch (cause) {
	fail(`npm pack --dry-run 의 JSON 을 읽지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
	packEntries = [];
}
if (packEntries.length === 0) fail('npm 이 싣는 파일 목록이 비었습니다.');
const shipped: Array<[string, URL]> = packEntries.map((f) => [f.path, new URL(f.path, ROOT)]);

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

// ★★ `files` 가 `schema` 를 **통째로** 싣는다. 그 안에 기준선 말고 다른 것이 들어가면
//    그대로 발행된다. 생성기가 만드는 검사용 임시 파일이 실제로 여기에 있었다
//    (코덱스 13차: 예외·동시 실행 때 남고, `npm-packlist` 가 집어 갔다).
//    그래서 «무엇이 실렸나» 를 이름으로 못 박는다 — 새 파일을 넣으려면 여기도 고쳐야 한다.
const SCHEMA_ALLOWED = new Set(['schema/baseline.json']);
const strays = shipped
	.map(([label]) => label)
	.filter((label) => label === 'schema' || label.startsWith('schema/'))
	.filter((label) => !SCHEMA_ALLOWED.has(label));
if (strays.length > 0) {
	fail(
		`발행물의 schema/ 에 실리면 안 되는 것이 있습니다(${strays.length}개): ${strays.join(', ')}\n` +
			'   임시 파일이 남았거나, 새 파일을 추가하고 verify-dist 의 SCHEMA_ALLOWED 를 안 고쳤습니다.',
	);
}

// ── ★ 마지막으로 **진짜 SDK 클라이언트**로 붙어본다 ──────────────────────
//
// 여기까지의 검사는 우리가 프로토콜을 흉내 낸 것이다. 그러다 두 번 데였다:
//   6차 — `jsonrpc:'2.0'` + id/method 만 봤더니 SDK 가 거부하는 JSON 을 통과시켰다
//   7차 — 외피 스키마만 봤더니 `inputSchema` 가 빠진 도구를 통과시켰다
//   8차 — 결과 스키마도 `protocolVersion` **값**은 안 본다. SDK 클라이언트는
//         `SUPPORTED_PROTOCOL_VERSIONS` 포함 여부를 따로 검사한다.
//
// 흉내를 정교하게 만드는 건 끝이 없다. **진짜 클라이언트를 한 번 붙여보는 게**
// 그 부류 전체를 닫는다. 위의 raw 검사는 stdout 순도·생존처럼 클라이언트가
// 안 보여주는 것을 위해 남긴다.

/** 키 순서에 흔들리지 않게 정렬해서 찍는다 — 스키마 비교용. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

async function toolsVia(
	label: string,
	command: string,
	args: string[],
	extraEnv: Record<string, string>,
): Promise<Array<{ name: string; snapshot: string }>> {
	const probe = new Client({ name: 'verify-dist', version: '0' });
	try {
		await probe.connect(
			new StdioClientTransport({
				command,
				args,
				env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...extraEnv },
				stderr: 'ignore',
			}),
		);
	} catch (error: unknown) {
		fail(
			`실제 MCP 클라이언트가 ${label} 에 붙지 못했습니다 — ${error instanceof Error ? error.message : String(error)}\n` +
				'   우리 검사는 통과했는데 진짜 클라이언트가 거부했다면, 흉내가 부족한 것입니다.',
		);
	}
	const listed = await probe.listTools().catch((error: unknown) => {
		fail(`실제 클라이언트가 ${label} 의 도구 목록을 못 받았습니다 — ${String(error)}`);
	});
	await probe.close().catch(() => undefined);
	return listed.tools
		.map((tool) => ({ name: tool.name, snapshot: canonical(tool) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ── dist 가 소스와 같은지 — **이름만이 아니라 스키마까지, 조건부 분기까지** ──
//
// ⚠️ 두 번 좁았다.
//    ① 개수와 크롬 도구 두 이름만 봤더니 `velog_list_posts` → `velog_list_postz` 로
//       바꿔도 통과했다(8차 반례). → 소스를 직접 띄워 이름을 대조한다.
//    ② 기본 분기만 봤더니 `VELOG_ALLOW_PROFILE=1` 에서만 등록되는 5개 도구와
//       `VELOG_ALLOW_PUBLIC=1` 에서 달라지는 `is_private` 스키마는 아무도 안
//       봤다(9차 반례 — 그 산출물이 깨져도 관문이 통과한다). → **옵션을 켠 모드도
//       똑같이 대조한다.** 이름 집합만이 아니라 도구 스냅샷(스키마 포함) 전체를 본다.
//    ③ {0,0}·{1,1} 두 조합만 봤더니, dist 가 조건을 `PUBLIC` 대신 `PROFILE || PUBLIC`
//       으로 잘못 계산해도 두 조합에서는 소스와 같아 통과한다(9차 반영 검토 반례).
//       독립 플래그는 **네 조합 전부** 돈다.
const sourceEntry = fileURLToPath(new URL('src/index.ts', ROOT));
const OPTION_MODES: ReadonlyArray<[string, Record<string, string>]> = [
	['프로필만', { VELOG_ALLOW_PROFILE: '1' }],
	['공개만', { VELOG_ALLOW_PUBLIC: '1' }],
	['모든 옵션', { VELOG_ALLOW_PROFILE: '1', VELOG_ALLOW_PUBLIC: '1' }],
];
const MODES: ReadonlyArray<[string, Record<string, string>]> = [
	['기본', {}],
	...OPTION_MODES,
];
for (const [mode, extraEnv] of MODES) {
	// 조건부 분기에서만 터지는 stdout 오염·조기 종료는 기본 모드 검사가 못 본다
	// (10차 반례 — SDK 탐침은 listTools 직후 닫혀 지연 오염을 놓친다).
	// 옵션 모드에서도 raw handshake 로 순도·생존을 본다.
	if (mode !== '기본') {
		const opt = await handshake(binLink, extraEnv);
		if (opt.died) {
			fail(`[${mode}] dist 가 스스로 종료했습니다(${opt.died}).\n   stderr: ${opt.stderr.trim()}`);
		}
		if (opt.junk.length > 0) {
			fail(
				`[${mode}] dist 가 stdout 에 프로토콜 아닌 줄을 냈습니다(${opt.junk.length}줄).\n` +
					`   첫 줄: ${opt.junk[0] ?? ''}`,
			);
		}
	}
	const distTools = await toolsVia(`dist(${mode})`, binLink, [], extraEnv);
	const srcTools = await toolsVia(`소스(${mode})`, process.execPath, [sourceEntry], extraEnv);
	// 개수 대조는 실제 클라이언트 다리의 일부다 — 루프 밖에 두면, 관문 변이가
	// 루프를 비웠을 때 이 검사만 남아 "정상 dist 도 막는 깨진 변이 관문"이 된다.
	if (mode === '기본' && distTools.length !== tools.length) {
		fail(`도구 수가 다릅니다 — raw ${tools.length}개, 실제 클라이언트 ${distTools.length}개.`);
	}

	const distNames = distTools.map((tool) => tool.name);
	const srcNames = srcTools.map((tool) => tool.name);
	if (JSON.stringify(distNames) !== JSON.stringify(srcNames)) {
		const onlyDist = distNames.filter((n) => !srcNames.includes(n));
		const onlySource = srcNames.filter((n) => !distNames.includes(n));
		fail(
			`[${mode}] dist 의 도구 이름이 소스와 다릅니다 — 빌드 산출물이 소스를 반영하지 않았습니다.\n` +
				`   dist 에만: ${onlyDist.join(', ') || '(없음)'}\n` +
				`   소스에만: ${onlySource.join(', ') || '(없음)'}`,
		);
	}
	const drifted = distTools.filter(
		(tool, i) => tool.snapshot !== (srcTools[i]?.snapshot ?? ''),
	);
	if (drifted.length > 0) {
		fail(
			`[${mode}] dist 도구의 스키마·설명이 소스와 다릅니다(${drifted.length}개): ` +
				`${drifted.map((t) => t.name).join(', ')}\n   빌드 산출물이 낡았거나 손이 탔습니다.`,
		);
	}
}
cleanupLink();

// ★★ 여기까지는 전부 **저장소 안에서** 돈다. 그래서 `files` 에 빠진 파일이 있어도
//   로컬에 그 파일이 있으면 통과한다 — 거짓 초록이다.
//
//   2026-09-14 실측: `dist/drift.js` 가 `../schema/baseline.json` 을 import 하는데
//   `files` 에 `schema` 가 없었다. 위 검사는 전부 통과했고 발행했으면 설치본이
//   `ERR_MODULE_NOT_FOUND` 로 죽었다. 대조군(저장소에서 실행)은 멀쩡했다.
//
//   그래서 **npm 이 실제로 싣는 것만** 풀어서 띄워 본다. 의존성은 설치하지 않고
//   링크만 걸어 준다 — 우리가 보려는 건 우리 파일이 다 실렸는지이지 npm install 이 아니다.
{
	const packDir = await mkdtemp(join(tmpdir(), 'velog-mcp-pack-'));
	try {
		const packed = await run('npm', ['pack', '--pack-destination', packDir], fileURLToPath(ROOT));
		if (packed.code !== 0) fail(`npm pack 실패:\n${packed.stderr}`);
		const [tgz] = (await readdir(packDir)).filter((f) => f.endsWith('.tgz'));
		if (!tgz) fail('npm pack 이 tarball 을 만들지 않았습니다.');
		const untar = await run('tar', ['xzf', join(packDir, tgz), '-C', packDir], packDir);
		if (untar.code !== 0) fail(`tarball 을 풀지 못했습니다:\n${untar.stderr}`);

		const pkgRoot = join(packDir, 'package');
		await symlink(fileURLToPath(new URL('node_modules', ROOT)), join(pkgRoot, 'node_modules'));

		// ★★ «죽지 않았다» 로는 부족하다. 조용히 exit(0) 하는 패키지도 통과한다
		//   (코덱스가 변이로 증명: guardExit=0 인데 실제 MCP 는 Connection closed).
		//   그래서 **핸드셰이크를 실제로 주고받는다.** 위의 handshake() 와 같은 규율이다.
		const packedEntry = join(pkgRoot, 'dist', 'index.js');
		await chmod(packedEntry, 0o755);
		const packedLink = join(packDir, 'velog-mcp');
		await symlink(packedEntry, packedLink);
		const packedOutcome = await handshake(packedLink);
		if (packedOutcome.died !== null) {
			fail(
				`발행물만 풀어서 띄우니 스스로 끝났습니다 (${packedOutcome.died}).\n` +
					'   `files` 에 빠진 파일이 있는지 보세요.\n' +
					`   ${packedOutcome.stderr.split('\n').slice(0, 6).join('\n   ')}`,
			);
		}
		// ★★ 발행물에도 저장소와 **같은 잣대**를 댄다. 한때 여기서는 «죽었나 · 도구가
		//   몇 개인가» 만 봤는데, 그러면 설치본만 stdout 을 더럽히거나 initialize 를
		//   오류로 돌려줘도 통과한다(코덱스 9차가 응답을 주입해 증명). 설치본에서만
		//   깨지는 것을 잡는 게 이 블록의 존재 이유인데 그물이 저장소 쪽보다 성겼다.
		if (packedOutcome.junk.length > 0) {
			fail(
				`발행물이 stdout 에 프로토콜 아닌 줄을 냈습니다(${packedOutcome.junk.length}줄).\n` +
					`   첫 줄: ${packedOutcome.junk[0] ?? ''}`,
			);
		}
		const packedInit = packedOutcome.responses.find((r) => r['id'] === 1);
		const initResult = packedInit?.['result'] as
			| { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } }
			| undefined;
		if (!packedInit || packedInit['error'] !== undefined || !initResult) {
			fail(
				'발행물이 initialize 에 정상 응답하지 않습니다 — 설치본은 연결 자체가 안 됩니다.\n' +
					`   ${JSON.stringify(packedInit ?? null).slice(0, 300)}`,
			);
		}
		if (typeof initResult?.protocolVersion !== 'string' || typeof initResult?.serverInfo?.name !== 'string') {
			fail(
				'발행물의 initialize 응답에 protocolVersion·serverInfo 가 없습니다.\n' +
					`   ${JSON.stringify(initResult ?? null).slice(0, 300)}`,
			);
		}
		// ★ «문자열이냐» 로는 부족하다. 이름·버전이 딴것이어도 연결은 되고 도구도 같다
		//   (코덱스 10차가 serverInfo 를 바꿔 증명). 저장소 쪽에 있는 잣대를 여기도 댄다.
		if (initResult?.serverInfo?.name !== SERVER_NAME) {
			fail(
				`발행물이 자기를 '${initResult?.serverInfo?.name ?? '(없음)'}' 라고 합니다 — '${SERVER_NAME}' 이어야 합니다.`,
			);
		}
		if (initResult?.serverInfo?.version !== pkg.version) {
			fail(
				`발행물의 서버 버전이 ${String(initResult?.serverInfo?.version)} 입니다 — package.json 은 ${pkg.version} 입니다.`,
			);
		}
		const packedTools = packedOutcome.responses.find(
			(r) => r['id'] === 2 && typeof r['result'] === 'object',
		);
		if (!packedTools) {
			fail(
				'발행물이 MCP 핸드셰이크에 응답하지 않습니다 — 설치본은 도구가 하나도 없습니다.\n' +
					`   ${packedOutcome.stderr.split('\n').slice(0, 6).join('\n   ')}`,
			);
		}
		const packedNames = (
			(packedTools['result'] as { tools?: Array<{ name: string }> }).tools ?? []
		).map((tool) => tool.name);
		if (packedNames.length < MIN_TOOLS) {
			fail(
				`발행물의 도구가 ${packedNames.length}개뿐입니다 (최소 ${MIN_TOOLS}개).\n` +
					'   저장소에서는 되는데 발행물에서 안 되는 것이 있습니다.',
			);
		}

		// ★★ raw 핸드셰이크는 «줄을 주고받았다» 까지다. 실제 SDK 클라이언트로 붙어
		//   도구 목록과 스키마가 소스와 **같은지**까지 본다 — 저장소 쪽에 이미 있는
		//   잣대이고, 설치본에만 없을 이유가 없다.
		const packedViaSdk = await toolsVia('발행물', packedLink, [], {});
		const sourceViaSdk = await toolsVia('소스(발행물 대조)', process.execPath, [sourceEntry], {});
		const packedSdkNames = packedViaSdk.map((t) => t.name).sort();
		const sourceSdkNames = sourceViaSdk.map((t) => t.name).sort();
		if (JSON.stringify(packedSdkNames) !== JSON.stringify(sourceSdkNames)) {
			const onlyPacked = packedSdkNames.filter((n) => !sourceSdkNames.includes(n));
			const onlySource = sourceSdkNames.filter((n) => !packedSdkNames.includes(n));
			fail(
				'발행물의 도구 목록이 소스와 다릅니다.\n' +
					`   발행물에만: ${onlyPacked.join(', ') || '(없음)'}\n` +
					`   소스에만: ${onlySource.join(', ') || '(없음)'}`,
			);
		}
		// 이름이 같아도 스키마·설명이 다르면 설치본만 다르게 동작한다.
		const sourceSnapshots = new Map(sourceViaSdk.map((t) => [t.name, t.snapshot]));
		const snapshotDrift = packedViaSdk.filter((t) => sourceSnapshots.get(t.name) !== t.snapshot);
		if (snapshotDrift.length > 0) {
			fail(
				`발행물 도구의 스키마·설명이 소스와 다릅니다(${snapshotDrift.length}개): ` +
					snapshotDrift.map((t) => t.name).join(', '),
			);
		}

		// ★★ 플래그 조합도 발행물에서 본다. 저장소에서는 네 조합을 다 보는데 설치본은
		//   기본 모드만 봤다 — `VELOG_ALLOW_PROFILE=1` 에서만 깨지는 것을 놓친다
		//   (코덱스 11차가 분기 하네스로 증명). 조합마다 순도·생존·도구 목록을 본다.
		for (const [mode, extraEnv] of OPTION_MODES) {
			const optOutcome = await handshake(packedLink, extraEnv);
			if (optOutcome.died !== null) {
				fail(`[발행물·${mode}] 설치본이 스스로 끝났습니다 (${optOutcome.died}).\n   ${optOutcome.stderr.split('\n').slice(0, 4).join('\n   ')}`);
			}
			if (optOutcome.junk.length > 0) {
				fail(`[발행물·${mode}] stdout 에 프로토콜 아닌 줄을 냈습니다(${optOutcome.junk.length}줄).\n   첫 줄: ${optOutcome.junk[0] ?? ''}`);
			}
			const optPacked = await toolsVia(`발행물(${mode})`, packedLink, [], extraEnv);
			const optSource = await toolsVia(`소스(${mode}·발행물 대조)`, process.execPath, [sourceEntry], extraEnv);
			const packedSorted = optPacked.map((t) => t.name).sort();
			const sourceSorted = optSource.map((t) => t.name).sort();
			if (JSON.stringify(packedSorted) !== JSON.stringify(sourceSorted)) {
				fail(
					`[발행물·${mode}] 도구 목록이 소스와 다릅니다.\n` +
						`   발행물에만: ${packedSorted.filter((n) => !sourceSorted.includes(n)).join(', ') || '(없음)'}\n` +
						`   소스에만: ${sourceSorted.filter((n) => !packedSorted.includes(n)).join(', ') || '(없음)'}`,
				);
			}
			const optSnapshots = new Map(optSource.map((t) => [t.name, t.snapshot]));
			const optDrift = optPacked.filter((t) => optSnapshots.get(t.name) !== t.snapshot);
			if (optDrift.length > 0) {
				fail(`[발행물·${mode}] 도구 스키마가 소스와 다릅니다: ${optDrift.map((t) => t.name).join(', ')}`);
			}
		}

		// ★★ 기동만 보면 부족하다. 2026-09-14 에 «기준선이 깨져도 서버는 산다» 로 바꾸면서
		//   이 관문이 **무력해졌다** — `files` 에서 schema 를 빼도 도구 23개가 그대로 떠서
		//   조용히 통과했다(코덱스 5차가 변이로 증명). 안 죽는 쪽으로 고치면 «안 죽는지»
		//   보는 검사도 같이 약해진다. 그래서 **기능이 실제로 동작하는지**를 본다.
		//
		//   ⚠️ 한때 stderr 문구(`스키마 자가진단이 꺼졌습니다`)로 검사했는데, 그건 문구가
		//   바뀌면 조용히 무력해진다. 대신 **소스가 실제로 읽는 경로**를 확인한다.
		//   경로가 바뀌면 여기가 못 찾아 실패하므로 결합이 드러난다.
		const baselineRelative = (await readFile(new URL('src/drift.ts', ROOT), 'utf8')).match(
			/new URL\('([^']+\.json)', import\.meta\.url\)/,
		)?.[1];
		if (!baselineRelative) {
			fail(
				'src/drift.ts 에서 기준선 경로를 찾지 못했습니다.\n' +
					'   기준선을 읽는 방식이 바뀌었다면 이 검사도 함께 고치세요.',
			);
		}
		// dist/drift.js 기준의 상대 경로다. 발행물에서 같은 자리를 본다.
		const packedBaseline = new URL(baselineRelative, pathToFileURL(join(pkgRoot, 'dist', 'drift.js')));
		const baselineOk = await stat(fileURLToPath(packedBaseline))
			.then((s) => s.isFile() && s.size > 0)
			.catch(() => false);
		if (!baselineOk) {
			fail(
				`발행물에 기준선 파일이 없습니다 — ${baselineRelative}\n` +
					'   `velog_diagnose` 와 오류 진단이 통째로 꺼진 채 발행됩니다.\n' +
					'   `package.json` 의 `files` 에 `schema` 가 있는지 보세요.',
			);
		}
		// 그리고 실제로 꺼지지 않았는지도 본다 (파일은 있는데 모양이 틀린 경우).
		if (packedOutcome.stderr.includes('스키마 자가진단이 꺼졌습니다')) {
			fail(
				'발행물에서 스키마 자가진단이 꺼져 있습니다.\n' +
					`   ${packedOutcome.stderr.split('\n').find((l) => l.includes('자가진단')) ?? ''}`,
			);
		}
	} finally {
		rmSync(packDir, { recursive: true, force: true });
	}
}

process.stdout.write(
	`✅ dist 검증 통과 — ${pkg.name}@${pkg.version} · 도구 ${tools.length}개 · ` +
		`stdout 순수 · ${String(WATCH_MS / 1000)}초 생존 · **실제 SDK 클라이언트 연결 OK** · ` +
		`소스와 도구 스냅샷 일치(플래그 4조합) · 발행물 ${shipped.length}개 개인정보 0건\n`,
);
