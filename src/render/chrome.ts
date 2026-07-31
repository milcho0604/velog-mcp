/**
 * 헤드리스 크롬 실행기.
 *
 * ★ 왜 puppeteer 를 안 쓰나
 *   이 저장소는 런타임 의존성을 2개(MCP SDK, zod)로 묶어두고 그걸 테스트(A6)로
 *   강제한다. puppeteer 는 크로미움을 통째로 내려받아 설치 용량이 수백 MB 늘고,
 *   MCP 서버는 사용자 기기에서 도는 물건이라 그 비용이 그대로 사용자에게 간다.
 *   우리가 필요한 건 '스크린샷 한 장'뿐이라 이미 깔린 크롬을 CLI 로 부른다.
 *
 * ★ 렌더 페이지가 밖으로 나갈 수 없는 이유 — 순서가 중요하다
 *   **1차 방어는 '나갈 구멍이 없다'는 것이다.** 페이지에는 URL 을 받는 자리가 하나도
 *   없다 — 아이콘은 내장 도형이고, `href`·`src`·`fetch` 를 쓰지 않으며, `url(...)` 은
 *   문서 안 marker 참조(`url(#arr-…)`) 뿐이다. 이건 테스트가 강제한다.
 *   **2차 방어가 `--host-resolver-rules=MAP * ~NOTFOUND` 다.** 나중에 누가 실수로
 *   원격 리소스를 넣어도 이름을 못 찾게 막는다.
 *   ⚠️ 다만 이 플래그는 **이름 풀이를 막는 것**이라, IP 를 직접 적은 주소
 *   (`http://93.184.216.34/…`)까지 막아주지는 않는다. 그러니 2차를 믿고 1차를
 *   느슨하게 하면 안 된다 — 페이지에 URL 자리를 만들지 않는 게 본질이다.
 *
 * ★ 사용자의 크롬 프로필을 건드리지 않는다
 *   `--user-data-dir` 을 임시 폴더로 지정한다. 지정하지 않으면 기본 프로필을
 *   열려다 이미 떠 있는 크롬과 충돌하고, 로그인 세션이 있는 프로필에서 렌더하게 된다.
 *
 * ★★ 크롬이 끝나기를 기다리지 않는다 — 안 끝나기 때문이다
 *   Chrome 150 의 새 헤드리스는 `--dump-dom` 결과를 **1.7초 만에 stdout 으로 내놓고도
 *   프로세스를 유지한다** (실측: 30초를 더 기다려도 종료 안 함). 종료를 기다리는
 *   구현이었을 때 그림 한 장에 90초가 걸렸다 — 실제 작업은 2초인데 나머지는 전부
 *   기다림이었다.
 *   그래서 **산출물이 완성됐는지 직접 보고** 확인되면 프로세스를 끝낸다.
 *   PNG 는 크기가 아니라 마지막 IEND 청크로 판정한다. 크기 비교는 쓰다 만 파일을
 *   완성으로 오인할 수 있다.
 */

import { spawn } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { platform } from 'node:process';

const CANDIDATES: Record<string, readonly string[]> = {
	darwin: [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
		'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
	],
	linux: [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/bin/microsoft-edge',
		'/snap/bin/chromium',
	],
	win32: [
		'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
		'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
	],
};

export class ChromeNotFoundError extends Error {
	constructor() {
		super(
			'그림을 그리려면 크롬(또는 크로미움 계열 브라우저)이 필요한데 찾지 못했습니다.\n' +
				'설치돼 있다면 VELOG_CHROME_PATH 환경변수에 실행 파일 경로를 지정하세요.\n' +
				'예) VELOG_CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"',
		);
		this.name = 'ChromeNotFoundError';
	}
}

let cached: string | undefined;

/** 크롬 실행 파일을 찾는다. 결과는 프로세스 수명 동안 재사용한다. */
export async function findChrome(): Promise<string> {
	if (cached) return cached;

	const override = process.env['VELOG_CHROME_PATH'];
	if (override) {
		// 지정했는데 없으면 조용히 다른 걸 쓰지 않는다 — 의도한 브라우저로 그려야 한다.
		await access(override, constants.X_OK).catch(() => {
			throw new Error(`VELOG_CHROME_PATH 로 지정한 파일을 실행할 수 없습니다: ${override}`);
		});
		cached = override;
		return override;
	}

	for (const path of CANDIDATES[platform] ?? []) {
		const ok = await access(path, constants.X_OK).then(
			() => true,
			() => false,
		);
		if (ok) {
			cached = path;
			return path;
		}
	}
	throw new ChromeNotFoundError();
}

/** 테스트에서 탐색 결과를 되돌리기 위한 것. 운영 경로에서는 부르지 않는다. */
export function resetChromeCache(): void {
	cached = undefined;
}

const BASE_FLAGS: readonly string[] = [
	'--headless',
	'--disable-gpu',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-extensions',
	'--disable-background-networking',
	'--disable-component-update',
	'--disable-sync',
	'--disable-default-apps',
	'--mute-audio',
	'--hide-scrollbars',
	// 네트워크 원천 차단. 이 페이지는 외부를 볼 일이 없다.
	'--host-resolver-rules=MAP * ~NOTFOUND',
];

interface RunOptions {
	readonly profileDir: string;
	readonly timeoutMs?: number;
}

/** 산출물이 다 나왔는지 판정한다. true 가 되는 순간 크롬을 끝낸다. */
type Ready = (stdout: string) => boolean | Promise<boolean>;

function tail(text: string, lines = 4): string {
	return text.trim().split('\n').slice(-lines).join('\n');
}

function run(
	chrome: string,
	args: readonly string[],
	options: RunOptions,
	ready: Ready,
): Promise<string> {
	const full = [...BASE_FLAGS, `--user-data-dir=${options.profileDir}`, ...args];
	const limit = options.timeoutMs ?? 30_000;

	return new Promise((resolve, reject) => {
		const child = spawn(chrome, full, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		let settled = false;

		child.stdout.on('data', (chunk: Buffer) => {
			out += chunk.toString('utf8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			// ★ 크롬은 정상 동작 중에도 stderr 에 경고를 쏟는다. 실패 판정에 쓰지 않고
			//   오류 메시지에 붙일 꼬리만 남긴다. 무한정 모으지 않는다.
			if (err.length < 8000) err += chunk.toString('utf8');
		});

		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			clearTimeout(deadline);
			child.kill('SIGKILL');
			action();
		};

		const check = (onNotReady?: () => void): void => {
			void (async () => {
				const ok = await Promise.resolve(ready(out)).catch(() => false);
				if (ok) finish(() => { resolve(out); });
				else onNotReady?.();
			})();
		};

		const poll = setInterval(() => { check(); }, 120);
		const deadline = setTimeout(() => {
			finish(() => {
				reject(new Error(`크롬이 ${limit}ms 안에 결과를 내지 못했습니다.\n${tail(err)}`));
			});
		}, limit);

		child.on('error', (cause: Error) => {
			finish(() => { reject(new Error(`크롬을 실행하지 못했습니다: ${cause.message}`)); });
		});
		child.on('exit', (code) => {
			// 스스로 끝난 경우. 산출물이 있으면 성공, 없으면 진짜 실패다.
			check(() => {
				finish(() => {
					reject(new Error(`크롬이 결과 없이 종료했습니다 (code ${String(code)})\n${tail(err)}`));
				});
			});
		});
	});
}

/** PNG 가 끝까지 쓰였는지 — 마지막 IEND 청크로 확인한다. */
async function pngComplete(path: string): Promise<boolean> {
	const buf = await readFile(path).catch(() => null);
	if (!buf || buf.length < 16) return false;
	const end = buf.subarray(buf.length - 8);
	return (
		end[0] === 0x49 && end[1] === 0x45 && end[2] === 0x4e && end[3] === 0x44 &&
		end[4] === 0xae && end[5] === 0x42 && end[6] === 0x60 && end[7] === 0x82
	);
}

/** 스크립트가 다 돈 뒤의 DOM 을 문자열로 받는다. 자가감사 결과를 읽는 데 쓴다. */
export async function dumpDom(
	fileUrl: string,
	options: RunOptions,
): Promise<string> {
	const chrome = await findChrome();
	// 스크립트가 동기라 load 시점이면 이미 끝나 있다. </html> 이 오면 그만 기다린다.
	return run(chrome, ['--dump-dom', fileUrl], options, (out) => out.includes('</html>'));
}

export interface ShotOptions extends RunOptions {
	readonly width: number;
	readonly height: number;
	/** 2 = 레티나 배율. 블로그에 올릴 그림은 2배로 뽑아야 글자가 안 흐리다. */
	readonly scale?: number;
}

export async function screenshot(
	fileUrl: string,
	outPath: string,
	options: ShotOptions,
): Promise<void> {
	const chrome = await findChrome();
	await run(
		chrome,
		[
			`--window-size=${options.width},${options.height}`,
			`--force-device-scale-factor=${options.scale ?? 2}`,
			`--screenshot=${outPath}`,
			fileUrl,
		],
		options,
		() => pngComplete(outPath),
	);
}
