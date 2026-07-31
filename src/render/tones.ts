/**
 * 색 팔레트.
 *
 * ★ 색을 자유 문자열로 받지 않는 이유가 두 가지다.
 *
 *   ① 보안 — 이 값들은 결국 브라우저에서 SVG 속성이 된다. `url(#x)` 나
 *      `image-set(...)` 같은 값이 들어가면 우리가 의도하지 않은 참조가 생긴다.
 *      (렌더러가 네트워크를 못 쓰게 막아두긴 했지만, 입력 단계에서 한 번 더 좁힌다.)
 *   ② 일관성 — 파스텔 배경 + 진한 테두리 조합을 매번 모델이 고르면 그림마다
 *      톤이 달라진다. 이름으로만 고르게 해서 어느 글에 넣어도 같은 인상이 되게 한다.
 */

/** 그룹 박스용 — 옅은 배경 + 같은 계열의 진한 테두리. */
export interface Tone {
	readonly fill: string;
	readonly stroke: string;
	/** 이 톤을 액센트(배지·선)로 쓸 때의 진한 색 */
	readonly solid: string;
}

export const TONES: Record<string, Tone> = {
	slate: { fill: '#f8fafc', stroke: '#94a3b8', solid: '#475569' },
	gray: { fill: '#f9fafb', stroke: '#9ca3af', solid: '#4b5563' },
	blue: { fill: '#eff6ff', stroke: '#3b82f6', solid: '#2563eb' },
	green: { fill: '#f0fdf4', stroke: '#22c55e', solid: '#16a34a' },
	amber: { fill: '#fff7ed', stroke: '#f59e0b', solid: '#d97706' },
	yellow: { fill: '#fefce8', stroke: '#ca8a04', solid: '#a16207' },
	purple: { fill: '#faf5ff', stroke: '#a855f7', solid: '#7e5bd0' },
	teal: { fill: '#f0fdfa', stroke: '#14b8a6', solid: '#0e7490' },
	rose: { fill: '#fff1f2', stroke: '#f43f5e', solid: '#e11d48' },
	indigo: { fill: '#eef2ff', stroke: '#6366f1', solid: '#4f46e5' },
};

export const TONE_NAMES = Object.keys(TONES) as ReadonlyArray<string>;

export function tone(name: string | undefined, fallback = 'gray'): Tone {
	return TONES[name ?? fallback] ?? TONES[fallback] ?? {
		fill: '#f9fafb',
		stroke: '#9ca3af',
		solid: '#4b5563',
	};
}

/**
 * 직접 지정한 색은 `#rgb` / `#rrggbb` 만 받는다.
 * 함수 표기(`url(...)`, `var(...)`)와 상대 URL 을 원천 차단하기 위해서다.
 */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string): boolean {
	return HEX.test(value);
}

/** 평면(흐름 종류) 기본값 — 요청/외부/데이터/모니터링. */
export interface Plane {
	readonly key: string;
	readonly name: string;
	readonly color: string;
	readonly dash?: string | undefined;
}

export const DEFAULT_PLANES: readonly Plane[] = [
	{ key: 'r', name: '요청', color: '#64748b' },
	{ key: 'e', name: '외부 호출', color: '#7e5bd0' },
	{ key: 'd', name: '데이터', color: '#d97706' },
	{ key: 'm', name: '관측', color: '#0e7490', dash: '6 4' },
];
