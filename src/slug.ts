/**
 * url_slug 생성.
 *
 * 벨로그는 `WritePostInput.url_slug` 를 필수로 받는다. 사용자가 안 주면 제목에서
 * 만든다. 벨로그 자체는 한글 슬러그를 허용하므로(예: /@witwint/프로메테우스)
 * 한글을 로마자로 바꾸지 않고 그대로 둔다 — 억지 음차보다 원문이 낫다.
 */

/** URL 에서 실제로 문제가 되는 문자만 제거한다. */
export function slugify(title: string): string {
	const slug = title
		.trim()
		.toLowerCase()
		// 경로·쿼리·프래그먼트 구분자와 공백류를 하이픈으로
		.replace(/[\s/?#&=+%<>\\[\]{}|^~`"'`]+/g, '-')
		// 나머지 구두점 제거 (한글·영숫자·하이픈·밑줄만 남긴다)
		.replace(/[^\p{Letter}\p{Number}\-_]/gu, '')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');

	// 전부 걸러진 경우(기호만으로 된 제목) 빈 슬러그를 주면 벨로그가 거부한다.
	return slug || 'untitled';
}

/** 벨로그 슬러그 길이 상한이 문서화돼 있지 않아 보수적으로 자른다. */
export const MAX_SLUG_LENGTH = 120;

export function toUrlSlug(title: string, provided?: string): string {
	const base = provided?.trim() ? slugify(provided) : slugify(title);
	if (base.length <= MAX_SLUG_LENGTH) return base;
	// 자른 자리에 하이픈이 남지 않게 한다.
	return base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
}
