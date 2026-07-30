/**
 * 토큰 취급 — 환경변수로만 읽고, 디스크에 쓰지 않고, 로그에 싣지 않는다.
 *
 * 설계 근거: docs/decisions/0003-token-env-only.md
 * 이 파일에는 fs 를 import 하지 않는다. 토큰이 파일로 나갈 경로 자체를 없앤다.
 *
 * ★ 벨로그 서버가 토큰을 알아서 갱신한다 (공식 소스 authPlugin.mts 확인):
 *   - access_token 수명이 30분 미만이면 refresh_token 으로 재발급
 *   - access_token 이 없거나 깨져도 refresh_token 이 있으면 복구
 *   - 새 토큰은 응답의 Set-Cookie 로 온다
 *   그래서 (1) refresh_token 만 있어도 인증이 되고
 *         (2) Set-Cookie 를 받아 메모리에 반영하면 세션이 안 끊긴다.
 *   여전히 디스크에는 쓰지 않는다 — 프로세스 수명만큼만 산다.
 */

export interface Credentials {
	readonly accessToken: string | undefined;
	readonly refreshToken: string | undefined;
}

/**
 * 인증 상태. 토큰이 없는 것은 에러가 아니라 상태다 —
 * 공개 글 조회·검색·트렌딩은 인증 없이 동작한다.
 */
export type AuthState =
	| { readonly kind: 'anonymous' }
	| { readonly kind: 'authenticated'; readonly credentials: Credentials };

export function readAuthFromEnv(env: NodeJS.ProcessEnv = process.env): AuthState {
	const accessToken = env['VELOG_ACCESS_TOKEN']?.trim() || undefined;
	const refreshToken = env['VELOG_REFRESH_TOKEN']?.trim() || undefined;

	// 둘 중 하나만 있어도 인증을 시도한다. 서버가 refresh_token 으로 복구해준다.
	if (!accessToken && !refreshToken) return { kind: 'anonymous' };
	return { kind: 'authenticated', credentials: { accessToken, refreshToken } };
}

/** 벨로그는 쿠키 헤더로 인증한다. 없는 토큰은 싣지 않는다. */
export function buildCookieHeader(credentials: Credentials): string {
	const parts: string[] = [];
	if (credentials.accessToken) parts.push(`access_token=${credentials.accessToken}`);
	if (credentials.refreshToken) parts.push(`refresh_token=${credentials.refreshToken}`);
	return parts.join('; ');
}

/**
 * 응답의 Set-Cookie 에서 갱신된 토큰을 뽑는다.
 *
 * 서버가 재발급하면 여기로 온다. 값이 없으면 undefined 를 돌려
 * 호출부가 기존 토큰을 유지하게 한다.
 */
export function parseSetCookie(header: string | null): Partial<Credentials> {
	if (!header) return {};

	const out: { accessToken?: string; refreshToken?: string } = {};
	// fetch 는 여러 Set-Cookie 를 콤마로 합쳐 준다. 쿠키 값 자체에는 콤마가
	// 오지 않으므로 이름=값 패턴만 훑는 편이 안전하다.
	for (const match of header.matchAll(/(access_token|refresh_token)=([^;,\s]*)/g)) {
		const [, name, value] = match;
		if (!value) continue; // 로그아웃 시 빈 값으로 지우는 경우는 무시한다
		if (name === 'access_token') out.accessToken = value;
		else out.refreshToken = value;
	}
	return out;
}

/**
 * 현재 유효한 토큰을 들고 있는 저장소. 서버가 갱신해주면 여기에 반영한다.
 *
 * 메모리에만 있다. 디스크·키체인·브라우저 어디에도 쓰지 않는다.
 */
export class TokenStore {
	#state: AuthState;
	/** 마스킹 대상. 갱신 전 토큰도 계속 가려야 해서 누적한다. */
	readonly #seen = new Set<string>();

	constructor(initial: AuthState) {
		this.#state = initial;
		this.#remember(initial);
	}

	get state(): AuthState {
		return this.#state;
	}

	get isAuthenticated(): boolean {
		return this.#state.kind === 'authenticated';
	}

	/** Set-Cookie 로 받은 새 토큰을 반영한다. 바뀐 게 있으면 true. */
	update(incoming: Partial<Credentials>): boolean {
		if (this.#state.kind !== 'authenticated') return false;
		if (!incoming.accessToken && !incoming.refreshToken) return false;

		const current = this.#state.credentials;
		const next: Credentials = {
			accessToken: incoming.accessToken ?? current.accessToken,
			refreshToken: incoming.refreshToken ?? current.refreshToken,
		};
		if (
			next.accessToken === current.accessToken &&
			next.refreshToken === current.refreshToken
		) {
			return false;
		}
		this.#state = { kind: 'authenticated', credentials: next };
		this.#remember(this.#state);
		return true;
	}

	/** 지금까지 본 모든 토큰을 문자열에서 가린다. */
	mask(text: string): string {
		let masked = text;
		for (const secret of this.#seen) {
			masked = masked.split(secret).join('***REDACTED***');
		}
		return masked.replace(
			/(access_token|refresh_token)=[^;\s"']+/g,
			'$1=***REDACTED***',
		);
	}

	#remember(state: AuthState): void {
		if (state.kind !== 'authenticated') return;
		for (const secret of [
			state.credentials.accessToken,
			state.credentials.refreshToken,
		]) {
			// 너무 짧은 값을 치환하면 본문이 훼손된다. 토큰은 항상 이보다 길다.
			if (secret && secret.length >= 8) this.#seen.add(secret);
		}
	}
}

/**
 * 토큰 문자열이 메시지에 섞여 나가는 것을 막는다.
 *
 * GraphQL 에러 응답이나 fetch 예외를 그대로 던지면 요청 헤더가 함께 실릴 수
 * 있다. 사용자에게 보이는 모든 문자열은 이 함수를 통과시킨다.
 */
export function maskSecrets(text: string, state: AuthState): string {
	if (state.kind === 'anonymous') return text;

	let masked = text;
	const { accessToken, refreshToken } = state.credentials;
	for (const secret of [accessToken, refreshToken]) {
		if (secret && secret.length >= 8) {
			masked = masked.split(secret).join('***REDACTED***');
		}
	}
	return masked.replace(/(access_token|refresh_token)=[^;\s"']+/g, '$1=***REDACTED***');
}

/** 쓰기 도구가 인증을 요구할 때 쓰는 에러. */
export class AuthRequiredError extends Error {
	constructor(toolName: string) {
		super(
			`${toolName} 은(는) 인증이 필요합니다. ` +
				'VELOG_ACCESS_TOKEN 또는 VELOG_REFRESH_TOKEN 환경변수를 설정하세요. ' +
				'(velog.io 로그인 → F12 → Application → Cookies) ' +
				'refresh_token 만 넣어도 서버가 access_token 을 재발급합니다(유효기간 30일).',
		);
		this.name = 'AuthRequiredError';
	}
}
