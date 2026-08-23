/**
 * 초안 도구 — 쓰기 경로 둘 중 하나다(다른 하나는 tools/publish.ts).
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
import { assertOwned, assertOwnsSeries } from '../ownership.ts';
import type { VelogPostSummary } from '../types.ts';
import { READ_ONLY } from './posts.ts';
import { serializeWrite } from '../serial.ts';
import { chooseThumbnail, describeThumbnail } from '../thumbnail.ts';
import { seriesHintSafely, resolveSeriesId } from '../series.ts';

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
    post(input: $input) { id title is_temp meta user { username } }
  }
`;

/**
 * 초안 생성 직후 시리즈를 붙일 때 쓴다. `meta` 는 다시 실어 보내야 하고
 * (editPost 는 전체 교체다), `series` 는 붙었는지 **확인**하는 데 쓴다.
 */
const QUERY_POST_FOR_SERIES = `
  query PostForSeries($input: ReadPostInput!) {
    post(input: $input) {
      id title body tags url_slug thumbnail is_temp meta
      series { id name }
      user { username }
    }
  }
`;

/**
 * 벨로그 응답. ★ 공식 스키마에서 title·url_slug·is_temp 는 nullable 이다
 * (Post.gql). 선언을 낙관적으로 적으면 `!== true` 같은 방어가 '불필요한 비교'로
 * 보여 지워지고, 그러면 실제 null 에 그대로 당한다. updated_at 으로 겪은 일이다.
 */
interface WrittenPost {
	id: string;
	title?: string | null;
	url_slug?: string | null;
	is_temp?: boolean | null;
	user?: { username?: string } | null;
}

/**
 * 썸네일 입력 — 세 상태를 구분해야 한다.
 *
 *   미지정(undefined) → 본문 첫 이미지로 **자동** 채운다
 *   URL              → 그대로 쓴다
 *   `null` / `""`    → **자동 채움을 끈다** (일부러 비워 두는 사람의 의도를 지킨다)
 *
 * ★ nullable 을 뺐다가는 "끄는 방법"이 사라진다. 그러면 자동 채움이 강제가 된다.
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

/** 벨로그가 정말 임시저장으로 받았는지 응답으로 확인한다. */
function assertStayedDraft(post: WrittenPost): void {
	if (post.is_temp !== true) {
		throw new Error(
			`예상치 못한 상태: 벨로그가 이 글을 임시저장이 아닌 것으로 저장했습니다 ` +
				`(is_temp=${post.is_temp}, id=${post.id}). 즉시 벨로그에서 확인하세요.`,
		);
	}
}

/**
 * 초안을 만든 **직후** 시리즈를 붙인다.
 *
 * ★★ 왜 한 번 더 부르나 — 벨로그는 임시저장 **생성** 단계에서 `series_id` 를
 *   조용히 버린다(호출부 주석의 서버 코드). `edit` 경로에는 그 조건이 없다.
 *   이 시점의 서버는 초안 id 와 해석 끝난 series_id 를 이미 쥐고 있으므로
 *   사용자가 두 번 부를 이유가 없다.
 *
 * ★★ **`post:<id>` 줄에서 돈다.** 생성은 `post:new` 줄에 있는데, 그 줄에 그대로
 *   두면 `update_draft` 나 `publish_draft` 와 **다른 줄**이 되어 서로를 못 본다.
 *   실제로 겹치면 늦게 도착한 이 edit 이 `DRAFT_ONLY` 로 방금 발행된 글을 다시
 *   비공개 초안으로 내린다. 두 도구 다 성공을 보고하므로 아무도 모른다.
 *   (코덱스 교차검증 1차에서 재현됨. `velog_list_drafts` 는 직렬화되지 않아
 *    생성이 끝나기 전에도 새 id 를 볼 수 있다.)
 *
 * ★★ 어떤 경우에도 **던지지 않는다.** 초안은 이미 저장됐다. 여기서 던지면 저장이
 *   끝난 호출이 실패로 보고되고 사용자가 다시 부른다.
 *   ⚠️ 다만 이것이 중복 생성을 **막지는 못한다.** MCP SDK 는 호출이 취소되면
 *   서버가 무엇을 반환하든 호출자 쪽 Promise 를 reject 한다. 취소된 뒤 재시도하면
 *   초안은 두 개가 된다. 이건 이 함수가 없을 때도 마찬가지이고(생성 자체가 그렇다),
 *   여기서 하는 일은 그 창을 넓히지 않는 것뿐이다. 예전 주석은 이걸 막는다고
 *   적고 있었는데 사실이 아니었다.
 *
 * ★ `meta` 를 다시 읽어서 실어 보낸다. editPost 는 전체 교체라 `{}` 를 보내면
 *   벨로그가 생성 때 만들어 둔 short_description 등이 지워진다.
 *
 * ★ 붙었다고 **말하기 전에 재조회로 확인한다.** editPost 응답은 갱신 전에 읽은
 *   post 를 돌려주므로 그것만 보고는 알 수 없다.
 *
 * ★ 실패를 두 종류로 나눈다. 아무것도 안 쓴 것이 확실하면 '적용되지 않음'이고,
 *   edit 을 보낸 뒤 확인에 실패했으면 '반영 여부 불명'이다. 후자를 전자로 적으면
 *   사용자가 붙어 있는 시리즈를 다시 붙이려 든다.
 *
 * @returns 결과에 이어붙일 안내문. 성공이든 실패든 사람이 읽을 말을 돌려준다.
 */
function manualFixNote(postId: string, seriesId: string, lead: string): string {
	return (
		`${lead}\n\n` +
		`   이어서 붙이려면 \`velog_update_draft\` 를 부르되, **전체 교체**라서 원래 값을 ` +
		`다시 줘야 합니다. \`id="${postId}"\`, \`series_id="${seriesId}"\`, 그리고 방금 저장한 ` +
		`title 과 body 를 그대로. tags 와 url_slug 와 thumbnail 을 생략하면 지워지거나 ` +
		`새로 만들어집니다. 현재 값은 \`velog_get_post\` 로 읽을 수 있습니다.`
	);
}

interface DraftSnapshot {
	id: string;
	title?: string | null;
	body?: string | null;
	tags?: string[] | null;
	url_slug?: string | null;
	thumbnail?: string | null;
	is_temp?: boolean;
	meta?: unknown;
	series?: { id?: string; name?: string } | null;
	user?: { username?: string } | null;
}

async function attachSeriesToNewDraft(
	client: VelogClient,
	postId: string,
	seriesId: string,
	signal?: AbortSignal,
): Promise<string> {
	const notApplied = manualFixNote(
		postId,
		seriesId,
		'\n\n⚠️ 시리즈는 **적용되지 않았습니다.** 벨로그가 임시저장 생성 단계에서' +
			' series_id 를 무시하는데, 이어서 붙이려던 시도도 실패했습니다.',
	);
	const unknown = manualFixNote(
		postId,
		seriesId,
		'\n\n⚠️ 시리즈가 **붙었는지 확인하지 못했습니다.** 수정 요청은 보냈지만 결과를' +
			' 확인하는 조회가 실패했습니다. 이미 붙어 있을 수 있으니 먼저 확인하세요.',
	);
	// ★ 이 글 전용 줄로 넘긴다. 이유는 위 주석.
	// ⚠️ 바깥은 `post:new` 줄이다. 서버가 id 로 하필 "new" 를 돌려주면 두 키가 같아져
	//   안쪽이 바깥쪽을 기다리는 교착이 된다. 그때는 붙이기를 포기하는 쪽이 낫다.
	if (postId === 'new') return notApplied;
	return serializeWrite(`post:${postId}`, async () => {
		let sent = false;
		try {
			const before = await client.request<{ post: DraftSnapshot | null }>(
				QUERY_POST_FOR_SERIES,
				{ input: { id: postId } },
				{ signal },
			);
			// 방금 만든 글을 못 읽으면 손대지 않는다.
			if (!before.post || before.post.is_temp !== true) return notApplied;
			// ★ 이미 붙어 있으면 아무것도 쓰지 않는다. 벨로그가 언젠가 생성 단계에서도
			//   붙이기 시작하면 이 함수는 조회 한 번으로 끝나야 한다.
			if (before.post.series?.id === seriesId) {
				return `\n\n📚 시리즈 **${before.post.series.name ?? seriesId}** 에 넣었습니다.`;
			}
			// ★ 우리가 방금 만든 글이라 소유권은 자명해 보이지만 검증한다. 이 레포는
			//   "자명하다"에 이미 당했고(ownership.ts), 구조 테스트가 editPost 마다 짝을
			//   요구한다. 여기에 예외를 만들면 그 가드가 그만큼 헐거워진다.
			await assertOwned(client, before.post, 'velog_create_draft');

			// ★★ **생성 당시의 입력이 아니라 방금 읽은 현재 값**으로 전체교체를 만든다.
			//   editPost 는 전체 교체다. 생성 응답이 늦는 사이 update_draft 가 먼저
			//   `post:<id>` 줄을 잡고 제목·본문을 고칠 수 있는데, 그때 낡은 생성 입력을
			//   다시 펼치면 그 수정이 통째로 되돌아간다. 두 호출 다 성공을 보고하므로
			//   아무도 모른다. (코덱스 재검증에서 재현됨)
			const input: Record<string, unknown> = {
				id: postId,
				title: before.post.title ?? '',
				body: before.post.body ?? '',
				tags: before.post.tags ?? [],
				url_slug: before.post.url_slug ?? undefined,
				meta: before.post.meta ?? {},
				series_id: seriesId,
				...DRAFT_ONLY, // ★ 마지막에 펼친다 — 초안 상태를 무엇도 못 덮게
			};
			// ★ 썸네일은 있을 때만 싣는다. 빈 값을 보내면 일부러 비워 둔 상태를 덮는다.
			if (before.post.thumbnail) input['thumbnail'] = before.post.thumbnail;

			// ★ `sent` 를 세우는 자리가 중요하다. mutate() 는 fetch 보다 **먼저**
			//   취소를 검사한다(client.ts 의 `options.signal?.throwIfAborted()`).
			//   호출 직전에 무조건 세우면 요청이 0회인데도 '보냈다'가 되어, 아무것도
			//   안 쓴 실패를 '반영 여부 불명'으로 잘못 보고한다. 같은 검사를 여기서
			//   먼저 해서 그 경우를 '미적용' 쪽으로 갈라낸다.
			signal?.throwIfAborted();
			sent = true;
			await client.mutate<{ editPost: WrittenPost }>(
				MUTATION_EDIT_POST,
				{ input },
				{ signal },
			);

			const after = await client.request<{ post: DraftSnapshot | null }>(
				QUERY_POST_FOR_SERIES,
				{ input: { id: postId } },
				{ signal },
			);
			// ★ 초안이 아니게 됐으면 붙었는지보다 그게 급하다.
			if (after.post?.is_temp !== true) {
				return (
					'\n\n🚨 시리즈를 붙이는 과정에서 이 글이 **임시저장이 아니게 됐습니다**' +
					` (is_temp=${String(after.post?.is_temp)}, id=${postId}). 즉시 벨로그에서 확인하세요.`
				);
			}
			if (after.post.series?.id !== seriesId) return notApplied;
			return `\n\n📚 시리즈 **${after.post.series.name ?? seriesId}** 에 넣었습니다.`;
		} catch {
			// 보내기 전에 죽었으면 아무것도 안 썼다. 보낸 뒤라면 반영됐을 수 있다.
			return sent ? unknown : notApplied;
		}
	});
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
				thumbnail: THUMBNAIL_FIELD,
				series_id: z
					.string()
					.optional()
					.describe(
						'소속시킬 시리즈 id. 벨로그가 임시저장 생성 단계에서 이걸 버리므로 ' +
							'이 도구가 저장 직후 한 번 더 붙이고, 붙었는지 확인해 결과에 적는다. ' +
							'생략하면 결과에 내 시리즈 목록을 함께 돌려준다',
					),
				series_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						'시리즈 **이름**(id 대신). 저장 전에 내 시리즈에서 찾는다. ' +
							'못 찾으면 저장하지 않고 목록을 알려준다',
					),
			},
			// 되돌릴 수 있는 쓰기다 — 비공개 초안이므로 파괴적이지 않다.
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (
			{ title, body, tags, url_slug, thumbnail, series_id: rawSeriesId, series_name },
			extra,
		) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite('post:new', async () => {
				client.requireAuth('velog_create_draft');
				let series_id = rawSeriesId?.trim() || undefined;
				let seriesFromName = false;
				// ★ 이름을 id 로. **저장 전에** 한다 — 못 찾으면 아무것도 안 쓴 채 멈춘다.
				if (series_name !== undefined && series_id === undefined) {
					series_id = await resolveSeriesId(
						client,
						await resolveMyUsername(client, extra.signal),
						series_name,
						'velog_create_draft',
						extra.signal,
					);
					seriesFromName = true;
				}
				// ★ 이름으로 찾은 id 는 **내 시리즈 목록에서 고른 것**이라 소유권이 이미
				//   증명돼 있다. 다시 목록을 받아 확인하면 같은 질의를 두 번 하는 것뿐이다.
				//   검사가 필요한 것은 **사용자가 준** series_id 다 — safety.test.ts 의 A11 이
				//   스스로 그 범위를 적어두고 있다.
				if (series_id && !seriesFromName)
					await assertOwnsSeries(client, series_id, 'velog_create_draft');
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
				// ★ 본문에 그림이 있으면 썸네일로 쓴다. 결정 근거는 아래에서 그대로 알린다.
				const thumb = chooseThumbnail(thumbnail, body);
				if (thumb.url) input['thumbnail'] = thumb.url;
				if (series_id) input['series_id'] = series_id;

				// mutate 는 재시도하지 않는다 — 응답 유실 시 초안이 중복 생성된다.
				const data = await client.mutate<{ writePost: WrittenPost }>(
					MUTATION_WRITE_POST,
					{ input },
					{ signal: extra.signal },
				);
				assertStayedDraft(data.writePost);

				// ★ 벨로그는 임시저장 생성 시 series_id 를 조용히 버린다:
				//   // apps/server/src/services/PostApiService/index.mts
				//   if (series_id && !data.is_temp) await appendToSeries(...)
				// edit 경로에는 이 조건이 없다. 그래서 여기서 edit 을 한 번 더 쳐서 붙인다.
				const seriesNote = series_id
					? // ★ 버려진 series_id 를 여기서 직접 다시 붙인다. 던지지 않는다.
						await attachSeriesToNewDraft(client, data.writePost.id, series_id, extra.signal)
					: // ★ 힌트 조회가 실패해도 저장은 이미 끝났다 — 전부 삼킨다.
						await seriesHintSafely(
							client,
							async () =>
								data.writePost.user?.username ??
								(await resolveMyUsername(client, extra.signal)),
							series_id,
							extra.signal,
						);
				return textResult(
					draftResult(data.writePost, '저장') + describeThumbnail(thumb) + seriesNote,
				);
			}),
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
				thumbnail: THUMBNAIL_FIELD,
				series_id: z.string().optional(),
				series_name: z
					.string()
					.min(1)
					.optional()
					.describe(
						'시리즈 **이름**(id 대신). 저장 전에 내 시리즈에서 찾는다. ' +
							'못 찾으면 저장하지 않고 목록을 알려준다',
					),
			},
			// ★ destructive 가 맞다. 생략 필드가 보존되지 않고 초기화된다 —
			//   MCP 명세상 destructiveHint:false 는 '추가만 한다'는 뜻이라 거짓이 된다.
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
		},
		async (
			{ id, title, body, tags, url_slug, thumbnail, series_id: rawSeriesId, series_name },
			extra,
		) =>
			// ★ 같은 대상에 대한 쓰기는 줄을 세운다 — 이유는 src/serial.ts
			serializeWrite(`post:${id}`, async () => {
				client.requireAuth('velog_update_draft');

				// ★ 두 가지를 확인한 뒤에야 수정한다.
				//   ① 내 글인가 — 벨로그 서버가 edit 에서 소유권을 안 본다(ownership.ts)
				//   ② 정말 초안인가 — editPost 는 is_temp 를 덮어쓰므로 발행글 id 가
				//      들어오면 그 글이 조용히 비공개로 내려간다
				const before = await client.request<{
					post: {
						id: string;
						is_temp?: boolean;
						meta?: unknown;
						user?: { username?: string } | null;
					} | null;
				}>(QUERY_POST_STATE, { input: { id } });
				if (!before.post) {
					throw new Error(
						`id=${id} 인 글을 찾지 못했습니다. velog_list_drafts 로 id 를 확인하세요.`,
					);
				}
				await assertOwned(client, before.post, 'velog_update_draft');
				let series_id = rawSeriesId?.trim() || undefined;
				let seriesFromName = false;
				if (series_name !== undefined && series_id === undefined) {
					series_id = await resolveSeriesId(
						client,
						before.post.user?.username ?? (await resolveMyUsername(client, extra.signal)),
						series_name,
						'velog_update_draft',
						extra.signal,
					);
					seriesFromName = true;
				}
				// ★ 이름으로 찾은 id 는 **내 시리즈 목록에서 고른 것**이라 소유권이 이미
				//   증명돼 있다. 다시 목록을 받아 확인하면 같은 질의를 두 번 하는 것뿐이다.
				//   검사가 필요한 것은 **사용자가 준** series_id 다 — safety.test.ts 의 A11 이
				//   스스로 그 범위를 적어두고 있다.
				if (series_id && !seriesFromName)
					await assertOwnsSeries(client, series_id, 'velog_update_draft');
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
					// ★ {} 를 보내면 short_description 등 표시 데이터가 지워진다.
					//   서버가 받은 값을 그대로 DB 에 넣으므로 기존 값을 실어야 한다.
					//   (publish.ts 만 고치고 여기를 또 빠뜨렸었다 — 소유권 때와 같은 실수)
					meta: before.post.meta ?? {},
					...DRAFT_ONLY,
				};
				const thumb = chooseThumbnail(thumbnail, body);
				if (thumb.url) input['thumbnail'] = thumb.url;
				if (series_id) input['series_id'] = series_id;

				const data = await client.mutate<{ editPost: WrittenPost }>(
					MUTATION_EDIT_POST,
					{ input },
					{ signal: extra.signal },
				);

				// ★ editPost 의 응답으로는 사후 상태를 알 수 없다. 공식 구현이
				//   `return { ...post, url_slug: data.url_slug }` 로 **갱신 전에 읽은**
				//   post 를 돌려주고 url_slug 만 덮기 때문이다
				//   (apps/server/src/services/PostApiService/index.mts).
				//   그래서 응답의 is_temp 는 '수정 전' 값이다 — 그걸 검사해봐야 사전확인을
				//   한 번 더 하는 것에 불과하다. 진짜 사후 확인은 재조회뿐이다.
				// ★ 재조회 결과를 '보기만' 하면 검증이 아니다. null 도 실패로 처리한다.
				const after = await client.request<{
					post: { id: string; is_temp?: boolean; title?: string | null } | null;
				}>(QUERY_POST_STATE, { input: { id } });
				if (!after.post) {
					throw new Error(
						`velog_update_draft: 수정 후 글(id=${id})을 다시 찾지 못했습니다. ` +
							'벨로그에서 상태를 직접 확인하세요.',
					);
				}
				if (after.post.is_temp !== true) {
					throw new Error(
						`⚠️ 수정 후 확인 결과 이 글이 임시저장이 아닙니다 ` +
							`(id=${id}, is_temp=${after.post.is_temp}). ` +
							'수정 직전에 다른 곳에서 발행됐을 수 있습니다. 벨로그에서 상태를 확인하세요.',
					);
				}

				// ★ data.editPost 는 '갱신 전' 객체다(공식 서버가 그렇게 반환한다).
				//   그걸로 문구를 만들면 제목을 바꿔도 옛 제목이 표시된다.
				//   이미 재조회했으므로 그 결과를 얹는다.
				// ★ 초안 수정은 series_id 가 실제로 먹는 경로다(생성과 달리). 그래서
				//   여기서는 "안 넣었으면 무엇에 넣을 수 있는지"를 알리는 값이 크다.
				const ownerName = before.post.user?.username;
				const seriesNote = await seriesHintSafely(
					client,
					async () => ownerName ?? (await resolveMyUsername(client, extra.signal)),
					series_id,
					extra.signal,
				);
				return textResult(
					draftResult(
						{ ...data.editPost, title: after.post.title ?? data.editPost.title ?? null },
						'수정',
					) +
						describeThumbnail(thumb) +
						seriesNote,
				);
			}),
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
