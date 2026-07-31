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
import { readFile, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
	looksUnsubstituted,
	isBlank,
	normalizePluginEnv,
	describeAnomalies,
} from '../plugin-env.ts';
import { readAuthFromEnv } from '../auth.ts';
import { readCapabilities } from '../capabilities.ts';
import { findChrome, resetChromeCache } from '../render/chrome.ts';
import { SERVER_VERSION } from '../index.ts';

const ROOT = new URL('../../', import.meta.url);
const PLUGIN = new URL('plugins/velog/', ROOT);

async function json(url: URL): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(url, 'utf8')) as Record<string, unknown>;
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
	/**
	 * 코덱스가 짚은 구멍이다: `server.connect()` 를 통째로 지워도 기동 로그는 먼저
	 * 나오므로 P13/P14 가 전부 통과한다. 즉 "말은 하는데 서버가 아닌" 상태를 못 잡는다.
	 * 그래서 진짜 JSON-RPC 를 던지고 응답을 받는다.
	 */
	async function rpc(
		requests: readonly Record<string, unknown>[],
		env: NodeJS.ProcessEnv = {},
	): Promise<Array<Record<string, unknown>>> {
		const entry = fileURLToPath(new URL('index.ts', new URL('../', import.meta.url)));
		const child = spawn(process.execPath, [entry], {
			stdio: ['pipe', 'pipe', 'ignore'],
			env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
		});

		for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);

		// 알림(`id` 없음)에는 응답이 오지 않는다. 요청 수로 세면 영원히 안 차서
		// 매번 제한시간을 다 쓴다 — 실제로 그렇게 만들었다가 15초씩 걸렸다.
		const expected = requests.filter((request) => 'id' in request).length;

		let buffer = '';
		const received: Array<Record<string, unknown>> = [];
		return await new Promise((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				child.kill('SIGKILL');
				resolve(received);
			};
			const timer = setTimeout(done, 15_000);
			child.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString('utf8');
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						received.push(JSON.parse(line) as Record<string, unknown>);
					} catch {
						// 프로토콜 밖의 줄은 무시한다. stdout 은 MCP 전용이라 없어야 정상이다.
					}
				}
				if (received.length >= expected) done();
			});
			child.on('error', done);
			child.on('close', done);
		});
	}

	test('initialize 에 응답하고 도구 목록을 돌려준다', async () => {
		const responses = await rpc([
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
