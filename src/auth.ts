/**
 * 토큰 취급 — 환경변수로만 읽고, 디스크에 쓰지 않고, 로그에 싣지 않는다.
 *
 * 설계 근거: docs/decisions/0003-token-env-only.md
 * 이 파일에는 fs 를 import 하지 않는다. 토큰이 파일로 나갈 경로 자체를 없앤다.
 */

export interface Credentials {
	readonly accessToken: string;
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
	const accessToken = env['VELOG_ACCESS_TOKEN']?.trim();
	if (!accessToken) return { kind: 'anonymous' };

	const refreshToken = env['VELOG_REFRESH_TOKEN']?.trim();
	return {
		kind: 'authenticated',
		credentials: { accessToken, refreshToken: refreshToken || undefined },
	};
}

/** 벨로그는 쿠키 헤더로 인증한다. */
export function buildCookieHeader(credentials: Credentials): string {
	const parts = [`access_token=${credentials.accessToken}`];
	if (credentials.refreshToken) {
		parts.push(`refresh_token=${credentials.refreshToken}`);
	}
	return parts.join('; ');
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
		// 너무 짧은 값을 치환하면 본문이 훼손된다. 토큰은 항상 이보다 길다.
		if (secret && secret.length >= 8) {
			masked = masked.split(secret).join('***REDACTED***');
		}
	}
	// 토큰 값이 바뀐 뒤 남은 헤더 잔재까지 훑는다.
	return masked.replace(/(access_token|refresh_token)=[^;\s"']+/g, '$1=***REDACTED***');
}

/** 쓰기 도구가 인증을 요구할 때 쓰는 에러. */
export class AuthRequiredError extends Error {
	constructor(toolName: string) {
		super(
			`${toolName} 은(는) 인증이 필요합니다. ` +
				'VELOG_ACCESS_TOKEN 환경변수를 설정하세요. ' +
				'(velog.io 로그인 → F12 → Application → Cookies → access_token)',
		);
		this.name = 'AuthRequiredError';
	}
}
