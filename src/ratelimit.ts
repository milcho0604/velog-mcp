/**
 * 초안 생성 속도 제한.
 *
 * ★ 이건 예의가 아니라 안전장치다. 벨로그는 최근 5분의 `is_private:false` 글을
 *   `is_temp` 구분 없이 세고, 10개를 넘으면 **최근 5분의 글을 전부**
 *   `is_private:true` 로 바꾼다 (apps/server/src/services/PostApiService/index.mts).
 *   초안도 Prisma 기본값으로 `released_at = now()` 를 받으므로 이 카운트에 들어간다.
 *
 *   결과: 초안을 몰아 만들면 **같은 시간대에 발행한 진짜 글이 비공개가 된다.**
 *   되돌리려면 사용자가 글마다 공개 설정을 다시 손대야 한다.
 *
 * 그래서 벨로그 한계(10)보다 낮은 선에서 우리가 먼저 멈춘다. 여유를 두는 이유는
 * 사용자가 같은 시간대에 벨로그 웹에서 직접 글을 쓸 수도 있어서다 — 우리 카운터는
 * 그걸 못 본다.
 */

/** 벨로그가 파괴적 조치를 취하는 임계. 넘기면 안 된다. */
export const VELOG_DESTRUCTIVE_THRESHOLD = 10;

/** 우리 상한. 사용자가 웹에서 직접 쓴 글 몫을 남겨둔다. */
export const DRAFT_LIMIT = 5;

/** 벨로그가 보는 창과 같다. */
export const WINDOW_MS = 5 * 60 * 1000;

export class DraftRateLimitError extends Error {
	readonly retryAfterMs: number;

	constructor(retryAfterMs: number) {
		const seconds = Math.ceil(retryAfterMs / 1000);
		super(
			`초안 생성을 잠시 멈춥니다. 최근 5분에 이미 ${DRAFT_LIMIT}건을 만들었습니다.\n\n` +
				`이유: 벨로그는 최근 5분의 공개 글이 ${VELOG_DESTRUCTIVE_THRESHOLD}건을 넘으면 ` +
				'그 시간대 글을 **전부 비공개로 바꿉니다**. 초안도 이 계수에 포함되므로, ' +
				'계속하면 같은 시간대에 발행하신 진짜 글이 비공개가 될 수 있습니다.\n\n' +
				`약 ${seconds}초 뒤에 다시 시도하세요. ` +
				'급하면 만들어둔 초안을 velog_update_draft 로 이어 쓰는 편이 안전합니다.',
		);
		this.name = 'DraftRateLimitError';
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * 슬라이딩 윈도우 카운터. 프로세스 메모리에만 있다.
 *
 * 한계를 분명히 해둔다 — 이 카운터는 **이 서버가 만든 초안만** 센다.
 * 사용자가 벨로그 웹에서 직접 쓴 글은 안 보인다. 그래서 상한을 10이 아니라
 * 5로 잡아 여유를 남긴다.
 */
export class DraftRateLimiter {
	readonly #timestamps: number[] = [];
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #now: () => number;

	constructor(
		options: { limit?: number; windowMs?: number; now?: () => number } = {},
	) {
		this.#limit = options.limit ?? DRAFT_LIMIT;
		this.#windowMs = options.windowMs ?? WINDOW_MS;
		this.#now = options.now ?? (() => Date.now());
	}

	/** 한도를 넘었으면 던진다. 통과하면 이번 생성을 기록한다. */
	check(): void {
		const now = this.#now();
		const cutoff = now - this.#windowMs;
		while (this.#timestamps.length > 0 && this.#timestamps[0]! <= cutoff) {
			this.#timestamps.shift();
		}
		if (this.#timestamps.length >= this.#limit) {
			const oldest = this.#timestamps[0]!;
			throw new DraftRateLimitError(oldest + this.#windowMs - now);
		}
		this.#timestamps.push(now);
	}

	/** 창 안의 현재 건수. */
	get count(): number {
		const cutoff = this.#now() - this.#windowMs;
		return this.#timestamps.filter((t) => t > cutoff).length;
	}
}
