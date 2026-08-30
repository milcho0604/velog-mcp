/**
 * 응답 정형화.
 *
 * MCP 도구는 결국 모델이 읽는다. 원본 JSON 을 그대로 던지면 토큰만 먹고
 * 정작 필요한 값(제목·슬러그·조회수)은 묻힌다. 목록은 표로, 단건은 본문 위주로 낸다.
 */

import type { VelogPostSummary, VelogPostDetail } from './types.ts';

/**
 * 글 본문 문체 안내. 쓰기 도구 4개의 body 설명에 공통으로 붙는다.
 *
 * 근거는 실측이다: 사람이 쓴 통과본과 AI 초안을 나란히 세었을 때 실제로 갈린
 * 항목만 담았다(볼드 밀도·표·이모지는 차이가 없어서 넣지 않는다).
 */
export const HUMAN_BODY_STYLE =
	' 문체: 사람이 쓴 글처럼 자연스럽게. 긴 줄표(—)와 가운뎃점(·)을 쓰지 말고 쉼표나 마침표로 끊을 것.' +
	' "**하나.** ... **둘.**" 식 볼드 번호 나열 금지(산문이나 평범한 불릿으로).' +
	' 문단은 2~3문장으로 짧게, 200자가 넘으면 쪼갠다.' +
	' "이 글의 한계" 같은 부록 절을 만들지 말고 해당 문단 자리에 한 문장으로 녹일 것.';

/** 제목 규칙. 제목 필드 설명에 붙는다. */
export const HUMAN_TITLE_STYLE = ' 긴 줄표(—) 금지. 부제는 콜론이나 괄호, 짧은 하이픈으로.';

export function postUrl(post: VelogPostSummary): string {
	const username = post.user?.username;
	// url_slug 는 공식 스키마상 nullable 이다.
	const slug = post.url_slug;
	if (!slug) return `(id: ${post.id})`;
	return username ? `https://velog.io/@${username}/${slug}` : `(url_slug: ${slug})`;
}

/** title 도 nullable 이라 표시 전에 한 번 거른다. */
export function postTitle(post: VelogPostSummary): string {
	return post.title?.trim() || '(제목 없음)';
}

function dateOnly(iso: string | null | undefined): string {
	return iso ? iso.slice(0, 10) : '—';
}

/** 목록 — 한 줄에 하나. 모델이 훑고 고르기 좋게. */
export function formatPostList(
	posts: readonly VelogPostSummary[],
	options: { readonly total?: number; readonly showAuthor?: boolean } = {},
): string {
	if (posts.length === 0) return '결과 없음';

	const lines = posts.map((p, i) => {
		const head = `${String(i + 1).padStart(2)}. ${postTitle(p)}`;
		const author = options.showAuthor && p.user?.username ? `@${p.user.username} · ` : '';
		const stats = `${author}♥${p.likes ?? 0} · 👁${p.views ?? 0} · 💬${p.comments_count ?? 0}`;
		const tags = p.tags?.length ? ` · #${p.tags.join(' #')}` : '';
		const priv = p.is_private ? ' · 🔒비공개' : '';
		return `${head}\n    ${dateOnly(p.released_at)} · ${stats}${tags}${priv}\n    ${postUrl(p)}`;
	});

	const header =
		options.total !== undefined && options.total > posts.length
			? `총 ${options.total.toLocaleString('ko-KR')}건 중 ${posts.length}건\n\n`
			: `${posts.length}건\n\n`;

	return header + lines.join('\n\n');
}

/** 단건 — 메타는 압축하고 본문을 그대로 넘긴다. */
export function formatPostDetail(post: VelogPostDetail): string {
	const meta = [
		`# ${postTitle(post)}`,
		'',
		`- URL: ${postUrl(post)}`,
		`- 작성: ${dateOnly(post.released_at ?? post.created_at)}`,
		`- 통계: ♥${post.likes ?? 0} · 👁${post.views ?? 0} · 💬${post.comments_count ?? 0}`,
	];
	if (post.tags?.length) meta.push(`- 태그: ${post.tags.map((t) => `#${t}`).join(' ')}`);
	if (post.series?.name) meta.push(`- 시리즈: ${post.series.name}`);
	if (post.is_temp) meta.push('- 상태: **임시저장(비공개)**');
	else if (post.is_private) meta.push('- 상태: 비공개');
	meta.push(`- id: \`${post.id}\``);

	return `${meta.join('\n')}\n\n---\n\n${post.body ?? '(본문 없음)'}`;
}

/** MCP 도구 반환 형태. */
export function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(text: string) {
	return { content: [{ type: 'text' as const, text }], isError: true as const };
}
