/**
 * 통계 도구 — 벨로그에 없는 기능이라 우리가 집계한다.
 *
 * 벨로그는 글별 조회수를 보여주지만 "내 블로그 전체" 관점의 집계는 없다.
 * Post 에 likes/views/comments_count 가 직접 붙어 있어 목록만 긁으면 만들 수 있다.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { QUERY_POSTS } from '../graphql.ts';
import { postUrl, textResult } from '../format.ts';
import type { VelogPostSummary } from '../types.ts';
import { READ_ONLY } from './posts.ts';

/** 한 번에 받는 최대치. 벨로그 커넥션 풀이 작아 크게 잡지 않는다. */
const PAGE_SIZE = 50;

/**
 * 사용자의 글을 커서로 끝까지 긁는다.
 *
 * maxPages 로 상한을 둔다 — 무한 루프 방지이자 이용약관 8조(정상 운영 방해)
 * 회피다. 상한에 걸리면 조용히 자르지 않고 호출자에게 알린다.
 */
export async function fetchAllPosts(
	client: VelogClient,
	username: string,
	maxPages: number,
): Promise<{ posts: VelogPostSummary[]; truncated: boolean }> {
	const posts: VelogPostSummary[] = [];
	let cursor: string | undefined;

	for (let page = 0; page < maxPages; page++) {
		const input: Record<string, unknown> = { username, limit: PAGE_SIZE };
		if (cursor) input['cursor'] = cursor;

		const data = await client.request<{ posts: VelogPostSummary[] }>(QUERY_POSTS, {
			input,
		});
		const batch = data.posts ?? [];
		posts.push(...batch);

		if (batch.length < PAGE_SIZE) return { posts, truncated: false };
		cursor = batch.at(-1)?.id;
		if (!cursor) return { posts, truncated: false };
	}
	return { posts, truncated: true };
}

interface Totals {
	views: number;
	likes: number;
	comments: number;
}

function sum(posts: readonly VelogPostSummary[]): Totals {
	return posts.reduce<Totals>(
		(acc, p) => ({
			views: acc.views + (p.views ?? 0),
			likes: acc.likes + (p.likes ?? 0),
			comments: acc.comments + (p.comments_count ?? 0),
		}),
		{ views: 0, likes: 0, comments: 0 },
	);
}

const num = (n: number): string => n.toLocaleString('ko-KR');

function tagBreakdown(posts: readonly VelogPostSummary[], top: number): string {
	const counts = new Map<string, { posts: number; views: number }>();
	for (const p of posts) {
		for (const tag of p.tags ?? []) {
			const cur = counts.get(tag) ?? { posts: 0, views: 0 };
			counts.set(tag, { posts: cur.posts + 1, views: cur.views + (p.views ?? 0) });
		}
	}
	if (counts.size === 0) return '(태그 없음)';

	return [...counts.entries()]
		.sort((a, b) => b[1].views - a[1].views)
		.slice(0, top)
		.map(([tag, s]) => `  #${tag} — ${s.posts}편 · 👁${num(s.views)}`)
		.join('\n');
}

function yearBreakdown(posts: readonly VelogPostSummary[]): string {
	const byYear = new Map<string, { posts: number; views: number }>();
	for (const p of posts) {
		const year = p.released_at?.slice(0, 4) ?? '미상';
		const cur = byYear.get(year) ?? { posts: 0, views: 0 };
		byYear.set(year, { posts: cur.posts + 1, views: cur.views + (p.views ?? 0) });
	}
	return [...byYear.entries()]
		.sort((a, b) => b[0].localeCompare(a[0]))
		.map(([year, s]) => `  ${year} — ${s.posts}편 · 👁${num(s.views)}`)
		.join('\n');
}

export function registerStatsTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_blog_stats',
		{
			title: '블로그 통계',
			description:
				'한 사용자의 글 전체를 긁어 조회수·좋아요·댓글을 집계한다. ' +
				'연도별·태그별 분포와 상위 글 순위를 함께 낸다. 벨로그에 없는 화면이라 직접 계산한다. ' +
				'글이 많으면 여러 번 요청하므로 몇 초 걸릴 수 있다.',
			inputSchema: {
				username: z.string().describe('@ 없이'),
				top: z.number().int().min(1).max(30).default(10).describe('상위 몇 편까지 보여줄지'),
				max_pages: z
					.number()
					.int()
					.min(1)
					.max(20)
					.default(10)
					.describe(`최대 페이지 수 (1페이지=${PAGE_SIZE}편). 과도한 요청 방지용 상한`),
			},
			annotations: READ_ONLY,
		},
		async ({ username, top, max_pages }) => {
			const { posts, truncated } = await fetchAllPosts(client, username, max_pages);
			if (posts.length === 0) return textResult(`@${username} 의 공개 글이 없습니다.`);

			const totals = sum(posts);
			const avgViews = Math.round(totals.views / posts.length);

			const ranked = [...posts]
				.sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
				.slice(0, top)
				.map(
					(p, i) =>
						`${String(i + 1).padStart(2)}. 👁${num(p.views ?? 0).padStart(7)} ` +
						`♥${String(p.likes ?? 0).padStart(4)}  ${p.title}\n` +
						`      ${postUrl(p)}`,
				)
				.join('\n');

			const report = [
				`# @${username} 블로그 통계`,
				'',
				`- 글 ${num(posts.length)}편${truncated ? ` (상한 ${max_pages}페이지에서 잘림 — 더 있음)` : ''}`,
				`- 총 조회수 👁 ${num(totals.views)}`,
				`- 총 좋아요 ♥ ${num(totals.likes)}`,
				`- 총 댓글 💬 ${num(totals.comments)}`,
				`- 글당 평균 조회수 ${num(avgViews)}`,
				'',
				`## 조회수 상위 ${Math.min(top, posts.length)}편`,
				ranked,
				'',
				'## 연도별',
				yearBreakdown(posts),
				'',
				'## 태그별 (조회수 순 상위 10)',
				tagBreakdown(posts, 10),
			].join('\n');

			const warning = truncated
				? `\n\n⚠️ 최대 ${max_pages}페이지(${max_pages * PAGE_SIZE}편)까지만 집계했습니다. ` +
					'전체를 보려면 max_pages 를 올리세요.'
				: '';

			return textResult(report + warning);
		},
	);
}
