/**
 * 플러그인 포장 불변식 — 설치 경로에서만 생기는 실패를 고정한다.
 *
 * 이 파일이 지키는 것은 하나다: **설치한 사람이 조용히 틀린 상태로 쓰지 않는다.**
 *
 * 플러그인은 값을 사용자에게 묻고 `${user_config.KEY}` 자리에 끼워 넣는다.
 * 안 채운 값은 **빈 문자열로** 온다(실측 — plugin-env.ts 머리말의 표).
 * 빈 값을 '없음'으로 굳히는 것이 P1~P4, 그게 진짜 기동 경로에 붙어 있는지가
 * P13~P14, 배포물끼리 어긋나지 않는 것이 P6~P12 다.
 *
 * 왜 정합성까지 테스트로 묶나 — 이 배포물은 손으로 맞춰야 할 곳이 많다.
 * 버전이 네 군데, userConfig 키가 두 파일에 나뉘어 있다. 하나만 어긋나도
 * 증상이 먼 곳에서 나타난다. **특히 P6** — `.mcp.json` 이 선언되지 않은 설정 키를
 * 참조하면 Claude Code 가 그 MCP 서버를 **아무 말 없이 안 띄운다**(실측).
 * 오타 하나가 "플러그인은 깔렸는데 도구가 하나도 없음"이 된다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { satisfies, minVersion } from 'semver';

import {
	looksUnsubstituted,
	isBlank,
	normalizePluginEnv,
	describeAnomalies,
} from '../plugin-env.ts';
import { readAuthFromEnv } from '../auth.ts';
import { readCapabilities } from '../capabilities.ts';
import { findChrome, resetChromeCache } from '../render/chrome.ts';
import { SERVER_VERSION, CHROME_TOOLS } from '../index.ts';
import {
	findPersonalEmails,
	findLeaks,
	LOCAL_PATH_PATTERNS,
	scanFiles,
} from '../../scripts/shipping-checks.ts';

const execFile = promisify(execFileCb);

const ROOT = new URL('../../', import.meta.url);
const PLUGIN = new URL('plugins/velog/', ROOT);

async function json(url: URL): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(url, 'utf8')) as Record<string, unknown>;
}

/**
 * 진짜 JSON-RPC 를 던지고 응답을 받는다.
 *
 * ★ 왜 필요한가 — `server.connect()` 를 통째로 지워도 기동 로그는 먼저 나온다.
 *   즉 로그만 보는 테스트는 "말은 하는데 서버가 아닌" 상태를 못 잡는다.
 *
 * ★ 프로토콜 밖의 줄도 모은다(`junk`)
 *   stdout 은 MCP 전용이다. 여기에 `console.log` 한 줄만 섞여도 클라이언트가
 *   프레이밍을 잃는다. 처음엔 파싱 실패한 줄을 조용히 버렸는데, 그러면
 *   기동 경로에 디버그 출력을 넣어도 테스트가 통과한다. 버리지 않고 돌려준다.
 */
async function rpc(
	requests: readonly Record<string, unknown>[],
	env: NodeJS.ProcessEnv = {},
	/** 기본은 실제 소스 경로. P25 는 **심볼릭 링크**를 넘겨 npm 방식을 흉내낸다. */
	entryOverride?: string,
): Promise<{ responses: Array<Record<string, unknown>>; junk: string[] }> {
	const entry = entryOverride ?? fileURLToPath(new URL('index.ts', new URL('../', import.meta.url)));
	const child = spawn(process.execPath, [entry], {
		stdio: ['pipe', 'pipe', 'ignore'],
		env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
	});

	for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

	// 알림(`id` 없음)에는 응답이 오지 않는다. 요청 수로 세면 영원히 안 차서
	// 매번 제한시간을 다 쓴다 — 실제로 그렇게 만들었다가 15초씩 걸렸다.
	const expected = requests.filter((request) => 'id' in request).length;

	let buffer = '';
	const responses: Array<Record<string, unknown>> = [];
	const junk: string[] = [];
	return await new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			child.kill('SIGKILL');
			resolve({ responses, junk });
		};
		const timer = setTimeout(done, 15_000);
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
			if (responses.length >= expected) done();
		});
		child.on('error', done);
		child.on('close', done);
	});
}

/** 서버에 직접 물어본 도구 목록. 문서의 숫자가 아니라 실물이다. */
async function rpcTools(): Promise<Array<{ name: string }>> {
	const { responses } = await rpc([
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'plugin-test', version: '0' },
			},
		},
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	]);
	const list = responses.find((r) => r['id'] === 2);
	return ((list?.['result'] as { tools?: Array<{ name: string }> })?.tools ?? []);
}

/**
 * git 이 추적하는 파일 목록 = **사용자 기계로 클론되는 것 전부.**
 *
 * 직접 디렉터리를 훑으면 `.gitignore` 대상까지 섞이고, 목록을 손으로 적으면
 * 새 파일이 생길 때마다 빠진다. git 에게 묻는 게 정확하다.
 */
async function trackedFiles(cwd: string): Promise<string[]> {
	const { stdout } = await execFile('git', ['ls-files'], { cwd, maxBuffer: 4 * 1024 * 1024 });
	// ⚠️ 확장자로 거르면 `LICENSE`·`.gitignore` 같은 확장자 없는 파일을 통째로 놓친다.
	//    실제로 64개 중 62개만 보고 있었다. 전부 받고 바이너리만 나중에 건너뛴다.
	const candidates = stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	// 인덱스에는 남아 있지만 작업 트리에서 지워진 파일이 있을 수 있다
	// (예: `npm shrinkwrap` 이 package-lock.json 을 없앤 직후). 그건 배포되지 않는다.
	const present = await Promise.all(
		candidates.map(async (relative) =>
			access(new URL(relative, ROOT), constants.R_OK).then(
				() => relative,
				() => null,
			),
		),
	);
	return present.filter((value): value is string => value !== null);
}

/** `src/` 전체를 훑는다. 소비 지점을 하나라도 빠뜨리면 P15 가 헛돈다. */
async function readAllSources(dir: URL): Promise<Array<[string, string]>> {
	const out: Array<[string, string]> = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__') continue;
		const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
		if (entry.isDirectory()) out.push(...(await readAllSources(url)));
		else if (entry.name.endsWith('.ts')) out.push([entry.name, await readFile(url, 'utf8')]);
	}
	return out;
}



/**
 * `integrity` 가 온전한가 — **디코딩된 digest 바이트 수**로 본다.
 *
 * ⚠️ 세 번 헐렁했다. `sha512-====` → 문자 길이 요구 → `sha512-A×20` 통과 →
 *    `sha512-A×88` 통과(디코딩하면 66바이트). base64 **문자 수**는 답이 아니다.
 *    이 함수를 따로 뺀 이유는 **규칙 자체에 나쁜 값을 먹여 시험하려고**다 —
 *    실제 lock 만 훑으면 규칙을 느슨하게 되돌려도 안 걸린다(실제로 그랬다).
 */
export function integrityLooksValid(integrity: string | undefined): boolean {
	const BYTES: Record<string, number> = { sha256: 32, sha384: 48, sha512: 64 };
	// ⚠️ `split('-')` 의 첫 두 조각만 쓰면 두 번째 `-` 뒤가 **조용히 버려진다** —
	//    `sha512-<정상digest>-garbage` 가 통과했다(9차 반례, ssri strict 는 거부).
	//    첫 `-` 에서만 가르고 나머지 전부를 digest 로 본다.
	const raw = integrity ?? '';
	const cut = raw.indexOf('-');
	const algorithm = cut === -1 ? '' : raw.slice(0, cut);
	const digest = cut === -1 ? '' : raw.slice(cut + 1);
	const want = BYTES[algorithm];
	if (want === undefined) return false;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) return false;
	return Buffer.from(digest, 'base64').length === want;
}

/**
 * ★ 실측한 모양 그대로 쓴다 (Claude Code 2.1.220, `--plugin-dir`, 값 미입력)
 *
 * 탐침 플러그인으로 잰 결과다. 추측이 아니라 관찰이다:
 *   문자열 미입력            → `""`
 *   불린 default:false       → `"false"`
 *   불린 default 없음·미입력 → `""`
 *   미선언 키 참조           → 서버가 아예 기동하지 않음 (P6 이 이걸 막는다)
 *
 * `LITERAL` 은 **관찰된 적 없다.** URL 형태 서버에는 그 경로가 실재하므로
 * 보험으로만 다룬다 — 그래서 나오면 조용히 넘기지 않고 크게 알린다.
 */
const EMPTY = '';
const LITERAL = '${user_config.refresh_token}';

describe('★ P1 — 값의 모양을 알아본다', () => {
	test('빈 값을 알아본다', () => {
		for (const value of ['', ' ', '\t', '\n  ']) {
			assert.equal(isBlank(value), true, JSON.stringify(value));
		}
		for (const value of [undefined, '0', 'false', '/path']) {
			assert.equal(isBlank(value), false, String(value));
		}
	});

	test('치환되지 않은 자리표시자를 알아본다', () => {
		for (const value of [
			'${user_config.refresh_token}',
			'${user_config.chrome_path}',
			'${user_config.}',
			'앞뒤에 글자가 붙어도 ${user_config.x} 잡는다',
		]) {
			assert.equal(looksUnsubstituted(value), true, value);
		}
	});

	test('정상 값을 자리표시자로 오해하지 않는다', () => {
		for (const value of [
			undefined,
			'',
			'1',
			'true',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			// 토큰은 JWT 라 점(.)이 들어간다. 'user_config.' 글자만으로 걸리면 안 된다.
			'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2NvbmZpZy5hIjoxfQ.sig',
			// 닫는 괄호가 없으면 자리표시자가 아니다.
			'${user_config.refresh_token',
			// 다른 종류의 변수 치환은 우리 소관이 아니다.
			'${CLAUDE_PLUGIN_ROOT}/dist/index.js',
		]) {
			assert.equal(looksUnsubstituted(value), false, String(value));
		}
	});
});

describe('★ P2 — 우리 것만, 빈 것만 지운다', () => {
	test('실측한 모양을 그대로 넣으면 빈 것만 지워진다', () => {
		const env: NodeJS.ProcessEnv = {
			VELOG_REFRESH_TOKEN: EMPTY, // 사용자가 안 넣음
			VELOG_ALLOW_PUBLIC: 'false', // 불린 기본값
			VELOG_ALLOW_PROFILE: EMPTY, // 불린, default 없음
			VELOG_CHROME_PATH: EMPTY, // 파일, 안 넣음
			PATH: '/usr/bin',
			OTHER_TOOL_KEY: '', // 남의 빈 변수는 그대로 둔다
		};

		const { blanked, literal } = normalizePluginEnv(env);

		assert.deepEqual(blanked, [
			'VELOG_ALLOW_PROFILE',
			'VELOG_CHROME_PATH',
			'VELOG_REFRESH_TOKEN',
		]);
		assert.deepEqual(literal, []);
		assert.equal('VELOG_REFRESH_TOKEN' in env, false, '지운 키는 남아 있으면 안 된다');
		assert.equal(env['VELOG_ALLOW_PUBLIC'], 'false', "'false' 는 빈 값이 아니다 — 남겨야 한다");
		assert.equal('OTHER_TOOL_KEY' in env, true, '남의 변수는 비어 있어도 건드리지 않는다');
		assert.equal(env['PATH'], '/usr/bin');
	});

	test('자리표시자는 따로 분류한다', () => {
		const env: NodeJS.ProcessEnv = { VELOG_REFRESH_TOKEN: LITERAL, VELOG_CHROME_PATH: EMPTY };
		const { blanked, literal } = normalizePluginEnv(env);

		assert.deepEqual(literal, ['VELOG_REFRESH_TOKEN']);
		assert.deepEqual(blanked, ['VELOG_CHROME_PATH']);
		assert.equal('VELOG_REFRESH_TOKEN' in env, false);
	});

	test('정상 값은 하나도 건드리지 않는다', () => {
		const env: NodeJS.ProcessEnv = {
			VELOG_REFRESH_TOKEN: 'real-token-value',
			VELOG_ALLOW_PUBLIC: '1',
		};
		assert.deepEqual(normalizePluginEnv(env), { blanked: [], literal: [] });
		assert.equal(env['VELOG_REFRESH_TOKEN'], 'real-token-value');
		assert.equal(env['VELOG_ALLOW_PUBLIC'], '1');
	});
});

describe('★ P3 — 지운 뒤 세 소비 지점이 모두 "없음"으로 떨어진다', () => {
	test('인증: 빈 토큰도 자리표시자도 토큰으로 쓰지 않는다', () => {
		// 자리표시자는 지금 falsy 가 아니라 그대로 두면 통과해 버린다. 이게 원래 걱정이었다.
		assert.equal(
			readAuthFromEnv({ VELOG_REFRESH_TOKEN: LITERAL }).kind,
			'authenticated',
			'전제 확인: 걸러내지 않으면 인증된 것으로 판정된다',
		);

		for (const value of [EMPTY, LITERAL]) {
			const env: NodeJS.ProcessEnv = { VELOG_REFRESH_TOKEN: value };
			normalizePluginEnv(env);
			assert.equal(readAuthFromEnv(env).kind, 'anonymous', JSON.stringify(value));
		}
	});

	test('게이트: 실측 기본값 "false" 로도 꺼진 상태다', () => {
		const env: NodeJS.ProcessEnv = {
			VELOG_ALLOW_PUBLIC: 'false',
			VELOG_ALLOW_PROFILE: EMPTY,
		};
		normalizePluginEnv(env);
		assert.deepEqual(readCapabilities(env), { publicPublish: false, editProfile: false });
	});

	test('게이트: 사용자가 켜면 켜진다 (막기만 하는 게 아니다)', () => {
		const env: NodeJS.ProcessEnv = { VELOG_ALLOW_PUBLIC: 'true', VELOG_ALLOW_PROFILE: 'true' };
		normalizePluginEnv(env);
		assert.deepEqual(readCapabilities(env), { publicPublish: true, editProfile: true });
	});

	test('크롬: 빈 경로를 경로로 쓰지 않고 자동 탐색으로 간다', async () => {
		const saved = process.env['VELOG_CHROME_PATH'];
		process.env['VELOG_CHROME_PATH'] = EMPTY;
		resetChromeCache();
		try {
			normalizePluginEnv(process.env);

			// 크롬이 있든 없든 결론은 하나다 — **빈 값을 경로로 쓰지 않았다.**
			const outcome = await findChrome().then(
				(path) => ({ ok: true as const, path }),
				(error: unknown) => ({ ok: false as const, message: String(error) }),
			);

			if (outcome.ok) {
				assert.notEqual(outcome.path, EMPTY);
				await access(outcome.path, constants.X_OK); // 진짜 실행 가능한 파일이다
			} else {
				// 자동 탐색 실패 메시지여야 한다. override 실패 메시지가 나오면
				// 빈 값을 경로로 썼다는 뜻이다.
				assert.equal(
					outcome.message.includes('VELOG_CHROME_PATH 로 지정한 파일'),
					false,
					`빈 값을 경로로 사용했다: ${outcome.message}`,
				);
			}
		} finally {
			if (saved === undefined) delete process.env['VELOG_CHROME_PATH'];
			else process.env['VELOG_CHROME_PATH'] = saved;
			resetChromeCache();
		}
	});
});

describe('★ P4 — 말할 것만 말한다 (경고를 읽게 하려면 드물어야 한다)', () => {
	test('아무 이상 없으면 아무 말도 하지 않는다', () => {
		assert.equal(describeAnomalies({ blanked: [], literal: [] }), '');
	});

	test('선택 설정이 비어 있는 건 정상이므로 침묵한다', () => {
		// 플러그인은 설정 네 개를 항상 넘긴다. 토큰만 넣은 사용자에게 나머지 셋이
		// 빈 값으로 오는데, 그걸 매번 경고하면 경고를 안 읽게 된다.
		const quiet = describeAnomalies({
			blanked: ['VELOG_ALLOW_PROFILE', 'VELOG_ALLOW_PUBLIC', 'VELOG_CHROME_PATH'],
			literal: [],
		});
		assert.equal(quiet, '');
	});

	test('토큰이 비어서 왔으면 그것만 짚는다', () => {
		const message = describeAnomalies({
			blanked: ['VELOG_ALLOW_PUBLIC', 'VELOG_REFRESH_TOKEN'],
			literal: [],
		});
		assert.match(message, /VELOG_REFRESH_TOKEN/);
		assert.match(message, /읽기 전용/);
		assert.match(message, /plugin manage/);
		assert.equal(
			message.includes('VELOG_ALLOW_PUBLIC'),
			false,
			'같이 비어 있던 선택 설정까지 늘어놓으면 요점이 흐려진다',
		);
	});

	test('자리표시자가 살아 오면 관찰된 적 없는 일이므로 크게 알린다', () => {
		const message = describeAnomalies({ blanked: [], literal: ['VELOG_REFRESH_TOKEN'] });
		assert.match(message, /치환되지 않고/);
		assert.match(message, /VELOG_REFRESH_TOKEN/);
		// 빈 값 안내와 다른 문구여야 한다 — 원인도 대응도 다르다.
		assert.notEqual(
			message,
			describeAnomalies({ blanked: ['VELOG_REFRESH_TOKEN'], literal: [] }),
		);
	});
});

/**
 * 실제로 서버를 띄워 기동 로그(stderr)를 읽는다.
 *
 * ★ 왜 이게 필요한가 — P1~P4 는 함수만 본다
 *   `stripUnsubstituted` 가 아무리 완벽해도 `main()` 이 부르지 않으면 소용없다.
 *   그 연결은 순수 함수 테스트로는 절대 안 묶인다. 실제로 띄워야만 잡힌다.
 *
 * 서버는 stdio 로 붙어 대기하므로 스스로 끝나지 않는다. 찾는 문구가 다 나오면
 * 죽인다. 못 나오면 시간 제한으로 끊고 그때까지 모은 것을 그대로 보여준다 —
 * 무엇이 나왔는지 봐야 왜 실패했는지 알 수 있다.
 */
async function startupLog(env: NodeJS.ProcessEnv, expect: readonly RegExp[]): Promise<string> {
	const entry = fileURLToPath(new URL('index.ts', new URL('../', import.meta.url)));
	const child = spawn(process.execPath, [entry], {
		stdio: ['ignore', 'ignore', 'pipe'],
		env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
	});

	let out = '';
	return await new Promise<string>((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			child.kill('SIGKILL');
			resolve(out);
		};
		const timer = setTimeout(done, 15_000);
		child.stderr.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
			if (expect.every((re) => re.test(out))) done();
		});
		child.on('error', done);
		child.on('close', done);
	});
}

describe('★ P13 — 걸러내는 코드가 실제 기동 경로에 연결돼 있다', () => {
	test('플러그인이 실제로 넘기는 모양(빈 값)으로 띄우면 이유를 짚어준다', async () => {
		// 이게 실측한 모양이다 — 토큰만 안 넣은 사용자에게 오는 것.
		const log = await startupLog(
			{
				VELOG_REFRESH_TOKEN: '',
				VELOG_ALLOW_PUBLIC: 'false',
				VELOG_ALLOW_PROFILE: '',
				VELOG_CHROME_PATH: '',
			},
			[/토큰이 비어 있습니다/, /무인증/],
		);

		assert.match(log, /토큰이 비어 있습니다/);
		assert.match(log, /VELOG_REFRESH_TOKEN/);
		assert.match(log, /plugin manage/);
		assert.match(log, /무인증 — 읽기 전용/);
		assert.equal(/인증됨/.test(log), false, '빈 값으로 인증된 것처럼 굴면 안 된다');
		// 같이 비어 온 선택 설정 셋은 늘어놓지 않는다.
		assert.equal(/VELOG_CHROME_PATH/.test(log), false, '정상인 것까지 경고하면 경고를 안 읽는다');
	});

	test('자리표시자가 살아 오면 (관찰된 적 없는 일) 크게 알린다', async () => {
		const log = await startupLog(
			{ VELOG_REFRESH_TOKEN: '${user_config.refresh_token}' },
			[/치환되지 않고/, /무인증/],
		);

		assert.match(log, /치환되지 않고/);
		assert.match(log, /무인증 — 읽기 전용/);
		assert.equal(/인증됨/.test(log), false, '자리표시자로 인증된 것처럼 굴면 안 된다');
	});

	test('정상 값으로 띄우면 아무 경고도 하지 않는다', async () => {
		const log = await startupLog({ VELOG_REFRESH_TOKEN: 'looks-like-a-real-token' }, [/인증됨/]);

		assert.match(log, /인증됨/);
		for (const noise of [/토큰이 비어 있습니다/, /치환되지 않고/]) {
			assert.equal(noise.test(log), false, `정상 값에 경고가 나오면 경고를 무시하게 된다: ${log}`);
		}
	});

	test('P14 — 그림 도구가 지금 되는지 기동할 때 말한다', async () => {
		// ⚠️ 처음엔 `/그림 도구/` 가 보이는 즉시 자식을 죽였다. 코덱스가 짚었다 —
		//    파이프가 문장 중간에서 청크를 나누면 뒷부분을 못 읽고 죽여서 깜빡인다.
		//    그래서 **판정에 쓸 문구까지** 기다린 뒤에 죽인다.
		const log = await startupLog({}, [/그림 도구.*(사용 가능|안 됩니다)/s]);

		assert.match(log, /그림 도구/);
		// 크롬이 있으면 경로를, 없으면 어떻게 고치는지를 말해야 한다.
		// 어느 쪽이든 "말은 한다"가 불변식이다.
		const said = /사용 가능/.test(log) || /크롬을 설치하거나/.test(log);
		assert.ok(said, `크롬 가용 여부를 말하지 않았다:\n${log}`);
	});
});

describe('★ P25 — 심볼릭 링크로 실행해도 기동한다 (npm 이 하는 방식)', () => {
	/**
	 * ★★ 이것 때문에 서버가 통째로 안 뜬 적이 있다.
	 *
	 * `npx` 와 `npm i -g` 는 `node_modules/.bin/velog-mcp` **링크**를 만들어 실행한다.
	 * 그때 `process.argv[1]` 은 링크 경로, `import.meta.url` 은 실제 파일이라
	 * 문자열 비교가 어긋나 `main()` 이 아예 안 돌았다 — **출력 0줄, 종료코드 0.**
	 * 증상은 "플러그인은 깔렸는데 도구가 하나도 없음"이고, 실제 경로로 실행하는
	 * 테스트는 전부 통과하므로 아무도 못 본다.
	 *
	 * 발행 관문(verify-dist)도 같은 모양으로 띄우지만, 그건 발행할 때만 돈다.
	 * 여기서 소스 단계에 못 박아 둔다.
	 */
	test('링크를 통해 띄워도 MCP 로 응답한다', async () => {
		const linkDir = await mkdtemp(join(tmpdir(), 'velog-mcp-link-'));
		const link = join(linkDir, 'velog-mcp');
		const real = fileURLToPath(new URL('index.ts', new URL('../', import.meta.url)));
		try {
			await symlink(real, link);

			const { responses, junk } = await rpc(
				[
					{
						jsonrpc: '2.0',
						id: 1,
						method: 'initialize',
						params: {
							protocolVersion: '2024-11-05',
							capabilities: {},
							clientInfo: { name: 'link-test', version: '0' },
						},
					},
				],
				{},
				link,
			);

			const init = responses.find((r) => r['id'] === 1);
			assert.ok(
				init,
				`링크로 실행하면 응답이 없다 — isDirectRun 이 링크를 못 알아본다. junk=${JSON.stringify(junk)}`,
			);
			const info = (init['result'] as { serverInfo?: { name?: string } })?.serverInfo;
			assert.equal(info?.name, 'velog-mcp');
		} finally {
			await rm(linkDir, { recursive: true, force: true });
		}
	});
});

describe('★ P19 — 디렉터리를 크롬 실행 파일로 오인하지 않는다', () => {
	/**
	 * 크롬 경로 설정이 `file` 타입이라 macOS 파일 선택기가 `.app` **번들 자체**를
	 * 돌려줄 수 있다. 번들은 디렉터리이고, POSIX 에서 디렉터리의 `X_OK` 는
	 * '실행 가능'이 아니라 '탐색 가능'이라 `access(X_OK)` 를 통과한다(실측).
	 * 그러면 기동 로그는 "사용 가능"이라 해놓고 정작 그릴 때 `spawn` 이 실패한다.
	 */
	async function withChromePath<T>(value: string, run: () => Promise<T>): Promise<T> {
		const saved = process.env['VELOG_CHROME_PATH'];
		process.env['VELOG_CHROME_PATH'] = value;
		resetChromeCache();
		try {
			return await run();
		} finally {
			if (saved === undefined) delete process.env['VELOG_CHROME_PATH'];
			else process.env['VELOG_CHROME_PATH'] = saved;
			resetChromeCache();
		}
	}

	test('평범한 디렉터리를 주면 거부한다', async () => {
		const dir = fileURLToPath(ROOT); // 저장소 루트 — 확실히 디렉터리다
		await access(dir, constants.X_OK); // 전제 확인: 이 디렉터리는 X_OK 를 통과한다

		await withChromePath(dir, async () => {
			const outcome = await findChrome().then(
				(path) => ({ ok: true as const, path }),
				(error: unknown) => ({ ok: false as const, message: String(error) }),
			);
			assert.equal(outcome.ok, false, `디렉터리를 실행 파일로 받아들였다: ${JSON.stringify(outcome)}`);
		});
	});

	test('macOS 앱 번들을 주면 안쪽 실행 파일로 바꿔준다', async (t) => {
		const bundle = '/Applications/Google Chrome.app';
		const present = await access(bundle, constants.X_OK).then(
			() => true,
			() => false,
		);
		if (!present) {
			t.skip('이 기계에 크롬이 없다');
			return;
		}

		await withChromePath(bundle, async () => {
			const path = await findChrome();
			assert.notEqual(path, bundle, '번들 경로를 그대로 돌려주면 spawn 이 실패한다');
			assert.equal(path, `${bundle}/Contents/MacOS/Google Chrome`);
		});
	});
});

describe('★ P18 — 기동 로그만 내는 게 아니라 실제로 MCP 로 붙는다', () => {
	test('initialize 에 응답하고 도구 목록을 돌려준다', async () => {
		const { responses, junk } = await rpc([
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'plugin-test', version: '0' },
				},
			},
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		]);

		// stdout 은 MCP 전용이다. 한 줄만 섞여도 클라이언트가 프레이밍을 잃는다.
		assert.deepEqual(junk, [], 'stdout 에 프로토콜 아닌 줄이 섞였다');

		const init = responses.find((r) => r['id'] === 1);
		assert.ok(init, `initialize 응답이 없다: ${JSON.stringify(responses)}`);
		const serverInfo = (init['result'] as { serverInfo?: { name?: string; version?: string } })
			?.serverInfo;
		assert.equal(serverInfo?.name, 'velog-mcp');
		// 실제로 붙은 서버가 우리가 배포하려는 그 버전인지까지 확인한다.
		assert.equal(serverInfo?.version, SERVER_VERSION);

		const list = responses.find((r) => r['id'] === 2);
		assert.ok(list, `tools/list 응답이 없다: ${JSON.stringify(responses)}`);
		const tools = (list['result'] as { tools?: unknown[] })?.tools ?? [];
		assert.ok(tools.length >= 20, `도구가 너무 적다: ${tools.length}`);
	});
});

describe('★ P5 — 배포물이 서로 어긋나지 않는다', () => {
	test('P6 — 설정 키가 어느 환경변수로 가는지까지 정확히 고정한다', async () => {
		// ⚠️ 처음엔 '집합이 같은가'만 봤다. 코덱스가 반례를 냈다 —
		//    allow_public 과 allow_profile 을 **서로 바꿔도** 집합은 같다.
		//    그러면 사용자가 프로필 수정만 켰는데 공개 발행이 열린다.
		//    토큰과 크롬 경로를 바꿔도 통과했고, 그 경우 토큰이 크롬 오류 메시지에
		//    실려 stderr 로 나갈 수 있다. 그래서 매핑 전체를 그대로 못 박는다.
		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		const mcp = await json(new URL('.mcp.json', PLUGIN));

		const env = (mcp['mcpServers'] as Record<string, { env?: Record<string, string> }>)['velog']
			?.env;
		assert.ok(env, '.mcp.json 에 velog 서버의 env 가 있어야 한다');

		assert.deepEqual(
			Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('VELOG_'))),
			{
				VELOG_REFRESH_TOKEN: '${user_config.refresh_token}',
				VELOG_ALLOW_PUBLIC: '${user_config.allow_public}',
				VELOG_ALLOW_PROFILE: '${user_config.allow_profile}',
				VELOG_CHROME_PATH: '${user_config.chrome_path}',
			},
		);

		// 묻기만 하고 안 쓰는 설정이 없어야 한다 — 사용자가 넣은 값이 버려진다.
		const declared = Object.keys(manifest['userConfig'] as Record<string, unknown>).sort();
		const referenced = [
			...new Set(
				Object.values(env).flatMap((value) =>
					[...value.matchAll(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
						(m) => m[1] as string,
					),
				),
			),
		].sort();
		assert.deepEqual(referenced, declared);
	});

	test('P16 — 무엇을 어떻게 실행하는지 고정한다', async () => {
		// `npxx` 같은 오타는 패키지 이름·버전 정규식(P8/P11)을 그대로 통과한다.
		// 증상은 "플러그인은 깔렸는데 서버가 안 뜸"이다.
		const mcp = await json(new URL('.mcp.json', PLUGIN));
		const server = (mcp['mcpServers'] as Record<string, Record<string, unknown>>)['velog'];
		assert.ok(server);

		const pkg = await json(new URL('package.json', ROOT));
		assert.deepEqual(
			{ command: server['command'], args: server['args'] },
			{ command: 'npx', args: ['-y', `${String(pkg['name'])}@${String(pkg['version'])}`] },
		);
	});

	test('P17 — npx 가 설치 스크립트를 못 돌리게 막아둔다', async () => {
		// 코덱스 지적: `.mcp.json` 의 env 는 최종 서버만이 아니라 **먼저 실행되는
		// npx/npm 프로세스에도** 들어간다. 즉 30일짜리 토큰이 npm 이 읽는 환경에 놓인다.
		// 실측으로 지금 운영 의존성 트리에는 install/postinstall 이 하나도 없지만,
		// 전이 의존성이 나중에 추가할 수 있다. 이 스위치가 그걸 원천 차단한다.
		// (`npm_config_ignore_scripts=true` 가 실제로 먹히는 것은 실행해서 확인했다.)
		const mcp = await json(new URL('.mcp.json', PLUGIN));
		const env = (mcp['mcpServers'] as Record<string, { env?: Record<string, string> }>)['velog']
			?.env;
		assert.equal(env?.['npm_config_ignore_scripts'], 'true');
	});

	test('P7 — 토큰은 반드시 민감값으로 선언한다 (키체인 저장의 유일한 조건)', async () => {
		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		const options = manifest['userConfig'] as Record<string, Record<string, unknown>>;

		assert.equal(
			options['refresh_token']?.['sensitive'],
			true,
			'sensitive 가 아니면 settings.json 에 평문으로 저장된다 — 옮기려던 이유가 사라진다',
		);

		// 민감하지 않은 것에 sensitive 를 붙이면 키체인 2KB 한도를 잡아먹는다.
		for (const key of ['allow_public', 'allow_profile', 'chrome_path']) {
			assert.notEqual(options[key]?.['sensitive'], true, key);
		}
	});

	test('P8 — 버전이 네 곳에서 같다', async () => {
		const pkg = await json(new URL('package.json', ROOT));
		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		const mcpRaw = await readFile(new URL('.mcp.json', PLUGIN), 'utf8');

		const pin = /@milcho0604\/velog-mcp@([0-9]+\.[0-9]+\.[0-9]+)/.exec(mcpRaw)?.[1];
		assert.ok(pin, '.mcp.json 은 정확한 버전을 핀해야 한다 — latest 는 배포 게이트를 무력화한다');

		assert.deepEqual(
			{
				pkg: pkg['version'],
				plugin: manifest['version'],
				pin,
				server: SERVER_VERSION,
			},
			{
				pkg: pkg['version'],
				plugin: pkg['version'],
				pin: pkg['version'],
				server: pkg['version'],
			},
		);
	});

	test('P9 — plugin.json 에 version 이 있다 (없으면 매 커밋이 릴리스가 된다)', async () => {
		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		assert.match(String(manifest['version']), /^\d+\.\d+\.\d+$/);
	});

	test('P10 — marketplace 의 source 가 실제 플러그인 루트를 가리킨다', async () => {
		const market = await json(new URL('.claude-plugin/marketplace.json', ROOT));
		const entry = (market['plugins'] as Array<Record<string, unknown>>)[0];
		assert.ok(entry, '마켓플레이스에 항목이 하나는 있어야 한다');

		const source = String(entry['source']);
		assert.match(source, /^\.\//, '상대 경로는 ./ 로 시작해야 한다');

		// 그 경로에 진짜 매니페스트가 있는지 본다. 오타는 설치 시점에야 드러난다.
		await access(new URL(`${source}/.claude-plugin/plugin.json`, ROOT), constants.R_OK);

		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		assert.equal(entry['name'], manifest['name'], '슬러그가 다르면 사용자가 보는 이름이 갈린다');
	});

	test('P20 — 목록에 보이는 설명이 설치 화면 설명과 같다', async () => {
		// 커뮤니티 카탈로그 실측(2,307개): 전부 `description` 이 있고 2,306개가 `homepage` 가 있다.
		// 그리고 사용자가 목록에서 걸러내는 축은 **이름과 설명뿐**이다(공식 문서).
		// 설명이 두 파일에 복제돼 있으므로 어긋나면 카탈로그와 설치 화면이 다른 말을 한다.
		const market = await json(new URL('.claude-plugin/marketplace.json', ROOT));
		const entry = (market['plugins'] as Array<Record<string, unknown>>)[0];
		const manifest = await json(new URL('.claude-plugin/plugin.json', PLUGIN));
		assert.ok(entry);

		assert.equal(entry['description'], manifest['description'], '설명이 두 파일에서 갈렸다');
		assert.ok(entry['homepage'], '목록에서 더 볼 곳이 없으면 설치를 망설인다');

		// 이 목록은 대부분 영어로 훑는다(한국어 설명은 2,307개 중 9개).
		// 한국어만 적으면 `velog` 를 이미 아는 사람만 찾을 수 있다.
		const description = String(manifest['description']);
		assert.match(description, /velog/i, '이름으로 찾는 사람이 걸릴 단어가 없다');
		assert.match(description, /[A-Za-z]{40,}|[A-Za-z][A-Za-z ,.()-]{40,}/, '영어 설명이 없다');
	});

	test('P11 — .mcp.json 이 가리키는 npm 패키지가 이 저장소의 패키지다', async () => {
		const pkg = await json(new URL('package.json', ROOT));
		const mcpRaw = await readFile(new URL('.mcp.json', PLUGIN), 'utf8');
		assert.ok(
			mcpRaw.includes(`${String(pkg['name'])}@`),
			`.mcp.json 이 ${String(pkg['name'])} 를 가리켜야 한다`,
		);
	});

	test('P15 — .mcp.json 이 넘기는 환경변수를 서버가 실제로 읽는다', async () => {
		// 코덱스가 짚은 구멍이다: P13/P14 는 `node src/index.ts` 를 직접 띄우므로
		// **플러그인이 실제로 넘기는 이름**과 코드가 읽는 이름이 맞는지는 안 본다.
		// `VELOG_ALLOW_PUBIC` 같은 오타는 아무 데서도 안 걸리고, 증상은
		// "설정을 켰는데 안 켜짐"이 된다.
		//
		// 진짜 설치 경로(npx·치환)까지는 테스트가 못 간다 — 그건 배포 때 손으로 실증한다.
		// 여기서 닫는 건 **이름 대조** 하나다.
		const mcp = await json(new URL('.mcp.json', PLUGIN));
		const env = (mcp['mcpServers'] as Record<string, { env?: Record<string, string> }>)['velog']
			?.env;
		assert.ok(env);

		const sources = await readAllSources(new URL('../', import.meta.url));
		const consumed = new Set(
			sources.flatMap(([, code]) =>
				[...code.matchAll(/\benv\['(VELOG_[A-Z0-9_]+)'\]/g)].map((m) => m[1] as string),
			),
		);
		assert.ok(consumed.size >= 3, `환경변수 소비 지점을 못 찾았다 — 정규식을 확인하라`);

		for (const key of Object.keys(env).filter((k) => k.startsWith('VELOG_'))) {
			assert.ok(
				consumed.has(key),
				`.mcp.json 이 ${key} 를 넘기는데 코드에서 읽는 곳이 없다 (오타이거나 죽은 설정)`,
			);
		}
	});

	test('P15b — 문서가 안내하는 환경변수를 서버가 실제로 읽는다', async () => {
		// P15 의 반대 방향이다. P15 는 **플러그인이 넘기는** 이름만 본다. 사용자
		// 대다수는 플러그인이 아니라 README 를 보고 손으로 설정을 적는다. 문서에
		// `VELOG_ALLOW_PUBIC` 같은 오타가 있으면 아무 데서도 안 걸리고, 증상은
		// "안내대로 켰는데 안 켜짐"이 된다. 이 서버의 안전장치가 전부 환경변수
		// 이름에 걸려 있으므로 그 침묵은 비싸다.
		//
		// ⚠️ 문서에 '틀린 이름'을 일부러 예시로 적으면 여기서 걸린다. 그때는 그
		//    예시를 코드 폰트 밖으로 빼거나 이 목록에서 제외할 것.
		const docs = ['README.md', 'README.ko.md'];
		const texts = await Promise.all(
			docs.map(async (f) => readFile(new URL(`../../${f}`, import.meta.url), 'utf8')),
		);
		const documented = new Set(
			texts.flatMap((t) => [...t.matchAll(/\bVELOG_[A-Z0-9_]+/g)].map((m) => m[0])),
		);
		// ★ 대조군 — 못 읽었으면 이 테스트는 아무것도 안 지킨다.
		assert.ok(
			documented.size >= 3,
			`문서에서 환경변수를 못 찾았다 (${documented.size}개) — 경로나 정규식을 확인하라`,
		);

		const sources = await readAllSources(new URL('../', import.meta.url));
		const consumed = new Set(
			sources.flatMap(([, code]) =>
				[...code.matchAll(/\benv\['(VELOG_[A-Z0-9_]+)'\]/g)].map((m) => m[1] as string),
			),
		);
		for (const key of documented) {
			assert.ok(
				consumed.has(key),
				`문서가 ${key} 를 안내하는데 코드에서 읽는 곳이 없다 (오타이거나 죽은 안내다)`,
			);
		}
	});

	test('P27 — engines 하한과 CI 매트릭스 하한이 같다', async () => {
		// 둘은 조용히 어긋난다. engines 를 내려도 CI 가 그 버전을 안 돌면 "지원한다"는
		// 말에 근거가 없다.
		// ⚠️ 반대 방향은 조용하다 — npm 은 `engine-strict` 가 꺼져 있으면(기본값)
		//   engines 불일치에 **경고만** 하고 설치를 진행한다. 이 레포에는 그걸 켜는
		//   .npmrc 가 없다. 그래서 "npm 이 막아줄 것"에 기대면 안 된다.
		// ★ 비교는 **정확한 버전**으로 한다. CI 에 `22` 라고 적으면 최신 22.x 가
		//   풀려서 하한인 22.18.0 은 한 번도 안 돈다.
		const pkg = (await json(new URL('../../package.json', import.meta.url))) as {
			engines?: { node?: string };
		};
		const floor = pkg.engines?.node;
		assert.ok(floor, 'package.json 에 engines.node 가 없다');
		const floorMajor = Number(/(\d+)/.exec(floor)?.[1]);
		assert.ok(Number.isInteger(floorMajor), `engines.node 에서 메이저를 못 읽었다: ${floor}`);

		const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
		const listed = /^\s*node:\s*\[([^\]]+)\]/m.exec(ci)?.[1];
		assert.ok(listed, 'ci.yml 에서 node 매트릭스를 못 찾았다 — 형식이 바뀌었다');
		const entries = listed.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
		// ★ 대조군 — 못 읽었으면 아래 비교는 아무것도 안 지킨다.
		assert.ok(entries.length >= 2 && entries.every((e) => /^\d/.test(e)), `매트릭스 파싱 실패: ${listed}`);

		const exact = minVersion(floor);
		assert.ok(exact, `engines 범위에서 최소 버전을 못 읽었다: ${floor}`);
		assert.ok(
			entries.includes(exact.version),
			`engines 하한은 ${exact.version} 인데 CI 매트릭스는 ${listed} 다 — ` +
				'그 버전을 한 번도 안 돌리면 "지원한다"는 근거가 없다',
		);

		// ★★ 매트릭스에 적어두는 것만으로는 아무 일도 안 일어난다. setup-node 가
		//   그 값을 **실제로 써야** 그 버전에서 도는 것이다. `node-version: 24` 처럼
		//   상수로 바꿔놓으면 잡 이름만 22.18.0 이고 실행은 24 가 되는데, 그건
		//   거짓 초록이다 — 이름을 보고 필수 체크를 걸어둔 사람이 속는다.
		assert.match(
			ci,
			/node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/,
			'setup-node 가 matrix.node 를 안 쓴다 — 잡 이름과 실제 실행 버전이 어긋난다',
		);
	});

	test('P21 — 배포되는 모든 파일에 개인정보·로컬 경로가 실리지 않는다', async () => {
		// 플러그인을 git 소스로 설치하면 **레포 전체가 사용자 기계로 클론되고**,
		// npm 에 올리면 매니페스트가 레지스트리 페이지에 영구히 걸린다.
		// 연락은 GitHub 이슈로 받는다 — 이메일을 적을 이유가 없다.
		//
		// ⚠️ 처음엔 파일 넷만 봤다. 코덱스가 짚었다 — `.mcp.json`·루트 README 둘·
		//    `docs/` 를 통째로 놓치고, 예외가 '문자열에 noreply 가 들어 있으면 통과'라
		//    너무 넓었다(임의 도메인 주소에 그 낱말만 끼워 넣으면 빠져나간다).
		//    지금은 **git 이 추적하는 것 전부**를 훑는다. 확장자로 거르던 것도 없앴다 —
		//    그 필터가 `LICENSE`·`.gitignore` 를 통째로 빼먹어 64개 중 62개만 보고 있었다.
		//    이 주석에 예시 주소를 적었다가 이 테스트에 잡혔다 — 그게 의도한 동작이다.
		const shipped = await trackedFiles(fileURLToPath(ROOT));

		// 필터가 다시 좁아지면 여기서 걸린다. 확장자 없는 파일이 실제로 포함돼야 한다.
		assert.ok(shipped.length >= 60, `훑은 파일이 너무 적다: ${shipped.length}`);
		for (const extensionless of ['LICENSE', '.gitignore']) {
			assert.ok(
				shipped.includes(extensionless),
				`${extensionless} 를 안 훑는다 — 확장자로 거르고 있다`,
			);
		}

		const loaded: Array<[string, Uint8Array]> = [];
		for (const relative of shipped) loaded.push([relative, await readFile(new URL(relative, ROOT))]);

		const { leaks, skipped } = scanFiles(loaded);
		assert.deepEqual(
			leaks,
			[],
			`나가면 안 되는 것이 있다:\n${leaks.map((l) => `  ${l.file}: ${l.kind} ${l.value}`).join('\n')}`,
		);
		// ⚠️ 텍스트로 못 읽어 **검사하지 못한** 파일을 조용히 넘기면 그게 구멍이다.
		//    `looksTextual` 은 UTF-16 을 바이너리로 오판한다(실측). 지금은 그런 파일이 없다.
		assert.deepEqual(skipped, [], '검사하지 못한 추적 파일이 있다 — 눈으로 확인할 것');
	});

	test('P21b — 그 걸러내는 규칙 자체를 시험한다', () => {
		// ⚠️ 실제 파일만 훑으면, 규칙을 느슨하게 되돌려도 **지금 그 허점을 찌르는 값이
		//    없어서** 테스트가 통과한다. 실제로 변이 검증에서 살아남았다.
		//    그래서 규칙에 직접 나쁜 값을 먹인다.
		//
		// ⚠️⚠️ 그 값들을 소스에 그대로 적으면 **이 파일이 P21 에 걸린다**(실제로 걸렸다).
		//    이 파일도 클론돼 나가므로 스캔에서 빼는 건 구멍이 된다.
		//    그래서 실행할 때 조립한다 — 소스에는 온전한 주소가 없다.
		const at = String.fromCodePoint(0x40);
		const wideAt = String.fromCodePoint(0xff20);
		const mustCatch = [
			// 도메인 아무 데나 그 낱말만 끼워 넣어 예외를 흉내내는 경우
			['임의 도메인 + noreply 낱말', `a-noreply${at}evil-domain.test`],
			['하위도메인만 흉내', `a${at}users.noreply.github.com.evil.test`],
			// ★ 이게 `endsWith` 예외와 정확 일치 예외를 가르는 유일한 사례다.
			//   `endsWith` 면 통과시켜 버린다 — 남의 도메인 밑에 허용 도메인을 달면 된다.
			['허용 도메인을 접미로 단 남의 도메인', `a${at}evil.users.noreply.github.com`],
			['전각 골뱅이', `someone${wideAt}gmail.com`],
			['평범한 개인 주소', `someone${at}gmail.com`],
		] as const;
		for (const [label, value] of mustCatch) {
			assert.deepEqual(findPersonalEmails(value), [value], `못 잡았다: ${label}`);
		}

		const mustPass = [
			`128167167+milcho0604${at}users.noreply.github.com`,
			`noreply${at}noreply.github.com`,
			'@modelcontextprotocol/sdk', // 스코프 패키지는 이메일이 아니다
			'velog.io/@milcho0604', // 블로그 핸들
		] as const;
		for (const value of mustPass) {
			assert.deepEqual(findPersonalEmails(value), [], `잘못 잡았다: ${value}`);
		}

		// 경로 규칙도 같이 시험한다. 문서의 자리표시자는 실제 경로가 아니다.
		// 경로도 같은 이유로 조립한다 — 소스에 온전한 홈 경로를 적으면 P21 에 걸린다.
		const [macos, linux, windows] = LOCAL_PATH_PATTERNS;
		assert.ok(macos && linux && windows, '경로 규칙 세 개가 다 있어야 한다');
		const who = 'some' + 'one';
		const posix = (root: string): string => ['', root, who, 'dev'].join('/');
		const win = ['C:', 'Users', who, 'dev'].join('\\');

		assert.notEqual(macos[1].exec(posix('Users')), null, 'macOS 홈 경로를 놓쳤다');
		// 이 기계에서는 `/users/...` 도 실제 홈 경로로 해석된다(대소문자 무시 파일시스템).
		assert.notEqual(macos[1].exec(posix('users')), null, '소문자 users 를 놓쳤다');
		assert.notEqual(linux[1].exec(posix('home')), null, '리눅스 홈 경로를 놓쳤다');
		assert.notEqual(windows[1].exec(win), null, '윈도우 홈 경로를 놓쳤다');

		// 문서에 흔한 자리표시자·일반명은 실제 경로가 아니다.
		// 도구에 따라 드라이브 문자가 소문자로 나온다 — 그것도 사용자명이 새는 건 같다.
		// 드라이브 문자만 소문자인 경우다 — `Users` 는 그대로다.
		assert.notEqual(windows[1].exec(`c${win.slice(1)}`), null, '소문자 드라이브를 놓쳤다');

		assert.equal(macos[1].exec(['', 'Users', '<your-name>', 'dev'].join('/')), null, '자리표시자를 잘못 잡았다');
		assert.equal(linux[1].exec(['', 'home', 'user', 'dev'].join('/')), null, '문서용 일반명을 잘못 잡았다');
	});

	test('P21d — 규칙이 우회되는 모양을 직접 먹인다', () => {
		// 6차 반례 둘. 실제 파일에는 그런 값이 없어 규칙을 되돌려도 안 걸린다.
		const who = 'some' + 'one';

		// ① NUL 검사를 앞 8KiB 로 좁히면: 'A' 8,192개 뒤의 UTF-16 경로를 textual 로 보고
		//    그 파일을 **UTF-8 로 읽어** 훑는다 → 아무것도 못 찾고 조용히 통과한다.
		const filler = new Uint8Array(8192).fill(0x41);
		const utf16Path = new Uint8Array(
			Buffer.from(['C:', 'Users', who, 'dev'].join('\\'), 'utf16le'),
		);
		const mixed = new Uint8Array(filler.length + utf16Path.length);
		mixed.set(filler);
		mixed.set(utf16Path, filler.length);

		const mixedResult = scanFiles([['mixed.bin', mixed]]);
		assert.deepEqual(
			mixedResult.leaks,
			[],
			'UTF-16 은 UTF-8 규칙으로 못 찾는다 — 찾았다면 이 사례가 무의미해진 것이다',
		);
		assert.deepEqual(
			mixedResult.skipped,
			['mixed.bin'],
			'뒤쪽 NUL 을 못 보면 검사한 척하고 넘어간다 — 전체를 봐야 한다',
		);

		// ② 윈도우 경로의 `Users` 대소문자. 도구에 따라 소문자로 나온다.
		const lower = ['c:', 'users', who, 'dev'].join('\\');
		const found = findLeaks('doc.md', lower);
		assert.equal(found.length, 1, `소문자 users 를 놓쳤다: ${lower}`);
	});

	test('P21c — 검사하지 못한 파일은 조용히 넘기지 않고 보고한다', () => {
		// `looksTextual` 은 UTF-16 이나 앞부분에 NUL 이 든 텍스트를 바이너리로 오판한다.
		// 그걸 `continue` 로 넘기면 **검사받지 않은 파일이 그대로 발행된다.**
		// 지금 저장소엔 그런 파일이 없어서, 규칙에 직접 먹여야만 이 동작을 시험할 수 있다.
		const binary = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
		const text = new TextEncoder().encode('아무 문제 없는 본문');

		const result = scanFiles([
			['image.png', binary],
			['fine.md', text],
		]);
		assert.deepEqual(result.skipped, ['image.png'], '못 읽은 파일을 보고하지 않는다');
		assert.deepEqual(result.leaks, []);
	});

	test('P22 — 크롬이 필요한 도구를 개수가 아니라 이름으로 안내한다', async () => {
		// ⚠️ "그림 도구 3종"이라고 안내했는데 틀렸다 — `velog_upload_image` 는
		//    로컬 파일을 읽어 올릴 뿐 크롬을 쓰지 않는다. 숫자는 코드와 따로 논다.
		//    이름을 쓰면 실물과 대조할 수 있다.
		const responses = await rpcTools();
		const names = new Set(responses.map((tool) => tool.name));
		for (const tool of CHROME_TOOLS) {
			assert.ok(names.has(tool), `${tool} 은 등록된 도구가 아니다`);
		}

		const log = await startupLog({}, [/그림 도구.*(사용 가능|안 됩니다)/s]);
		for (const tool of CHROME_TOOLS) {
			assert.ok(log.includes(tool), `기동 안내가 ${tool} 을 말하지 않는다:\n${log}`);
		}

		// ⚠️ 두 번 약했다.
		//    ① 처음엔 '렌더 호출 지점 수'만 셌다 → CHROME_TOOLS 를
		//       [render_diagram, upload_image] 로 바꿔도 이름·개수가 맞아 통과했다.
		//    ② 그다음엔 `images.ts` 한 파일에서 `renderDiagram(`·`renderCover(` 글자만
		//       찾았다 → `renderCover as makeCover` 로 별칭을 주거나 다른 파일에 렌더를
		//       넣으면 안내가 조용히 낡는다(코덱스 5차).
		//    지금은 **도구 파일 전부**를 보고, 렌더 모듈에서 들여온 **지역 이름**을 추적한다.
		const toolsDir = new URL('tools/', new URL('../', import.meta.url));
		const rendering: string[] = [];
		let blocks: string[] = [];

		for (const file of await readdir(toolsDir)) {
			if (!file.endsWith('.ts')) continue;
			const code = await readFile(new URL(file, toolsDir), 'utf8');

			// `import { renderCover as makeCover, renderDiagram } from '../render/index.ts'`
			// 에서 **지역 이름**(makeCover·renderDiagram)을 뽑는다.
			// ⚠️ named import 만 보면 `import * as R` 이나 동적 import 를 못 본다(6차).
			//    그런 경로는 **이 검사가 감당 못 한다**는 뜻이므로 조용히 넘기지 않고 실패시킨다.
			for (const [shape, pattern] of [
				// ⚠️ 작은따옴표만 보다가 큰따옴표 변형을 놓쳤다(7차). 둘 다 본다.
				['namespace import', /import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*render\/index\.ts['"]/],
				['동적 import', /import\s*\(\s*['"][^'"]*render\/index\.ts['"]\s*\)/],
				['re-export', /export\s*\*\s*from\s*['"][^'"]*render\/index\.ts['"]/],
			] as const) {
				assert.equal(
					pattern.test(code),
					false,
					`${file} 이 ${shape} 로 렌더를 들여온다 — 이 검사가 못 따라간다. ` +
						'named import 로 바꾸거나 이 테스트를 확장하라.',
				);
			}

			const importBlock = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*render\/index\.ts['"]/s.exec(code);
			const localNames = (importBlock?.[1] ?? '')
				.split(',')
				.map((part) => part.trim())
				.filter((part) => /^render(?:Diagram|Cover|Sequence)\b/.test(part))
				.map((part) => (part.split(/\s+as\s+/)[1] ?? part).trim())
				.filter((name) => name.length > 0);
			if (localNames.length === 0) continue;

			const called = new RegExp(`\\b(?:${localNames.join('|')})\\s*\\(`);
			const fileBlocks = code.split(/\bserver\.registerTool\(/).slice(1);
			blocks = blocks.concat(fileBlocks);
			for (const block of fileBlocks) {
				const name = /^\s*'([a-z_]+)'/.exec(block)?.[1];
				if (name && called.test(block)) rendering.push(name);
			}
		}

		assert.ok(blocks.length >= 3, `registerTool 블록을 못 찾았다: ${blocks.length}`);
		assert.deepEqual(
			rendering.sort(),
			[...CHROME_TOOLS].sort(),
			'렌더를 부르는 도구와 CHROME_TOOLS 가 다르다 — 목록과 기동 안내를 갱신하라',
		);
	});

	test('P24 — 발행이 dist 검증을 반드시 거친다', async () => {
		// 코덱스 지적: 테스트는 `src/index.ts` 를 띄우는데 사용자가 실행하는 건
		// `dist/index.js` 다. `dist/` 는 .gitignore 대상이라 lint·테스트가 안 닿는다.
		// 그래서 dist 에서만 깨진 상태는 267개가 다 통과해도 안 잡힌다.
		//
		// `prepublishOnly` 는 `npm publish` 가 **반드시** 거치는 자리다.
		// 이 테스트는 그 관문이 조용히 빠지는 것을 막는다.
		const pkg = await json(new URL('package.json', ROOT));
		const scripts = pkg['scripts'] as Record<string, string>;

		// ⚠️ 처음엔 낱말만 봤다. 코덱스 반례 — `echo build verify:dist`,
		//    `npm run build; npm run verify:dist`, `... || true` 가 전부 통과한다.
		//    가운데 것은 **빌드가 실패해도** 낡은 dist 검증이 성공하면 발행이 계속된다.
		//    그래서 정확한 명령을 못 박는다.
		//
		// ★★ 관문이 `verify` 를 부르도록 바뀌었다. 예전에는 build 와 verify:dist 만
		//   돌아서 **로직 회귀를 잡는 테스트가 발행 경로에 없었다.** 실측 — 교착 가드를
		//   지운 회귀가 예전 관문은 통과하고 새 관문은 막는다.
		//   한 단계 간접이 생겼으므로 **끝까지 따라가서** 확인한다. 이름만 보고
		//   넘어가면 `verify` 가 속이 비어도 통과한다.
		assert.equal(
			scripts['prepublishOnly'],
			'npm run verify',
			'앞이 실패하면 멈춰야 한다 — `;` 나 `|| true` 는 관문이 아니다',
		);
		assert.equal(
			scripts['verify'],
			'npm run typecheck && npm run lint && npm test && npm run build && npm run verify:dist',
			'발행 관문이 부르는 verify 가 비었거나 && 로 이어지지 않는다',
		);

		// ⚠️ 정규식이면 `node scripts/verify-dist.ts || true` 나 `echo scripts/verify-dist.ts`
		//    도 통과한다(코덱스 5차 반례). 한 단계 안쪽에 우회가 남아 있었다.
		assert.equal(
			scripts['verify:dist'],
			'node scripts/verify-dist.ts',
			'`|| true` 나 echo 로 바꿔치기할 수 없게 정확히 고정한다',
		);
		await access(new URL('scripts/verify-dist.ts', ROOT), constants.R_OK);
	});

	test('P23b — 범위 판정을 흉내 내지 않고 실제 semver 를 쓴다', () => {
		// ⚠️ 최소 semver 를 직접 썼었다. 이 lock 의 (범위,버전) 280쌍과는 전부 일치했지만,
		//    코덱스가 **lock 에 없는 모양**으로 네 개의 불일치를 찾았다:
		//      0.0.4 vs ^0.0.3 / prerelease 세 경우.
		//    "흉내를 정교하게 만드는 건 끝이 없다" — 관문에서 SDK 스키마 대신 **실제
		//    클라이언트**를 붙인 것과 같은 판단으로, 여기도 실제 `semver` 를 쓴다.
		//    이 사례들은 그 교체가 되돌아가면 깨지라고 남긴다.
		for (const [version, range] of [
			['0.0.4', '^0.0.3'],
			['1.3.0-beta.1', '^1.2.3'],
			['1.3.0-beta.1', '>=1.2.3 <2.0.0'],
			['2.1.0-beta.1', '^1.2.3 || ^2.0.0'],
		] as const) {
			assert.equal(satisfies(version, range), false, `${version} 은 ${range} 에 안 맞는다`);
		}

		// integrity 규칙도 **직접 나쁜 값을 먹여** 시험한다. 실제 lock 만 훑으면
		// 규칙을 되돌려도 안 걸린다(변이 검증에서 실제로 살아남았다).
		const realDigest = 'A'.repeat(86) + '=='; // 디코딩하면 정확히 64바이트
		assert.equal(integrityLooksValid(`sha512-${realDigest}`), true, '정상 sha512 를 거부한다');
		for (const bad of [
			undefined,
			'',
			'sha512-',
			'sha512-====',
			'sha512-AAAAAAAAAAAAAAAAAAAA', // 20자 — 15바이트
			`sha512-${'A'.repeat(88)}`, // 88자지만 디코딩하면 66바이트
			`sha256-${realDigest}`, // sha256 인데 64바이트
			'md5-AAAAAAAAAAAAAAAAAAAAAA==',
			`sha512-${realDigest}-garbage`, // 정상 digest 뒤에 꼬리 — ssri strict 는 거부한다

		]) {
			assert.equal(integrityLooksValid(bad), false, `못 잡았다: ${String(bad)}`);
		}

		// 맞는 것도 함께 본다 — '무조건 false' 로 바꿔도 통과하면 안 되니까.
		for (const [version, range] of [
			['0.0.3', '^0.0.3'],
			['1.2.4', '^1.2.3'],
			['8.20.0', '^8.17.1'],
		] as const) {
			assert.equal(satisfies(version, range), true, `${version} 은 ${range} 에 맞는다`);
		}
	});

	test('P26 — 관문 자체를 검증하는 장치가 저장소에 있다', async () => {
		// ⚠️ 관문 변이 검증을 한동안 세션 스크래치패드에서만 돌렸다. 코덱스 지적 —
		//    저장소에 없으면 그 논리를 감사할 수 없고, 관문 회귀가 274개를 그대로 통과한다.
		//    그리고 그때는 **한 방향만** 봤다: 검사를 빼서 불량이 통과하는지.
		//    그것만으로는 **원래 관문도 그 불량을 못 잡던 경우**를 구분 못 한다.
		const script = await readFile(new URL('scripts/gate-mutation.sh', ROOT), 'utf8');

		// 양방향을 다 보는지 — 온전한 관문이 막는지(①)와 검사를 빼면 통과하는지(②).
		assert.match(script, /caught/, '온전한 관문이 불량을 막는지 안 본다');
		assert.match(script, /slipped/, '검사를 빼면 통과하는지 안 본다');
		assert.match(
			script,
			/if \[ "\$caught" -eq 0 \]; then/,
			'①(온전한 관문이 못 잡음)을 실패로 세지 않는다',
		);

		// ⚠️ `fail == 0` 만 요구하면 **검사를 통째로 건너뛰어도** 0/0 으로 성공한다(8차 반례).
		//    실제로 몇 개가 돌았는지 함께 요구해야 한다.
		assert.match(script, /EXPECTED=\d+/, '기대 검사 수를 안 정한다');
		assert.match(
			script,
			/if \[ "\$ran" -ne "\$EXPECTED" \]; then/,
			'실행된 검사 수를 요구하지 않는다 — 건너뛰어도 성공한다',
		);

		// 관문의 주요 검사가 전부 대상인지. 하나라도 빠지면 그 검사는 회귀해도 안 걸린다.
		// ⚠️ 8차의 핵심 수정(실제 클라이언트·소스 대조)이 정작 이 목록에 없었다(9차 반례) —
		//    그 관문을 약화해도 변이 검증이 계속 초록이었다. 새 검사를 넣으면 여기도 넣는다.
		for (const covered of [
			'shebang',
			'외피 스키마',
			'결과 스키마',
			'개인정보',
			'조기 종료',
			'낡은 산출물',
			'대상을 바꾸지 않',
			'소스 대조: 이름 약화',
			'소스 대조: 스냅샷 드리프트',
			'실제 클라이언트 (protocolVersion)',
			'조건부 모드 (ALLOW_PROFILE)',
			'조건부 모드 (ALLOW_PUBLIC)',
		]) {
			assert.ok(script.includes(covered), `관문 변이 목록에 '${covered}' 가 없다`);
		}

		// timeout(124)·명령 부재(127)·node 크래시(1)를 '잡았다'로 세면 관문이 매달리거나
		// 죽어도 초록이다(9차 + 반영 검토 반례). fail() 은 exit 2 로 구분한다.
		assert.match(
			script,
			/if \[ "\$caught" -ne "\$GATE_FAIL" \]; then/,
			'관문 실패(GATE_FAIL=2)와 실행 이상(1·124·127)을 구분하지 않는다',
		);
		assert.match(script, /GATE_FAIL=2/, '관문 실패 코드가 크래시(1)와 같아 구분 불가다');

		// 변이 관문이 **정상 dist 를 통과시키는지** 기준선을 안 보면, 관문을 파괴하는
		// 변이도 '겹침' 으로 오판한다(9차 반영 검토 반례 — protocolVersion 이 그랬다).
		assert.match(
			script,
			/if \[ "\$sane" -ne 0 \]; then/,
			'변이 관문의 정상 dist 기준선을 확인하지 않는다 — 관문 파괴를 겹침으로 오판한다',
		);

		// ⚠️ 플래그 4조합 행렬 자체도 고정한다 — 두 독립 행(프로필만·공개만)을 지워
		//    {0,0}·{1,1} 만 남겨도 모든 검증이 초록이었다(10차 반례). 독립 플래그는
		//    `PROFILE || PUBLIC` 같은 오계산을 조합 {1,0}·{0,1} 에서만 드러낸다.
		const gateSource = await readFile(new URL('scripts/verify-dist.ts', ROOT), 'utf8');
		for (const row of [
			"['기본', {}]",
			"['프로필만', { VELOG_ALLOW_PROFILE: '1' }]",
			"['공개만', { VELOG_ALLOW_PUBLIC: '1' }]",
			"['모든 옵션', { VELOG_ALLOW_PROFILE: '1', VELOG_ALLOW_PUBLIC: '1' }]",
		]) {
			assert.ok(gateSource.includes(row), `소스-dist 대조 모드 행렬에 ${row} 가 없다`);
		}
	});

	test('P23 — 의존성 트리 전체를 고정해서 발행한다', async () => {
		// 코덱스 지적: `@milcho0604/velog-mcp@0.4.0` 을 정확히 핀해도 **그 안의 의존성은
		// 안 고정된다**(`^1.30.0`, `^4.4.3`). 나중 콜드 설치는 같은 0.4.0 이어도 더 새
		// 의존성을 받고, 그 코드는 **토큰이 든 같은 프로세스에서** 돈다.
		// `npm-shrinkwrap.json` 은 package-lock 과 달리 발행물에 실려 트리를 고정한다.
		const pkg = await json(new URL('package.json', ROOT));
		const shrink = await json(new URL('npm-shrinkwrap.json', ROOT));

		assert.equal(shrink['version'], pkg['version'], 'shrinkwrap 버전이 패키지와 다르다');

		// `files` 화이트리스트에 없으면 tarball 에 안 실린다 — 실측으로 확인했다.
		assert.ok(
			(pkg['files'] as string[]).includes('npm-shrinkwrap.json'),
			'files 에 없으면 발행물에 안 실려서 고정이 무의미해진다',
		);

		const packages = shrink['packages'] as Record<
			string,
			{ dev?: boolean; version?: string; integrity?: string }
		>;

		// 루트 버전은 두 곳에 있다. 하나만 맞으면 도구마다 다르게 읽는다.
		assert.equal(packages['']?.version, pkg['version'], 'shrinkwrap 의 packages[""] 버전이 다르다');

		// 루트가 선언한 의존성과 shrinkwrap 이 아는 의존성이 같아야 한다.
		assert.deepEqual(
			(packages['']as { dependencies?: Record<string, string> }).dependencies,
			pkg['dependencies'],
			'shrinkwrap 이 아는 루트 의존성이 package.json 과 다르다',
		);

		// ⚠️ 처음엔 '운영 항목 수 > 50' 만 봤다(zod 를 지워도 92개라 통과).
		//    그다음엔 직접 의존성만 봤다 — 그것도 부족했다. **전이 의존성까지 전부**
		//    정확한 버전과 integrity 를 가져야 "트리를 고정했다"고 말할 수 있다.
		const production = Object.keys(packages).filter((key) => key && !packages[key]?.dev);
		assert.ok(production.length > 50, `고정된 운영 의존성이 너무 적다: ${production.length}`);

		const broken = production.filter((key) => {
			const entry = packages[key];
			// 정확한 버전만 인정한다 — 끝을 고정하지 않으면 `9.9.9-not-real` 도 통과한다.
			if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry?.version ?? '')) return true;
			return !integrityLooksValid(entry?.integrity);
		});
		assert.deepEqual(broken, [], `버전이나 integrity 가 온전치 않은 항목이 있다`);

		// 직접 의존성은 이름으로도 한 번 더 확인한다 — 통째로 사라지는 경우를 잡는다.
		// ⚠️ `dev: true` 를 붙이면 위의 운영 목록에서 빠져 검사를 통째로 우회한다(6차 반례).
		for (const name of Object.keys(pkg['dependencies'] as Record<string, string>)) {
			const entry = packages[`node_modules/${name}`];
			assert.ok(entry, `${name} 이 shrinkwrap 에 없다`);
			assert.notEqual(entry.dev, true, `${name} 은 운영 의존성인데 dev 로 표시돼 있다`);
		}

		// ★ 전이 의존성까지 **풀리는지** 본다. 개수만 세면 `ajv` 를 지워도 92개라 통과한다.
		//   node_modules 해석 규칙대로 위로 올라가며 찾는다.
		// ⚠️ 처음엔 '항목이 있기만 하면' 통과였다. 코덱스 7차 반례 —
		//    ① 찾은 항목이 `dev:true` 여도 통과 ② 선언한 범위와 **안 맞는** 버전이어도 통과.
		//    실제로 `body-parser` 가 요구하는 `content-type@^2.0.0` 의 중첩 항목을 지우면
		//    호환되지 않는 루트 `1.0.5` 를 찾아 정상이라고 했다.
		const resolves = (fromPath: string, name: string, range: string): boolean => {
			// `node_modules/a/node_modules/b` → 후보: 그 안 → 바깥 → … → 루트
			const segments = fromPath === '' ? [] : fromPath.split('/node_modules/');
			for (let depth = segments.length; depth >= 0; depth -= 1) {
				const prefix = segments.slice(0, depth).join('/node_modules/');
				const candidate = prefix ? `${prefix}/node_modules/${name}` : `node_modules/${name}`;
				const entry = packages[candidate];
				if (!entry) continue;
				// node_modules 해석은 **처음 만난 것**을 쓴다. 그게 안 맞으면 못 쓰는 것이다.
				if (entry.dev === true) return false;
				return satisfies(entry.version ?? '', range);
			}
			return false;
		};

		const unresolved: string[] = [];
		for (const key of ['', ...production]) {
			const entry = packages[key] as { dependencies?: Record<string, string> } | undefined;
			for (const [name, range] of Object.entries(entry?.dependencies ?? {})) {
				if (!resolves(key, name, range)) {
					unresolved.push(`${key || '<루트>'} → ${name}@${range}`);
				}
			}
		}
		assert.deepEqual(unresolved, [], '풀리지 않는 의존성이 있다 — 트리가 온전히 고정되지 않았다');
	});

	test('P12 — .mcp.json 의 env 에는 실제 값이 들어갈 수 없다', async () => {
		const mcp = await json(new URL('.mcp.json', PLUGIN));
		const env = (mcp['mcpServers'] as Record<string, { env?: Record<string, string> }>)['velog']
			?.env;
		assert.ok(env);

		// 이 파일은 공개 저장소에 있다. 값을 직접 적는 순간 그게 그대로 공개된다.
		// 형태를 강제해두면 실수로 넣을 수가 없다.
		//
		// `VELOG_*` 만 본다 — 사용자 값이 들어오는 자리는 그것뿐이다.
		// `npm_config_*` 같은 동작 스위치(P17)는 값이 리터럴이어야 의미가 있다.
		for (const [key, value] of Object.entries(env)) {
			if (!key.startsWith('VELOG_')) continue;
			assert.match(
				value,
				/^\$\{user_config\.[A-Za-z_][A-Za-z0-9_]*\}$/,
				`${key} 에 자리표시자가 아닌 값이 들어 있다`,
			);
		}
	});
});
