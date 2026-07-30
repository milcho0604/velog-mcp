/**
 * 벨로그 GraphQL 클라이언트.
 *
 * Node 24 내장 fetch 만 쓴다 — HTTP 라이브러리를 추가하지 않는다.
 * 접속하는 호스트는 v3.velog.io 하나뿐이다 (docs/security.md).
 */

import {
	type AuthState,
	AuthRequiredError,
	TokenStore,
	buildCookieHeader,
	parseSetCookie,
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
	/** 코드만 보관한다. 원본 응답에는 토큰이 섞일 수 있다. */
	readonly graphqlErrorCodes?: readonly string[];
	/**
	 * 네트워크 오류의 원인 표식 (ECONNRESET·TimeoutError 등).
	 * ★ Node 의 fetch 실패는 TypeError('fetch failed') 로 오고 진짜 원인은
	 *   cause 체인에 있다. message 만 뽑으면 'fetch failed' 만 남아 재시도 판정이
	 *   전부 실패한다 — 실측으로 확인함.
	 */
	readonly networkCodes?: readonly string[];
}

/** cause 체인을 훑어 code·name 을 모은다. 토큰이 섞일 수 있는 message 는 담지 않는다. */
export function collectCauseCodes(error: unknown, depth = 5): string[] {
	const codes: string[] = [];
	let current: unknown = error;
	for (let i = 0; i < depth && current; i++) {
		if (typeof current !== 'object') break;
		const node = current as { name?: unknown; code?: unknown; cause?: unknown };
		if (typeof node.name === 'string') codes.push(node.name);
		if (typeof node.code === 'string') codes.push(node.code);
		current = node.cause;
	}
	return codes;
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
	/**
	 * 인증 상태로 비-벨로그 엔드포인트에 요청하는 것을 허용한다.
	 * 가짜 fetch 로 도구를 검사하는 테스트 전용이며, 운영 경로에서는 절대 켜지 않는다.
	 */
	readonly allowInsecureEndpoint?: boolean;
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
const TRANSIENT_CODES = new Set([
	'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
	'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
	'TimeoutError', 'AbortError',
]);

export function isTransient(error: unknown): boolean {
	if (!(error instanceof VelogApiError)) return false;

	const status = error.detail?.status;
	if (status !== undefined && status >= 500) return true;
	// 4xx 는 다시 쳐도 같은 답이다.
	if (status !== undefined && status < 500) return false;

	// ★ 네트워크 오류는 message 가 아니라 cause 체인의 code 로 판정한다.
	for (const code of error.detail?.networkCodes ?? []) {
		if (TRANSIENT_CODES.has(code)) return true;
	}
	return /connection pool|timed out|timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(
		error.message,
	);
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** 인증 만료 안내. HTTP 401 경로와 GraphQL errors 경로 둘 다에서 쓴다. */
const AUTH_HINT =
	' — access_token 이 만료됐을 수 있습니다(유효기간 1시간). 새 토큰으로 갱신하세요.';

export class VelogClient {
	readonly #tokens: TokenStore;
	readonly #endpoint: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #maxRetries: number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #allowInsecureEndpoint: boolean;

	constructor(options: ClientOptions) {
		this.#tokens = new TokenStore(options.auth);
		this.#endpoint = options.endpoint ?? VELOG_ENDPOINT;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#maxRetries = options.maxRetries ?? 2;
		this.#sleep = options.sleepImpl ?? defaultSleep;
		this.#allowInsecureEndpoint = options.allowInsecureEndpoint ?? false;
	}

	get isAuthenticated(): boolean {
		return this.#tokens.isAuthenticated;
	}

	/** 인증이 필요한 도구가 먼저 호출한다. */
	requireAuth(toolName: string): void {
		if (!this.#tokens.isAuthenticated) throw new AuthRequiredError(toolName);
	}

	/**
	 * 일시적 실패는 지수 백오프로 다시 친다. 영구 오류(인증 만료·잘못된 질의)는
	 * 즉시 던진다 — 재시도해봤자 같은 답이고 사용자만 기다린다.
	 *
	 * ★ mutation 은 재시도하지 않는다. 멱등하지 않기 때문이다.
	 *   서버가 글을 만든 뒤 응답만 유실되면 재시도가 초안을 하나 더 만든다.
	 *   그냥 중복이 아니라 실제 피해로 이어진다 — mutate() 주석 참고.
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

	/**
	 * 쓰기 전용 — **재시도하지 않는다.**
	 *
	 * 벨로그는 최근 5분의 `is_private:false` 글을 세는데 `is_temp` 를 구분하지
	 * 않는다. 10개를 넘으면 최근 5분의 글을 **전부** `is_private:true` 로 바꾼다:
	 *
	 *   // apps/server/src/services/PostApiService/index.mts
	 *   const recentPostCount = await db.post.count({
	 *     where: { fk_user_id, is_private: false, released_at: { gt: 5분전 } } })
	 *   if (recentPostCount < 10) return false
	 *   await db.post.updateMany({
	 *     where: { fk_user_id, released_at: { gt: 5분전 } },   // is_private 필터 없음
	 *     data: { is_private: true } })
	 *
	 * 초안도 Prisma 기본값으로 `released_at = now()` 가 붙으므로(schema.prisma)
	 * 이 카운트에 들어간다. 즉 초안을 몰아 만들면 **같은 시간대에 발행한 진짜 글이
	 * 비공개로 내려간다.** 응답 유실로 인한 자동 재시도가 이 한계를 앞당길 수 있어
	 * 쓰기는 한 번만 친다. 실패하면 사용자가 상태를 확인하고 다시 부르게 한다.
	 */
	async mutate<T>(
		query: string,
		variables: Record<string, unknown> = {},
	): Promise<T> {
		return this.#requestOnce<T>(query, variables);
	}

	async #requestOnce<T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		// ★ 자격증명은 벨로그 정규 엔드포인트로만 보낸다.
		//   endpoint 는 테스트 주입용 옵션인데, 임의 URL 이 들어오면 쿠키가 그
		//   호스트로 나간다. "벨로그 외 호스트에 접속하지 않는다"는 보장을 코드로
		//   지키려면 여기서 목적지를 확인해야 한다 — 문자열 검색 테스트로는 못 막는다.
		const auth = this.#tokens.state;
		if (auth.kind === 'authenticated') {
			if (this.#endpoint === VELOG_ENDPOINT) {
				headers['Cookie'] = buildCookieHeader(auth.credentials);
			} else if (!this.#allowInsecureEndpoint) {
				throw new VelogApiError(
					`인증 요청은 ${VELOG_ENDPOINT} 로만 보낼 수 있습니다. ` +
						'다른 엔드포인트로는 토큰을 전송하지 않습니다.',
				);
			}
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
			const codes = collectCauseCodes(cause);
			// 네트워크 예외에도 요청 정보가 실릴 수 있으므로 마스킹한다.
			// 원인 코드를 detail 에 실어야 재시도 판정이 동작한다.
			throw new VelogApiError(
				`벨로그 요청 실패: ${this.#mask(reason)}${codes.length ? ` (${codes.join('/')})` : ''}`,
				{ networkCodes: codes },
			);
		}

		// ★ 벨로그는 access_token 수명이 30분 아래로 내려가면 refresh_token 으로
		//   재발급해 Set-Cookie 로 돌려준다 (공식 authPlugin.mts). 이걸 버리면
		//   1시간마다 세션이 죽는다. 받아서 메모리에만 반영한다 — 디스크엔 안 쓴다.
		//   실패 응답에도 실려 올 수 있으므로 상태 확인보다 먼저 처리한다.
		this.#tokens.update(parseSetCookie(response.headers.get('set-cookie')));

		if (!response.ok) {
			const body = this.#mask(await response.text().catch(() => ''));
			// ★ 벨로그는 만료 토큰에 HTTP 401 을 준다 (실측). GraphQL errors 경로가
			//   아니라 여기로 떨어지므로, 만료 안내를 이쪽에도 붙여야 한다.
			//   실사용에서 제일 흔한 오류인데 안내가 없으면 원인을 못 찾는다.
			const hint =
				response.status === 401 || response.status === 403 ? AUTH_HINT : '';
			throw new VelogApiError(
				`벨로그 HTTP ${response.status}: ${truncate(body, 400)}${hint}`,
				{ status: response.status },
			);
		}

		// ★ JSON 파싱 실패가 그냥 SyntaxError 로 빠지면 마스킹도 재시도 판정도 우회한다.
		//   벨로그가 502 HTML 을 200 으로 주는 경우가 실제로 있다.
		let payload: GraphQLResponse<T>;
		try {
			payload = (await response.json()) as GraphQLResponse<T>;
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new VelogApiError(
				`벨로그 응답을 JSON 으로 읽지 못했습니다: ${this.#mask(reason)}`,
				{ networkCodes: collectCauseCodes(cause) },
			);
		}

		if (payload.errors?.length) {
			const messages = payload.errors
				.map((e) => e.message ?? '(메시지 없음)')
				.join(' / ');
			const codes = payload.errors.map((e) => e.extensions?.code).filter(Boolean);

			// 만료를 뭉뚱그리면 사용자가 원인을 못 찾는다. 별도로 짚어준다.
			const looksUnauthenticated =
				codes.includes('UNAUTHENTICATED') || /not logged|unauthor/i.test(messages);
			const hint = looksUnauthenticated ? AUTH_HINT : '';

			// ★ 원본 payload.errors 를 그대로 담으면 토큰이 Error 객체에 남는다.
			//   지금은 MCP SDK 가 message 만 내보내지만, 나중에 console.error(error)
			//   나 오류 수집기를 붙이는 순간 샌다. 코드만 보관한다.
			throw new VelogApiError(`벨로그 GraphQL 오류: ${this.#mask(messages)}${hint}`, {
				graphqlErrorCodes: codes.filter((c): c is string => typeof c === 'string'),
			});
		}

		if (payload.data === undefined || payload.data === null) {
			throw new VelogApiError('벨로그가 빈 응답을 반환했습니다.');
		}
		return payload.data;
	}

	#mask(text: string): string {
		return this.#tokens.mask(text);
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
