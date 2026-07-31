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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dumpDom, screenshot } from './chrome.ts';
import {
	type AuditReport,
	type DiagramSpec,
	buildDiagramHtml,
	parseAudit,
} from './page.ts';
import { type CoverAudit, type CoverSpec, buildCoverHtml } from './cover.ts';

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

async function render<A extends { w: number; h: number }>(
	args: RunArgs,
	parse: (dom: string) => A,
): Promise<RenderResult<A>> {
	const dir = await mkdtemp(join(tmpdir(), 'velog-mcp-render-'));
	const profileDir = await mkdtemp(join(tmpdir(), 'velog-mcp-chrome-'));
	const htmlPath = join(dir, `${args.basename}.html`);
	const pngPath = join(dir, `${args.basename}.png`);

	try {
		await writeFile(htmlPath, args.html, 'utf8');
		const fileUrl = pathToFileURL(htmlPath).href;

		const dom = await dumpDom(fileUrl, { profileDir });
		const audit = parse(dom);

		await screenshot(fileUrl, pngPath, {
			profileDir,
			width: audit.w,
			height: audit.h,
			scale: args.scale,
		});

		const { stat } = await import('node:fs/promises');
		const info = await stat(pngPath).catch(() => null);
		if (!info) {
			throw new Error(
				'크롬이 PNG 를 만들지 못했습니다. 화면 크기가 비정상이거나(0 이하) ' +
					'크롬 실행이 중간에 끊겼을 수 있습니다.',
			);
		}

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
		// 크롬 프로필은 임시 산출물이라 항상 지운다. 렌더 결과(dir)는 남긴다 —
		// 사용자가 HTML 을 열어 손보거나 PNG 를 다시 쓸 수 있어야 한다.
		await rm(profileDir, { recursive: true, force: true }).catch(() => {});
	}
}

export function renderDiagram(
	spec: DiagramSpec,
	scale = 2,
): Promise<RenderResult<AuditReport>> {
	return render({ html: buildDiagramHtml(spec), basename: 'diagram', scale }, parseAudit);
}

export function renderCover(
	spec: CoverSpec,
	scale = 2,
): Promise<RenderResult<CoverAudit>> {
	return render({ html: buildCoverHtml(spec), basename: 'cover', scale }, (dom) => {
		const match = /<title>AUDIT (\{.*?\})<\/title>/s.exec(dom);
		if (!match?.[1]) throw new Error('표지 렌더 결과를 읽지 못했습니다.');
		return JSON.parse(match[1]) as CoverAudit;
	});
}

export { type DiagramSpec, type AuditReport, formatAudit } from './page.ts';
export { type CoverSpec, type CoverAudit, formatCoverAudit } from './cover.ts';
export { ICON_NAMES } from './icons.ts';
export { TONE_NAMES } from './tones.ts';
