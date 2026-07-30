/**
 * 벨로그 GraphQL 클라이언트.
 *
 * Node 24 내장 fetch 만 쓴다 — HTTP 라이브러리를 추가하지 않는다.
 * 접속하는 호스트는 v3.velog.io 하나뿐이다 (docs/security.md).
 */

import {
	type AuthState,
	AuthRequiredError,
	buildCookieHeader,
	maskSecrets,
} from './auth.ts';

export const VELOG_ENDPOINT = 'https://v3.velog.io/graphql';

/** 벨로그가 비정상 응답을 줬을 때. 메시지는 마스킹을 거친 뒤 담긴다. */
export class VelogApiError extends Error {
	constructor(
		message: string,
		readonly detail?: { readonly status?: number; readonly graphqlErrors?: unknown },
	) {
		super(message);
		this.name = 'VelogApiError';
	}
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

export interface ClientOptions {
	readonly auth: AuthState;
	readonly endpoint?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
}

export class VelogClient {
	readonly #auth: AuthState;
	readonly #endpoint: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;

	constructor(options: ClientOptions) {
		this.#auth = options.auth;
		this.#endpoint = options.endpoint ?? VELOG_ENDPOINT;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
		this.#fetch = options.fetchImpl ?? fetch;
	}

	get isAuthenticated(): boolean {
		return this.#auth.kind === 'authenticated';
	}

	/** 인증이 필요한 도구가 먼저 호출한다. */
	requireAuth(toolName: string): void {
		if (this.#auth.kind !== 'authenticated') throw new AuthRequiredError(toolName);
	}

	async request<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (this.#auth.kind === 'authenticated') {
			headers['Cookie'] = buildCookieHeader(this.#auth.credentials);
		}

		let response: Response;
		try {
			response = await this.#fetch(this.#endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify({ query, variables }),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			// 네트워크 예외에도 요청 정보가 실릴 수 있으므로 마스킹한다.
			throw new VelogApiError(
				`벨로그 요청 실패: ${this.#mask(reason)}`,
			);
		}

		if (!response.ok) {
			const body = this.#mask(await response.text().catch(() => ''));
			throw new VelogApiError(
				`벨로그 HTTP ${response.status}: ${truncate(body, 400)}`,
				{ status: response.status },
			);
		}

		const payload = (await response.json()) as GraphQLResponse<T>;

		if (payload.errors?.length) {
			const messages = payload.errors
				.map((e) => e.message ?? '(메시지 없음)')
				.join(' / ');
			const codes = payload.errors.map((e) => e.extensions?.code).filter(Boolean);

			// 만료를 뭉뚱그리면 사용자가 원인을 못 찾는다. 별도로 짚어준다.
			const looksUnauthenticated =
				codes.includes('UNAUTHENTICATED') || /not logged|unauthor/i.test(messages);
			const hint = looksUnauthenticated
				? ' — access_token 이 만료됐을 수 있습니다(유효기간 1시간). 새 토큰으로 갱신하세요.'
				: '';

			throw new VelogApiError(`벨로그 GraphQL 오류: ${this.#mask(messages)}${hint}`, {
				graphqlErrors: payload.errors,
			});
		}

		if (payload.data === undefined || payload.data === null) {
			throw new VelogApiError('벨로그가 빈 응답을 반환했습니다.');
		}
		return payload.data;
	}

	#mask(text: string): string {
		return maskSecrets(text, this.#auth);
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
