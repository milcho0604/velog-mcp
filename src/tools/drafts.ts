/**
 * 초안 도구 — 이 파일이 이 레포의 '유일한' 쓰기 경로다.
 *
 * ★★ is_temp 는 상수다. 도구 입력 스키마에 없으므로 호출자가 덮어쓸 수 없고,
 *    따라서 **이 도구들은** 어떤 설정에서도 글을 발행하지 않는다.
 *    발행은 별도 파일(tools/publish.ts)이 담당한다 — 이름이 다르면 초안을
 *    쓰려다 실수로 발행되는 사고가 안 난다.
 *
 * 이 파일을 고칠 때는 ADR 0004 를 먼저 읽을 것.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { QUERY_POSTS } from '../graphql.ts';
import { formatPostList, textResult } from '../format.ts';
import { toUrlSlug, isSafeImageUrl } from '../slug.ts';
import { resolveMyUsername } from '../me.ts';
import type { VelogPostSummary } from '../types.ts';
import { READ_ONLY } from './posts.ts';

/**
 * ★ 발행 차단 지점. 이 값은 파라미터가 아니라 상수다.
 *   true = 임시저장(남에게 보이지 않음), false = 발행(되돌릴 수 없음).
 */
const DRAFT_ONLY = { is_temp: true, is_markdown: true, is_private: true } as const;

const MUTATION_WRITE_POST = `
  mutation WriteDraft($input: WritePostInput!) {
    writePost(input: $input) { id title url_slug is_temp user { username } }
  }
`;

const MUTATION_EDIT_POST = `
  mutation EditDraft($input: EditPostInput!) {
    editPost(input: $input) { id title url_slug is_temp user { username } }
  }
`;

/** 수정 전 상태 확인용. 필요한 필드만 받는다. */
const QUERY_POST_STATE = `
  query PostState($input: ReadPostInput!) {
    post(input: $input) { id is_temp }
  }
`;

interface WrittenPost {
	id: string;
	title: string;
	url_slug: string;
	is_temp: boolean;
	user?: { username?: string } | null;
}

/** 벨로그가 정말 임시저장으로 받았는지 응답으로 확인한다. */
function assertStayedDraft(post: WrittenPost): void {
	if (post.is_temp !== true) {
		throw new Error(
			`예상치 못한 상태: 벨로그가 이 글을 임시저장이 아닌 것으로 저장했습니다 ` +
				`(is_temp=${post.is_temp}, id=${post.id}). 즉시 벨로그에서 확인하세요.`,
		);
	}
}

function draftResult(post: WrittenPost, verb: string): string {
	const username = post.user?.username;
	const where = username
		? `https://velog.io/write?id=${post.id}`
		: `(id: ${post.id})`;
	return [
		`✅ 초안을 ${verb}했습니다. **아직 발행되지 않았습니다.**`,
		'',
		`- 제목: ${post.title}`,
		`- id: \`${post.id}\``,
		`- 상태: 임시저장 (is_temp=true) — 나만 볼 수 있음`,
		`- 편집: ${where}`,
		'',
		'발행하려면 velog_publish_draft 를 쓰거나, 벨로그에서 직접 "출간하기"를 누르세요.',
	].join('\n');
}

export function registerDraftTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_create_draft',
		{
			title: '벨로그 초안 작성',
			description:
				'벨로그에 임시저장 글(초안)을 만든다. 발행되지 않으며 작성자 본인만 볼 수 있다. ' +
				'이 도구는 어떤 설정에서도 발행하지 않는다 — 발행하려면 velog_publish_draft 를 따로 부를 것. ' +
				'body 는 마크다운으로 쓴다.',
			inputSchema: {
				title: z.string().min(1).describe('글 제목'),
				body: z.string().min(1).describe('본문 (마크다운)'),
				tags: z.array(z.string()).default([]).describe('태그 목록'),
				url_slug: z.string().optional().describe('생략하면 제목에서 생성'),
				thumbnail: z
					.string()
					.refine(isSafeImageUrl, 'http(s) 이미지 URL 만 허용합니다')
					.optional()
					.describe('썸네일 이미지 URL (http/https 만)'),
				series_id: z
					.string()
					.optional()
					.describe(
						'소속시킬 시리즈 id. ★ 벨로그는 임시저장 단계에서 이걸 무시한다 — ' +
							'초안 생성 후 velog_update_draft 로 다시 지정해야 실제로 붙는다',
					),
			},
			// 되돌릴 수 있는 쓰기다 — 비공개 초안이므로 파괴적이지 않다.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ title, body, tags, url_slug, thumbnail, series_id }) => {
			client.requireAuth('velog_create_draft');
			// ★ 초안은 is_private:true 라 벨로그 계수(is_private:false 만 셈)에
			//   잡히지 않는다. 그래서 상한을 걸지 않는다 — 상한은 '공개 발행' 쪽에 있다.

			const input: Record<string, unknown> = {
				title,
				body,
				tags,
				url_slug: toUrlSlug(title, url_slug),
				meta: {},
				...DRAFT_ONLY, // ★ 마지막에 펼쳐서 위 값들이 덮어쓸 수 없게 한다
			};
			if (thumbnail) input['thumbnail'] = thumbnail;
			if (series_id) input['series_id'] = series_id;

			// mutate 는 재시도하지 않는다 — 응답 유실 시 초안이 중복 생성된다.
			const data = await client.mutate<{ writePost: WrittenPost }>(
				MUTATION_WRITE_POST,
				{ input },
			);
			assertStayedDraft(data.writePost);

			// ★ 벨로그는 임시저장 생성 시 series_id 를 조용히 버린다:
			//   // apps/server/src/services/PostApiService/index.mts
			//   if (series_id && !data.is_temp) await appendToSeries(...)
			// edit 경로에는 이 조건이 없어 update_draft 로는 붙는다. 이 비대칭을
			// 사용자가 알 방법이 없으므로 직접 알린다.
			const seriesNote = series_id
				? '\n\n⚠️ 시리즈는 **적용되지 않았습니다.** 벨로그가 임시저장 생성 단계에서는' +
					' series_id 를 무시합니다. 방금 만든 초안 id 로 velog_update_draft 를' +
					' 한 번 호출하면 그때 실제로 붙습니다.'
				: '';
			return textResult(draftResult(data.writePost, '저장') + seriesNote);
		},
	);

	server.registerTool(
		'velog_update_draft',
		{
			title: '벨로그 초안 수정',
			description:
				'기존 초안을 **통째로 교체**한다. 부분 수정이 아니다. ' +
				'생략한 필드는 유지되지 않고 초기화된다 — tags 를 안 주면 기존 태그가 전부 지워지고, ' +
				'url_slug 를 안 주면 제목에서 새로 만들어 주소가 바뀌며, series_id 를 안 주면 ' +
				'기존 시리즈 연결이 끊긴다. 그래서 수정 전에 velog_get_post 로 현재 값을 읽어 ' +
				'바꾸지 않을 필드도 그대로 다시 넘기는 것을 권한다. ' +
				'발행된 글의 id 는 거부한다(비공개로 내려가는 사고 방지).',
			inputSchema: {
				id: z.string().min(1).describe('초안의 id (velog_list_drafts 로 확인)'),
				title: z.string().min(1),
				body: z.string().min(1).describe('본문 전체 (마크다운). 부분 수정이 아니라 교체다'),
				tags: z.array(z.string()).default([]),
				url_slug: z.string().optional(),
				thumbnail: z
					.string()
					.refine(isSafeImageUrl, 'http(s) 이미지 URL 만 허용합니다')
					.optional(),
				series_id: z.string().optional(),
			},
			// ★ destructive 가 맞다. 생략 필드가 보존되지 않고 초기화된다 —
			//   MCP 명세상 destructiveHint:false 는 '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ id, title, body, tags, url_slug, thumbnail, series_id }) => {
			client.requireAuth('velog_update_draft');

			// ★ 발행된 글을 임시저장으로 끌어내리는 사고를 코드로 막는다.
			//   editPost 는 is_temp 를 덮어쓰므로, 발행글 id 가 들어오면 그 글이
			//   조용히 비공개가 된다. 문서 경고만으로는 부족해 사전 확인을 넣었다.
			const before = await client.request<{ post: { is_temp?: boolean } | null }>(
				QUERY_POST_STATE,
				{ input: { id } },
			);
			if (!before.post) {
				throw new Error(
					`id=${id} 인 글을 찾지 못했습니다. velog_list_drafts 로 id 를 확인하세요.`,
				);
			}
			if (before.post.is_temp !== true) {
				throw new Error(
					`id=${id} 는 이미 발행된 글입니다. 이 도구로 수정하면 임시저장으로 내려가 ` +
						`비공개가 되므로 중단했습니다. 발행된 글은 벨로그에서 직접 수정하세요.`,
				);
			}

			const input: Record<string, unknown> = {
				id,
				title,
				body,
				tags,
				url_slug: toUrlSlug(title, url_slug),
				meta: {},
				...DRAFT_ONLY,
			};
			if (thumbnail) input['thumbnail'] = thumbnail;
			if (series_id) input['series_id'] = series_id;

			const data = await client.mutate<{ editPost: WrittenPost }>(MUTATION_EDIT_POST, {
				input,
			});

			// ★ editPost 의 응답으로는 사후 상태를 알 수 없다. 공식 구현이
			//   `return { ...post, url_slug: data.url_slug }` 로 **갱신 전에 읽은**
			//   post 를 돌려주고 url_slug 만 덮기 때문이다
			//   (apps/server/src/services/PostApiService/index.mts).
			//   그래서 응답의 is_temp 는 '수정 전' 값이다 — 그걸 검사해봐야 사전확인을
			//   한 번 더 하는 것에 불과하다. 진짜 사후 확인은 재조회뿐이다.
			const after = await client.request<{ post: { is_temp?: boolean } | null }>(
				QUERY_POST_STATE,
				{ input: { id } },
			);
			if (after.post && after.post.is_temp !== true) {
				throw new Error(
					`⚠️ 수정 후 확인 결과 이 글이 임시저장이 아닙니다 (id=${id}). ` +
						'수정 직전에 다른 곳에서 발행됐을 수 있습니다. 벨로그에서 상태를 확인하세요.',
				);
			}

			return textResult(draftResult(data.editPost, '수정'));
		},
	);

	server.registerTool(
		'velog_list_drafts',
		{
			title: '내 초안 목록',
			description:
				'내 임시저장 글 목록. 초안을 이어 쓰거나 수정하기 전에 id 를 여기서 확인한다.',
			inputSchema: {
				username: z
					.string()
					.optional()
					.describe('생략하면 토큰의 계정을 쓴다. 남의 초안은 어차피 안 보인다'),
				limit: z.number().int().min(1).max(50).default(20),
			},
			annotations: READ_ONLY,
		},
		async ({ username, limit }) => {
			client.requireAuth('velog_list_drafts');

			// 토큰이 있으면 서버가 이미 누군지 안다. 사용자가 매번 칠 이유가 없다.
			const target = username ?? (await resolveMyUsername(client));

			const data = await client.request<{ posts: VelogPostSummary[] | null }>(
				QUERY_POSTS,
				{ input: { username: target, limit, temp_only: true } },
			);
			const posts = data.posts ?? [];
			if (posts.length === 0) return textResult('임시저장된 초안이 없습니다.');

			const withIds = posts
				.map((p, i) => `${i + 1}. ${p.title}\n    id: \`${p.id}\``)
				.join('\n\n');
			return textResult(`초안 ${posts.length}건\n\n${withIds}`);
		},
	);
}

/** 테스트에서 상수를 직접 검사하기 위해 노출한다. */
export const __testing = { DRAFT_ONLY, formatPostList };
