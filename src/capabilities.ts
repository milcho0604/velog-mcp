/**
 * 기능 범위 — 사용자가 환경변수로 정한다.
 *
 * 설계 원칙: **모델은 이 값을 바꿀 수 없다.** MCP 설정 파일을 손대는 사람만
 * 바꿀 수 있고, 이는 토큰을 넣는 것과 같은 신뢰 경계다. 도구 파라미터로
 * 노출하면 모델이 스스로 권한을 올릴 수 있게 되므로 그렇게 하지 않는다.
 *
 * 왜 '비공개 발행'이 기본인가 — 벨로그 실측에 근거가 있다:
 *
 *   // apps/server/src/services/PostApiService/index.mts
 *   count({ where: { fk_user_id, is_private: false, released_at: { gt: 5분전 } } })
 *
 * 계수 대상이 `is_private: false` 뿐이다. 즉 **비공개 글은 이 카운터를 올리지
 * 않는다.**
 *
 * ⚠️ 다만 '올리지 않는다'와 '유발하지 않는다'는 다르다. 처음엔 이걸 혼동해
 * "비공개면 위험이 원천 소멸"이라고 잘못 적었다. 실제 서버 코드는:
 *
 *   const isPublish = !data.is_temp && !data.is_private
 *   const isLimit = await this.isPostLimitReached(signedUserId)   // ← 무조건 실행
 *
 * 공개 여부를 보기 **전에** 검사를 돌린다. 그래서 이미 최근 5분에 공개 글이
 * 10건 쌓여 있으면, 다음 요청이 비공개 초안 생성이어도 그 시점에 최근 글 전체가
 * 비공개로 바뀐다. 그 10건은 사용자가 웹에서 직접 올린 것일 수도 있어 우리
 * 카운터로는 못 본다.
 *
 * 정리하면 — 비공개로 두는 것은 **위험을 줄이지만 없애지는 못한다.**
 * 그래서 쓰기 무재시도와 자체 상한을 함께 유지한다.
 *
 * 공개 발행만 다르다. RSS·검색·구독 메일로 나간 뒤에는 지워도 회수가 안 되고,
 * 벨로그 계수에도 잡힌다. 그래서 이것만 명시적 opt-in 으로 둔다.
 */

export interface Capabilities {
	/** 공개 발행 (`is_private: false`). VELOG_ALLOW_PUBLIC=1 */
	readonly publicPublish: boolean;
}

/** '켠다'로 인정하는 값. 오타로 조용히 켜지지 않게 좁게 받는다. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function flag(value: string | undefined): boolean {
	return TRUTHY.has((value ?? '').trim().toLowerCase());
}

export function readCapabilities(
	env: NodeJS.ProcessEnv = process.env,
): Capabilities {
	return { publicPublish: flag(env['VELOG_ALLOW_PUBLIC']) };
}

/** 기동 로그용 한 줄 요약. 사용자가 지금 뭐가 열렸는지 즉시 알 수 있어야 한다. */
export function describeCapabilities(capabilities: Capabilities): string {
	return capabilities.publicPublish
		? '읽기 + 초안 + 발행(공개/비공개 선택 가능)'
		: '읽기 + 초안 + 비공개 발행 (공개 발행은 VELOG_ALLOW_PUBLIC=1 필요)';
}
