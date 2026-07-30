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

/**
 * 벨로그가 비정상 응답을 줬을 때. 메시지는 마스킹을 거친 뒤 담긴다.
 *
 * ★ 파라미터 프로퍼티(`constructor(readonly x: T)`)를 쓰지 않는다.
 *   Node 의 타입 스트리핑은 '지우기만' 하지 코드를 생성하지 않아
 *   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 로 죽는다. 같은 이유로 이 레포는
 *   enum·namespace·데코레이터도 쓰지 않는다. (docs/architecture.md 참고)
 */
export interface VelogApiErrorDetail {
	readonly status?: number;
	readonly graphqlErrors?: unknown;
}

export class VelogApiError extends Error {
	readonly detail: VelogApiErrorDetail | undefined;

	constructor(message: string, detail?: VelogApiErrorDetail) {
		super(message);
		this.name = 'VelogApiError';
		this.detail = detail;
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
	readonly maxRetries?: number;
	/** 테스트에서 대기를 건너뛰기 위해 주입한다. */
	readonly sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 벨로그는 Prisma 커넥션 풀이 작다 (connection limit 5 / timeout 10s).
 * 연속 호출하면 아래 오류가 실제로 뜬다 — 우리 잘못이 아니라 상대 쪽 포화다.
 *
 *   Timed out fetching a new connection from the connection pool
 *
 * 2026-07-30 실측: velog_export_posts 처럼 순차 요청이 많은 도구에서 재현.
 * 영구 실패가 아니므로 잠깐 쉬었다 다시 친다.
 */
export function isTransient(error: unknown): boolean {
	if (!(error instanceof VelogApiError)) return false;
	const status = error.detail?.status;
	if (status !== undefined && status >= 500) return true;
	return /connection pool|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(
		error.message,
	);
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export class VelogClient {
	readonly #auth: AuthState;
	readonly #endpoint: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #maxRetries: number;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor(options: ClientOptions) {
		this.#auth = options.auth;
		this.#endpoint = options.endpoint ?? VELOG_ENDPOINT;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#maxRetries = options.maxRetries ?? 2;
		this.#sleep = options.sleepImpl ?? defaultSleep;
	}

	get isAuthenticated(): boolean {
		return this.#auth.kind === 'authenticated';
	}

	/** 인증이 필요한 도구가 먼저 호출한다. */
	requireAuth(toolName: string): void {
		if (this.#auth.kind !== 'authenticated') throw new AuthRequiredError(toolName);
	}

	/**
	 * 일시적 실패는 지수 백오프로 다시 친다. 영구 오류(인증 만료·잘못된 질의)는
	 * 즉시 던진다 — 재시도해봤자 같은 답이고 사용자만 기다린다.
	 */
	async request<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			try {
				return await this.#requestOnce<T>(query, variables);
			} catch (error) {
				lastError = error;
				if (!isTransient(error) || attempt === this.#maxRetries) throw error;
				await this.#sleep(500 * 2 ** attempt); // 500ms → 1s
			}
		}
		throw lastError;
	}

	async #requestOnce<T>(
		query: string,
		variables: Record<string, unknown>,
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
