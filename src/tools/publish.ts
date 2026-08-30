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

import type { ToolExtra, VelogClient } from '../client.ts';
import type { Capabilities } from '../capabilities.ts';
import { textResult, HUMAN_BODY_STYLE, HUMAN_TITLE_STYLE } from '../format.ts';
import { toUrlSlug, isSafeImageUrl } from '../slug.ts';
import { assertOwned, assertOwnsSeries } from '../ownership.ts';
import type { PublishRateLimiter } from '../ratelimit.ts';
import { serializeWrite } from '../serial.ts';
import {
	chooseThumbnail,
	chooseThumbnailForUpdate,
	describeThumbnail,
} from '../thumbnail.ts';
import { seriesHintSafely, resolveSeriesId } from '../series.ts';
import { resolveMyUsername } from '../me.ts';

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
	thumbnail?: string | null | undefined;
	series_id?: string | undefined;
	series_name?: string | undefined;
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
	thumbnail?: string | null | undefined;
	series_id?: string | undefined;
	series_name?: string | undefined;
	is_private?: boolean | undefined;
}

/**
 * 썸네일 입력 — 세 상태를 구분한다 (drafts.ts 와 같은 규약).
 *   미지정 → 본문 첫 이미지로 자동 / URL → 그대로 / null·"" → 자동 채움 끄기
 */
const THUMBNAIL_FIELD = z
	.string()
	.refine((v) => v === '' || isSafeImageUrl(v), 'http(s) 이미지 URL 만 허용합니다')
	.nullable()
	.optional()
	.describe(
		'썸네일 이미지 URL (http/https). 생략하면 본문 첫 이미지로 자동 설정한다. ' +
			'자동 설정을 원하지 않으면 null 을 준다',
	);

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
/** 키 순서에 좌우되지 않는 값 비교. meta 가 임의 JSON 이라 필요하다. */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
	}
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	return ka.every((k) =>
		Object.hasOwn(b, k) &&
		deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
	);
}

/** 비교 불가 표식. 어떤 실제 값과도 같지 않다. */
const NOT_COMPARABLE = Symbol('not-comparable');

async function verifyAfter(
	client: VelogClient,
	id: string,
	toolName: string,
	expected: {
		is_temp: boolean;
		is_private: boolean;
		/**
		 * 보낸 input. 넘기면 내용까지 대조한다.
		 *
		 * ★ 왜 필요한가 — `editPost` 는 전체 교체이고 우리 도구는 '생략 필드를
		 *   보존한다'고 문서에 적어놨다. 그런데 플래그 두 개만 확인하면 본문·태그·
		 *   슬러그가 통째로 날아가도 성공으로 보고한다. 보장과 검증이 어긋나 있었다.
		 *   이미 재조회하고 있으므로 비교는 공짜다.
		 */
		content?: Record<string, unknown>;
	},
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
	const sent = expected.content;
	if (sent) {
		const checks: Array<[string, unknown, unknown]> = [
			['제목', sent['title'], post.title],
			// ★ 길이만 비교하면 같은 길이의 다른 본문이 통과한다. 내용을 본다.
			//   보낸 값이 문자열이 아니면(있을 수 없지만) 절대 안 맞는 표식을 쓴다.
			['본문', typeof sent['body'] === 'string' ? sent['body'] : NOT_COMPARABLE, post.body ?? ''],
			['주소(url_slug)', sent['url_slug'], post.url_slug],
			['썸네일', sent['thumbnail'] ?? null, post.thumbnail ?? null],
			['시리즈', sent['series_id'] ?? null, post.series?.id ?? null],
		];
		for (const [label, want, got] of checks) {
			if (want !== got) {
				mismatches.push(`${label}이(가) 저장되지 않았습니다 (보낸 값 ≠ 저장된 값)`);
			}
		}
		// 태그는 서버가 trim·정렬을 바꿀 수 있어 정규화해 비교한다.
		if (!sameTags(sent['tags'] as string[] | undefined, post.tags)) {
			mismatches.push('태그가 저장되지 않았습니다 (보낸 값 ≠ 저장된 값)');
		}
		// ★ '비었나'만 보면 {cover, short_description} → {cover} 같은 부분 손실을
		//   놓친다. 보낸 키·값이 **전부** 남았는지 본다. 서버가 키를 더 채우는 건 허용.
		const sentMeta = sent['meta'];
		if (sentMeta && typeof sentMeta === 'object') {
			const savedMeta = (post.meta ?? {}) as Record<string, unknown>;
			// ★ JSON.stringify 비교는 키 순서에 걸린다({a,b} vs {b,a}). meta 는 임의
			//   JSON 이고 PostgreSQL JSON 컬럼이라 순서가 바뀔 수 있다. 의미로 비교한다.
			const lost = Object.entries(sentMeta as Record<string, unknown>).filter(
				([k, v]) => !deepEqual(savedMeta[k], v),
			);
			if (lost.length > 0) {
				mismatches.push(
					`meta 가 보존되지 않았습니다 (${lost.map(([k]) => k).join(', ')})`,
				);
			}
		}
	}

	if (mismatches.length > 0) {
		throw new Error(`⚠️ ${toolName} 결과 확인 실패:\n  - ${mismatches.join('\n  - ')}`);
	}
	return post;
}

/**
 * 서버가 태그에 하는 짓을 그대로 재현해 비교한다.
 *
 *   trim() → slice(0, 255) → 중복 제거
 *
 * 이렇게 안 하면 중복 태그나 255자 초과 태그를 보냈을 때 **정상 저장됐는데도**
 * 실패로 보고한다. 순서는 서버가 바꿀 수 있어 정렬 후 비교한다.
 * ★ 구분자로 join 하지 않는다 — 예전에 NUL 로 join 했다가 소스가 바이너리로
 *   판정돼 git diff 가 깨졌다. 배열끼리 비교하면 그 문제가 없다.
 */
function normalizeTags(tags: readonly string[] | null | undefined): string[] {
	const seen = new Set<string>();
	for (const tag of tags ?? []) {
		seen.add(tag.trim().slice(0, 255));
	}
	return [...seen].sort();
}

function sameTags(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
	const x = normalizeTags(a);
	const y = normalizeTags(b);
	return x.length === y.length && x.every((v, i) => v === y[i]);
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
				title: z.string().min(1).describe('글 제목.' + HUMAN_TITLE_STYLE),
				body: z.string().min(1).describe('본문 (마크다운).' + HUMAN_BODY_STYLE),
				tags: z.array(z.string()).default([]),
				url_slug: z.string().optional().describe('생략하면 제목에서 생성'),
				thumbnail: THUMBNAIL_FIELD,
				series_id: z.string().optional(),
				series_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						'시리즈 **이름**(id 대신). 저장 전에 내 시리즈에서 찾아 같은 요청에 실어 보낸다 — ' +
							'한 번의 호출로 시리즈까지 붙는다. 못 찾으면 저장하지 않고 목록을 알려준다',
					),
				...visibilityField,
			},
			// 공개 발행은 되돌릴 수 없다(RSS·검색·메일). destructive 로 표시한다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
		},
		async (args: PublishArgs, extra: ToolExtra) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite('post:new', async () => {
				client.requireAuth('velog_publish_post');
				const { title, body, tags, url_slug, thumbnail, series_name } = args;
				let series_id = args.series_id?.trim() || undefined;
				let seriesFromName = false;
				const isPrivate = resolvePrivacy(args.is_private);
				// ★ 이름을 id 로 바꾼다. **저장 전에** 한다 — 못 찾으면 아무것도 안 쓴 채 멈춘다.
				if (series_name !== undefined && series_id === undefined) {
					series_id = await resolveSeriesId(
						client,
						await resolveMyUsername(client, extra.signal),
						series_name,
						'velog_publish_post',
						extra.signal,
					);
					seriesFromName = true;
				}
				// ★ 이름으로 찾은 id 는 **내 시리즈 목록에서 고른 것**이라 소유권이 이미
				//   증명돼 있다. 다시 목록을 받아 확인하면 같은 질의를 두 번 하는 것뿐이다.
				//   검사가 필요한 것은 **사용자가 준** series_id 다 — safety.test.ts 의 A11 이
				//   스스로 그 범위를 적어두고 있다.
				if (series_id && !seriesFromName)
					await assertOwnsSeries(client, series_id, 'velog_publish_post');
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
				const thumb = chooseThumbnail(thumbnail, body);
				if (thumb.url) input['thumbnail'] = thumb.url;
				if (series_id) input['series_id'] = series_id;

				const data = await client.mutate<{ writePost: PostState }>(
					MUTATION_WRITE_POST,
					{ input },
					{ signal: extra.signal },
				);
				// ★ 힌트 조회가 실패해도 발행은 이미 끝났다 — 삼킨다(취소만 올린다).
				const seriesNote = await seriesHintSafely(
					client,
					async () =>
						data.writePost.user?.username ?? (await resolveMyUsername(client, extra.signal)),
					series_id,
					extra.signal,
				);
				return textResult(
					resultLines(data.writePost, '발행') + describeThumbnail(thumb) + seriesNote,
				);
			}),
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
		async (args: PublishDraftArgs, extra: ToolExtra) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite(`post:${args.id}`, async () => {
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

				await client.mutate<{ editPost: PostState }>(
					MUTATION_EDIT_POST,
					{ input },
					{ signal: extra.signal },
				);
				const after = await verifyAfter(client, id, 'velog_publish_draft', {
					is_temp: false,
					is_private: isPrivate,
					content: input,
				});
				return textResult(resultLines(after, '발행'));
			}),
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
		async ({ id }, extra) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite(`post:${id}`, async () => {
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

				await client.mutate<{ editPost: PostState }>(
					MUTATION_EDIT_POST,
					{ input },
					{ signal: extra.signal },
				);
				const after = await verifyAfter(client, id, 'velog_unpublish_post', {
					is_temp: true,
					is_private: true,
					content: input,
				});
				return textResult(
					`${resultLines(after, '초안으로 되돌리기')}\n\n` +
						'※ 이미 배포된 RSS·구독 메일과 검색엔진 캐시는 회수되지 않습니다.',
				);
			}),
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
					: ' 현재 설정에서는 공개 범위를 바꿀 수단이 없다 — 공개 글은 공개로, ' +
						'비공개 글은 비공개로 그대로 남는다. 범위를 바꾸려면 VELOG_ALLOW_PUBLIC=1 이 필요하다.'),
			inputSchema: {
				id: z.string().min(1),
				title: z.string().min(1).optional().describe('글 제목.' + HUMAN_TITLE_STYLE),
				body: z.string().min(1).optional().describe('생략하면 기존 본문 유지.' + HUMAN_BODY_STYLE),
				tags: z.array(z.string()).optional().describe('생략하면 기존 태그 유지'),
				url_slug: z.string().optional().describe('생략하면 기존 주소 유지'),
				thumbnail: THUMBNAIL_FIELD,
				series_id: z.string().optional(),
				series_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						'시리즈 **이름**(id 대신). 저장 전에 내 시리즈에서 찾아 같은 요청에 실어 보낸다 — ' +
							'한 번의 호출로 시리즈까지 붙는다. 못 찾으면 저장하지 않고 목록을 알려준다',
					),
				...visibilityFieldForUpdate,
			},
			// 생략 필드는 보존하지만 넘긴 필드는 덮어쓴다. MCP 명세상 false 는
			// '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (args: UpdatePostArgs, extra: ToolExtra) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite(`post:${args.id}`, async () => {
				client.requireAuth('velog_update_post');
				const { id, title, body, tags, url_slug, thumbnail } = args;
				// ★ 빈 문자열은 '미지정'으로 읽는다. 예전엔 `'' ?? post.series?.id` 가
				//   `''` 로 평가돼 기존 시리즈가 전송에서 빠졌고, 전체교체형 editPost 가
				//   **연결을 끊었다.** 끊고 싶으면 벨로그에서 직접 할 일이다.
				let series_id = args.series_id?.trim() || undefined;
				let seriesFromName = false;
				const { series_name } = args;

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

				// ★ 이름을 id 로 바꾼다. **저장 전에** 한다 — 못 찾으면 아무것도 안 쓴 채 멈춘다.
				if (series_name !== undefined && series_id === undefined) {
					series_id = await resolveSeriesId(
						client,
						post.user?.username ?? (await resolveMyUsername(client, extra.signal)),
						series_name,
						'velog_update_post',
						extra.signal,
					);
					seriesFromName = true;
				}
				// ★ 이름으로 찾은 id 는 **내 시리즈 목록에서 고른 것**이라 소유권이 이미
				//   증명돼 있다. 다시 목록을 받아 확인하면 같은 질의를 두 번 하는 것뿐이다.
				//   검사가 필요한 것은 **사용자가 준** series_id 다 — safety.test.ts 의 A11 이
				//   스스로 그 범위를 적어두고 있다.
				if (series_id && !seriesFromName)
					await assertOwnsSeries(client, series_id, 'velog_update_post');

				// ★★ 공개 범위는 **기존 값을 잇는다.** 게이트가 꺼져 있어도 마찬가지다.
				//
				//   예전엔 게이트가 꺼져 있으면 무조건 `true` 를 보냈다. 그래서 기본
				//   설정에서 공개글의 **제목만 고쳐도 그 글이 비공개로 내려갔다** —
				//   오류도 아니고 결과 한 줄에 '🔒 비공개'라고만 적혀 나갔다(실측).
				//   바로 위 visibilityFieldForUpdate 주석이 경고하던 그 사고가, 고쳐둔
				//   경로가 아니라 **기본값 경로에서** 살아 있었다.
				//
				//   게이트(capabilities.ts)가 막는 것은 '공개 발행' 즉 안 보이던 글을
				//   내보내는 행위다. 이미 공개된 글을 **내리는 것**은 발행이 아니라
				//   되돌리기 어려운 파괴적 변경이고, 게이트가 할 일이 아니다.
				//   그래서 게이트가 꺼져 있으면 '바꿀 수단이 없다'로 두고 값을 잇는다.
				//
				// ⚠️ 남는 한계 — 고치지 못했고, 숨기지도 않는다.
				//   읽은 뒤 쓰기 전에 **다른 곳에서** 글을 비공개로 바꾸면, 우리가
				//   읽어둔 `false` 를 그대로 보내 글이 공개로 되돌아간다. 벨로그에는
				//   버전도 ETag 도 없어 이 창을 닫을 방법이 없다. 한 프로세스 안의
				//   동시 수정은 serial.ts 의 줄 세우기가 막지만, 사용자가 벨로그 웹에서
				//   동시에 만지는 것은 우리가 볼 수 없다. (코덱스 교차검증 지적)
				//   그래도 이쪽이 낫다 — 옛 동작은 아무 경합 없이도 **매번** 내렸다.
				const requested = capabilities.publicPublish ? args.is_private : undefined;
				// ★ 모르면 건드리지 않는다 — is_temp 와 같은 규율. is_private 는 스키마상
				//   nullable 이라 `?? true` 로 메우면 '알 수 없음'이 곧 강등이 된다.
				if (typeof post.is_private !== 'boolean' && requested === undefined) {
					throw new Error(
						`velog_update_post: 글(id=${id})의 공개 범위를 확인할 수 없어 중단했습니다 ` +
							`(is_private=${post.is_private}). 공개글을 실수로 내리지 않기 위한 조치입니다.`,
					);
				}
				const isPrivate = requested ?? post.is_private === true;
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
				// ★ 병합 수정이라 기존 썸네일이 우선이다 — 규칙은 thumbnail.ts 참고.
				const thumb = chooseThumbnailForUpdate(
					thumbnail,
					post.thumbnail,
					body ?? post.body ?? '',
				);
				if (thumb.url) input['thumbnail'] = thumb.url;
				const nextSeries = series_id ?? post.series?.id;
				if (nextSeries) input['series_id'] = nextSeries;

				await client.mutate<{ editPost: PostState }>(
					MUTATION_EDIT_POST,
					{ input },
					{ signal: extra.signal },
				);
				const after = await verifyAfter(client, id, 'velog_update_post', {
					is_temp: false,
					is_private: isPrivate,
					content: input,
				});
				// ★ 이미 시리즈에 들어 있으면(nextSeries) 참견하지 않는다.
				const seriesNote = await seriesHintSafely(
					client,
					async () => post.user?.username ?? (await resolveMyUsername(client, extra.signal)),
					nextSeries,
					extra.signal,
				);
				return textResult(
					resultLines(after, '수정') + describeThumbnail(thumb) + seriesNote,
				);
			}),
	);
}
