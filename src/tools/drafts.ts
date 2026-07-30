/**
 * 초안 도구 — 이 파일이 이 레포의 '유일한' 쓰기 경로다.
 *
 * ★★ is_temp 는 상수다. 도구 입력 스키마에 없으므로 호출자가 덮어쓸 수 없고,
 *    따라서 이 서버는 글을 발행할 수 없다. 설계 근거: docs/decisions/0002.
 *
 * 이 파일을 고칠 때는 ADR 0002 를 먼저 읽을 것.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import { QUERY_POSTS } from '../graphql.ts';
import { formatPostList, textResult } from '../format.ts';
import { toUrlSlug } from '../slug.ts';
import type { VelogPostSummary } from '../types.ts';
import { READ_ONLY } from './posts.ts';

/**
 * ★ 발행 차단 지점. 이 값은 파라미터가 아니라 상수다.
 *   true = 임시저장(남에게 보이지 않음), false = 발행(되돌릴 수 없음).
 */
const DRAFT_ONLY = { is_temp: true, is_markdown: true } as const;

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
		'발행하려면 벨로그에서 내용을 확인한 뒤 직접 "출간하기"를 누르세요.',
		'이 서버에는 발행 기능이 없습니다.',
	].join('\n');
}

export function registerDraftTools(server: McpServer, client: VelogClient): void {
	server.registerTool(
		'velog_create_draft',
		{
			title: '벨로그 초안 작성',
			description:
				'벨로그에 임시저장 글(초안)을 만든다. 발행되지 않으며 작성자 본인만 볼 수 있다. ' +
				'이 서버는 발행 기능이 없다 — 초안 생성 후 사용자에게 "벨로그에서 확인하고 직접 출간하세요"라고 안내할 것. ' +
				'body 는 마크다운으로 쓴다.',
			inputSchema: {
				title: z.string().min(1).describe('글 제목'),
				body: z.string().min(1).describe('본문 (마크다운)'),
				tags: z.array(z.string()).default([]).describe('태그 목록'),
				url_slug: z.string().optional().describe('생략하면 제목에서 생성'),
				thumbnail: z.string().url().optional().describe('썸네일 이미지 URL'),
				series_id: z.string().optional().describe('소속시킬 시리즈 id'),
			},
			// 되돌릴 수 있는 쓰기다 — 비공개 초안이므로 파괴적이지 않다.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async ({ title, body, tags, url_slug, thumbnail, series_id }) => {
			client.requireAuth('velog_create_draft');

			const input: Record<string, unknown> = {
				title,
				body,
				tags,
				url_slug: toUrlSlug(title, url_slug),
				is_private: false,
				meta: {},
				...DRAFT_ONLY, // ★ 마지막에 펼쳐서 위 값들이 덮어쓸 수 없게 한다
			};
			if (thumbnail) input['thumbnail'] = thumbnail;
			if (series_id) input['series_id'] = series_id;

			const data = await client.request<{ writePost: WrittenPost }>(
				MUTATION_WRITE_POST,
				{ input },
			);
			assertStayedDraft(data.writePost);
			return textResult(draftResult(data.writePost, '저장'));
		},
	);

	server.registerTool(
		'velog_update_draft',
		{
			title: '벨로그 초안 수정',
			description:
				'기존 초안을 수정한다. 수정 후에도 임시저장 상태로 남는다. ' +
				'★ 주의: 이미 발행된 글의 id 를 주면 그 글이 임시저장으로 내려가 비공개가 된다. ' +
				'velog_list_drafts 로 확인한 초안 id 만 사용할 것.',
			inputSchema: {
				id: z.string().min(1).describe('초안의 id (velog_list_drafts 로 확인)'),
				title: z.string().min(1),
				body: z.string().min(1).describe('본문 전체 (마크다운). 부분 수정이 아니라 교체다'),
				tags: z.array(z.string()).default([]),
				url_slug: z.string().optional(),
				thumbnail: z.string().url().optional(),
				series_id: z.string().optional(),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ id, title, body, tags, url_slug, thumbnail, series_id }) => {
			client.requireAuth('velog_update_draft');

			const input: Record<string, unknown> = {
				id,
				title,
				body,
				tags,
				url_slug: toUrlSlug(title, url_slug),
				is_private: false,
				meta: {},
				...DRAFT_ONLY,
			};
			if (thumbnail) input['thumbnail'] = thumbnail;
			if (series_id) input['series_id'] = series_id;

			const data = await client.request<{ editPost: WrittenPost }>(MUTATION_EDIT_POST, {
				input,
			});
			assertStayedDraft(data.editPost);
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
				username: z.string().describe('내 벨로그 username (@ 없이)'),
				limit: z.number().int().min(1).max(50).default(20),
			},
			annotations: READ_ONLY,
		},
		async ({ username, limit }) => {
			client.requireAuth('velog_list_drafts');

			const data = await client.request<{ posts: VelogPostSummary[] }>(QUERY_POSTS, {
				input: { username, limit, temp_only: true },
			});
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
