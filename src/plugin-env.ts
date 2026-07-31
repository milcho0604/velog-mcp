/**
 * 플러그인으로 설치됐을 때 오는 환경변수를 정리한다.
 *
 * ★★ 실측이 내 예상을 뒤집었다 — 그 기록이 이 파일의 핵심이다
 *
 *   처음엔 "치환이 실패하면 `${user_config.x}` 가 **글자 그대로** 남는다"고 보고
 *   그걸 막으려 했다. 근거는 Claude Code 2.1.220 실행 파일 안의 이 검사였다:
 *
 *       p = l.includes("${user_config.") ? "user_config_missing" : "url_invalid"
 *
 *   그럴듯했지만 **틀렸다.** 탐침 플러그인을 만들어 실제로 재보니
 *   (`claude --plugin-dir`, userConfig 를 아무것도 안 채운 상태) 이렇게 나왔다:
 *
 *   | `.mcp.json` 의 env 값                  | MCP 서버가 실제로 받는 것 |
 *   | -------------------------------------- | ------------------------- |
 *   | `${user_config.문자열}` (값 없음)      | `""` — 키는 존재한다      |
 *   | `${user_config.불린}` (default: false) | `"false"`                 |
 *   | `${user_config.불린}` (default 없음)   | `""`                      |
 *   | `prefix-${user_config.x}-suffix`       | `prefix--suffix`          |
 *   | **선언하지 않은 키를 참조**            | **서버가 기동하지 않는다** |
 *
 *   위의 `includes` 검사는 **URL 형태 서버 경로에만** 있다. stdio 서버의 env 는
 *   빈 문자열로 치환된다. 즉 내가 막으려던 사고는 이 경로에서 일어나지 않는다.
 *
 *   마지막 줄이 제일 중요하다 — 오타 하나로 서버가 **조용히** 안 뜬다.
 *   그건 코드로는 못 막고 배포물 정합성으로 막는다(테스트 P6).
 *
 * ★ 그래서 이 파일이 실제로 하는 일
 *
 *   **"빈 값"을 "없음"으로 굳힌다.** 지금은 소비 지점 셋이 각자 falsy 검사로
 *   우연히 맞게 동작한다 — `auth.ts` 의 `|| undefined`, `chrome.ts` 의 `if (override)`,
 *   `capabilities.ts` 의 TRUTHY 집합. 셋 다 맞지만 셋 다 **따로** 맞는다.
 *   그중 하나만 나중에 `?? undefined` 로 바뀌어도 빈 문자열이 토큰 행세를 한다.
 *   한 곳에서 지워 두면 그 종류의 회귀가 아예 성립하지 않는다.
 *
 *   자리표시자 검사도 남긴다. 관찰한 건 버전 하나(2.1.220)의 동작이고, 문서에
 *   보장된 계약이 아니다. 비용은 정규식 하나다.
 *
 * ★ 조용히 지우지 않는다 — 다만 시끄럽지도 않게
 *   빈 값 대부분은 정상이다. 플러그인은 설정 네 개를 **항상** 넘기므로, 토큰만
 *   넣은 사용자에게도 나머지 셋이 빈 값으로 온다. 그걸 매번 경고하면 경고를
 *   읽지 않게 된다. 그래서 말하는 건 두 경우뿐이다:
 *     - 토큰이 **비어서** 왔다 → 읽기 전용이 된 이유를 짚어준다
 *     - 자리표시자가 살아서 왔다 → 관찰된 적 없는 일이다. 크게 알린다.
 */

/** 치환되지 않고 남은 플러그인 설정 자리표시자. 실측에서는 관찰되지 않았다. */
const PLACEHOLDER = /\$\{user_config\.[^}]*\}/;

/** 우리가 소비하는 환경변수의 이름 공간. 남의 변수는 건드리지 않는다. */
const OURS = /^VELOG_/;

/** 토큰 자리. 이게 비어서 오면 사용자가 놀랄 결과(읽기 전용)가 된다. */
const TOKEN_KEYS = ['VELOG_ACCESS_TOKEN', 'VELOG_REFRESH_TOKEN'];

export interface EnvAnomalies {
	/** 값이 비어서 지운 것. 대부분 정상이다. */
	readonly blanked: readonly string[];
	/** 자리표시자가 글자로 남아서 지운 것. 나오면 안 되는 것이다. */
	readonly literal: readonly string[];
}

export function looksUnsubstituted(value: string | undefined): boolean {
	return typeof value === 'string' && PLACEHOLDER.test(value);
}

export function isBlank(value: string | undefined): boolean {
	return typeof value === 'string' && value.trim() === '';
}

/**
 * `VELOG_*` 중 비었거나 치환에 실패한 것을 지우고, 무엇을 왜 지웠는지 돌려준다.
 *
 * 값을 고쳐 쓰지 않고 **지운다**. 우리 코드는 전부 '없음'을 정상 상태로
 * 다루도록 이미 만들어져 있다(무인증 읽기 전용, 크롬 자동 탐색, 게이트 꺼짐).
 */
export function normalizePluginEnv(env: NodeJS.ProcessEnv): EnvAnomalies {
	const blanked: string[] = [];
	const literal: string[] = [];

	for (const key of Object.keys(env)) {
		if (!OURS.test(key)) continue;

		const value = env[key];
		if (looksUnsubstituted(value)) literal.push(key);
		else if (isBlank(value)) blanked.push(key);
		else continue;

		// `env[key] = undefined` 는 안 된다 — process.env 는 값을 문자열로 강제해서
		// 문자열 'undefined' 가 들어간다(실측). 키 자체를 없애야 한다.
		Reflect.deleteProperty(env, key);
	}

	return { blanked: blanked.sort(), literal: literal.sort() };
}

/**
 * 기동 로그에 실을 한 줄. 말할 게 없으면 빈 문자열이다.
 *
 * 우선순위가 있다 — 자리표시자가 살아 온 건 설정 실수가 아니라 **우리가 모르는
 * 동작**이므로 먼저, 크게 알린다.
 */
export function describeAnomalies(anomalies: EnvAnomalies): string {
	const out: string[] = [];

	if (anomalies.literal.length > 0) {
		out.push(
			`⚠️ 설정값이 치환되지 않고 글자 그대로 왔습니다: ${anomalies.literal.join(', ')}\n` +
				'   이건 예상된 동작이 아닙니다. 무시하고 진행하지만 값은 비어 있는 것으로 다룹니다.\n',
		);
	}

	const missingToken = anomalies.blanked.filter((key) => TOKEN_KEYS.includes(key));
	if (missingToken.length > 0) {
		out.push(
			`토큰이 비어 있습니다(${missingToken.join(', ')}) — 읽기 전용으로 돕니다.\n` +
				'   플러그인으로 설치했다면 `/plugin manage`, 직접 설정했다면 MCP 설정의 env 를 보세요.\n',
		);
	}

	return out.join('');
}
