/**
 * 사용자·시리즈·태그 조회. 전부 읽기 전용이고 인증이 필요 없다.
 *
 * 시리즈와 태그는 "이 사람이 무엇을 꾸준히 쓰는가"를 한눈에 보여준다.
 * 글 목록을 다 훑는 것보다 훨씬 싸다.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { textResult } from '../format.ts';
import { READ_ONLY } from './posts.ts';

const QUERY_USER = `
  query GetUser($input: GetUserInput!) {
    user(input: $input) {
      id
      username
      followers_count
      followings_count
      profile { display_name short_bio thumbnail about profile_links }
      velog_config { title }
    }
  }
`;

const QUERY_SERIES_LIST = `
  query SeriesList($input: GetSeriesListInput!) {
    seriesList(input: $input) {
      id
      name
      url_slug
      description
      posts_count
      updated_at
    }
  }
`;

const QUERY_USER_TAGS = `
  query UserTags($input: UserTagsInput!) {
    userTags(input: $input) {
      tags { id name posts_count }
    }
  }
`;

interface UserResult {
	user: {
		username?: string;
		followers_count?: number | null;
		followings_count?: number | null;
		profile?: {
			display_name?: string | null;
			short_bio?: string | null;
			about?: string | null;
			profile_links?: unknown;
		} | null;
		velog_config?: { title?: string | null } | null;
	} | null;
}

interface SeriesListResult {
	seriesList: Array<{
		id: string;
		name?: string | null;
		url_slug?: string | null;
		description?: string | null;
		posts_count?: number | null;
		updated_at?: string | null;
	}> | null;
}

interface UserTagsResult {
	userTags: { tags: Array<{ name?: string | null; posts_count?: number | null }> } | null;
}

export function registerProfileTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_get_user',
		{
			title: '벨로그 사용자 정보',
			description: '벨로그 사용자의 프로필과 팔로워 수를 조회한다.',
			inputSchema: { username: z.string().describe('@ 없이') },
			annotations: READ_ONLY,
		},
		async ({ username }) => {
			const data = await client.request<UserResult>(QUERY_USER, {
				input: { username },
			});
			const user = data.user;
			if (!user) return textResult(`@${username} 을(를) 찾지 못했습니다.`);

			const p = user.profile;
			const lines = [
				`# @${user.username ?? username}`,
				'',
				`- 이름: ${p?.display_name ?? '—'}`,
				`- 소개: ${p?.short_bio ?? '—'}`,
				`- 블로그 제목: ${user.velog_config?.title ?? '—'}`,
				`- 팔로워 ${user.followers_count ?? 0} · 팔로잉 ${user.followings_count ?? 0}`,
				`- URL: https://velog.io/@${user.username ?? username}`,
			];
			if (p?.about?.trim()) {
				lines.push('', '## 소개글', p.about.trim().slice(0, 1000));
			}
			return textResult(lines.join('\n'));
		},
	);

	server.registerTool(
		'velog_list_series',
		{
			title: '시리즈 목록',
			description:
				'사용자의 연재 시리즈 목록. 각 시리즈에 글이 몇 편인지 함께 준다. ' +
				'초안을 특정 시리즈에 넣으려면 여기서 얻은 id 를 velog_create_draft 의 series_id 에 준다.',
			inputSchema: { username: z.string().describe('@ 없이') },
			annotations: READ_ONLY,
		},
		async ({ username }) => {
			const data = await client.request<SeriesListResult>(QUERY_SERIES_LIST, {
				input: { username },
			});
			const list = data.seriesList ?? [];
			if (list.length === 0) return textResult(`@${username} 의 시리즈가 없습니다.`);

			const body = list
				.map(
					(s, i) =>
						`${i + 1}. ${s.name ?? '(제목 없음)'} — ${s.posts_count ?? 0}편\n` +
						`    id: \`${s.id}\`\n` +
						`    https://velog.io/@${username}/series/${s.url_slug ?? ''}`,
				)
				.join('\n\n');
			return textResult(`시리즈 ${list.length}개\n\n${body}`);
		},
	);

	server.registerTool(
		'velog_user_tags',
		{
			title: '사용자 태그 목록',
			description:
				'사용자가 쓴 태그와 각 태그의 글 수. "이 사람이 뭘 주로 쓰나"를 가장 싸게 파악하는 방법이다.',
			inputSchema: {
				username: z.string().describe('@ 없이'),
				top: z.number().int().min(1).max(100).default(30),
			},
			annotations: READ_ONLY,
		},
		async ({ username, top }) => {
			const data = await client.request<UserTagsResult>(QUERY_USER_TAGS, {
				input: { username },
			});
			const tags = data.userTags?.tags ?? [];
			if (tags.length === 0) return textResult(`@${username} 의 태그가 없습니다.`);

			const sorted = [...tags]
				.sort((a, b) => (b.posts_count ?? 0) - (a.posts_count ?? 0))
				.slice(0, top);
			const body = sorted
				.map((t) => `  #${t.name ?? '?'} — ${t.posts_count ?? 0}편`)
				.join('\n');
			return textResult(
				`@${username} 의 태그 ${tags.length}개 (상위 ${sorted.length})\n\n${body}`,
			);
		},
	);
}
