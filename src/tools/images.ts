/**
 * 그림 도구 — 다이어그램·표지를 그리고 벨로그에 올린다.
 *
 * ## 왜 모델이 HTML 을 쓰게 하지 않았나
 *
 * 그림 스타일은 서버가 쥔다. 모델은 **무엇이 있고 무엇이 어디로 흐르는지**만 주고,
 * 색·여백·글자 실측·선 라운딩·자가감사는 렌더러가 한다. 이유는 두 가지다.
 *
 *   ① 품질 — 매번 다시 그리면 매번 다르게 생긴다. 규칙을 코드에 박아두면
 *      어느 글에 넣어도 같은 인상이 나온다.
 *   ② 안전 — 모델이 임의 HTML/JS 를 넘겨 브라우저에서 실행시킬 수 있으면
 *      그건 그냥 코드 실행 통로다. 데이터만 받으면 그 통로가 없다.
 *
 * ## 업로드에 건 방어
 *
 * `velog_upload_image` 는 로컬 파일을 받아 **공개 CDN** 으로 보낸다. 경로를 그대로
 * 믿으면 "이미지를 올려줘" 한 마디로 아무 파일이나 인터넷에 올라갈 수 있다.
 * 그래서 확장자가 아니라 **파일 앞부분 시그니처**로 진짜 이미지인지 확인한다.
 * SVG 는 통과시키지 않는다 — 텍스트라 시그니처로 가릴 수 없고, 스크립트를 품은 채
 * velcdn 도메인에서 서빙되면 그 자체가 문제가 된다.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { textResult } from '../format.ts';
import {
	type CoverSpec,
	type DiagramSpec,
	ICON_NAMES,
	TONE_NAMES,
	formatAudit,
	formatCoverAudit,
	renderCover,
	renderDiagram,
} from '../render/index.ts';
import { isHexColor } from '../render/tones.ts';

/** 우리가 올리는 것 — 서버 상한(30MB)보다 낮게 잡는다. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Sniffed {
	readonly mime: string;
	readonly ext: string;
}

/**
 * 파일 앞부분으로 형식을 판정한다. 확장자는 보지 않는다 — 이름은 누구나 바꾼다.
 * 여기서 통과하지 못하면 업로드하지 않는다.
 */
export function sniffImage(bytes: Uint8Array): Sniffed | null {
	const at = (i: number): number => bytes[i] ?? -1;
	if (
		at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 &&
		at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a
	) {
		return { mime: 'image/png', ext: 'png' };
	}
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
		return { mime: 'image/jpeg', ext: 'jpg' };
	}
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
		return { mime: 'image/gif', ext: 'gif' };
	}
	// RIFF....WEBP
	if (
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	) {
		return { mime: 'image/webp', ext: 'webp' };
	}
	return null;
}

/** 파일을 읽고 검사까지 한다. 통과 못 하면 이유를 그대로 말해준다. */
async function readImageFile(path: string): Promise<{ bytes: Uint8Array; kind: Sniffed }> {
	const info = await stat(path).catch(() => null);
	if (!info) throw new Error(`파일을 찾지 못했습니다: ${path}`);
	if (!info.isFile()) throw new Error(`파일이 아닙니다: ${path}`);
	if (info.size > MAX_UPLOAD_BYTES) {
		throw new Error(
			`파일이 너무 큽니다 (${(info.size / 1024 / 1024).toFixed(1)}MB). ` +
				`이 도구의 상한은 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 입니다.`,
		);
	}
	const bytes = new Uint8Array(await readFile(path));
	const kind = sniffImage(bytes);
	if (!kind) {
		throw new Error(
			`이미지 파일이 아닙니다: ${path}\n` +
				'PNG·JPEG·GIF·WebP 만 올립니다. 확장자가 아니라 파일 내용으로 판정합니다 ' +
				'(SVG 는 받지 않습니다).',
		);
	}
	return { bytes, kind };
}

const toneField = z
	.string()
	.refine((v) => TONE_NAMES.includes(v), `톤 이름이어야 합니다: ${TONE_NAMES.join(', ')}`);

const nodeSchema = z.object({
	id: z.string().optional().describe('선을 연결할 때 쓰는 이름. 생략하면 n0, n1 …'),
	x: z.number().describe('왼쪽 위 x. 원점은 아무 데나 잡아도 된다 — 캔버스는 자동으로 맞춘다'),
	y: z.number(),
	w: z.number().min(60).max(2400).optional().describe('생략하면 글자 실측으로 정한다'),
	h: z.number().min(36).max(1400).optional(),
	title: z.string().min(1),
	sub: z.string().optional().describe('두 번째 줄. 짧게'),
	icon: z
		.string()
		.refine((v) => ICON_NAMES.includes(v), `아이콘 이름: ${ICON_NAMES.join(', ')}`)
		.optional(),
	icon_tone: toneField.optional(),
	tag: z.string().optional().describe('오른쪽 위 작은 배지 (예: ":6820", "v2")'),
	tag_tone: toneField.optional(),
});

const groupSchema = z.object({
	name: z.string().min(1),
	sub: z.string().optional(),
	tone: toneField.optional(),
	members: z
		.array(z.string())
		.optional()
		.describe('이 노드들을 감싸도록 상자를 자동 계산한다. 좌표를 직접 줄 거면 생략'),
	x: z.number().optional(),
	y: z.number().optional(),
	w: z.number().optional(),
	h: z.number().optional(),
});

const edgeSchema = z.object({
	plane: z.string().optional().describe('흐름 종류 key (범례와 색이 여기서 갈린다)'),
	from: z.string().optional().describe('노드 id. 면을 고르려면 "id:right" 처럼'),
	to: z.string().optional(),
	points: z
		.array(z.tuple([z.number(), z.number()]))
		.optional()
		.describe('직접 꺾는 경우. 주면 from/to 대신 이 좌표를 쓴다'),
	label: z.string().optional(),
	label_at: z.tuple([z.number(), z.number()]).optional(),
	label_anchor: z.enum(['start', 'middle', 'end']).optional(),
});

const planeSchema = z.object({
	// ★ key 는 SVG marker 의 id 가 되고 `url(#arr-<key>)` 로 참조된다.
	//   자유 문자열이면 그 참조식이 깨지거나 다른 걸 가리키게 만들 수 있다.
	key: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,16}$/, '영숫자·밑줄·하이픈 1~16자만 (SVG id 가 된다)'),
	name: z.string().min(1),
	color: z.string().refine(isHexColor, '#rrggbb 형식만 받습니다'),
	// stroke-dasharray 는 길이 목록이다. 숫자·공백·쉼표 외에는 받지 않는다.
	dash: z
		.string()
		.regex(/^[\d.\s,]+$/, '숫자와 공백·쉼표만 (예: "6 4")')
		.optional()
		.describe('점선 (예: "6 4")'),
});

function markdown(alt: string, url: string): string {
	return `![${alt}](${url})`;
}

export function registerImageTools(server: McpServer, client: VelogClient): void {
	/** 렌더 결과를 올리고 결과 문구를 만든다. 감사에 걸린 게 있으면 올리지 않는다. */
	async function finish(args: {
		pngPath: string;
		htmlPath: string;
		width: number;
		height: number;
		scale: number;
		bytes: number;
		auditText: string;
		clean: boolean;
		upload: boolean;
		force: boolean;
		alt: string;
		postId?: string;
		what: string;
	}): Promise<string[]> {
		const lines: string[] = [];
		const px = `${args.width * args.scale}×${args.height * args.scale}px`;
		lines.push(`${args.what} 완성 — ${px} (${(args.bytes / 1024).toFixed(0)}KB)`);
		lines.push('');
		lines.push(args.auditText);
		lines.push('');

		if (args.upload && !args.clean && !args.force) {
			// ★ 감사에 걸린 그림은 올리지 않는다. 벨로그 업로드는 되돌릴 수 없고
			//   (삭제 API 가 없다) 계정 업로드 한도도 깎는다. 고쳐서 다시 그리는 게 맞다.
			lines.push('올리지 않았습니다 — 위 문제를 고쳐 다시 그리세요.');
			lines.push('그대로 올리려면 force_upload: true 를 주세요.');
			lines.push('');
			lines.push(`- 로컬 PNG: ${args.pngPath}`);
			lines.push(`- 편집용 HTML: ${args.htmlPath}`);
			return lines;
		}

		if (args.upload) {
			const bytes = new Uint8Array(await readFile(args.pngPath));
			const uploadOptions: Parameters<VelogClient['uploadImage']>[2] = args.postId
				? { type: 'post', contentType: 'image/png', refId: args.postId }
				: { type: 'post', contentType: 'image/png' };
			const url = await client.uploadImage(
				bytes,
				`${basename(args.pngPath, '.png')}.png`,
				uploadOptions,
			);
			lines.push('본문에 붙여넣을 마크다운:');
			lines.push('');
			lines.push(markdown(args.alt, url));
			lines.push('');
			lines.push(`- 이미지 주소: ${url}`);
		} else {
			lines.push('올리지 않았습니다 (upload: false).');
		}
		lines.push(`- 로컬 PNG: ${args.pngPath}`);
		lines.push(`- 편집용 HTML: ${args.htmlPath}`);
		return lines;
	}

	server.registerTool(
		'velog_render_diagram',
		{
			title: '다이어그램 그리기',
			description:
				'구성도·흐름도를 그려 PNG 로 만들고 벨로그에 올린다. 본문에 붙일 마크다운을 돌려준다.\n' +
				'좌표만 주면 나머지는 렌더러가 맞춘다 — 노드 폭·캔버스 크기·선 꺾임·라벨 위치는 ' +
				'브라우저 실측으로 정해지고, 글자 삐져나옴/선 관통/겹침은 자가감사가 잡는다.\n' +
				'감사에 걸리면 올리지 않고 무엇이 문제인지 알려준다 (force_upload 로 무시 가능).\n' +
				`아이콘: ${ICON_NAMES.join(' ')}\n톤: ${TONE_NAMES.join(' ')}`,
			inputSchema: {
				title: z.string().min(1).describe('그림 제목 (좌상단)'),
				subtitle: z.string().optional().describe('한 줄 설명·근거'),
				nodes: z.array(nodeSchema).min(1).max(60),
				groups: z.array(groupSchema).max(12).optional(),
				edges: z.array(edgeSchema).max(120).optional(),
				planes: z
					.array(planeSchema)
					.max(6)
					.optional()
					.describe('흐름 종류. 생략하면 요청/외부 호출/데이터/관측 4종'),
				legend: z.boolean().default(true),
				alt: z.string().optional().describe('이미지 대체 텍스트'),
				upload: z.boolean().default(true),
				force_upload: z.boolean().default(false),
				post_id: z
					.string()
					.optional()
					.describe('붙일 글 id. 주면 벨로그가 내 글인지 확인한 뒤 받는다'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			if (args.upload) client.requireAuth('velog_render_diagram');
			const spec: DiagramSpec = {
				title: args.title,
				nodes: args.nodes,
				legend: args.legend,
			};
			if (args.subtitle !== undefined) spec.subtitle = args.subtitle;
			if (args.groups !== undefined) spec.groups = args.groups;
			if (args.edges !== undefined) spec.edges = args.edges;
			if (args.planes !== undefined) spec.planes = args.planes;

			const result = await renderDiagram(spec);
			const a = result.audit;
			const clean =
				a.over.length === 0 &&
				a.compressed.length === 0 &&
				a.cross.length === 0 &&
				a.overlap.length === 0 &&
				a.collide.length === 0 &&
				a.label.length === 0;

			return textResult(
				(await finish({
					pngPath: result.pngPath,
					htmlPath: result.htmlPath,
					width: result.width,
					height: result.height,
					scale: result.scale,
					bytes: result.bytes,
					auditText: formatAudit(a),
					clean,
					upload: args.upload,
					force: args.force_upload,
					alt: args.alt ?? args.title,
					...(args.post_id ? { postId: args.post_id } : {}),
					what: '다이어그램',
				})).join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_render_cover',
		{
			title: '글 표지 만들기',
			description:
				'글 목록·SNS 미리보기에 쓸 표지 이미지(1200×630)를 만든다.\n' +
				'제목이 길면 줄바꿈하고, 그래도 안 들어가면 글자 크기를 줄인다 — 전부 실측 기준이다.\n' +
				'만든 뒤 velog_update_post 의 thumbnail 에 돌려받은 주소를 넣으면 표지가 된다.',
			inputSchema: {
				title: z.string().min(1),
				subtitle: z.string().optional(),
				kicker: z.string().optional().describe("상단 작은 라벨 (예: '디버깅 기록')"),
				tags: z.array(z.string()).max(6).optional(),
				tone: toneField.optional(),
				footer: z.string().optional().describe("우상단 서명 (예: '@milcho0604')"),
				upload: z.boolean().default(true),
				force_upload: z.boolean().default(false),
				post_id: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			if (args.upload) client.requireAuth('velog_render_cover');
			const spec: CoverSpec = { title: args.title };
			if (args.subtitle !== undefined) spec.subtitle = args.subtitle;
			if (args.kicker !== undefined) spec.kicker = args.kicker;
			if (args.tags !== undefined) spec.tags = args.tags;
			if (args.tone !== undefined) spec.tone = args.tone;
			if (args.footer !== undefined) spec.footer = args.footer;

			const result = await renderCover(spec);
			return textResult(
				(await finish({
					pngPath: result.pngPath,
					htmlPath: result.htmlPath,
					width: result.width,
					height: result.height,
					scale: result.scale,
					bytes: result.bytes,
					auditText: formatCoverAudit(result.audit),
					clean: result.audit.truncated.length === 0,
					upload: args.upload,
					force: args.force_upload,
					alt: args.title,
					...(args.post_id ? { postId: args.post_id } : {}),
					what: '표지',
				})).join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_upload_image',
		{
			title: '이미지 올리기',
			description:
				'로컬 이미지 파일을 벨로그에 올리고 본문용 마크다운을 돌려준다.\n' +
				'PNG·JPEG·GIF·WebP 만 받으며, 확장자가 아니라 **파일 내용**으로 판정한다.\n' +
				'⚠️ 올라간 주소는 공개다 — 주소를 아는 사람은 누구나 볼 수 있고, 벨로그에는 ' +
				'이미지 삭제 API 가 없다. 올리기 전에 무슨 파일인지 확인하라.',
			inputSchema: {
				path: z.string().min(1).describe('로컬 파일 경로'),
				alt: z.string().optional(),
				type: z
					.enum(['post', 'profile'])
					.default('post')
					.describe("profile 은 프로필 사진용 분류일 뿐 — 사진 교체는 velog_update_profile_image"),
				post_id: z.string().optional().describe('붙일 글 id (서버가 소유권을 확인한다)'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			client.requireAuth('velog_upload_image');
			const { bytes, kind } = await readImageFile(args.path);
			const name = basename(args.path);
			const uploadOptions: Parameters<VelogClient['uploadImage']>[2] = args.post_id
				? { type: args.type, contentType: kind.mime, refId: args.post_id }
				: { type: args.type, contentType: kind.mime };
			const url = await client.uploadImage(bytes, name, uploadOptions);
			return textResult(
				[
					`✅ 올렸습니다 — ${kind.mime} · ${(bytes.length / 1024).toFixed(0)}KB`,
					'',
					markdown(args.alt ?? name, url),
					'',
					`- 이미지 주소: ${url}`,
				].join('\n'),
			);
		},
	);
}
