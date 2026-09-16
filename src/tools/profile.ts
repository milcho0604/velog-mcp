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
import { fetchCurrentUser } from '../me.ts';

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
		'velog_whoami',
		{
			title: '내 계정 확인',
			description:
				'현재 토큰으로 인증된 계정을 확인한다. 토큰이 살아있는지 점검하는 용도로도 쓴다. ' +
				'다른 도구에서 username 을 생략하면 여기서 얻는 계정을 쓴다.',
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async (_args, extra) => {
			client.requireAuth('velog_whoami');
			// ★ 이 도구는 «토큰이 살아있는가» 를 묻는 자리다. 캐시를 돌려주면
			//   만료된 뒤에도 «인증됨» 이라 답한다. 여기서만 캐시를 건너뛴다.
			const me = await fetchCurrentUser(client, extra.signal, { bypassCache: true });
			return textResult(
				[
					`✅ 인증됨 — @${me.username ?? '(username 없음)'}`,
					'',
					`- 이름: ${me.profile?.display_name ?? '—'}`,
					`- 소개: ${me.profile?.short_bio ?? '—'}`,
					`- 내 블로그: https://velog.io/@${me.username ?? ''}`,
					'',
					'※ 공개 발행은 VELOG_ALLOW_PUBLIC=1 이 설정돼 있을 때만 가능합니다.',
				].join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_get_user',
		{
			title: '벨로그 사용자 정보',
			description: '벨로그 사용자의 프로필과 팔로워 수를 조회한다.',
			inputSchema: { username: z.string().describe('@ 없이') },
			annotations: READ_ONLY,
		},
		async ({ username }, extra) => {
			const data = await client.request<UserResult>(
				QUERY_USER,
				{ input: { username } },
				{ signal: extra.signal },
			);
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
			// ★★ 소개글은 **자르지 않는다.**
			//
			//   한때 1,000자에서 잘랐다. 그런데 `velog_update_about` 은 「먼저
			//   velog_get_user 로 읽어 합친 뒤 넘기라」고 안내한다 — 전체 교체라서다.
			//   그래서 **문서가 시키는 대로 하면 1,000자 뒤가 사라졌다.** 1,216자짜리
			//   소개글에 6자를 붙이자 1,006자가 되어 216자가 조용히 날아갔다(코덱스 18차).
			//   잘린 줄 모르면 «성공» 응답과 함께 잃는다. 그게 제일 나쁘다.
			//
			//   상한은 안전선으로만 둔다. 넘으면 **잘렸다고 말하고 합치지 말라고 한다.**
			// ⚠️ 비었는지 판정에만 trim 을 쓰고 **원문을 그대로 돌려준다.** trim 한 값을
			//   돌려주면 마크다운 코드블록의 들여쓰기와 끝 개행이 사라진다 —
			//   그걸 합쳐 저장하면 글이 망가진다(코덱스 19차).
			if (p?.about && p.about.trim() !== '') {
				const about = p.about;
				const limit = 20_000;
				// ⚠️ 상한 자리가 서로게이트 쌍 한가운데면 한 글자 물러선다.
				let cut = Math.min(limit, about.length);
				const head = about.charCodeAt(cut - 1);
				if (cut < about.length && head >= 0xd800 && head <= 0xdbff) cut -= 1;
				lines.push('', '## 소개글', about.slice(0, cut));
				if (about.length > limit) {
					lines.push(
						'',
						`⚠️ 소개글이 ${about.length}자라 ${limit}자에서 잘랐습니다. ` +
							'**이 내용으로 velog_update_about 을 부르면 나머지가 사라집니다.** ' +
							'벨로그에서 전문을 확인한 뒤 수정하세요.',
					);
				}
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
		async ({ username }, extra) => {
			const data = await client.request<SeriesListResult>(
				QUERY_SERIES_LIST,
				{ input: { username } },
				{ signal: extra.signal },
			);
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
		async ({ username, top }, extra) => {
			const data = await client.request<UserTagsResult>(
				QUERY_USER_TAGS,
				{ input: { username } },
				{ signal: extra.signal },
			);
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
