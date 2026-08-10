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
import { resolveMyUsername } from '../me.ts';

/** 한 번에 받는 최대치. 벨로그 커넥션 풀이 작아 크게 잡지 않는다. */
const PAGE_SIZE = 50;

/**
 * 사용자의 글을 커서로 끝까지 긁는다.
 *
 * maxPages 로 상한을 둔다 — 무한 루프 방지이자 이용약관 8조(정상 운영 방해)
 * 회피다. 상한에 걸리면 조용히 자르지 않고 호출자에게 알린다.
 */
/**
 * 수집이 어떻게 끝났는지. `truncated: boolean` 하나로는 '다 봤다'와
 * '커서가 막혀서 멈췄다'를 구분할 수 없어 오보고가 난다.
 */
export type FetchOutcome =
	/** 마지막 페이지까지 봤다. */
	| 'complete'
	/** maxPages 상한에 걸렸다. 더 있을 수 있다. */
	| 'page_limit'
	/** 커서가 안 움직였다. 벨로그가 커서를 못 찾으면 1페이지를 다시 준다. */
	| 'cursor_stalled';

export async function fetchAllPosts(
	client: VelogClient,
	username: string,
	maxPages: number,
	/** 취소 신호. 페이지를 여러 장 넘기므로 중간에 멈출 수 있어야 한다. */
	signal?: AbortSignal,
): Promise<{ posts: VelogPostSummary[]; truncated: boolean; outcome: FetchOutcome }> {
	const posts: VelogPostSummary[] = [];
	// ★ 중복 방어. 커서가 안 움직이면(벨로그가 같은 페이지를 반복 반환) 같은 글을
	//   여러 번 담아 집계가 배수로 부풀려진다. 실측 재현: 커서 고착 시 50편이
	//   250편으로 계수됨 — 조회수 총계가 5배가 된다. 통계 도구에서 이건 치명적이다.
	const seenIds = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	for (let page = 0; page < maxPages; page++) {
		const input: Record<string, unknown> = { username, limit: PAGE_SIZE };
		if (cursor) input['cursor'] = cursor;

		const data = await client.request<{ posts: VelogPostSummary[] | null }>(
			QUERY_POSTS,
			{ input },
			{ signal },
		);
		const batch = data.posts ?? [];

		let added = 0;
		for (const post of batch) {
			if (post.id && seenIds.has(post.id)) continue;
			if (post.id) seenIds.add(post.id);
			posts.push(post);
			added++;
		}

		// 새로 들어온 게 없다 = 커서가 제자리다. '다 봤다'가 아니다.
		if (added === 0) {
			return { posts, truncated: true, outcome: 'cursor_stalled' };
		}
		// 한 페이지를 못 채웠으면 진짜 마지막이다.
		if (batch.length < PAGE_SIZE) {
			return { posts, truncated: false, outcome: 'complete' };
		}

		const next = batch.at(-1)?.id;
		if (!next || seenCursors.has(next)) {
			return { posts, truncated: true, outcome: 'cursor_stalled' };
		}
		seenCursors.add(next);
		cursor = next;
	}
	return { posts, truncated: true, outcome: 'page_limit' };
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
				username: z
					.string()
					.optional()
					.describe('@ 없이. 생략하면 인증된 내 계정을 쓴다'),
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
		async ({ username, top, max_pages }, extra) => {
			// ★ 최대 20페이지를 넘긴다. 취소를 안 보면 사용자가 포기한 뒤에도 계속 돈다.
			const target = username ?? (await resolveMyUsername(client, extra.signal));
			const { posts, truncated, outcome } = await fetchAllPosts(
				client,
				target,
				max_pages,
				extra.signal,
			);
			if (posts.length === 0) return textResult(`@${target} 의 공개 글이 없습니다.`);

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
				`# @${target} 블로그 통계`,
				'',
				`- 글 ${num(posts.length)}편${truncated ? ' (전부는 아닙니다 — 아래 참고)' : ''}`,
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

			// 왜 덜 봤는지에 따라 사용자가 할 일이 다르다. 뭉뚱그리면 안 된다.
			const warning =
				outcome === 'page_limit'
					? `\n\n⚠️ 상한 ${max_pages}페이지(${max_pages * PAGE_SIZE}편)에서 멈췄습니다. ` +
						'전체를 보려면 max_pages 를 올리세요.'
					: outcome === 'cursor_stalled'
						? '\n\n⚠️ 벨로그 페이지네이션이 더 진행되지 않아 여기서 멈췄습니다. ' +
							'집계는 위 편수 기준이며 실제 글은 더 있을 수 있습니다.'
						: '';

			return textResult(report + warning);
		},
	);
}
