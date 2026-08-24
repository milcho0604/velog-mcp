/**
 * 렌더 실행기 — HTML 을 만들고, 자가감사 결과를 읽고, PNG 를 뽑는다.
 *
 * 크롬을 두 번 부른다.
 *   ① `--dump-dom` : 스크립트가 계산한 캔버스 크기와 자가감사 결과를 받는다.
 *   ② `--screenshot`: ①에서 받은 크기로 정확히 찍는다.
 * 한 번에 하려면 창 크기를 미리 알아야 하는데, 그 크기는 글자 실측 뒤에야 정해진다.
 * 즉 이 왕복이 "글자 폭을 추정하지 않는다"는 규칙의 대가다. 한 번에 1초 남짓이다.
 *
 * ★ 이 모듈은 토큰을 만지지 않는다. 파일을 쓰는 건 렌더 산출물뿐이다.
 *   (safety.test.ts 의 A5 가 '파일을 쓰는 모듈은 토큰 경로를 참조하지 않는다'로
 *    이 분리를 강제한다.)
 */

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { makeSerializer } from '../serial.ts';
import { dumpDom, screenshot } from './chrome.ts';
import {
	type AuditReport,
	type DiagramSpec,
	MAX_AREA,
	MAX_DIM,
	buildDiagramHtml,
	parseAudit,
} from './page.ts';
import { type CoverAudit, type CoverSpec, buildCoverHtml } from './cover.ts';
import {
	type SequenceAudit,
	type SequenceSpec,
	buildSequenceHtml,
	parseSequenceAudit,
} from './sequence.ts';

export interface RenderResult<A> {
	/** 뽑아낸 PNG 경로 */
	pngPath: string;
	/** 손으로 고치고 싶을 때 열어보는 HTML */
	htmlPath: string;
	width: number;
	height: number;
	scale: number;
	audit: A;
	bytes: number;
}

interface RunArgs {
	html: string;
	basename: string;
	scale: number;
}

/**
 * 렌더는 한 번에 하나만 돈다.
 *
 * ★ 실측: 렌더 1회가 크롬 프로세스 9개로 최대 약 1GB 를 쓴다. 동시에 2회를 돌리면
 *   17개·약 1.9GB 로 **선형으로 늘어난다.** MCP 클라이언트는 도구를 병렬로 부르므로
 *   모델이 그림 다섯 장을 한 번에 요청하면 크롬 45개·6GB 가 된다.
 *   사용자 기기에서 도는 물건이 그러면 안 된다 — 다른 작업까지 같이 죽는다.
 *
 * 그림 한 장은 4초면 끝나므로 줄 세워도 체감 손해가 거의 없다
 * (실측 2026-08-07: 3.9초/장 → 60초에 15장). 얻는 것이 훨씬 크다.
 *
 * ★ 구현은 src/serial.ts 로 옮겼다. 업로드도 같은 이유로 줄이 필요해졌는데,
 *   같은 코드를 두 벌 두면 한쪽만 고치게 된다.
 */
const serialize = makeSerializer();

const RENDER_PREFIX = 'velog-mcp-render-';
const PROFILE_PREFIX = 'velog-mcp-chrome-';
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * 오래된 렌더 산출물을 치운다.
 *
 * 방금 만든 건 지우지 않는다 — 사용자가 HTML 을 열어 손보거나 PNG 를 다시 쓸 수 있어야
 * 해서 경로를 돌려주기 때문이다. 대신 하루가 지난 건 아무도 안 본다.
 * 지우는 대상은 **우리가 만든 이름표가 붙은 것**뿐이다. 임시폴더의 남의 파일은 건드리지 않는다.
 */
async function sweepOld(): Promise<void> {
	const base = tmpdir();
	const cutoff = Date.now() - KEEP_MS;
	const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(RENDER_PREFIX) && !entry.name.startsWith(PROFILE_PREFIX)) continue;
		const full = join(base, entry.name);
		const info = await stat(full).catch(() => null);
		if (info && info.mtimeMs < cutoff) {
			await rm(full, { recursive: true, force: true }).catch(() => {});
		}
	}
}

async function render<A extends { w: number; h: number }>(
	args: RunArgs,
	parse: (dom: string) => A,
): Promise<RenderResult<A>> {
	// 정리 실패가 렌더를 막으면 안 된다 — 청소는 부수적인 일이다.
	await sweepOld().catch(() => {});

	// ★ 폴더 생성도 try 안에서 한다. 밖에 두면 두 번째 생성만 실패했을 때 앞서 만든
	//   것들이 finally 에 도달하지 못하고 남는다.
	// 프로필만 finally 에서 지운다. 렌더 결과(dir)는 남겨야 하므로 밖에 둘 이유가 없다.
	let profileA = '';
	let profileB = '';
	// ★ 결과 디렉터리는 **성공했을 때만** 남긴다. 예전엔 실패해도 남겨서,
	//   감사 파싱이나 스크린샷이 반복 실패하면 HTML 과 쓰다 만 PNG 가 든 폴더가
	//   매번 하나씩 쌓였다. 청소(sweepOld)는 다음 렌더가 돌 때만, 그것도 24시간이
	//   지난 것만 거둬가므로 다시 안 그리면 영영 남는다.
	//   실패한 산출물은 사용자가 열어볼 이유도 없다 — 경로를 돌려주지 못하니까.
	let resultDir = '';
	let succeeded = false;
	try {
		const dir = await mkdtemp(join(tmpdir(), RENDER_PREFIX));
		resultDir = dir;
		// 크롬 두 번에 **서로 다른 프로필**을 준다. 산출물이 나오면 SIGKILL 하고 실제
		// 종료를 기다리지 않으므로, 같은 프로필을 재사용하면 앞선 크롬이 잠금을 놓기
		// 전에 다음 크롬이 같은 폴더를 열게 된다.
		profileA = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
		profileB = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
		const htmlPath = join(dir, `${args.basename}.html`);
		const pngPath = join(dir, `${args.basename}.png`);
		await writeFile(htmlPath, args.html, 'utf8');
		const fileUrl = pathToFileURL(htmlPath).href;

		const dom = await dumpDom(fileUrl, { profileDir: profileA });
		const audit = parse(dom);

		// 2차 방어. 1차는 페이지 안에서 크기를 **설정하기 전에** 거른다(page.ts).
		// 여기까지 왔다는 건 1차가 뚫렸다는 뜻이므로 그대로 두면 안 된다.
		if (audit.w > MAX_DIM || audit.h > MAX_DIM || audit.w * audit.h > MAX_AREA) {
			throw new Error(
				`그림이 너무 큽니다: ${audit.w}×${audit.h}px ` +
					`(상한 ${MAX_DIM}px / 면적 ${(MAX_AREA / 1_000_000).toFixed(0)}백만px).`,
			);
		}

		await screenshot(fileUrl, pngPath, {
			profileDir: profileB,
			width: audit.w,
			height: audit.h,
			scale: args.scale,
		});

		const info = await stat(pngPath).catch(() => null);
		if (!info) {
			throw new Error(
				'크롬이 PNG 를 만들지 못했습니다. 화면 크기가 비정상이거나(0 이하) ' +
					'크롬 실행이 중간에 끊겼을 수 있습니다.',
			);
		}

		succeeded = true;
		return {
			pngPath,
			htmlPath,
			width: audit.w,
			height: audit.h,
			scale: args.scale,
			audit,
			bytes: info.size,
		};
	} finally {
		// 크롬 프로필은 임시 산출물이라 항상 지운다. 렌더 결과(dir)는 **성공했을
		// 때만** 남긴다 — 사용자가 HTML 을 열어 손보거나 PNG 를 다시 쓸 수 있어야 한다.
		for (const profile of [profileA, profileB]) {
			if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
		}
		if (!succeeded && resultDir) {
			await rm(resultDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

export function renderDiagram(
	spec: DiagramSpec,
	scale = 2,
): Promise<RenderResult<AuditReport>> {
	return serialize(() =>
		render({ html: buildDiagramHtml(spec), basename: 'diagram', scale }, parseAudit),
	);
}

export function renderSequence(
	spec: SequenceSpec,
	scale = 2,
): Promise<RenderResult<SequenceAudit>> {
	return serialize(() =>
		render({ html: buildSequenceHtml(spec), basename: 'sequence', scale }, parseSequenceAudit),
	);
}

export function renderCover(
	spec: CoverSpec,
	scale = 2,
): Promise<RenderResult<CoverAudit>> {
	return serialize(() =>
		render({ html: buildCoverHtml(spec), basename: 'cover', scale }, (dom) => {
			const match = /<title>AUDIT (\{.*?\})<\/title>/s.exec(dom);
			if (!match?.[1]) throw new Error('표지 렌더 결과를 읽지 못했습니다.');
			return JSON.parse(match[1]) as CoverAudit;
		}),
	);
}

export { type DiagramSpec, type AuditReport, formatAudit } from './page.ts';
export { type CoverSpec, type CoverAudit, formatCoverAudit } from './cover.ts';
export {
	type SequenceSpec,
	type SequenceAudit,
	SEQ_KINDS,
	formatSequenceAudit,
} from './sequence.ts';
export { ICON_NAMES } from './icons.ts';
export { TONE_NAMES } from './tones.ts';
