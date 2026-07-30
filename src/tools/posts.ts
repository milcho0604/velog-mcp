/**
 * 글 조회 도구 — 전부 읽기 전용.
 *
 * 인증이 없어도 공개 글은 조회된다 (ADR 0003).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { QUERY_POST, QUERY_POSTS } from '../graphql.ts';
import { formatPostDetail, formatPostList, textResult } from '../format.ts';
import type { VelogPostDetail, VelogPostSummary } from '../types.ts';

/** 읽기 도구 공통 표식 — 클라이언트가 위험도를 판단할 수 있게 한다. */
export const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	openWorldHint: true,
} as const;

export function registerPostTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_get_post',
		{
			title: '벨로그 글 읽기',
			description:
				'벨로그 글 하나를 본문까지 읽어온다. username + url_slug 조합이나 글 id 로 지정한다. ' +
				'예: https://velog.io/@velopert/react-context-tutorial → username="velopert", url_slug="react-context-tutorial"',
			inputSchema: {
				username: z.string().optional().describe('@ 없이. 예: "velopert"'),
				url_slug: z.string().optional().describe('URL 마지막 조각'),
				id: z.string().optional().describe('글 UUID. 이걸 주면 username/url_slug 는 불필요'),
			},
			annotations: READ_ONLY,
		},
		async ({ username, url_slug, id }) => {
			if (!id && !(username && url_slug)) {
				throw new Error('id 를 주거나, username 과 url_slug 를 함께 주세요.');
			}
			const input: Record<string, string> = {};
			if (id) input['id'] = id;
			else {
				input['username'] = username!;
				input['url_slug'] = url_slug!;
			}

			const data = await client.request<{ post: VelogPostDetail | null }>(QUERY_POST, {
				input,
			});
			if (!data.post) return textResult('해당 글을 찾지 못했습니다.');
			return textResult(formatPostDetail(data.post));
		},
	);

	server.registerTool(
		'velog_list_posts',
		{
			title: '벨로그 글 목록',
			description:
				'특정 사용자의 글 목록을 최신순으로 가져온다. tag 로 좁힐 수 있다. ' +
				'cursor 에 직전 응답의 마지막 글 id 를 주면 다음 페이지를 읽는다.',
			inputSchema: {
				username: z.string().describe('@ 없이'),
				tag: z.string().optional().describe('이 태그가 달린 글만'),
				limit: z.number().int().min(1).max(50).default(20),
				cursor: z.string().optional().describe('이전 페이지 마지막 글의 id'),
			},
			annotations: READ_ONLY,
		},
		async ({ username, tag, limit, cursor }) => {
			const input: Record<string, unknown> = { username, limit };
			if (tag) input['tag'] = tag;
			if (cursor) input['cursor'] = cursor;

			const data = await client.request<{ posts: VelogPostSummary[] }>(QUERY_POSTS, {
				input,
			});
			const posts = data.posts ?? [];
			const body = formatPostList(posts);
			const last = posts.at(-1);
			const more =
				posts.length === limit && last
					? `\n\n다음 페이지: cursor="${last.id}"`
					: '';
			return textResult(body + more);
		},
	);
}
