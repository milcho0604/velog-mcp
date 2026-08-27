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

import { constants, open, readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
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
	type SequenceSpec,
	SEQ_KINDS,
	formatSequenceAudit,
	renderCover,
	renderDiagram,
	renderSequence,
} from '../render/index.ts';
import { isHexColor } from '../render/tones.ts';
import { makeSerializer } from '../serial.ts';

/** 우리가 올리는 것 — 서버 상한(30MB)보다 낮게 잡는다. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 자가감사에 걸려 업로드를 건너뛴 PNG 경로.
 *
 * `force_upload` 를 없앴더니 "감사 실패 → 그 경로를 velog_upload_image 에 넘기기"라는
 * 두 단계 우회가 남았다. 같은 인증으로 즉시 되므로 사실상 차단이 아니었다.
 * 그래서 **이 서버가 감사에서 떨어뜨린 산출물은 이 서버로 못 올리게** 표시해 둔다.
 *
 * 이게 절대적 차단은 아니다 — 파일을 다른 곳으로 복사하면 우회된다. 그건 사용자가
 * 눈으로 보게 되는 별개의 행동이므로 그 선에서 멈춘다. 목적은 '사고 방지'이지
 * 사용자를 막는 것이 아니다.
 */
const rejectedRenders = new Set<string>();

/**
 * 거부 목록에 걸리는지 본다. 경로 표기가 달라도 같은 파일이면 같게 취급한다.
 *
 * ★ 이건 **완전한 차단이 아니다.** 파일을 다른 데로 복사하거나 서버를 다시 띄우면
 *   풀린다. 목적은 "방금 감사에서 떨어진 그림을 그대로 다시 올리는 실수"를 막는 것이지
 *   사용자를 가두는 것이 아니다. 그 이상으로 설명하면 과장이다.
 */
async function isRejected(path: string): Promise<boolean> {
	if (rejectedRenders.has(resolve(path))) return true;
	const real = await realpath(path).catch(() => null);
	return real !== null && rejectedRenders.has(real);
}

interface Sniffed {
	readonly mime: string;
	readonly ext: string;
}

/**
 * 앞부분 시그니처만 보면 "PNG 머리 8바이트 + 아무 텍스트" 도 통과한다.
 * 그건 이미지가 아니라 **이미지처럼 시작하는 파일**이다.
 *
 * ★ 그래서 끝맺음도 봤는데, 그것도 부족했다. `IDAT` 을 **파일 전체에서 바이트열로**
 *   찾았더니 `IHDR 의 payload 안에 IDAT 이라는 글자` 를 넣은 파일이 통과했다
 *   (코덱스가 재현). 청크가 아니라 글자를 본 것이다.
 *   그래서 지금은 **청크 구조를 실제로 걸어간다.** 길이 필드를 따라가며
 *   경계가 맞는지, 필요한 청크가 제자리에 있는지 확인한다.
 *
 * 완전한 디코딩은 아니다 — 화소 데이터가 진짜인지까지는 안 본다.
 * 목적은 "아무 바이트나 이미지인 척 공개 CDN 에 올라가는 것"을 막는 것이다.
 */
function readU32BE(bytes: Uint8Array, at: number): number {
	return (
		((bytes[at] ?? 0) << 24) |
		((bytes[at + 1] ?? 0) << 16) |
		((bytes[at + 2] ?? 0) << 8) |
		(bytes[at + 3] ?? 0)
	) >>> 0;
}

function readU32LE(bytes: Uint8Array, at: number): number {
	return (
		(bytes[at] ?? 0) |
		((bytes[at + 1] ?? 0) << 8) |
		((bytes[at + 2] ?? 0) << 16) |
		((bytes[at + 3] ?? 0) << 24)
	) >>> 0;
}

function fourCC(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(
		bytes[at] ?? 0,
		bytes[at + 1] ?? 0,
		bytes[at + 2] ?? 0,
		bytes[at + 3] ?? 0,
	);
}

/** PNG 청크를 실제로 걸어간다: [길이4][타입4][데이터][CRC4] */
function pngStructureOk(bytes: Uint8Array): boolean {
	let at = 8; // 시그니처 다음
	let first = true;
	let sawIdat = false;
	// 청크가 아무리 많아도 유한하다. 이상하면 즉시 실패.
	while (at + 8 <= bytes.length) {
		const len = readU32BE(bytes, at);
		const type = fourCC(bytes, at + 4);
		const next = at + 12 + len; // 길이4 + 타입4 + 데이터 + CRC4
		if (len > bytes.length || next > bytes.length) return false;
		if (first) {
			if (type !== 'IHDR' || len !== 13) return false;
			// ★ 폭·높이 0 은 규격상 무효다. 길이만 맞춘 껍데기를 한 겹 더 거른다.
			const w = readU32BE(bytes, at + 8);
			const h = readU32BE(bytes, at + 12);
			if (w === 0 || h === 0) return false;
			first = false;
		}
		// 빈 IDAT 은 화소가 없다는 뜻이다.
		if (type === 'IDAT' && len > 0) sawIdat = true;
		// ★ IEND 는 규격상 **마지막** 청크다. 뒤에 뭔가 더 있으면 정상 PNG 가 아니고,
		//   거기가 바로 polyglot 이 숨는 자리다. 파일 끝과 일치하는지까지 본다.
		if (type === 'IEND') return len === 0 && sawIdat && next === bytes.length;
		at = next;
	}
	return false; // IEND 로 끝나지 않았다
}

/** RIFF/WebP 청크를 걸어간다: [FourCC4][길이4][데이터(짝수 정렬)] */
function webpStructureOk(bytes: Uint8Array): boolean {
	const riffSize = readU32LE(bytes, 4);
	if (riffSize + 8 > bytes.length) return false;
	let at = 12;
	const endAt = Math.min(bytes.length, riffSize + 8);
	let sawFrame = false;
	while (at + 8 <= endAt) {
		const type = fourCC(bytes, at);
		const len = readU32LE(bytes, at + 4);
		const next = at + 8 + len + (len % 2); // 홀수면 1바이트 패딩
		if (next > endAt) return false;
		// 실제 화소가 든 청크. VP8X(확장 헤더)만 있는 건 이미지가 아니다.
		// ★ ANMF 는 16바이트 프레임 헤더 뒤에 실제 비트스트림이 온다 — len>0 만으로는
		//   1바이트짜리도 통과한다.
		if (type === 'VP8 ' || type === 'VP8L') {
			if (len > 0) sawFrame = true;
		} else if (type === 'ANMF') {
			if (len > 16) sawFrame = true;
		}
		at = next;
	}
	// ★ 첫 프레임에서 바로 반환하면 그 뒤 청크 경계가 깨져 있어도 모른다.
	//   끝까지 걸어 경계가 맞는지 확인한 뒤에 판정한다.
	return sawFrame && at === endAt;
}

function looksComplete(bytes: Uint8Array, ext: string): boolean {
	if (ext === 'png') return pngStructureOk(bytes);
	if (ext === 'webp') return webpStructureOk(bytes);
	// JPEG·GIF 는 컨테이너 구조가 PNG/WebP 만큼 단순하지 않다. 끝맺음만 본다 —
	// 머리만 베껴 붙인 파일을 거르는 선까지다. (그 이상은 디코더가 필요하다)
	const len = bytes.length;
	const tailFrom = Math.max(0, len - 64);
	const has = (...sig: number[]): boolean => {
		for (let i = tailFrom; i <= len - sig.length; i++) {
			let ok = true;
			for (let j = 0; j < sig.length; j++) {
				if (bytes[i + j] !== sig[j]) { ok = false; break; }
			}
			if (ok) return true;
		}
		return false;
	};
	if (ext === 'jpg') return has(0xff, 0xd9); // EOI
	if (ext === 'gif') return has(0x3b); // trailer
	return true;
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
		return looksComplete(bytes, 'png') ? { mime: 'image/png', ext: 'png' } : null;
	}
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
		return looksComplete(bytes, 'jpg') ? { mime: 'image/jpeg', ext: 'jpg' } : null;
	}
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) {
		return looksComplete(bytes, 'gif') ? { mime: 'image/gif', ext: 'gif' } : null;
	}
	// RIFF....WEBP
	if (
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	) {
		return looksComplete(bytes, 'webp') ? { mime: 'image/webp', ext: 'webp' } : null;
	}
	return null;
}

/**
 * 파일을 읽고 검사까지 한다. 통과 못 하면 이유를 그대로 말해준다.
 *
 * ★ `stat` 으로 크기를 보고 나서 `readFile` 로 다시 여는 구조였다. 그 사이에 경로가
 *   다른 파일로 바뀌면 크기 검사가 무의미해진다. 한 번 연 **같은 핸들**에서 크기를
 *   보고 그대로 읽어 그 틈을 없앤다.
 */
async function readImageFile(path: string): Promise<{ bytes: Uint8Array; kind: Sniffed }> {
	// ★ O_NONBLOCK 으로 연다. 그냥 열면 **FIFO 에서 open 자체가 writer 를 기다리며
	//   멈춘다** — 요청이 몇 개만 겹쳐도 Node 의 파일 I/O 스레드풀이 고갈된다.
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
	if (!handle) throw new Error(`파일을 찾지 못했습니다: ${path}`);
	let bytes: Uint8Array;
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`파일이 아닙니다: ${path}`);

		// ★ 크기 판정은 **실제로 읽은 바이트** 하나로만 한다.
		//   예전엔 stat 으로 한 번 보고 read 에서 또 봤는데, 두 가지가 문제였다:
		//   ① readFile() 은 내부에서 크기를 다시 재므로 stat 이후 파일이 커지면
		//      상한을 넘겨 읽는다 (검사가 무의미해진다)
		//   ② 검사가 둘이면 하나를 지워도 다른 하나가 가려서 **테스트가 못 잡는다**
		//      (실제로 변이가 통과했다)
		//   상한+1 만큼만 읽고, 그 이상이면 거부한다. 10MB 버퍼는 유한하고 예측 가능하다.
		const buf = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead > MAX_UPLOAD_BYTES) {
			throw new Error(
				`파일이 너무 큽니다 — 이 도구의 상한은 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 입니다.`,
			);
		}
		bytes = new Uint8Array(buf.subarray(0, bytesRead));
	} finally {
		await handle.close().catch(() => {});
	}
	const kind = sniffImage(bytes);
	if (!kind) {
		throw new Error(
			`이미지 파일이 아닙니다(또는 파일이 온전하지 않습니다): ${path}\n` +
				'PNG·JPEG·GIF·WebP 만 올립니다. 확장자가 아니라 파일 내용으로 판정하며 ' +
				'시작 시그니처와 끝맺음을 함께 봅니다 (SVG 는 받지 않습니다).',
		);
	}
	return { bytes, kind };
}

const toneField = z
	.string()
	.refine((v) => TONE_NAMES.includes(v), `톤 이름이어야 합니다: ${TONE_NAMES.join(', ')}`);

const nodeSchema = z.object({
	id: z.string().max(64).optional().describe('선을 연결할 때 쓰는 이름. 생략하면 n0, n1 …'),
	// 상한이 없으면 요청 하나로 수억 픽셀짜리 캔버스를 요구할 수 있다.
	x: z
		.number()
		.min(-20000)
		.max(20000)
		.describe('왼쪽 위 x. 원점은 아무 데나 잡아도 된다 — 캔버스는 자동으로 맞춘다'),
	y: z.number().min(-20000).max(20000),
	w: z.number().min(60).max(2400).optional().describe('생략하면 글자 실측으로 정한다'),
	h: z.number().min(36).max(1400).optional(),
	title: z.string().min(1).max(120),
	sub: z.string().max(120).optional().describe('두 번째 줄. 짧게'),
	icon: z
		.string()
		.refine((v) => ICON_NAMES.includes(v), `아이콘 이름: ${ICON_NAMES.join(', ')}`)
		.optional(),
	icon_tone: toneField.optional(),
	tag: z.string().max(40).optional().describe('오른쪽 위 작은 배지 (예: ":6820", "v2")'),
	tag_tone: toneField.optional(),
});

const groupSchema = z.object({
	name: z.string().min(1).max(80),
	sub: z.string().max(80).optional(),
	tone: toneField.optional(),
	members: z
		.array(z.string().max(64))
		.max(60)
		.optional()
		.describe('이 노드들을 감싸도록 상자를 자동 계산한다. 좌표를 직접 줄 거면 생략'),
	x: z.number().min(-20000).max(20000).optional(),
	y: z.number().min(-20000).max(20000).optional(),
	w: z.number().min(0).max(40000).optional(),
	h: z.number().min(0).max(40000).optional(),
});

const edgeSchema = z.object({
	// plane.key 와 같은 규칙. 이 값도 marker 참조로 들어간다.
	plane: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,16}$/, '영숫자·밑줄·하이픈 1~16자만')
		.optional()
		.describe('흐름 종류 key (범례와 색이 여기서 갈린다)'),
	from: z.string().max(80).optional().describe('노드 id. 면을 고르려면 "id:right" 처럼'),
	to: z.string().max(80).optional(),
	// ★ 점 개수에 상한이 없으면 감사 비용이 O(E²×S²) 로 터진다.
	//   엣지 120개 × 점 1000개면 선분 비교가 수십억 번이다.
	points: z
		.array(z.tuple([z.number().min(-20000).max(20000), z.number().min(-20000).max(20000)]))
		.max(40)
		.optional()
		.describe('직접 꺾는 경우. 주면 from/to 대신 이 좌표를 쓴다'),
	label: z.string().max(120).optional(),
	label_at: z
		.tuple([z.number().min(-20000).max(20000), z.number().min(-20000).max(20000)])
		.optional(),
	label_anchor: z.enum(['start', 'middle', 'end']).optional(),
});

const planeSchema = z.object({
	// ★ key 는 SVG marker 의 id 가 되고 `url(#arr-<key>)` 로 참조된다.
	//   자유 문자열이면 그 참조식이 깨지거나 다른 걸 가리키게 만들 수 있다.
	key: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,16}$/, '영숫자·밑줄·하이픈 1~16자만 (SVG id 가 된다)'),
	name: z.string().min(1).max(40),
	color: z.string().refine(isHexColor, '#rrggbb 형식만 받습니다'),
	// stroke-dasharray 는 길이 목록이다. 숫자·공백·쉼표 외에는 받지 않는다.
	// ★ 문자 종류만 좁히고 길이를 안 뒀다. 이 값은 엣지 120개의 stroke-dasharray 로
	//   전부 복제되고 DOM 출력에도 그만큼 반복된다 — 1MB 입력 하나가 100MB 넘는
	//   DOM 이 된다. 점선 패턴은 원래 짧다.
	dash: z
		.string()
		.max(40)
		.regex(/^[\d.\s,]+$/, '숫자와 공백·쉼표만 (예: "6 4")')
		.optional()
		.describe('점선 (예: "6 4")'),
});

const participantSchema = z.object({
	id: z.string().max(64).optional().describe('메시지에서 가리킬 이름. 생략하면 p0, p1 …'),
	name: z.string().min(1).max(80),
	sub: z.string().max(80).optional().describe('두 번째 줄. 짧게'),
	icon: z.string().max(40).optional(),
	icon_tone: toneField.optional(),
	tag: z.string().max(40).optional().describe('오른쪽 위 작은 배지 (예: ":6820")'),
	tag_tone: toneField.optional(),
});

const messageSchema = z.object({
	kind: z
		.enum(SEQ_KINDS)
		.optional()
		.describe("생략하면 call. return 은 활성 막대를 닫고, note 는 선이 아니라 설명 상자"),
	from: z.string().max(64),
	to: z.string().max(64).optional().describe('note 만 생략 가능. 자기호출은 from 과 같게'),
	// ★ 라벨 길이는 그대로 열 폭이 된다 — 이 도구는 글자를 줄이지 않고 자리를 넓히므로
	//   상한이 없으면 캔버스가 그만큼 커진다. 접히긴 하지만 행 높이로 옮겨갈 뿐이다.
	label: z.string().max(200).optional(),
});

const fragmentSchema = z.object({
	kind: z.string().min(1).max(16).describe("상자 종류 (예: 'alt', 'opt', 'loop', 'par')"),
	label: z.string().max(120).optional().describe("조건 (예: '토큰이 살아 있으면')"),
	from: z.number().int().min(0).max(199).describe('감쌀 첫 메시지 번호 (0부터)'),
	to: z.number().int().min(0).max(199).describe('감쌀 마지막 메시지 번호 (포함)'),
	tone: toneField.optional(),
});

function markdown(alt: string, url: string): string {
	return `![${alt}](${url})`;
}

/**
 * 업로드도 줄을 세운다.
 *
 * ★ 파일당 10MB 상한은 있는데 **동시성 상한이 없었다.** 한 요청이 10MB 버퍼와
 *   그 multipart 사본을 최대 60초 들고 있으므로, 병렬 호출 수만큼 그대로 곱해진다.
 *   렌더는 같은 이유로 이미 줄을 세워 크롬 메모리를 1GB 에 묶어뒀는데
 *   업로드만 빠져 있었다.
 * ★ 벨로그 쪽 사정도 같은 방향이다 — 1분 20건을 넘기면 계정을 막는다
 *   (ImageService.detectAbuse). 몰아치지 않는 편이 안전하다.
 */
const serializeUpload = makeSerializer();

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
		alt: string;
		postId?: string;
		what: string;
		/** 취소 신호. 업로드는 되돌릴 수 없으므로 반드시 받아 넘긴다. */
		signal: AbortSignal;
	}): Promise<string[]> {
		const lines: string[] = [];
		// ★ upload 여부와 무관하게, 감사에 걸린 산출물은 거부 목록에 올린다.
		//   예전엔 upload:true 로 막힌 경우에만 넣었는데, 그러면 upload:false 로 그린 뒤
		//   그 경로를 velog_upload_image 에 주는 우회가 그대로 남는다.
		if (!args.clean) {
			rejectedRenders.add(resolve(args.pngPath));
			const real = await realpath(args.pngPath).catch(() => null);
			if (real) rejectedRenders.add(real);
		}
		const px = `${args.width * args.scale}×${args.height * args.scale}px`;
		lines.push(`${args.what} 완성 — ${px} (${(args.bytes / 1024).toFixed(0)}KB)`);
		lines.push('');
		lines.push(args.auditText);
		lines.push('');

		if (args.upload && !args.clean) {
			// ★ 감사에 걸린 그림은 올리지 않는다. 벨로그 업로드는 되돌릴 수 없고
			//   (삭제 API 가 없다) 계정 업로드 한도도 깎는다. 고쳐서 다시 그리는 게 맞다.
			//
			// ★★ 예전엔 `force_upload` 파라미터로 이걸 끌 수 있었다. 그건 이 저장소가
			//   공개 발행에서 이미 배운 것(ADR 0004)을 그대로 어긴 것이다 —
			//   **모델이 스스로 켤 수 있는 스위치는 방어가 아니다.** 그래서 없앴다.
			//   그래도 올려야 하면 경로가 있다: upload:false 로 그린 뒤 PNG 를 직접 보고
			//   velog_upload_image 로 올리면 된다. 사람이 한 번 더 개입하게 된다.
			// ★ 예전엔 여기서 "velog_upload_image 로 올리면 된다"고 안내했다.
			//   그건 차단 안내문이 우회 방법을 같은 상대에게 그대로 알려주는 꼴이다.
			//   경로는 알려주되(사람이 열어봐야 하므로) 우회를 권하지는 않는다.
			//   그리고 이 PNG 는 아래에서 업로드 거부 목록에 올린다.
			lines.push('올리지 않았습니다 — 위 문제를 고쳐 다시 그리세요.');
			lines.push('아래 PNG 는 이 서버로 올릴 수 없습니다 (감사에 걸린 산출물).');
			lines.push('');
			lines.push(`- 로컬 PNG: ${args.pngPath}`);
			lines.push(`- 편집용 HTML: ${args.htmlPath}`);
			return lines;
		}

		if (args.upload) {
			// ★ 파일 읽기도 **줄 안에서** 한다. 밖에서 읽으면 대기 중인 요청마다
			//   10MB 버퍼가 메모리에 올라간 채 순서를 기다린다 — 줄을 세운 이유
			//   (메모리 상한)가 그대로 사라진다. 코덱스 교차검증에서 잡았다.
			const url = await serializeUpload(async () => {
				// ★ 줄에서 기다리는 동안 취소됐을 수 있다. 읽기 전에 확인한다 —
				//   안 그러면 이미 포기한 요청이 파일부터 읽고 버퍼를 잡는다.
				args.signal.throwIfAborted();
				const bytes = new Uint8Array(await readFile(args.pngPath));
				const uploadOptions: Parameters<VelogClient['uploadImage']>[2] = args.postId
					? { type: 'post', contentType: 'image/png', refId: args.postId, signal: args.signal }
					: { type: 'post', contentType: 'image/png', signal: args.signal };
				return client.uploadImage(
					bytes,
					`${basename(args.pngPath, '.png')}.png`,
					uploadOptions,
				);
			});
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
				'감사에 걸리면 **올리지 않고** 무엇이 문제인지 알려준다. 이 판단은 끌 수 없고, ' +
				'감사에 걸린 산출물은 velog_upload_image 로도 받지 않는다. 고쳐서 다시 그릴 것.\n' +
				`아이콘: ${ICON_NAMES.join(' ')}\n톤: ${TONE_NAMES.join(' ')}`,
			inputSchema: {
				// ★ 글자에도 상한이 필요하다. 좌표만 묶어두면 제목 하나에 10MB 를 넣어
				//   HTML·SVG·getBBox·stdout 을 동시에 부풀릴 수 있다 (코덱스 4차).
				title: z.string().min(1).max(200).describe('그림 제목 (좌상단)'),
				subtitle: z.string().max(300).optional().describe('한 줄 설명·근거'),
				// ★ id 가 겹치면 관통 감사를 피할 수 있다. NMAP 은 마지막 것만 남기는데
				//   '자기 노드 제외' 집합은 id 문자열로 같은 id 를 전부 빼기 때문이다.
				//   생략 시 자동 부여되는 n0·n1 과의 충돌도 같은 문제라 함께 본다.
				nodes: z
					.array(nodeSchema)
					.min(1)
					.max(60)
					.superRefine((list, ctx) => {
						const seen = new Set<string>();
						list.forEach((node, i) => {
							const id = node.id ?? `n${i}`;
							if (seen.has(id)) {
								ctx.addIssue({
									code: 'custom',
									message: `노드 id 가 겹칩니다: ${id} (생략하면 n0·n1… 이 자동 부여됩니다)`,
									path: [i, 'id'],
								});
							}
							seen.add(id);
						});
					}),
				groups: z.array(groupSchema).max(12).optional(),
				edges: z.array(edgeSchema).max(120).optional(),
				planes: z
					.array(planeSchema)
					.max(6)
					.optional()
					.describe('흐름 종류. 생략하면 요청/외부 호출/데이터/관측 4종'),
				legend: z.boolean().default(true),
				alt: z.string().max(300).optional().describe('이미지 대체 텍스트'),
				upload: z.boolean().default(true),
				post_id: z
					.string()
					.max(64)
					.optional()
					.describe('붙일 글 id. 주면 벨로그가 내 글인지 확인한 뒤 받는다'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args, extra) => {
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
					alt: args.alt ?? args.title,
					...(args.post_id ? { postId: args.post_id } : {}),
					what: '다이어그램',
					signal: extra.signal,
				})).join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_render_sequence',
		{
			title: '시퀀스 다이어그램 그리기',
			description:
				'참가자와 순서 있는 메시지로 시퀀스 다이어그램을 그려 PNG 로 만들고 벨로그에 올린다.\n' +
				'**좌표를 받지 않는다** — 열 간격, 행 높이, 활성 막대, 묶음 상자를 전부 렌더러가 실측으로 정한다. ' +
				'라벨이 안 들어가면 글자를 줄이는 게 아니라 그 구간을 넓히고, 길면 접고, 접힌 만큼 행을 높인다.\n' +
				'메시지는 배열 순서가 곧 시간 순서다. 중간에 하나를 끼워 넣어도 아래가 알아서 밀린다.\n' +
				'구성도나 흐름도(시간 축이 없는 그림)는 velog_render_diagram 을 쓸 것.\n' +
				'**깔끔하게 나오는 건 레이아웃이 아니라 입력이 정한다.** 세로 길이를 지배하는 셋:\n' +
				'- `call` 에는 짝이 되는 `return` 을 붙인다. 안 닫힌 활성 막대는 계단처럼 겹쳐 쌓인다.\n' +
				'- `note` 는 한 줄로 쓴다. 접힌 줄 수만큼 그 행이 통째로 높아진다.\n' +
				'- 구분 기호(& ? = / , ; |)가 있는 긴 라벨은 렌더러가 그 뒤에서 끊는다. 그런 기호가 없는 긴 한글 토큰만 직접 끊어주면 된다.\n' +
				'⚠️ **자가감사 통과는 「보기 좋다」가 아니다.** 감사는 기하만 본다 — 삐져나옴, 겹침, 관통, 상자 범위. ' +
				'쌓인 막대도 어색한 줄바꿈도 통과시킨다.\n' +
				'감사에 걸리면 **올리지 않고** 무엇이 문제인지 알려준다. 이 판단은 끌 수 없고, ' +
				'감사에 걸린 산출물은 velog_upload_image 로도 받지 않는다.\n' +
				`종류: ${SEQ_KINDS.join(' ')}\n아이콘: ${ICON_NAMES.join(' ')}\n톤: ${TONE_NAMES.join(' ')}`,
			inputSchema: {
				title: z.string().min(1).max(200).describe('그림 제목 (좌상단)'),
				subtitle: z.string().max(300).optional().describe('한 줄 설명·근거'),
				participants: z
					.array(participantSchema)
					.min(1)
					.max(12)
					.describe('왼쪽부터 순서대로 세로 열이 된다'),
				messages: z
					.array(messageSchema)
					.min(1)
					.max(200)
					.describe('배열 순서가 시간 순서다. call 마다 짝이 되는 return 을 넣어야 활성 막대가 닫힌다'),
				fragments: z
					.array(fragmentSchema)
					.max(12)
					.optional()
					.describe('alt·opt·loop 묶음 상자. 서로 완전히 포개거나 완전히 떨어져야 한다'),
				legend: z.boolean().default(true),
				numbers: z.boolean().default(true).describe('메시지 앞에 1. 2. 3. 을 붙인다'),
				activations: z
					.boolean()
					.default(true)
					.describe('call/return 짝에서 활성 막대를 뽑아 그린다'),
				alt: z.string().max(300).optional().describe('이미지 대체 텍스트'),
				upload: z.boolean().default(true),
				post_id: z
					.string()
					.max(64)
					.optional()
					.describe('붙일 글 id. 주면 벨로그가 내 글인지 확인한 뒤 받는다'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args, extra) => {
			if (args.upload) client.requireAuth('velog_render_sequence');
			const spec: SequenceSpec = {
				title: args.title,
				participants: args.participants,
				messages: args.messages,
				legend: args.legend,
				numbers: args.numbers,
				activations: args.activations,
			};
			if (args.subtitle !== undefined) spec.subtitle = args.subtitle;
			if (args.fragments !== undefined) spec.fragments = args.fragments;

			const result = await renderSequence(spec);
			const q = result.audit;
			// ★ 항목을 하나 늘리고 여기에 안 더하면 결함 있는 그림이 조용히 올라간다.
			//   render.test.ts 의 R7 이 SequenceAudit 의 배열 항목 전부가 여기 있는지 본다.
			const seqClean =
				q.over.length === 0 &&
				q.collide.length === 0 &&
				q.label.length === 0 &&
				q.cross.length === 0 &&
				q.frame.length === 0;

			return textResult(
				(await finish({
					pngPath: result.pngPath,
					htmlPath: result.htmlPath,
					width: result.width,
					height: result.height,
					scale: result.scale,
					bytes: result.bytes,
					auditText: formatSequenceAudit(q),
					clean: seqClean,
					upload: args.upload,
					alt: args.alt ?? args.title,
					...(args.post_id ? { postId: args.post_id } : {}),
					what: '시퀀스 다이어그램',
					signal: extra.signal,
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
				title: z.string().min(1).max(200),
				subtitle: z.string().max(300).optional(),
				kicker: z.string().max(60).optional().describe("상단 작은 라벨 (예: '디버깅 기록')"),
				tags: z.array(z.string().max(40)).max(6).optional(),
				tone: toneField.optional(),
				footer: z.string().max(60).optional().describe("우상단 서명 (예: '@milcho0604')"),
				upload: z.boolean().default(true),
				post_id: z.string().max(64).optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args, extra) => {
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
					alt: args.title,
					...(args.post_id ? { postId: args.post_id } : {}),
					what: '표지',
					signal: extra.signal,
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
				path: z.string().min(1).max(4096).describe('로컬 파일 경로'),
				alt: z.string().max(300).optional(),
				type: z
					.enum(['post', 'profile'])
					.default('post')
					.describe("profile 은 프로필 사진용 분류일 뿐 — 사진 교체는 velog_update_profile_image"),
				post_id: z.string().max(64).optional().describe('붙일 글 id (서버가 소유권을 확인한다)'),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args, extra) => {
			client.requireAuth('velog_upload_image');
			// ★ 문자열 그대로 비교하면 `/tmp/x/./a.png` 하나로 빠져나간다.
			//   경로를 정규화하고, 심볼릭 링크까지 푼 형태로도 본다.
			if (await isRejected(args.path)) {
				throw new Error(
					'이 PNG 는 이 서버의 자가감사에서 떨어진 산출물입니다 — 올릴 수 없습니다.\n' +
						'그림을 고쳐 다시 그리세요 (velog_render_diagram).',
				);
			}
			const name = basename(args.path);
			// ★ 읽기부터 줄 안이다 — 이유는 위 finish() 의 주석과 같다.
			//   대기 중인 요청이 10MB 씩 들고 서 있으면 상한을 둔 의미가 없다.
			const { url, kind, bytes } = await serializeUpload(async () => {
				extra.signal.throwIfAborted();
				// ★ 거부 목록은 줄 밖에서 한 번 봤지만, 기다리는 사이에 이 PNG 가
				//   감사에서 떨어져 목록에 오를 수 있다. 읽기 직전에 다시 본다.
				if (await isRejected(args.path)) {
					throw new Error(
						'이 PNG 는 이 서버의 자가감사에서 떨어진 산출물입니다 — 올릴 수 없습니다.',
					);
				}
				const read = await readImageFile(args.path);
				const uploadOptions: Parameters<VelogClient['uploadImage']>[2] = args.post_id
					? { type: args.type, contentType: read.kind.mime, refId: args.post_id, signal: extra.signal }
					: { type: args.type, contentType: read.kind.mime, signal: extra.signal };
				return {
					url: await client.uploadImage(read.bytes, name, uploadOptions),
					kind: read.kind,
					bytes: read.bytes,
				};
			});
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
