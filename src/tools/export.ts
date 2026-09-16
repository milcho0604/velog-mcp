/**
 * 글 백업 — 벨로그 글을 프론트매터 붙인 마크다운으로 내려받는다.
 *
 * ★ 이 레포에서 파일을 쓰는 유일한 모듈이다. 쓰는 내용은 '글 본문'뿐이고
 *   토큰은 절대 닿지 않는다. safety.test.ts 가 이 파일만 예외로 둔다.
 *
 * 벨로그에 공식 내보내기가 없어서 만든다. 서비스가 사라져도 글은 남아야 한다.
 */

import { mkdir, writeFile, rename, lstat, access, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { QUERY_POST } from '../graphql.ts';
import { textResult } from '../format.ts';
import { slugify } from '../slug.ts';
import type { VelogPostDetail } from '../types.ts';
import { fetchAllPosts } from './stats.ts';
import { READ_ONLY } from './posts.ts';
import { resolveMyUsername } from '../me.ts';

/** 벨로그 커넥션 풀(limit 5)을 배려하는 요청 간격. */
const GAP_MS = 250;

/**
 * 한 호출에 쓸 수 있는 시간.
 *
 * ★ 왜 필요한가 — MCP SDK 의 클라이언트측 기본 요청 타임아웃은 60초다
 *   (shared/protocol.js: DEFAULT_REQUEST_TIMEOUT_MSEC = 60000).
 *   그런데 이 도구는 글 한 편마다 상세를 따로 받는다. 실측(2026-08-07, 벨로그
 *   공개 글 3편): 본문 왕복 평균 1,313ms. 간격 250ms 를 더하면 편당 약 1.5초다.
 *   **기본값 limit=50 이면 약 78초** — 60초를 넘는다. 즉 기본 인자로 부르면
 *   클라이언트가 먼저 포기했고, 그런데도 루프는 계속 돌며 파일을 썼다.
 *   화면에는 '실패'가 뜨는데 디스크에는 파일이 생기는 상태였다.
 *
 * 그래서 60초 안쪽에서 **우리가 먼저 멈추고 무엇을 했는지 보고한다.**
 * 파일 이름이 글 순서로 정해지므로 같은 out_dir 로 다시 부르면 그대로 이어진다.
 */
const TIME_BUDGET_MS = 50_000;

/**
 * 한 편을 더 시작하기 전에 남겨둬야 할 여유.
 *
 * 데드라인 직전에 루프로 들어가면 간격 250ms 에 상세 요청 한 번이 통째로 붙는다.
 * 실측 왕복이 1.3초대이므로 3초면 정상 한 편은 넉넉히 들어가고, 안 들어갈 만하면
 * 아예 시작하지 않아 예산을 지킨다.
 */
const PER_POST_RESERVE_MS = 3_000;

/**
 * YAML 이중따옴표 문자열 값.
 *
 * ★★ 따옴표와 백슬래시만 막으면 부족하다. **줄바꿈이 프론트매터를 통째로 깨뜨린다.**
 *   실측(2026-09-15): 제목이 `첫째\n둘째` 인 글을 내보내면
 *
 *       title: "첫째
 *       둘째"
 *
 *   가 되어 YAML 이 아니게 된다. 사용자의 백업 파일이 망가지는 것이라 조용히 넘어갈
 *   수 없다. 벨로그 제목에 줄바꿈이 들어갈 수 있고(붙여넣기), 널 문자가 섞여 오는
 *   경우도 있었다.
 *
 * YAML 1.2 의 이중따옴표 스칼라가 정의한 탈출만 쓴다. 정의가 없는 제어문자는
 * `\xNN`·`\uNNNN` 으로 적는다. NEL(U+0085)과 LS/PS(U+2028·U+2029)도 YAML 에서는
 * 줄바꿈이라 함께 막는다.
 */
function yamlString(value: string): string {
	const escaped = value.replace(
		// ⚠️ C1 구간(U+0080–U+009F)을 통째로 넣는다. 한때 `\u007F` 와 `\u0085` 만 넣었는데,
		//   엄격한 파서(Ruby Psych)는 U+0080·0084·0086·009F 도 «control characters are
		//   not allowed» 로 거부한다(코덱스 15차 실측). 관대한 파서 하나로 시험하면
		//   통과해서 못 본다. 비문자(U+FFFE·U+FFFF)도 같은 이유로 막는다.
		// eslint-disable-next-line no-control-regex
		/[\\"\u0000-\u001F\u007F-\u009F\u2028\u2029\uFFFE\uFFFF]/g,
		(ch) => {
			switch (ch) {
				case '\\':
					return '\\\\';
				case '"':
					return '\\"';
				case '\n':
					return '\\n';
				case '\r':
					return '\\r';
				case '\t':
					return '\\t';
				case '\b':
					return '\\b';
				case '\f':
					return '\\f';
				case '\v':
					return '\\v';
				case '\0':
					return '\\0';
				default: {
					const code = ch.codePointAt(0) ?? 0;
					return code <= 0xff
						? `\\x${code.toString(16).padStart(2, '0')}`
						: `\\u${code.toString(16).padStart(4, '0')}`;
				}
			}
		},
	);
	return `"${escaped}"`;
}

/**
 * 이 경로가 «이미 받아 둔 백업» 인가.
 *
 * ⚠️ `stat` 은 심볼릭 링크를 **따라간다.** 그래서 다른 파일을 가리키는 링크가
 *   `isFile() === true` 로 통과했다. 읽을 수 없는 파일도 `stat` 은 성공한다.
 *   둘 다 «받아 둔 것» 이 아닌데 건너뛰면 그 글은 영영 안 받는다(코덱스 18차).
 */
async function looksComplete(path: string): Promise<boolean> {
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile() || info.size === 0) return false;
	return access(path, fsConstants.R_OK).then(
		() => true,
		() => false,
	);
}

export function toMarkdown(post: VelogPostDetail, username: string): string {
	// 공식 스키마상 title·url_slug 는 nullable 이다. 여기서 막지 않으면
	// yamlString(null) 이 프론트매터를 깨뜨린다.
	const title = post.title ?? '(제목 없음)';
	const slug = post.url_slug ?? post.id;
	const front = [
		'---',
		// ★ 글 id 를 적는다. 이어받기가 **파일 이름이 아니라 이것으로** 짝을 맞춘다.
		//   이름에는 순번이 들어가는데, 목록 순서는 글이 하나만 늘어도 바뀐다.
		`id: ${yamlString(post.id)}`,
		`title: ${yamlString(title)}`,
		`date: ${post.released_at ?? post.created_at ?? ''}`,
		`slug: ${yamlString(slug)}`,
		`url: ${yamlString(`https://velog.io/@${username}/${slug}`)}`,
	];
	if (post.tags?.length) {
		front.push(`tags: [${post.tags.map(yamlString).join(', ')}]`);
	}
	if (post.series?.name) front.push(`series: ${yamlString(post.series.name)}`);
	front.push(`likes: ${post.likes ?? 0}`, `views: ${post.views ?? 0}`);
	if (post.is_private) front.push('private: true');
	if (post.is_temp) front.push('draft: true');
	front.push('---', '');

	return `${front.join('\n')}\n${post.body ?? ''}\n`;
}

/**
 * 파일명 안전화.
 *
 * 슬러그에 경로 구분자가 들어오면 지정한 디렉터리 밖에 쓸 수 있다.
 * slugify 가 이미 `/` 를 제거하지만, 여기서 한 번 더 막는다 —
 * 파일을 쓰는 코드는 이중으로 방어한다.
 */
/**
 * 백업 파일 이름.
 *
 * ★★ **글 id 를 이름에 넣는다.** 예전엔 `순번-슬러그.md` 였는데, 그 둘 다 불안정하다 —
 *   순번은 글이 하나만 늘어도 밀리고, 슬러그는 앞 100자를 자르므로 겹칠 수 있다.
 *   그래서 이어받기가 **다른 글의 백업을 자기 것으로 보고 덮어쓰는** 사고가 났다
 *   (실측: 파일에는 B 만 남는데 응답은 「1편 저장, 1개 건너뜀」).
 *
 *   id 가 이름에 있으면 «이 글의 파일» 이 한 곳으로 정해진다. 디렉터리를 훑어
 *   프론트매터를 파싱할 일도 없어진다 — 그 파싱에서만 결함 3건이 났다.
 *
 * ⚠️ 0.9.0 에서 이름 규칙이 바뀌었다. 옛 백업은 다시 받는다. 덜 받는 것보다 낫다.
 */
/** UTF-8 **바이트** 예산에 맞춰 자른다. 글자를 중간에서 끊지 않는다. */
function clipBytes(text: string, budget: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= budget) return text;
	let out = '';
	let used = 0;
	// 코드 포인트 단위로 돈다 — 인덱스로 끊으면 서로게이트 쌍이 갈라진다.
	for (const ch of text) {
		const size = encoder.encode(ch).length;
		if (used + size > budget) break;
		out += ch;
		used += size;
	}
	return out;
}

/**
 * 글 id 를 파일 이름에 쓸 수 있는 형태로.
 *
 * ⚠️ 그냥 거르기만 하면 `!!!` 와 `???` 가 **둘 다 빈 문자열**이 되어 서로 다른 글이
 *   한 파일로 합쳐진다. 40자로 자르는 것도 같다 — 앞 40자가 같으면 충돌한다.
 *   그래서 «거른 뒤에도 원본과 1:1 인지» 를 보고, 아니면 원본 해시를 쓴다.
 */
function fileIdOf(id: string): string {
	const clean = id.replace(/[^0-9A-Za-z_-]/g, '');
	if (clean.length > 0 && clean.length <= 40 && clean === id) return clean;
	// FNV-1a 32비트. 암호용이 아니라 «서로 다른 id 를 서로 다르게» 하려는 것뿐이다.
	let hash = 0x811c9dc5;
	for (const unit of new TextEncoder().encode(id)) {
		hash = ((hash ^ unit) * 0x01000193) >>> 0;
	}
	const tag = hash.toString(16).padStart(8, '0');
	return clean.length > 0 ? `${clean.slice(0, 24)}-${tag}` : `id-${tag}`;
}

/**
 * 백업 파일 이름.
 *
 * ★★ **글 id 를 이름에 넣는다.** 예전엔 `순번-슬러그.md` 였는데, 그 둘 다 불안정하다 —
 *   순번은 글이 하나만 늘어도 밀리고, 슬러그는 앞 100자를 자르므로 겹칠 수 있다.
 *   그래서 이어받기가 **다른 글의 백업을 자기 것으로 보고 덮어쓰는** 사고가 났다.
 *
 * ⚠️ 길이는 **글자 수가 아니라 바이트**로 잰다. 한글은 글자당 3바이트라 80자면
 *   240바이트이고, 여기에 `--<UUID>.md.part` 가 붙으면 ext4 의 255바이트 한계를
 *   넘어 **저장 자체가 안 된다**(실측 281·286바이트). 임시 접미사까지 예산에 넣는다.
 *
 * ⚠️ 0.9.0 에서 이름 규칙이 바뀌었다. 옛 백업은 다시 받는다. 덜 받는 것보다 낫다.
 */
const NAME_BYTE_BUDGET = 200;

export function safeFileName(slug: string, id: string): string {
	const safeId = fileIdOf(id);
	const tail = `--${safeId}.md`;
	const room = NAME_BYTE_BUDGET - new TextEncoder().encode(tail).length;
	const base = clipBytes(slugify(slug).replace(/[/\\]/g, '-'), Math.max(0, room));
	return `${base || 'untitled'}${tail}`;
}

export function registerExportTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_export_posts',
		{
			title: '글 마크다운 백업',
			description:
				'한 사용자의 벨로그 글을 프론트매터가 붙은 마크다운 파일로 로컬에 저장한다. ' +
				'벨로그에 공식 내보내기가 없어서 만든 기능이다. ' +
				'파일 이름은 `슬러그--글id.md` 다 — 글마다 한 곳으로 정해지므로 같은 글을 ' +
				'다시 받으면 그 파일만 덮어쓴다. ' +
				'글 본문을 한 편씩 받아오므로 글이 많으면 시간이 걸린다.',
			inputSchema: {
				username: z
					.string()
					.optional()
					.describe('@ 없이. 생략하면 인증된 내 계정을 쓴다'),
				out_dir: z.string().describe('저장할 디렉터리 (절대경로 권장). 없으면 만든다'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.default(50)
					.describe('내보낼 최대 글 수'),
				skip_existing: z
					.boolean()
					.default(false)
					.describe(
						'out_dir 에 **이미 내보낸 글**은 건너뛴다. 파일 이름에 글 id 가 들어 있어 ' +
							'그 이름의 파일이 읽을 수 있는 일반 파일이고 비어 있지 않으면 «받았다» 로 본다 ' +
							'(내용은 읽지 않는다). 예산·취소로 멈췄을 때 같은 인자에 이것만 켜서 다시 부르면 ' +
							'남은 글부터 이어간다. 이름 규칙이 다른 옛 백업은 다시 받는다',
					),
			},
			// 벨로그 쪽 상태는 안 바뀌지만 로컬 파일은 '덮어쓴다'. MCP 명세상
			// destructiveHint:false 는 '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { ...READ_ONLY, readOnlyHint: false, destructiveHint: true },
		},
		async ({ username, out_dir, limit, skip_existing }, extra) => {
			// ★ 예산 시계는 **핸들러가 시작하자마자** 켠다. 예전엔 목록 조회가 끝난
			//   뒤에 켰는데, 그 앞의 계정 조회·목록 4페이지가 이미 몇 초를 먹는다.
			//   '한 호출에 쓸 수 있는 시간'을 재는데 그 앞을 빼면 예산이 아니다.
			const deadline = Date.now() + TIME_BUDGET_MS;
			// ★★ 예산을 **신호로** 만든다.
			//
			//   한때 예산은 루프 진입 때만 봤다. 그러면 두 가지가 예산 밖에 있다 —
			//   ① 루프 앞의 계정 조회·목록 조회, ② 루프 안의 상세 요청 한 건.
			//   각 요청은 클라이언트 예산(35초) 안이라 자기 기준으로는 정상인데,
			//   목록 30초 + 상세 35초면 **65초 뒤에도 파일을 쓰고 있다**(코덱스 15차).
			//   시계를 보는 것만으로는 이미 시작한 요청을 못 끊는다. 신호를 걸어야 끊긴다.
			const budget = AbortSignal.timeout(TIME_BUDGET_MS);
			const signal = AbortSignal.any([extra.signal, budget]);
			/** 왜 멈췄는지. 사용자가 끊은 것과 예산이 끝난 것은 안내가 달라야 한다. */
			const stopReason = (): '취소' | '시간' | null =>
				budget.aborted ? '시간' : extra.signal.aborted ? '취소' : null;

			const target = username ?? (await resolveMyUsername(client, signal));
			const dir = resolve(out_dir);
			await mkdir(dir, { recursive: true });

			const maxPages = Math.ceil(limit / 50);
			const { posts } = await fetchAllPosts(client, target, maxPages, signal);
			const targets = posts.slice(0, limit);
			if (targets.length === 0) return textResult(`@${target} 의 공개 글이 없습니다.`);

			// 이 호출만의 표식. 임시 파일 이름에 넣어 동시 호출끼리 섞이지 않게 한다.
			const runTag = randomUUID().slice(0, 8);

			const written: string[] = [];
			const failed: string[] = [];
			/** 이미 있어서 건너뛴 것. 「이어서 받았다」를 사용자가 확인할 수 있어야 한다. */
			const skipped: string[] = [];
			/** 다 못 돈 이유. 없으면 끝까지 돈 것이다. */
			let stoppedBy: '취소' | '시간' | null = null;

			for (const [index, summary] of targets.entries()) {
				// ★ 클라이언트가 취소했으면 즉시 멈춘다. 여기서 안 보면 사용자는 이미
				//   포기했는데 파일은 계속 쌓인다 — 화면과 디스크가 어긋난다.
				const why = stopReason();
				if (why !== null) {
					stoppedBy = why;
					break;
				}
				// ★ 시간 예산. 이유는 TIME_BUDGET_MS 주석 참고.
				//   ★ 남은 시간이 '한 편 분량'도 안 되면 시작하지 않는다. 데드라인
				//     직전에 들어가면 간격 250ms + 상세 요청(최대 재시도 예산)이
				//     그대로 붙어 예산을 훌쩍 넘긴다.
				if (Date.now() + PER_POST_RESERVE_MS >= deadline) {
					stoppedBy = '시간';
					break;
				}
				// ★★ 이어받기. 이름에 글 id 가 들어 있으므로 **그 한 곳만** 보면 된다.
				//   상세 조회 **전에** 본다. 뒤에 두면 건너뛸 글도 왕복을 한 번 하게 되어
				//   «예산이 모자라 멈춘 상황» 에서 이어받는 의미가 사라진다.
				//   ⚠️ 0바이트는 «받은 것» 이 아니다. 아래 쓰기가 원자적이라 반쪽 파일은
				//   생기지 않지만, 사용자가 만든 빈 파일까지 «받았다» 고 보면 안 된다.
				const targetName = safeFileName(summary.url_slug ?? summary.id, summary.id);
				if (skip_existing && (await looksComplete(join(dir, targetName)))) {
					skipped.push(targetName);
					continue;
				}
				// 벨로그 커넥션 풀(limit 5)을 배려한다. 몰아치면 상대가 먼저 죽는다.
				if (index > 0) await new Promise((r) => setTimeout(r, GAP_MS));
				try {
					// 목록에는 body 가 없으므로 한 편씩 상세를 받는다.
					const data = await client.request<{ post: VelogPostDetail | null }>(
						QUERY_POST,
						// url_slug 가 없으면 id 로 조회한다.
						summary.url_slug
							? { input: { username: target, url_slug: summary.url_slug } }
							: { input: { id: summary.id } },
						{ signal },
					);
					if (!data.post) {
						failed.push(`${summary.title} (본문 조회 실패)`);
						continue;
					}
					// ★★ **받은 글이 그 글인지 확인한다.**
					//
					//   파일 이름은 «목록의 id» 로 정하는데 상세는 «슬러그» 로 조회한다.
					//   그 사이에 A 가 주소를 바꾸고 B 가 그 슬러그를 가져가면, A 의 id 가
					//   붙은 파일에 **B 의 본문이 저장되고 「✅ 1편」이 나간다**(코덱스 23차 재현).
					//   백업이 조용히 다른 글로 바뀌는 것이라 그냥 둘 수 없다.
					//   id 가 다르면 저장하지 않고 실패로 적는다 — 덜 받는 것이 낫다.
					if (data.post.id && data.post.id !== summary.id) {
						failed.push(
							`${summary.title} (받은 글이 다릅니다 — 목록 id ${summary.id}, 응답 id ${data.post.id}. ` +
								'조회 중에 주소가 바뀐 것으로 보입니다)',
						);
						continue;
					}
					// ★ 쓰기 직전에 다시 본다. 요청이 예산을 다 먹고 돌아온 경우,
					//   여기서 안 보면 «예산이 끝난 뒤에 파일을 쓰는» 일이 그대로 남는다.
					const stop = stopReason();
					if (stop !== null) {
						stoppedBy = stop;
						break;
					}
					// ★ **원자적으로 쓴다.** 도중에 끊기면 임시 파일만 남고 최종 파일은 없다.
					//   그래야 이어받기가 «반쪽 파일» 을 완성본으로 오인하지 않는다.
					// ⚠️ 임시 이름은 **호출마다 달라야** 한다. 고정 `.part` 를 쓰면 같은 글을
					//   동시에 내보낼 때 두 호출이 한 파일에 겹쳐 쓰고, 결과가 어느 쪽 본문과도
					//   같지 않은데 둘 다 «저장 성공» 을 보고한다(코덱스 18차 재현).
					const partial = join(dir, `${targetName}.${runTag}.part`);
					try {
						await writeFile(partial, toMarkdown(data.post, target), { encoding: 'utf8', signal });
						// ⚠️ 쓰기와 rename 사이에도 본다. 여기서 안 보면 «취소했는데 파일은
						//   확정되고 안내도 없이 ✅ 가 나가는» 일이 생긴다(코덱스 19차).
						const stopNow = stopReason();
						if (stopNow !== null) {
							await rm(partial, { force: true }).catch(() => {});
							stoppedBy = stopNow;
							break;
						}
						await rename(partial, join(dir, targetName));
					} catch (cause) {
						// ⚠️ 실패해도 임시 파일을 남기지 않는다. ENOSPC·rename 실패에서
						//   부스러기가 쌓이면 사용자가 그걸 백업으로 오해한다.
						await rm(partial, { force: true }).catch(() => {});
						throw cause;
					}
					written.push(targetName);
				} catch (error) {
					const stop = stopReason();
					if (stop !== null) {
						stoppedBy = stop;
						break;
					}
					const reason = error instanceof Error ? error.message : String(error);
					failed.push(`${summary.title} — ${reason}`);
				}
			}

			// ★ 건너뛴 것도 «처리한 것» 이다. 빼면 「0/2편에서 멈췄습니다」와
			//   「준비 조회만으로 예산을 다 썼습니다」가 함께 나온다(코덱스 16차).
			const done = written.length + failed.length + skipped.length;
			const lines = [
				`✅ ${written.length}편을 저장했습니다.`,
				'',
				`- 위치: ${dir}`,
				`- 형식: YAML 프론트매터 + 마크다운 본문`,
			];
			if (stoppedBy !== null) {
				const left = targets.length - done;
				lines.push(
					'',
					stoppedBy === '취소'
						? `⏹️ 요청이 취소되어 ${done}/${targets.length}편에서 멈췄습니다.`
						: `⏱️ ${TIME_BUDGET_MS / 1000}초 예산에 도달해 ${done}/${targets.length}편에서 멈췄습니다.`,
					done === 0
						? '준비 조회(계정·글 목록)만으로 예산을 다 썼습니다. 벨로그가 느린 ' +
							'상태일 수 있으니 잠시 뒤 다시 시도하세요 — limit 을 줄여도 소용없습니다.'
						: `남은 ${left}편은 저장되지 않았습니다. **같은 인자에 \`skip_existing: true\` 만 ` +
							'더해 다시 부르면** 이미 받은 글을 건너뛰고 남은 글부터 이어갑니다.\n' +
							'  ⚠️ 그것 없이 다시 부르면 **처음부터 다시** 받습니다 — 앞의 것을 또 받느라 ' +
							'예산이 또 떨어져 남은 글은 계속 못 받습니다. limit 을 줄여도 앞에서부터 ' +
							'고르는 것이라 마찬가지입니다.',
				);
			}
			if (skipped.length > 0) {
				lines.push('', `⏭️ 이미 있어서 건너뛴 파일: ${skipped.length}개`);
			}
			if (failed.length > 0) {
				lines.push(
					'',
					`⚠️ ${failed.length}편 실패:`,
					...failed.slice(0, 10).map((f) => `  - ${f}`),
				);
				if (failed.length > 10) lines.push(`  ... 외 ${failed.length - 10}편`);
			}
			// ★★ **전부 실패했으면 오류다.** 저장 0편인데 `✅` 와 함께 성공으로 끝나면
			//   모델은 백업이 된 줄 안다(코덱스 19차: 조회 전건 실패·ENOSPC·rename 실패
			//   모두 isError 없이 «✅ 0편» 이었다).
			const nothingSaved = written.length === 0 && skipped.length === 0;
			if (nothingSaved && failed.length > 0) {
				return { ...textResult(lines.join('\n')), isError: true };
			}
			return textResult(lines.join('\n'));
		},
	);
}
