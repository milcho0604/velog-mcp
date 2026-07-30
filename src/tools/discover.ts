/**
 * 탐색 도구 — 검색·트렌딩·최신. 전부 읽기 전용이고 인증이 필요 없다.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import {
	QUERY_RECENT_POSTS,
	QUERY_SEARCH_POSTS,
	QUERY_TRENDING_POSTS,
} from '../graphql.ts';
import { formatPostList, textResult } from '../format.ts';
import type { SearchPostsResult, VelogPostSummary } from '../types.ts';
import { READ_ONLY } from './posts.ts';

/** 벨로그 트렌딩이 받는 기간 값. */
const TIMEFRAMES = ['day', 'week', 'month', 'year'] as const;

export function registerDiscoverTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_search_posts',
		{
			title: '벨로그 글 검색',
			description:
				'키워드로 벨로그 전체를 검색한다. username 을 주면 그 사람 글 안에서만 찾는다 — ' +
				'"내가 예전에 쓴 그 글" 을 찾을 때 이 조합을 쓴다.',
			inputSchema: {
				keyword: z.string().min(1).describe('검색어'),
				username: z.string().optional().describe('이 사용자의 글로 한정'),
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0).describe('페이지네이션'),
			},
			annotations: READ_ONLY,
		},
		async ({ keyword, username, limit, offset }) => {
			const input: Record<string, unknown> = { keyword, limit, offset };
			if (username) input['username'] = username;

			const data = await client.request<{ searchPosts: SearchPostsResult }>(
				QUERY_SEARCH_POSTS,
				{ input },
			);
			const result = data.searchPosts;
			const posts = result.posts ?? [];
			const body = formatPostList(posts, {
				total: result.count,
				showAuthor: !username,
			});

			// count 는 '필터 이전' 총계다. 벨로그는 조회 후 일부 글을 걸러내므로
			// 반환 건수가 limit 보다 적을 수 있다 (2026-07-30 실측: "프로메테우스"
			// limit=5 → 4건, "리액트" limit=5 → 5건). 그래도 offset 산술 자체는
			// 정상이라(중복·누락 0 확인) 다음 페이지는 limit 만큼 더한다.
			// 반환 건수로 판정하면 필터링된 페이지에서 조기 종료된다.
			const more =
				offset + limit < result.count ? `\n\n다음 페이지: offset=${offset + limit}` : '';
			return textResult(body + more);
		},
	);

	server.registerTool(
		'velog_trending_posts',
		{
			title: '벨로그 트렌딩',
			description: '벨로그 인기 글. 기간을 골라 본다.',
			inputSchema: {
				timeframe: z.enum(TIMEFRAMES).default('week'),
				limit: z.number().int().min(1).max(50).default(20),
				offset: z.number().int().min(0).default(0),
			},
			annotations: READ_ONLY,
		},
		async ({ timeframe, limit, offset }) => {
			const data = await client.request<{ trendingPosts: VelogPostSummary[] }>(
				QUERY_TRENDING_POSTS,
				{ input: { timeframe, limit, offset } },
			);
			return textResult(
				`[트렌딩 · ${timeframe}]\n\n` +
					formatPostList(data.trendingPosts ?? [], { showAuthor: true }),
			);
		},
	);

	server.registerTool(
		'velog_recent_posts',
		{
			title: '벨로그 최신 글',
			description: '벨로그 전체 최신 글. 지금 무슨 글이 올라오는지 훑을 때.',
			inputSchema: {
				limit: z.number().int().min(1).max(50).default(20),
				cursor: z.string().optional().describe('이전 페이지 마지막 글의 id'),
			},
			annotations: READ_ONLY,
		},
		async ({ limit, cursor }) => {
			const input: Record<string, unknown> = { limit };
			if (cursor) input['cursor'] = cursor;

			const data = await client.request<{ recentPosts: VelogPostSummary[] }>(
				QUERY_RECENT_POSTS,
				{ input },
			);
			const posts = data.recentPosts ?? [];
			const last = posts.at(-1);
			const more =
				posts.length === limit && last ? `\n\n다음 페이지: cursor="${last.id}"` : '';
			return textResult(formatPostList(posts, { showAuthor: true }) + more);
		},
	);
}
