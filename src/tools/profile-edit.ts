/**
 * 프로필 수정 도구.
 *
 * `VELOG_ALLOW_PROFILE=1` 이 있어야 실제로 동작한다. 근거는 capabilities.ts 주석 —
 * 위험해서가 아니라 `short_bio`(프로필)와 `short_description`(글) 혼동 때문이다.
 *
 * ★ 병합이 핵심이다. `UpdateProfileInput` 은 `display_name` 과 `short_bio` 를
 *   **둘 다 필수**로 받는다. 하나만 바꾸겠다고 한쪽만 보내면 다른 쪽이 빈 문자열로
 *   덮인다. 그래서 항상 현재 값을 읽어 채운 뒤 보낸다.
 *   (초안 도구의 '생략=초기화'가 사고를 부른다는 걸 이미 확인했다.)
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import type { Capabilities } from '../capabilities.ts';
import { textResult } from '../format.ts';
import { isSafeImageUrl, isSafeHttpUrl } from '../slug.ts';
import { fetchCurrentUser, invalidateMe } from '../me.ts';

const MUTATION_UPDATE_PROFILE = `
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) { id display_name short_bio }
  }
`;

const MUTATION_UPDATE_ABOUT = `
  mutation UpdateAbout($input: UpdateAboutInput!) {
    updateAbout(input: $input) { id about }
  }
`;

const MUTATION_UPDATE_VELOG_TITLE = `
  mutation UpdateVelogTitle($input: UpdateVelogTitleInput!) {
    updateVelogTitle(input: $input) { title logo_image }
  }
`;

const MUTATION_UPDATE_SOCIAL = `
  mutation UpdateSocialInfo($input: UpdateSocialInfoInput!) {
    updateSocialInfo(input: $input) { id profile_links }
  }
`;

const MUTATION_UPDATE_THUMBNAIL = `
  mutation UpdateThumbnail($input: UpdateThumbnailInput!) {
    updateThumbnail(input: $input) { id thumbnail }
  }
`;

/** 현재 프로필 전체. 병합에 필요해 한 번에 읽는다. */
const QUERY_MY_PROFILE = `
  query MyProfile($input: GetUserInput!) {
    user(input: $input) {
      id
      username
      profile { display_name short_bio about thumbnail profile_links }
      velog_config { title }
    }
  }
`;

interface MyProfile {
	id?: string;
	username?: string;
	profile?: {
		display_name?: string | null;
		short_bio?: string | null;
		about?: string | null;
		thumbnail?: string | null;
		profile_links?: Record<string, unknown> | null;
	} | null;
	velog_config?: { title?: string | null } | null;
}

/** 벨로그가 받는 SNS 링크 키. 임의 키를 넣으면 프로필 화면에서 안 보인다. */
const SOCIAL_KEYS = ['github', 'twitter', 'facebook', 'url', 'email'] as const;

export function registerProfileEditTools(
	server: McpServer,
	client: VelogClient,
	capabilities: Capabilities,
): void {
	// 꺼져 있으면 도구를 아예 등록하지 않는다. 목록에 없으면 부를 수도 없다.
	if (!capabilities.editProfile) return;

	/** 현재 프로필을 읽는다. 병합의 기준값이다. */
	async function current(toolName: string): Promise<MyProfile> {
		client.requireAuth(toolName);
		const me = await fetchCurrentUser(client);
		if (!me.username) {
			throw new Error(`${toolName}: 현재 계정의 username 을 확인하지 못했습니다.`);
		}
		const data = await client.request<{ user: MyProfile | null }>(QUERY_MY_PROFILE, {
			input: { username: me.username },
		});
		if (!data.user) {
			throw new Error(`${toolName}: 프로필을 불러오지 못했습니다.`);
		}
		return data.user;
	}

	server.registerTool(
		'velog_update_profile',
		{
			title: '프로필 수정 (이름·한줄소개)',
			description:
				'벨로그 프로필의 표시 이름과 한줄 소개를 바꾼다. ' +
				'★ 이건 **블로그 주인의 프로필**이다 — 글의 요약문(short_description)이 아니다. ' +
				'생략한 항목은 현재 값을 그대로 유지한다.',
			inputSchema: {
				display_name: z.string().max(255).optional().describe('표시 이름. 생략하면 유지'),
				// ★ 서버가 short_bio 를 255자로 **조용히 자른다**(userResolvers 의 slice).
				//   여기서 안 막으면 "저장했습니다" 라고 해놓고 뒷부분이 사라진다.
				short_bio: z
					.string()
					.max(255, '한줄 소개는 255자까지입니다 (서버가 그 이상을 조용히 자릅니다)')
					.optional()
					.describe('한줄 소개 (255자 이내). 생략하면 유지'),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ display_name, short_bio }) => {
			const user = await current('velog_update_profile');
			const p = user.profile;

			// ★ 둘 다 필수 필드라 한쪽만 보내면 다른 쪽이 지워진다. 반드시 채워 보낸다.
			const input = {
				display_name: display_name ?? p?.display_name ?? '',
				short_bio: short_bio ?? p?.short_bio ?? '',
			};

			await client.mutate(MUTATION_UPDATE_PROFILE, { input });
			invalidateMe(client);

			const after = await current('velog_update_profile');
			return textResult(
				[
					'✅ 프로필을 수정했습니다.',
					'',
					`- 이름: ${after.profile?.display_name ?? '—'}`,
					`- 한줄 소개: ${after.profile?.short_bio ?? '—'}`,
					`- 확인: https://velog.io/@${after.username ?? ''}`,
				].join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_update_about',
		{
			title: '소개글 수정',
			description:
				'벨로그 "소개" 탭의 긴 글을 통째로 바꾼다(마크다운). ' +
				'★ 전체 교체다 — 기존 내용에 덧붙이려면 먼저 velog_get_user 로 읽어 합친 뒤 넘길 것.',
			inputSchema: {
				about: z.string().describe('소개글 전문 (마크다운). 빈 문자열이면 소개글이 비워진다'),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ about }) => {
			client.requireAuth('velog_update_about');
			await client.mutate(MUTATION_UPDATE_ABOUT, { input: { about } });
			invalidateMe(client);

			const after = await current('velog_update_about');
			const saved = after.profile?.about ?? '';
			return textResult(
				[
					'✅ 소개글을 수정했습니다.',
					'',
					`- 길이: ${saved.length}자`,
					`- 확인: https://velog.io/@${after.username ?? ''}/about`,
					'',
					'--- 저장된 내용 앞부분 ---',
					saved.slice(0, 300) + (saved.length > 300 ? '…' : ''),
				].join('\n'),
			);
		},
	);

	server.registerTool(
		'velog_update_blog_title',
		{
			title: '블로그 제목 수정',
			description: '벨로그 상단에 뜨는 블로그 제목을 바꾼다 (예: "velopert.log").',
			inputSchema: { title: z.string().min(1).describe('새 블로그 제목') },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ title }) => {
			client.requireAuth('velog_update_blog_title');
			await client.mutate(MUTATION_UPDATE_VELOG_TITLE, { input: { title } });

			const after = await current('velog_update_blog_title');
			return textResult(
				`✅ 블로그 제목을 "${after.velog_config?.title ?? title}" 로 바꿨습니다.\n` +
					`- 확인: https://velog.io/@${after.username ?? ''}`,
			);
		},
	);

	server.registerTool(
		'velog_update_social_links',
		{
			title: 'SNS 링크 수정',
			description:
				`프로필의 SNS 링크를 바꾼다. 지원 키: ${SOCIAL_KEYS.join(', ')}. ` +
				'생략한 키는 현재 값을 유지하고, 빈 문자열을 주면 그 항목이 지워진다.',
			inputSchema: {
				// 빈 문자열은 '삭제' 의미라 허용한다. 그 외에는 형식을 본다 —
				// 잘못된 링크를 프로필에 박아두면 방문자가 깨진 링크를 밟는다.
				github: z.string().max(100).optional().describe('사용자명 또는 URL'),
				twitter: z.string().max(100).optional(),
				facebook: z.string().max(100).optional(),
				url: z
					.string()
					.refine((v) => v === '' || isSafeHttpUrl(v), 'http(s) URL 이어야 합니다')
					.optional()
					.describe('홈페이지 (빈 문자열이면 삭제)'),
				email: z
					.string()
					.refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), '이메일 형식이 아닙니다')
					.optional()
					.describe('공개 이메일 (빈 문자열이면 삭제)'),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (args: Record<string, unknown>) => {
			const user = await current('velog_update_social_links');
			const existing = user.profile?.profile_links ?? {};

			// ★ profile_links 는 JSON 통째로 교체된다. 기존 값 위에 덮어써야
			//   지정하지 않은 링크가 사라지지 않는다.
			const merged: Record<string, unknown> = { ...existing };
			for (const key of SOCIAL_KEYS) {
				const value = args[key];
				if (typeof value === 'string') merged[key] = value;
			}

			await client.mutate(MUTATION_UPDATE_SOCIAL, {
				input: { profile_links: merged },
			});
			invalidateMe(client);

			const after = await current('velog_update_social_links');
			const links = after.profile?.profile_links ?? {};
			const shown = Object.entries(links)
				.filter(([, v]) => typeof v === 'string' && v.length > 0)
				.map(([k, v]) => `  - ${k}: ${String(v)}`)
				.join('\n');
			return textResult(
				`✅ SNS 링크를 수정했습니다.\n\n${shown || '  (등록된 링크 없음)'}`,
			);
		},
	);

	server.registerTool(
		'velog_update_profile_image',
		{
			title: '프로필 사진 변경',
			description:
				'프로필 이미지를 지정한 URL 로 바꾼다. http(s) 이미지 주소만 받는다. ' +
				'이미지 업로드 기능은 없으므로 이미 어딘가에 올라간 주소가 필요하다.',
			inputSchema: {
				url: z
					.string()
					.refine(isSafeImageUrl, 'http(s) 이미지 URL 만 허용합니다')
					.describe('이미지 URL'),
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ url }) => {
			client.requireAuth('velog_update_profile_image');
			await client.mutate(MUTATION_UPDATE_THUMBNAIL, { input: { url } });
			invalidateMe(client);

			const after = await current('velog_update_profile_image');
			return textResult(
				`✅ 프로필 사진을 바꿨습니다.\n- 현재: ${after.profile?.thumbnail ?? '—'}`,
			);
		},
	);
}
