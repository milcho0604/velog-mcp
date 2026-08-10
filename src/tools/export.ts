/**
 * 글 백업 — 벨로그 글을 프론트매터 붙인 마크다운으로 내려받는다.
 *
 * ★ 이 레포에서 파일을 쓰는 유일한 모듈이다. 쓰는 내용은 '글 본문'뿐이고
 *   토큰은 절대 닿지 않는다. safety.test.ts 가 이 파일만 예외로 둔다.
 *
 * 벨로그에 공식 내보내기가 없어서 만든다. 서비스가 사라져도 글은 남아야 한다.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

/** YAML 문자열 값. 따옴표·백슬래시를 이스케이프해 프론트매터가 깨지지 않게 한다. */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toMarkdown(post: VelogPostDetail, username: string): string {
	// 공식 스키마상 title·url_slug 는 nullable 이다. 여기서 막지 않으면
	// yamlString(null) 이 프론트매터를 깨뜨린다.
	const title = post.title ?? '(제목 없음)';
	const slug = post.url_slug ?? post.id;
	const front = [
		'---',
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
export function safeFileName(slug: string, index: number): string {
	const base = slugify(slug).replace(/[/\\]/g, '-').slice(0, 100);
	const prefix = String(index).padStart(3, '0');
	return `${prefix}-${base || 'untitled'}.md`;
}

export function registerExportTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_export_posts',
		{
			title: '글 마크다운 백업',
			description:
				'한 사용자의 벨로그 글을 프론트매터가 붙은 마크다운 파일로 로컬에 저장한다. ' +
				'벨로그에 공식 내보내기가 없어서 만든 기능이다. ' +
				'★ 같은 이름의 기존 파일이 있으면 덮어쓴다 — 전용 디렉터리를 쓰는 것을 권한다. ' +
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
			},
			// 벨로그 쪽 상태는 안 바뀌지만 로컬 파일은 '덮어쓴다'. MCP 명세상
			// destructiveHint:false 는 '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { ...READ_ONLY, readOnlyHint: false, destructiveHint: true },
		},
		async ({ username, out_dir, limit }, extra) => {
			// ★ 예산 시계는 **핸들러가 시작하자마자** 켠다. 예전엔 목록 조회가 끝난
			//   뒤에 켰는데, 그 앞의 계정 조회·목록 4페이지가 이미 몇 초를 먹는다.
			//   '한 호출에 쓸 수 있는 시간'을 재는데 그 앞을 빼면 예산이 아니다.
			const deadline = Date.now() + TIME_BUDGET_MS;
			const target = username ?? (await resolveMyUsername(client, extra.signal));
			const dir = resolve(out_dir);
			await mkdir(dir, { recursive: true });

			const maxPages = Math.ceil(limit / 50);
			const { posts } = await fetchAllPosts(client, target, maxPages, extra.signal);
			const targets = posts.slice(0, limit);
			if (targets.length === 0) return textResult(`@${target} 의 공개 글이 없습니다.`);

			const written: string[] = [];
			const failed: string[] = [];
			/** 다 못 돈 이유. 없으면 끝까지 돈 것이다. */
			let stoppedBy: '취소' | '시간' | null = null;

			for (const [index, summary] of targets.entries()) {
				// ★ 클라이언트가 취소했으면 즉시 멈춘다. 여기서 안 보면 사용자는 이미
				//   포기했는데 파일은 계속 쌓인다 — 화면과 디스크가 어긋난다.
				if (extra.signal.aborted) {
					stoppedBy = '취소';
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
						{ signal: extra.signal },
					);
					if (!data.post) {
						failed.push(`${summary.title} (본문 조회 실패)`);
						continue;
					}
					const name = safeFileName(summary.url_slug ?? summary.id, index + 1);
					await writeFile(join(dir, name), toMarkdown(data.post, target), 'utf8');
					written.push(name);
				} catch (error) {
					if (extra.signal.aborted) {
						stoppedBy = '취소';
						break;
					}
					const reason = error instanceof Error ? error.message : String(error);
					failed.push(`${summary.title} — ${reason}`);
				}
			}

			const done = written.length + failed.length;
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
					`남은 ${left}편은 저장되지 않았습니다. **같은 out_dir 로 다시 부르면** ` +
						'이미 받은 파일을 덮어쓰며 이어집니다(파일 이름이 글 순서로 정해집니다). ' +
						'한 번에 끝내려면 limit 을 줄여 나눠 부르세요.',
				);
			}
			if (failed.length > 0) {
				lines.push(
					'',
					`⚠️ ${failed.length}편 실패:`,
					...failed.slice(0, 10).map((f) => `  - ${f}`),
				);
				if (failed.length > 10) lines.push(`  ... 외 ${failed.length - 10}편`);
			}
			return textResult(lines.join('\n'));
		},
	);
}
