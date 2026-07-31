/**
 * "밖으로 나가면 안 되는 것" 판정 규칙 — **한 곳에만 둔다.**
 *
 * 나가는 경로가 둘이라서다:
 *   git 클론  → 추적 파일 전부 (플러그인을 git 소스로 설치하면 레포째 복제된다)
 *   npm 발행  → `files` 화이트리스트 (dist·docs·README·LICENSE·shrinkwrap)
 *
 * 규칙을 양쪽에 각각 적으면 한쪽만 느슨해져도 아무도 모른다.
 * 테스트(P21)와 발행 관문(verify-dist)이 **같은 함수**를 부른다.
 */

/**
 * 실제 사람의 주소만 골라낸다.
 *
 * ★ 예외는 **정확한 도메인**으로 판정한다
 *   처음엔 '문자열에 noreply 가 들어 있으면 통과'였다. 임의 도메인 주소에 그 낱말만
 *   끼워 넣으면 빠져나간다. 그다음엔 `endsWith` 로 좁혔는데, 그것도
 *   `foo.noreply.github.com` 같은 하위도메인을 통과시킨다. 그래서 `@` 뒤를 잘라
 *   **정확히 일치**하는지 본다.
 *
 * 전각 `＠` 도 본다 — 눈으로는 같은 글자다.
 */
const ALLOWED_EMAIL_DOMAINS = new Set(['users.noreply.github.com', 'noreply.github.com']);

const EMAIL = /[A-Za-z0-9._%+-]+[@＠][A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function findPersonalEmails(text: string): string[] {
	return [...text.matchAll(EMAIL)]
		.map((match) => match[0])
		.filter((value) => {
			const domain = value.split(/[@＠]/)[1] ?? '';
			return !ALLOWED_EMAIL_DOMAINS.has(domain.toLowerCase());
		});
}

/**
 * 개발 기계의 홈 경로. 남으면 사용자 계정명이 그대로 새 나간다.
 *
 * 문서에 흔한 자리표시자(`<your-name>`, `...`)와 일반명(`/home/user`)은 실제 경로가
 * 아니므로 뺀다. 윈도우는 역슬래시·슬래시 둘 다 본다 — 도구마다 다르게 뱉는다.
 */
export const LOCAL_PATH_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
	['macOS', /\/Users\/(?!\.\.\.|<)[^\s/'")\]]+/],
	['리눅스', /\/home\/(?!\.\.\.|<|user\b)[^\s/'")\]]+/],
	['윈도우', /[A-Za-z]:[\\/][Uu][Ss][Ee][Rr][Ss][\\/](?!<)[^\s\\/'")\]]+/],
];

export interface Leak {
	readonly file: string;
	readonly kind: string;
	readonly value: string;
}

/** 텍스트 한 덩이에서 나가면 안 되는 것을 전부 찾는다. */
export function findLeaks(file: string, text: string): Leak[] {
	const found: Leak[] = findPersonalEmails(text).map((value) => ({
		file,
		kind: '이메일',
		value,
	}));
	for (const [label, pattern] of LOCAL_PATH_PATTERNS) {
		const hit = pattern.exec(text);
		if (hit) found.push({ file, kind: `${label} 로컬 경로`, value: hit[0] });
	}
	return found;
}

/**
 * 텍스트로 볼 수 있는 파일인지. NUL 바이트가 있으면 바이너리로 본다.
 *
 * 확장자로 거르면 `LICENSE`·`.gitignore` 처럼 확장자 없는 파일을 통째로 놓친다 —
 * 실제로 그렇게 만들었다가 64개 중 62개만 검사하고 있었다.
 */
export function looksTextual(bytes: Uint8Array): boolean {
	// ⚠️ 앞 8KiB 만 보면 우회된다 — 'A' 8,192바이트 뒤에 UTF-16 홈 경로를 붙인 버퍼가
	//    textual 로 판정되고 leaks 도 skipped 도 비었다(실측). 전체를 본다.
	//    발행물이 0.6MiB 라 비용은 무시할 만하다.
	return !bytes.includes(0);
}

export interface ScanResult {
	readonly leaks: Leak[];
	/** 텍스트로 못 읽어 **검사하지 못한** 파일. 조용히 넘기면 그게 구멍이다. */
	readonly skipped: string[];
}

/**
 * 파일 묶음을 훑는다.
 *
 * ★ 건너뛴 것을 반드시 돌려준다
 *   `looksTextual` 은 UTF-16 이나 앞부분에 NUL 이 든 텍스트를 바이너리로 오판한다
 *   (실측: UTF-16LE 이메일 버퍼 → false). 그걸 `continue` 로 조용히 넘기면
 *   **검사받지 않은 파일이 그대로 발행된다.** 넘긴 목록을 내보내 호출부가 판단하게 한다.
 */
export function scanFiles(
	files: ReadonlyArray<readonly [string, Uint8Array]>,
): ScanResult {
	const leaks: Leak[] = [];
	const skipped: string[] = [];
	for (const [label, bytes] of files) {
		if (!looksTextual(bytes)) {
			skipped.push(label);
			continue;
		}
		leaks.push(...findLeaks(label, Buffer.from(bytes).toString('utf8')));
	}
	return { leaks, skipped };
}
