/**
 * 발행 도구.
 *
 * 기본은 **비공개 발행**이다. 공개 발행은 `VELOG_ALLOW_PUBLIC=1` 이 있어야 한다
 * — 근거는 src/capabilities.ts 주석 참고 (비공개 글은 벨로그의 파괴적 제한에
 * 걸리지 않지만 공개 글은 걸리고, RSS·검색·구독메일로 나가면 회수가 안 된다).
 *
 * 초안 작성과 발행을 **별도 도구**로 나눈 이유: 같은 도구에 `is_temp` 파라미터를
 * 두면 초안을 쓰려다 값 하나 잘못 넣어 발행되는 경로가 생긴다. 이름이 다르면
 * 그 사고가 안 난다.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';
import type { Capabilities } from '../capabilities.ts';
import { textResult } from '../format.ts';
import { toUrlSlug, isSafeImageUrl } from '../slug.ts';
import { assertOwned, assertOwnsSeries } from '../ownership.ts';
import type { PublishRateLimiter } from '../ratelimit.ts';

const MUTATION_WRITE_POST = `
  mutation PublishPost($input: WritePostInput!) {
    writePost(input: $input) { id title url_slug is_temp is_private user { username } }
  }
`;

const MUTATION_EDIT_POST = `
  mutation EditPost($input: EditPostInput!) {
    editPost(input: $input) { id title url_slug is_temp is_private user { username } }
  }
`;

const QUERY_POST_FULL = `
  query PostForEdit($input: ReadPostInput!) {
    post(input: $input) {
      id title body url_slug is_temp is_private thumbnail tags meta
      series { id }
      user { username }
    }
  }
`;


/**
 * 도구 인자 타입.
 *
 * `is_private` 는 설정에 따라 스키마에 있기도 없기도 하다(조건부 spread).
 * 그러면 SDK 의 추론이 끊기므로 여기서 명시한다 — 스키마에 없으면 undefined 가
 * 들어오고, resolvePrivacy 가 비공개로 확정한다.
 */
interface PublishArgs {
	title: string;
	body: string;
	tags: string[];
	url_slug?: string | undefined;
	thumbnail?: string | undefined;
	series_id?: string | undefined;
	is_private?: boolean | undefined;
}

interface PublishDraftArgs {
	id: string;
	is_private?: boolean | undefined;
}

interface UpdatePostArgs {
	id: string;
	title?: string | undefined;
	body?: string | undefined;
	tags?: string[] | undefined;
	url_slug?: string | undefined;
	thumbnail?: string | undefined;
	series_id?: string | undefined;
	is_private?: boolean | undefined;
}

interface PostState {
	id: string;
	title?: string | null;
	body?: string | null;
	url_slug?: string | null;
	is_temp?: boolean | null;
	is_private?: boolean | null;
	thumbnail?: string | null;
	tags?: string[] | null;
	meta?: unknown;
	series?: { id?: string } | null;
	user?: { username?: string } | null;
}

function resultLines(post: PostState, verb: string): string {
	const username = post.user?.username;
	const url =
		username && post.url_slug
			? `https://velog.io/@${username}/${post.url_slug}`
			: `(id: ${post.id})`;
	const visibility = post.is_private ? '🔒 비공개' : '🌍 공개';
	return [
		`✅ ${verb}했습니다.`,
		'',
		`- 제목: ${post.title ?? '(제목 없음)'}`,
		`- 상태: ${post.is_temp ? '임시저장' : '발행됨'} · ${visibility}`,
		`- URL: ${url}`,
		`- id: \`${post.id}\``,
	].join('\n');
}

/**
 * ★ 사후 검증. 재조회만 하고 결과를 안 보면 검증이 아니다.
 *
 * 확인이 필요한 이유가 실재한다:
 *  - 벨로그는 발행 제한에 걸리면 요청과 무관하게 글을 비공개로 바꾼다.
 *    "공개로 발행했다"고 보고했는데 실제로는 비공개일 수 있다.
 *  - editPost 응답은 '갱신 전' 상태라 그것만 봐서는 아무것도 알 수 없다.
 *  - 재조회가 null 을 주면 뭔가 잘못된 것인데, 이전 상태로 성공을 보고하면
 *    사용자가 그걸 모른다.
 */
async function verifyAfter(
	client: VelogClient,
	id: string,
	toolName: string,
	expected: { is_temp: boolean; is_private: boolean },
): Promise<PostState> {
	const after = await client.request<{ post: PostState | null }>(QUERY_POST_FULL, {
		input: { id },
	});
	const post = after.post;
	if (!post) {
		throw new Error(
			`${toolName}: 작업 후 글(id=${id})을 다시 찾지 못했습니다. ` +
				'벨로그에서 상태를 직접 확인하세요.',
		);
	}

	const mismatches: string[] = [];
	if (post.is_temp !== expected.is_temp) {
		mismatches.push(
			`발행 상태가 예상과 다릅니다 (기대 is_temp=${expected.is_temp}, 실제 ${post.is_temp})`,
		);
	}
	if (post.is_private !== expected.is_private) {
		mismatches.push(
			`공개 범위가 예상과 다릅니다 (기대 is_private=${expected.is_private}, 실제 ${post.is_private})` +
				(!expected.is_private && post.is_private === true
					? ' — 벨로그 발행 제한에 걸려 비공개로 전환됐을 수 있습니다'
					: ''),
		);
	}
	if (mismatches.length > 0) {
		throw new Error(`⚠️ ${toolName} 결과 확인 실패:\n  - ${mismatches.join('\n  - ')}`);
	}
	return post;
}

/** 공개 발행일 때만 벨로그 계수에 잡힌다 — 그때만 상한을 적용한다. */
function guardIfPublic(isPrivate: boolean, limiter: PublishRateLimiter): void {
	if (!isPrivate) limiter.check();
}

export function registerPublishTools(
	server: McpServer,
	client: VelogClient,
	capabilities: Capabilities,
	limiter: PublishRateLimiter,
): void {
	/**
	 * 공개 발행이 켜져 있을 때만 노출하는 파라미터.
	 *
	 * ★ '새 글'과 '기존 글 수정'의 기본값이 달라야 한다.
	 *   새 글: 생략하면 비공개 (안전한 쪽)
	 *   수정 : 생략하면 **기존 값 유지** — .default(true) 를 걸면 공개글을
	 *          수정만 해도 조용히 비공개가 된다. 실측으로 잡은 버그다.
	 */
	const visibilityField = capabilities.publicPublish
		? {
				is_private: z
					.boolean()
					.default(true)
					.describe(
						'true=비공개 발행(기본), false=공개 발행. ' +
							'공개하면 RSS·검색·구독 메일로 나가며 지워도 회수되지 않는다.',
					),
			}
		: {};

	/** 수정용 — 기본값을 두지 않는다. 생략 = 기존 공개 범위 유지. */
	const visibilityFieldForUpdate = capabilities.publicPublish
		? {
				is_private: z
					.boolean()
					.optional()
					.describe(
						'생략하면 이 글의 현재 공개 범위를 그대로 둔다. ' +
							'true=비공개로 전환, false=공개로 전환.',
					),
			}
		: {};

	/** 설정에 따라 실제로 쓸 is_private 값을 정한다. 모델이 못 넘는 선이다. */
	function resolvePrivacy(requested: boolean | undefined): boolean {
		if (!capabilities.publicPublish) return true; // 공개 불가 — 무조건 비공개
		return requested ?? true;
	}

	const publicNote = capabilities.publicPublish
		? ''
		: ' 현재 설정에서는 **비공개로만** 발행된다 ' +
			'(공개 발행은 VELOG_ALLOW_PUBLIC=1 이 필요하다).';

	server.registerTool(
		'velog_publish_post',
		{
			title: '벨로그 글 발행',
			description:
				'새 글을 바로 발행한다. 초안을 거치지 않는다.' +
				publicNote +
				' 되돌리려면 velog_unpublish_post 로 초안으로 내릴 수 있다.',
			inputSchema: {
				title: z.string().min(1),
				body: z.string().min(1).describe('본문 (마크다운)'),
				tags: z.array(z.string()).default([]),
				url_slug: z.string().optional().describe('생략하면 제목에서 생성'),
				thumbnail: z
					.string()
					.refine(isSafeImageUrl, 'http(s) 이미지 URL 만 허용합니다')
					.optional(),
				series_id: z.string().optional(),
				...visibilityField,
			},
			// 공개 발행은 되돌릴 수 없다(RSS·검색·메일). destructive 로 표시한다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async (args: PublishArgs) => {
			client.requireAuth('velog_publish_post');
			const { title, body, tags, url_slug, thumbnail, series_id } = args;
			const isPrivate = resolvePrivacy(args.is_private);
			if (series_id) await assertOwnsSeries(client, series_id, 'velog_publish_post');
			// ★ 상한은 '검증을 다 통과한 뒤' 소비한다. 앞에 두면 잘못된 입력으로
			//   5번 실패해도 5분간 공개 발행이 막힌다.
			guardIfPublic(isPrivate, limiter);

			const input: Record<string, unknown> = {
				title,
				body,
				tags,
				url_slug: toUrlSlug(title, url_slug),
				is_markdown: true,
				is_temp: false,
				is_private: isPrivate,
				meta: {},
			};
			if (thumbnail) input['thumbnail'] = thumbnail;
			if (series_id) input['series_id'] = series_id;

			const data = await client.mutate<{ writePost: PostState }>(
				MUTATION_WRITE_POST,
				{ input },
			);
			return textResult(resultLines(data.writePost, '발행'));
		},
	);

	server.registerTool(
		'velog_publish_draft',
		{
			title: '초안 발행',
			description:
				'기존 임시저장 글을 발행한다. 본문은 저장된 내용을 그대로 쓴다 — ' +
				'다시 넘길 필요가 없다.' +
				publicNote,
			inputSchema: {
				id: z.string().min(1).describe('초안 id (velog_list_drafts 로 확인)'),
				...visibilityField,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async (args: PublishDraftArgs) => {
			client.requireAuth('velog_publish_draft');
			const { id } = args;
			const isPrivate = resolvePrivacy(args.is_private);

			// ★ 저장된 내용을 그대로 살려 발행한다. 호출자가 본문을 다시 넘기게
			//   하면 그 과정에서 태그·슬러그·시리즈가 날아간다(editPost 는 전체 교체).
			const current = await client.request<{ post: PostState | null }>(
				QUERY_POST_FULL,
				{ input: { id } },
			);
			const post = current.post;
			if (!post) throw new Error(`id=${id} 인 글을 찾지 못했습니다.`);
			await assertOwned(client, post, 'velog_publish_draft');
			if (post.is_temp !== true) {
				throw new Error(
					`id=${id} 는 이미 발행된 글입니다. 공개 범위만 바꾸려면 velog_update_post 를 쓰세요.`,
				);
			}
			// 검증을 다 통과한 뒤에 상한을 소비한다.
			guardIfPublic(isPrivate, limiter);

			const input: Record<string, unknown> = {
				id,
				title: post.title ?? '(제목 없음)',
				body: post.body ?? '',
				tags: post.tags ?? [],
				url_slug: post.url_slug ?? toUrlSlug(post.title ?? id),
				is_markdown: true,
				is_temp: false,
				is_private: isPrivate,
				// ★ meta 를 {} 로 보내면 short_description 같은 표시 데이터가 지워진다.
				//   서버가 받은 값을 그대로 DB 에 넣으므로 반드시 기존 값을 실어야 한다.
				meta: post.meta ?? {},
			};
			if (post.thumbnail) input['thumbnail'] = post.thumbnail;
			if (post.series?.id) input['series_id'] = post.series.id;

			await client.mutate<{ editPost: PostState }>(MUTATION_EDIT_POST, { input });
			const after = await verifyAfter(client, id, 'velog_publish_draft', {
				is_temp: false,
				is_private: isPrivate,
			});
			return textResult(resultLines(after, '발행'));
		},
	);

	server.registerTool(
		'velog_unpublish_post',
		{
			title: '발행 취소 (초안으로 되돌리기)',
			description:
				'발행된 글을 임시저장으로 되돌린다. 글은 사라지지 않고 초안 목록으로 간다. ' +
				'★ 이미 나간 RSS·구독 메일은 회수되지 않는다 — 검색엔진 캐시도 한동안 남는다.',
			inputSchema: { id: z.string().min(1).describe('발행된 글의 id') },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async ({ id }) => {
			client.requireAuth('velog_unpublish_post');

			const current = await client.request<{ post: PostState | null }>(
				QUERY_POST_FULL,
				{ input: { id } },
			);
			const post = current.post;
			if (!post) throw new Error(`id=${id} 인 글을 찾지 못했습니다.`);
			await assertOwned(client, post, 'velog_unpublish_post');
			if (post.is_temp === true) {
				return textResult(`id=${id} 는 이미 임시저장 상태입니다. 아무것도 하지 않았습니다.`);
			}

			const input: Record<string, unknown> = {
				id,
				title: post.title ?? '(제목 없음)',
				body: post.body ?? '',
				tags: post.tags ?? [],
				url_slug: post.url_slug ?? toUrlSlug(post.title ?? id),
				is_markdown: true,
				is_temp: true,
				// ★ is_private 를 기존 값(공개글이면 false)으로 두면 안 된다.
				//   is_temp:true + is_private:false 인 초안이 생겨 다시 벨로그 계수
				//   대상이 되고, 초안은 비공개라는 불변식(DRAFT_ONLY)도 깨진다.
				//   공식 서버의 외부연동 삭제 알림도 false→true 전환에서만 나간다.
				is_private: true,
				meta: post.meta ?? {},
			};
			if (post.thumbnail) input['thumbnail'] = post.thumbnail;
			if (post.series?.id) input['series_id'] = post.series.id;

			await client.mutate<{ editPost: PostState }>(MUTATION_EDIT_POST, { input });
			const after = await verifyAfter(client, id, 'velog_unpublish_post', {
				is_temp: true,
				is_private: true,
			});
			return textResult(
				`${resultLines(after, '초안으로 되돌리기')}\n\n` +
					'※ 이미 배포된 RSS·구독 메일과 검색엔진 캐시는 회수되지 않습니다.',
			);
		},
	);

	server.registerTool(
		'velog_update_post',
		{
			title: '발행글 수정',
			description:
				'이미 발행된 글을 수정한다. 발행 상태(is_temp:false)는 유지된다. ' +
				'생략한 필드는 **기존 값을 그대로 유지**한다 — 초안 도구와 달리 전체 교체가 아니다. ' +
				'초안 id 는 거부한다(초안 수정은 velog_update_draft).' +
				(capabilities.publicPublish
					? ' is_private 로 공개 범위도 바꿀 수 있고, 생략하면 현재 범위를 유지한다.'
					: ' ★현재 설정에서는 공개 글을 수정하면 **비공개로 내려간다** — ' +
						'공개 상태를 유지하려면 VELOG_ALLOW_PUBLIC=1 이 필요하다.'),
			inputSchema: {
				id: z.string().min(1),
				title: z.string().min(1).optional(),
				body: z.string().min(1).optional().describe('생략하면 기존 본문 유지'),
				tags: z.array(z.string()).optional().describe('생략하면 기존 태그 유지'),
				url_slug: z.string().optional().describe('생략하면 기존 주소 유지'),
				thumbnail: z
					.string()
					.refine(isSafeImageUrl, 'http(s) 이미지 URL 만 허용합니다')
					.optional(),
				series_id: z.string().optional(),
				...visibilityFieldForUpdate,
			},
			// 생략 필드는 보존하지만 넘긴 필드는 덮어쓴다. MCP 명세상 false 는
			// '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (args: UpdatePostArgs) => {
			client.requireAuth('velog_update_post');
			const { id, title, body, tags, url_slug, thumbnail, series_id } = args;

			// ★ 병합 수정. 기존 값을 읽어 생략 필드를 채운다 — 초안 도구에서
			//   '생략하면 초기화'가 사고를 부른다는 걸 확인했으므로 이쪽은 보존한다.
			const current = await client.request<{ post: PostState | null }>(
				QUERY_POST_FULL,
				{ input: { id } },
			);
			const post = current.post;
			if (!post) throw new Error(`id=${id} 인 글을 찾지 못했습니다.`);
			await assertOwned(client, post, 'velog_update_post');
			// 초안은 velog_update_draft 담당이다. 여기로 오면 is_temp:false 를 보내
			// 의도치 않게 발행되므로 막는다.
			// ★ `=== true` 만 막으면 null·누락이 '발행글'로 통과해 is_temp:false 가
			//   나간다(fail-open). is_temp 는 스키마상 nullable 이므로
			//   '확실히 false 인 경우'만 진행한다.
			if (post.is_temp !== false) {
				throw new Error(
					`id=${id} 의 발행 상태를 확인할 수 없거나 임시저장 글입니다 ` +
						`(is_temp=${post.is_temp}). 초안 수정은 velog_update_draft 를 쓰세요.`,
				);
			}

			if (series_id) await assertOwnsSeries(client, series_id, 'velog_update_post');

			const requested = args.is_private;
			const isPrivate = capabilities.publicPublish
				? (requested ?? post.is_private ?? true)
				: true;
			// 비공개 → 공개로 바뀌는 경우에만 계수 대상이 된다.
			if (post.is_private !== false && !isPrivate) limiter.check();

			const nextTitle = title ?? post.title ?? '(제목 없음)';
			const input: Record<string, unknown> = {
				id,
				title: nextTitle,
				body: body ?? post.body ?? '',
				tags: tags ?? post.tags ?? [],
				url_slug: url_slug ? toUrlSlug(nextTitle, url_slug) : (post.url_slug ?? toUrlSlug(nextTitle)),
				is_markdown: true,
				is_temp: false,
				is_private: isPrivate,
				// ★ meta 를 {} 로 보내면 short_description 등이 지워진다. 기존 값 유지.
				meta: post.meta ?? {},
			};
			const nextThumbnail = thumbnail ?? post.thumbnail;
			if (nextThumbnail) input['thumbnail'] = nextThumbnail;
			const nextSeries = series_id ?? post.series?.id;
			if (nextSeries) input['series_id'] = nextSeries;

			await client.mutate<{ editPost: PostState }>(MUTATION_EDIT_POST, { input });
			const after = await verifyAfter(client, id, 'velog_update_post', {
				is_temp: false,
				is_private: isPrivate,
			});
			return textResult(resultLines(after, '수정'));
		},
	);
}
