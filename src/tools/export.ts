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

/** YAML 문자열 값. 따옴표·백슬래시를 이스케이프해 프론트매터가 깨지지 않게 한다. */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toMarkdown(post: VelogPostDetail, username: string): string {
	const front = [
		'---',
		`title: ${yamlString(post.title)}`,
		`date: ${post.released_at ?? post.created_at ?? ''}`,
		`slug: ${yamlString(post.url_slug)}`,
		`url: ${yamlString(`https://velog.io/@${username}/${post.url_slug}`)}`,
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
				'글 본문을 한 편씩 받아오므로 글이 많으면 시간이 걸린다.',
			inputSchema: {
				username: z.string().describe('@ 없이'),
				out_dir: z.string().describe('저장할 디렉터리 (절대경로 권장). 없으면 만든다'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.default(50)
					.describe('내보낼 최대 글 수'),
			},
			// 파일을 쓰지만 읽어온 글을 저장할 뿐이라 벨로그 쪽 상태는 안 바뀐다.
			annotations: { ...READ_ONLY, readOnlyHint: false, destructiveHint: false },
		},
		async ({ username, out_dir, limit }) => {
			const dir = resolve(out_dir);
			await mkdir(dir, { recursive: true });

			const maxPages = Math.ceil(limit / 50);
			const { posts } = await fetchAllPosts(client, username, maxPages);
			const targets = posts.slice(0, limit);
			if (targets.length === 0) return textResult(`@${username} 의 공개 글이 없습니다.`);

			const written: string[] = [];
			const failed: string[] = [];

			for (const [index, summary] of targets.entries()) {
				// 벨로그 커넥션 풀(limit 5)을 배려한다. 몰아치면 상대가 먼저 죽는다.
				if (index > 0) await new Promise((r) => setTimeout(r, 250));
				try {
					// 목록에는 body 가 없으므로 한 편씩 상세를 받는다.
					const data = await client.request<{ post: VelogPostDetail | null }>(
						QUERY_POST,
						{ input: { username, url_slug: summary.url_slug } },
					);
					if (!data.post) {
						failed.push(`${summary.title} (본문 조회 실패)`);
						continue;
					}
					const name = safeFileName(summary.url_slug, index + 1);
					await writeFile(join(dir, name), toMarkdown(data.post, username), 'utf8');
					written.push(name);
				} catch (error) {
					const reason = error instanceof Error ? error.message : String(error);
					failed.push(`${summary.title} — ${reason}`);
				}
			}

			const lines = [
				`✅ ${written.length}편을 저장했습니다.`,
				'',
				`- 위치: ${dir}`,
				`- 형식: YAML 프론트매터 + 마크다운 본문`,
			];
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
