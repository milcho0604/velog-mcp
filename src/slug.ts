/**
 * url_slug 생성.
 *
 * 벨로그는 `WritePostInput.url_slug` 를 필수로 받는다. 사용자가 안 주면 제목에서
 * 만든다. 벨로그 자체는 한글 슬러그를 허용하므로(예: /@witwint/프로메테우스)
 * 한글을 로마자로 바꾸지 않고 그대로 둔다 — 억지 음차보다 원문이 낫다.
 */

/**
 * 이미지 URL 검사.
 *
 * ★ zod 의 `z.string().url()` 로는 부족하다. 실측하면 아래를 전부 통과시킨다:
 *     javascript:alert(1)          data:text/html,<script>…
 *     file:///etc/passwd           http://127.0.0.1/…
 *   URL 형식이 맞는지만 보고 스킴은 안 따지기 때문이다. 썸네일은 결국 남의
 *   페이지에서 렌더되므로 http/https 로 못 박는다.
 */
export function isSafeHttpUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	return url.hostname.length > 0;
}

/**
 * 이미지용. 현재 규칙은 http(s) + 호스트 존재로 같아서 그대로 위임한다.
 * 구현을 복사하지 않는다 — 한쪽만 고쳐지는 사고를 이 레포에서 이미 두 번 겪었다.
 */
export const isSafeImageUrl = isSafeHttpUrl;

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

/**
 * 프로필 홈페이지 링크 검사.
 *
 * 벨로그 웹은 값에 http(s) 스킴이 없으면 렌더링 시점에 `https://` 를 붙인다
 * (apps/web/src/lib/includeProtocol.ts). 그래서 `example.com` 도, `example.com:8080`
 * 도 정상 입력이다. 우리가 http(s) 만 받으면 정상 사용을 막는다.
 *
 * ★ 반대로 막아야 하는 건 `javascript:`·`data:` 같은 위험 스킴인데, 정규식으로
 *   '스킴처럼 생겼나' 를 보면 두 방향으로 다 틀린다:
 *     - `example.com:8080` 을 스킴으로 오인해 거부
 *     - `" javascript:…"` 처럼 앞에 공백을 붙이면 통과 (실측 확인)
 *   그래서 정규식 대신 **웹과 같은 방식으로 실제 URL 을 만들어 본다.**
 *   앞뒤 공백은 먼저 제거한다 — 공백 하나로 검사가 뚫리면 안 된다.
 */
export function isSafeProfileLink(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === '') return true; // 빈 값 = 삭제
	// 있는 그대로 http(s) 이거나, https:// 를 붙였을 때 http(s) 가 되면 통과.
	// javascript:·data: 는 두 경우 모두 http(s) 가 되지 않는다.
	return isSafeHttpUrl(trimmed) || isSafeHttpUrl(`https://${trimmed}`);
}
