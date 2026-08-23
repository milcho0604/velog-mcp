/**
 * 벨로그 GraphQL 클라이언트.
 *
 * Node 내장 fetch 만 쓴다 — HTTP 라이브러리를 추가하지 않는다.
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
 * 이미지 업로드만 GraphQL 이 아니다.
 *
 * v3 의 mutation 23개 어디에도 업로드가 없다. 벨로그 서버는 파일을 fastify REST
 * 라우트로 받는다 — `routes/index.mts` 가 `/api` 아래에 `/files` 를 붙이고,
 * `routes/files/index.mts` 가 다시 `/v3` 를 붙여 아래 경로가 된다.
 * 폼 필드 이름이 `image` 인 것도 서버 쪽 `multer.single('image')` 에서 온다.
 */
export const VELOG_UPLOAD_ENDPOINT = 'https://v3.velog.io/api/files/v3/upload';

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
	/**
	 * 서버가 `errors` 와 `data` 를 **함께** 준 경우.
	 *
	 * ★ 이 표식이 붙은 오류는 절대 재시도하지 않는다. 작업이 이미 반영됐을 수
	 *   있는데 다시 치면 두 번 반영된다 — mutate() 무재시도와 같은 이유다.
	 */
	readonly partial?: boolean;
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
	readonly uploadEndpoint?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	readonly maxRetries?: number;
	/** 재시도를 포함한 총 예산. 기본값 근거는 RETRY_BUDGET_MS 주석. */
	readonly retryBudgetMs?: number;
	/** 테스트에서 대기를 건너뛰기 위해 주입한다. */
	readonly sleepImpl?: (ms: number) => Promise<void>;
	/** 테스트에서 예산 소진을 벽시계 없이 재현하기 위해 주입한다. */
	readonly nowImpl?: () => number;
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
	// ★ 아래 둘은 우리가 붙이는 표식이다. 벨로그가 **HTTP 200 으로** 502 HTML 이나
	//   빈 본문을 주는 일이 실제로 있는데(아래 #requestOnce 주석), 그러면 JSON 파싱
	//   오류가 되어 status 도 network code 도 없는 '영구 오류'로 분류됐다.
	//   실측: 200+HTML 을 한 번 준 뒤 정상 JSON 을 줘도 재시도 없이 1회로 포기했다
	//   (같은 조건에서 HTTP 503 은 정상적으로 재시도됨 — 대조군 확인).
	//   이건 상대 인프라의 일시 장애지 우리 질의의 문제가 아니다.
	'INVALID_JSON', 'EMPTY_RESPONSE',
]);

export function isTransient(error: unknown): boolean {
	if (!(error instanceof VelogApiError)) return false;

	// ★ 부분 성공은 무슨 일이 있어도 다시 치지 않는다. 이미 반영됐을 수 있다.
	if (error.detail?.partial) return false;

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

/**
 * 재시도까지 포함한 **총** 예산.
 *
 * ★ 왜 상한이 필요한가 — 시도당 20초 × 3회 + 백오프 1.5초 = 61.5초다. 그런데
 *   MCP SDK 의 클라이언트측 기본 요청 타임아웃은 60초다
 *   (shared/protocol.js: DEFAULT_REQUEST_TIMEOUT_MSEC = 60000).
 *   실측 61.6초 — **클라이언트가 항상 먼저 포기한다.** 즉 마지막 시도의 20초는
 *   결과를 아무도 보지 못하는 순수 낭비였다. 기다린 사람만 손해다.
 *
 * 35초로 잡은 이유: 발행 계열 도구는 한 호출에서 `mutate`(무재시도 20초) 다음에
 * 사후 재조회를 한 번 더 한다. 20 + 35 = 55초로 60초 안에 들어온다.
 * 빠르게 실패하는 오류(ECONNRESET 등)에는 영향이 없다 — 세 번 다 그대로 돈다.
 *
 * ⚠️ 감수하는 것 — 첫 시도가 19초를 태우고 실패한 뒤 두 번째가 16초 걸려 성공할
 *   경우, 예산이 남은 시간으로 잘라 그 성공을 놓친다. 실측 왕복이 1.3초대라
 *   현실에서 보기 어려운 조합이고, 그걸 살리려고 예산을 늘리면 61.5초짜리
 *   '아무도 못 보는 기다림'이 돌아온다. 둘 중 하나는 포기해야 한다.
 */
export const RETRY_BUDGET_MS = 35_000;

/**
 * 도구 핸들러가 MCP 에게서 받는 것 중 **우리가 쓰는 부분만.**
 *
 * SDK 의 실제 타입(RequestHandlerExtra)은 이보다 넓다. 좁게 받으면 콜백이
 * 그대로 들어맞고(넓은 쪽을 좁은 쪽 자리에 넣는 것이므로 안전하다) SDK 내부
 * 타입에 이 파일이 묶이지 않는다. 인자 타입을 직접 적은 핸들러들
 * (`async (args: PublishArgs, extra) =>`) 은 SDK 의 문맥 추론이 끊기므로 이걸 쓴다.
 */
export interface ToolExtra {
	readonly signal: AbortSignal;
}

/** 호출자가 요청 단위로 넘기는 것. */
export interface RequestOptions {
	/**
	 * 도구 취소 신호. MCP 는 요청마다 AbortSignal 을 주는데
	 * (shared/protocol.js 가 `notifications/cancelled` 에 abort 한다) 이걸 fetch 까지
	 * 내려보내지 않으면, 클라이언트가 포기한 뒤에도 요청이 끝까지 가고 mutation 이
	 * 그대로 나간다.
	 */
	readonly signal?: AbortSignal | undefined;
}

/** 인증 만료 안내. HTTP 401 경로와 GraphQL errors 경로 둘 다에서 쓴다. */
const AUTH_HINT =
	' — access_token 이 만료됐을 수 있습니다(유효기간 1시간). 새 토큰으로 갱신하세요.';

export class VelogClient {
	readonly #tokens: TokenStore;
	readonly #endpoint: string;
	readonly #uploadEndpoint: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #maxRetries: number;
	readonly #retryBudgetMs: number;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #now: () => number;
	readonly #allowInsecureEndpoint: boolean;

	constructor(options: ClientOptions) {
		this.#tokens = new TokenStore(options.auth);
		this.#endpoint = options.endpoint ?? VELOG_ENDPOINT;
		this.#uploadEndpoint = options.uploadEndpoint ?? VELOG_UPLOAD_ENDPOINT;
		this.#timeoutMs = options.timeoutMs ?? 20_000;
		this.#fetch = options.fetchImpl ?? fetch;
		this.#maxRetries = options.maxRetries ?? 2;
		this.#retryBudgetMs = options.retryBudgetMs ?? RETRY_BUDGET_MS;
		this.#sleep = options.sleepImpl ?? defaultSleep;
		this.#now = options.nowImpl ?? Date.now;
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
		options: RequestOptions = {},
	): Promise<T> {
		// 예산은 '재시도까지 합쳐 여기까지'다. 시도마다 남은 만큼으로 잘라 준다.
		const deadline = this.#now() + this.#retryBudgetMs;
		// ★ `lastError` 를 좁히지 않으려고 플래그를 따로 둔다. `lastError ?? 기본값`
		//   으로 쓰면 타입이 unknown 에서 벗어나 only-throw-error 에 걸린다.
		let lastError: unknown;
		let failed = false;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
			options.signal?.throwIfAborted();
			const left = deadline - this.#now();
			if (left <= 0) break;
			try {
				return await this.#requestOnce<T>(query, variables, {
					signal: options.signal,
					timeoutMs: Math.min(this.#timeoutMs, left),
				});
			} catch (error) {
				lastError = error;
				failed = true;
				if (!isTransient(error) || attempt === this.#maxRetries) throw error;
				// 남은 예산보다 오래 자면 자고 일어나 아무것도 못 한다.
				const backoff = 500 * 2 ** attempt; // 500ms → 1s
				if (deadline - this.#now() <= backoff) break;
				await this.#sleep(backoff);
			}
		}
		if (!failed) {
			throw new VelogApiError(
				`벨로그가 ${this.#retryBudgetMs / 1000}초 안에 응답하지 않아 중단했습니다.`,
			);
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
	 * 계수(`count`)에는 `is_private:false` 필터가 있어 우리 초안(is_private:true)은
	 * 카운터를 올리지 않는다. 하지만 쓸어내는 `updateMany` 에는 그 필터가 없다 —
	 * 이미 공개 글 10건이 쌓인 상태에서 조치가 돌면 **같은 5분 안의 글이 전부**
	 * 비공개로 내려간다. 응답 유실로 인한 자동 재시도가 그 순간을 앞당길 수 있어
	 * 쓰기는 한 번만 친다. 실패하면 사용자가 상태를 확인하고 다시 부르게 한다.
	 */
	async mutate<T>(
		query: string,
		variables: Record<string, unknown> = {},
		options: RequestOptions = {},
	): Promise<T> {
		options.signal?.throwIfAborted();
		return this.#requestOnce<T>(query, variables, {
			signal: options.signal,
			isMutation: true,
		});
	}

	/**
	 * 이미지 업로드. **재시도하지 않는다.**
	 *
	 * 벨로그는 업로드 횟수를 사용자 단위로 센다 (`ImageService.detectAbuse`):
	 * 1시간 100건 초과 또는 1분 20건 이상이면 그 계정을 막고 슬랙으로 알린다.
	 * 응답만 유실됐을 때 자동 재시도하면 실제로는 두 번 올라가 이 한도를 앞당긴다.
	 * mutate() 와 같은 이유로 한 번만 친다.
	 *
	 * `refId` 를 주면 서버가 "그 글이 내 글인지" 확인한다 (남의 글이면 403).
	 * 벨로그에 몇 없는 실제 소유권 검사라 쓸 수 있으면 쓴다.
	 *
	 * @returns 업로드된 이미지의 공개 URL (`https://velog.velcdn.com/...`)
	 */
	async uploadImage(
		bytes: Uint8Array,
		filename: string,
		options: {
			readonly type: 'post' | 'profile';
			readonly contentType: string;
			readonly refId?: string;
			readonly signal?: AbortSignal | undefined;
		},
	): Promise<string> {
		options.signal?.throwIfAborted();
		const auth = this.#tokens.state;
		if (auth.kind !== 'authenticated') throw new AuthRequiredError('velog_upload_image');

		// GraphQL 경로와 같은 규율 — 자격증명은 벨로그 정규 주소로만 나간다.
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (this.#uploadEndpoint === VELOG_UPLOAD_ENDPOINT) {
			headers['Cookie'] = buildCookieHeader(auth.credentials);
		} else if (!this.#allowInsecureEndpoint) {
			throw new VelogApiError(
				`이미지는 ${VELOG_UPLOAD_ENDPOINT} 로만 보낼 수 있습니다. ` +
					'다른 주소로는 파일도 토큰도 보내지 않습니다.',
			);
		}

		const form = new FormData();
		form.append('type', options.type);
		if (options.refId) form.append('ref_id', options.refId);
		// ★ 필드 이름은 반드시 'image'. 서버가 multer.single('image') 로 받는다.
		//   Content-Type 헤더는 손대지 않는다 — fetch 가 multipart 경계를 붙인다.
		form.append('image', new Blob([bytes], { type: options.contentType }), filename);

		let response: Response;
		try {
			response = await this.#fetch(this.#uploadEndpoint, {
				method: 'POST',
				headers,
				body: form,
				// 이미지는 GraphQL 질의보다 오래 걸린다. 최소 60초는 준다.
				signal: this.#abortSignal(
					Math.max(this.#timeoutMs, 60_000),
					options.signal,
				),
			});
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			const codes = collectCauseCodes(cause);
			// ★ '실패'라고 단정하면 안 된다. 서버가 파일을 받아 저장한 뒤 응답만
			//   끊겼을 수도 있다. 그 상태에서 다시 올리면 중복 업로드가 되고 한도만
			//   깎인다. 무엇을 모르는지 그대로 알려줘야 사용자가 판단할 수 있다.
			throw new VelogApiError(
				`이미지 업로드 중 통신이 끊겼습니다: ${this.#mask(reason)}` +
					`${codes.length ? ` (${codes.join('/')})` : ''}\n` +
					'⚠️ 올라갔는지 아닌지 알 수 없습니다. 다시 올리면 같은 그림이 두 번 저장될 수 ' +
					'있으니(삭제 API 없음) 벨로그에서 확인한 뒤 결정하세요.',
				{ networkCodes: codes },
			);
		}

		this.#tokens.update(parseSetCookie(response.headers.get('set-cookie')));

		if (!response.ok) {
			const body = this.#mask(await response.text().catch(() => ''));
			let hint = '';
			if (response.status === 401 || response.status === 403) hint = AUTH_HINT;
			if (response.status === 429) {
				hint =
					' — 벨로그가 업로드를 일시 차단했습니다. 1시간 100건 / 1분 20건이 한도입니다.';
			}
			if (response.status === 413) hint = ' — 파일이 너무 큽니다 (서버 상한 30MB).';
			// ★ 5xx 는 서버가 이미 저장한 뒤 실패했을 수도 있다. 통신 단절과 같은 성격이다.
			if (response.status >= 500) {
				hint =
					'\n⚠️ 서버 오류라 저장 여부를 알 수 없습니다. 다시 올리면 중복될 수 ' +
					'있으니(삭제 API 없음) 벨로그에서 확인한 뒤 결정하세요.';
			}
			throw new VelogApiError(
				`이미지 업로드 HTTP ${response.status}: ${truncate(body, 300)}${hint}`,
				{ status: response.status },
			);
		}

		let payload: { path?: unknown };
		try {
			payload = (await response.json()) as { path?: unknown };
		} catch (cause) {
			// 2xx 를 받고 본문만 못 읽은 경우다 — 서버는 이미 저장했을 가능성이 높다.
			throw new VelogApiError(
				'업로드 응답을 JSON 으로 읽지 못했습니다: ' +
					this.#mask(cause instanceof Error ? cause.message : String(cause)) +
					'\n⚠️ 서버는 200 을 줬으므로 이미 저장됐을 수 있습니다. 다시 올리기 전에 확인하세요.',
			);
		}
		if (typeof payload.path !== 'string' || payload.path === '') {
			throw new VelogApiError('업로드는 됐는데 서버가 이미지 주소를 주지 않았습니다.');
		}
		return payload.path;
	}

	/**
	 * 시간 상한과 취소 신호를 하나로 합친다.
	 *
	 * 둘 중 먼저 오는 쪽이 이긴다. 취소 신호가 없으면 예전과 똑같이 시간 상한만 건다.
	 */
	#abortSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
		const timeout = AbortSignal.timeout(timeoutMs);
		return signal ? AbortSignal.any([timeout, signal]) : timeout;
	}

	async #requestOnce<T>(
		query: string,
		variables: Record<string, unknown>,
		options: {
			signal?: AbortSignal | undefined;
			timeoutMs?: number;
			/** 쓰기인가. 결과 불명 경고를 붙일지 판단하는 데만 쓴다. */
			isMutation?: boolean;
		} = {},
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
				signal: this.#abortSignal(options.timeoutMs ?? this.#timeoutMs, options.signal),
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
			// ★ INVALID_JSON 표식을 붙여 재시도 대상으로 만든다. 이 자리에 오는 건
			//   대부분 우리 질의 문제가 아니라 상대가 200 으로 흘린 502 HTML 이다.
			throw new VelogApiError(
				`벨로그 응답을 JSON 으로 읽지 못했습니다: ${this.#mask(reason)}`,
				{ networkCodes: [...collectCauseCodes(cause), 'INVALID_JSON'] },
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

			// ★★ `data` 가 같이 왔으면 **부분 성공**이다 — 실패가 아니다.
			//   GraphQL 은 최상위 필드가 성공한 뒤 하위 resolver 만 깨져도 둘을 함께
			//   돌려준다. 예전엔 errors 만 보고 무조건 던지면서 data 를 버렸다.
			//   그러면 `writePost` 가 글을 만든 뒤 하위 필드가 깨졌을 때 사용자는
			//   '실패'로 보고 다시 부르고, 그 결과 **글이 두 번 만들어진다.**
			//   무엇을 모르는지 그대로 알려줘야 사용자가 판단할 수 있다
			//   (uploadImage 의 '올라갔는지 알 수 없습니다' 와 같은 규율).
			const created = firstId(payload.data);
			// ★★ GraphQL 명세상 `data` 키의 **유무**가 실행 여부를 가른다.
			//   키가 아예 없으면 질의가 실행 전에 거부된 것(파싱·검증 실패)이고,
			//   `data: null` 은 **실행이 시작된 뒤** non-null 필드 오류가 최상위까지
			//   전파된 것이다. 쓰기에서 후자는 "서버가 이미 반영했는데 응답을 못
			//   만든" 경우일 수 있다 — 벨로그 스키마상 writePost·editPost 는 `Post!`,
			//   `Post.id` 는 `ID!` 라 이 전파가 실제로 가능하다.
			//   그걸 평범한 실패로 보고하면 사용자가 다시 불러 글이 두 번 생긴다.
			//   (코덱스 3차 교차검증 지적)
			const executed = Object.hasOwn(payload, 'data');
			// ★ '`data` 가 있다'만으로 부분 성공이라 하면 안 된다. GraphQL 은 resolver
			//   가 깨지면 `{ data: { post: null }, errors: [...] }` 를 준다 — 이건
			//   아무것도 반영되지 않은 **완전 실패**다. 그걸 partial 로 찍으면
			//   재시도가 막히는데, 벨로그의 커넥션 풀 고갈이 정확히 이 모양으로 온다.
			//   (코덱스 교차검증에서 잡았다: 재시도 가능하던 읽기가 1회로 죽었다.)
			//   그래서 **값이 하나라도 실제로 들어있을 때만** 부분 성공으로 본다.
			const partial = hasAnyValue(payload.data);
			const unknownOutcome = partial || (options.isMutation === true && executed);
			const partialWarning = unknownOutcome
				? '\n⚠️ 요청이 **이미 반영됐을 수** 있습니다' +
					(partial
						? ' (서버가 결과 데이터를 함께 돌려줬습니다).'
						: ' (서버가 실행을 시작한 뒤 응답을 만들지 못했습니다).') +
					' 다시 시도하면 두 번 적용될 수 있으니 벨로그에서 확인한 뒤 결정하세요.' +
					(created ? ` (id=${created})` : '')
				: '';

			// ★ 원본 payload.errors 를 그대로 담으면 토큰이 Error 객체에 남는다.
			//   지금은 MCP SDK 가 message 만 내보내지만, 나중에 console.error(error)
			//   나 오류 수집기를 붙이는 순간 샌다. 코드만 보관한다.
			throw new VelogApiError(
				`벨로그 GraphQL 오류: ${this.#mask(messages)}${hint}${partialWarning}`,
				{
					graphqlErrorCodes: codes.filter((c): c is string => typeof c === 'string'),
					// partial 은 '값이 실제로 왔다' 는 뜻이고, 이게 붙으면 재시도가 막힌다.
					// 쓰기의 결과 불명은 어차피 mutate 가 재시도하지 않으므로 표식을
					// 넓히지 않는다 — 읽기의 정당한 재시도까지 막을 이유가 없다.
					...(partial ? { partial: true } : {}),
				},
			);
		}

		if (payload.data === undefined || payload.data === null) {
			// 빈 200 도 상대 인프라의 일시 장애다 (JSON 파싱 실패와 같은 성격).
			throw new VelogApiError('벨로그가 빈 응답을 반환했습니다.', {
				networkCodes: ['EMPTY_RESPONSE'],
			});
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

/**
 * 부분 성공 응답에서 '만들어졌거나 바뀐 것'의 id 를 한 개 찾는다.
 *
 * GraphQL 응답은 `{ writePost: { id } }` 처럼 최상위에 mutation 이름이 오고 그
 * 아래 결과가 온다. 사용자가 벨로그에서 확인하려면 id 하나가 필요하다.
 * 못 찾으면 그냥 없이 안내한다 — 없는 걸 지어내지 않는다.
 */
/** 최상위 필드 중 실제로 값이 담긴 게 하나라도 있는가. */
function hasAnyValue(data: unknown): boolean {
	if (typeof data !== 'object' || data === null) return false;
	return Object.values(data as Record<string, unknown>).some(
		(v) => v !== null && v !== undefined,
	);
}

function firstId(data: unknown): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	for (const value of Object.values(data as Record<string, unknown>)) {
		if (typeof value !== 'object' || value === null) continue;
		const id = (value as { id?: unknown }).id;
		if (typeof id === 'string' && id !== '') return id;
	}
	return undefined;
}
