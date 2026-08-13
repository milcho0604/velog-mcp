/**
 * 썸네일 자동 채움 — 본문에 이미 있는 이미지를 목록 카드에 쓴다.
 *
 * ★ 왜 있는가 — 썸네일이 없으면 글 목록·공유 카드가 글자만 나온다. 그런데
 *   본문에 그림을 넣은 사람은 이미 쓸 만한 이미지를 가지고 있다. 한 번 더
 *   지정하게 만들 이유가 없다.
 *
 * ★★ 이 모듈은 **본문을 고치지 않는다.** 읽기만 한다. 반환값은 '무엇을 쓸지'와
 *    '왜 그렇게 정했는지'뿐이고, 실제 적용은 호출부가 한다.
 */

import { isSafeImageUrl } from './slug.ts';

/** 문자 개수. 괄호 균형 검사에만 쓴다. */
function countOf(text: string, ch: string): number {
	let n = 0;
	for (const c of text) if (c === ch) n++;
	return n;
}

/** 한 번의 결정 결과. `url` 이 undefined 면 채우지 않는다. */
export interface ThumbnailChoice {
	/** 실제로 보낼 값. 채우지 않기로 했으면 undefined. */
	readonly url: string | undefined;
	/** 본문에서 찾은 후보 전부 (중복 제거, 등장 순서). */
	readonly candidates: readonly string[];
	/** 왜 이렇게 정했나. 결과 메시지를 만들 때 쓴다. */
	readonly reason: 'explicit' | 'opted-out' | 'auto' | 'none';
}

/**
 * 마크다운 본문에서 이미지 URL 을 등장 순서대로 뽑는다.
 *
 * 다루는 형태:
 *   - `![alt](url)` · `![alt](url "제목")`
 *   - `<img src="url">` (HTML 을 섞어 쓰는 사람이 많다)
 *
 * ⚠️ 코드블록 안의 이미지는 **제외한다.** 예제로 적어둔 마크다운이 썸네일이
 *   되어버리면 황당하다. 펜스(``` 또는 ~~~)와 인라인 코드(`...`)를 먼저 지운다.
 */
export function extractImageUrls(body: string): string[] {
	// ★ 지우는 순서가 중요하다. 펜스를 먼저 지워야 그 안의 백틱이 인라인 코드로
	//   잘못 짝지어지지 않는다.
	const withoutCode = body
		.replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
		.replace(/`[^`\n]*`/g, '');

	const found: string[] = [];
	const push = (raw: string | undefined): void => {
		if (!raw) return;
		// 마크다운은 URL 뒤에 제목을 붙일 수 있다: (url "제목")
		const url = raw.trim().split(/\s+/)[0]?.replace(/^<|>$/g, '');
		if (!url || !isSafeImageUrl(url)) return;
		// ★★ 괄호가 안 맞으면 **버린다.** `![a](https://x/y(1).png)` 는 `)` 에서 끊겨
		//   `https://x/y(1` 이 잡히는데, 이것도 https 라 URL 검사를 통과한다.
		//   그대로 두면 **깨진 주소가 조용히 썸네일이 된다** — 아무도 모르게 목록
		//   카드만 깨진다. 애매하면 넣지 않는 쪽이 맞다.
		if (countOf(url, '(') !== countOf(url, ')')) return;
		if (!found.includes(url)) found.push(url);
	};

	// alt 안의 대괄호 한 겹까지 허용한다: `![도표[1]](url)`
	for (const m of withoutCode.matchAll(/!\[(?:[^[\]]|\[[^\]]*\])*\]\(([^)]+)\)/g)) push(m[1]);
	for (const m of withoutCode.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi)) {
		push(m[1]);
	}
	return found;
}

/**
 * 무엇을 썸네일로 쓸지 정한다.
 *
 * 우선순위:
 *   1. 호출자가 준 값 → 그대로 쓴다 (`explicit`)
 *   2. 호출자가 **끄겠다고** 명시 → 안 쓴다 (`opted-out`)
 *   3. 본문 첫 이미지 → 자동 (`auto`)
 *   4. 본문에 이미지가 없음 → 안 쓴다 (`none`)
 *
 * ★ 끄는 방법을 둔 이유 — 이 도구는 나만 쓰는 게 아니다. 썸네일을 **일부러**
 *   비워 두는 사람이 있고, 자동 채움이 그 의도를 조용히 덮으면 안 된다.
 *   빈 문자열이나 null 을 주면 "비워 둬라"로 읽는다.
 */
export function chooseThumbnail(
	requested: string | null | undefined,
	body: string,
): ThumbnailChoice {
	const candidates = extractImageUrls(body);

	if (typeof requested === 'string' && requested.trim() !== '') {
		return { url: requested, candidates, reason: 'explicit' };
	}
	// ★ null 과 빈 문자열은 "자동으로 넣지 마라"는 뜻이다. undefined(미지정)와
	//   구분해야 한다 — 미지정은 "알아서 해달라"이고 이건 명시적 거부다.
	if (requested !== undefined) {
		return { url: undefined, candidates, reason: 'opted-out' };
	}
	const first = candidates[0];
	if (first === undefined) return { url: undefined, candidates, reason: 'none' };
	return { url: first, candidates, reason: 'auto' };
}

/**
 * 병합 수정(velog_update_post)용. 생성과 규칙이 다르다.
 *
 * ★★ **기존 썸네일이 최우선이다.** 이미 붙어 있는 그림을 본문 첫 이미지로
 *    갈아치우면, 제목만 고치려던 사람이 목록 카드가 바뀌는 걸 당한다.
 *    자동 채움은 **비어 있을 때만** 한다.
 *
 * ⚠️ `null` 을 줘도 **기존 썸네일을 지우지 않는다.** 여기서 null 은 "자동으로
 *   채우지 마라"이지 "지워라"가 아니다. 지우는 건 되돌리기 어려운데 그 의도를
 *   null 하나로 단정할 수 없다 — 지우려면 벨로그에서 직접 하는 게 맞다.
 */
export function chooseThumbnailForUpdate(
	requested: string | null | undefined,
	existing: string | null | undefined,
	body: string,
): ThumbnailChoice {
	if (typeof requested === 'string' && requested.trim() !== '') {
		return { url: requested, candidates: extractImageUrls(body), reason: 'explicit' };
	}
	if (existing) {
		// 기존 값을 그대로 잇는다. 안내도 하지 않는다 — 바뀐 게 없다.
		return { url: existing, candidates: [], reason: 'explicit' };
	}
	return chooseThumbnail(requested, body);
}

/**
 * 결과 메시지에 붙일 안내. 붙일 말이 없으면 빈 문자열.
 *
 * ★ 조용히 하지 않는다. 자동으로 넣었으면 **넣었다고 말한다.** 내가 시키지 않은
 *   변경이 결과에 안 보이면 그게 사고다.
 */
export function describeThumbnail(choice: ThumbnailChoice): string {
	if (choice.reason === 'auto') {
		const others = choice.candidates.length - 1;
		const head =
			`\n\n🖼️ 썸네일을 본문 첫 이미지로 **자동 설정**했습니다.\n   ${choice.url}`;
		if (others <= 0) return head;
		const list = choice.candidates
			.slice(1, 6)
			.map((u, i) => `   ${i + 2}. ${u}`)
			.join('\n');
		const more = others > 5 ? `\n   … 외 ${others - 5}개` : '';
		return (
			`${head}\n\n   본문에 이미지가 ${choice.candidates.length}개 있습니다. ` +
			`다른 걸 쓰려면 thumbnail 에 아래 중 하나를 주세요.\n${list}${more}`
		);
	}
	if (choice.reason === 'none') {
		return (
			'\n\n💡 썸네일이 없습니다. 본문에 이미지가 없어 자동으로 채우지 못했습니다 — ' +
			'목록·공유 카드에 그림이 필요하면 thumbnail 에 이미지 URL 을 주거나 ' +
			'velog_render_diagram / velog_upload_image 로 하나 만들어 붙이세요.'
		);
	}
	return '';
}
