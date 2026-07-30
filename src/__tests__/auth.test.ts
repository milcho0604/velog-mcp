import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
	readAuthFromEnv,
	buildCookieHeader,
	TokenStore,
	AuthRequiredError,
	type AuthState,
} from '../auth.ts';

/** 마스킹 구현은 TokenStore 하나뿐이다. 여기서도 그것을 검사한다. */
const maskWith = (state: AuthState) => (text: string) => new TokenStore(state).mask(text);

const FAKE_ACCESS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_REFRESH = 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr';

const authed: AuthState = {
	kind: 'authenticated',
	credentials: { accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH },
};

describe('readAuthFromEnv', () => {
	test('토큰이 없으면 에러가 아니라 anonymous 상태다', () => {
		// 읽기 도구는 무인증으로 동작해야 하므로 여기서 throw 하면 안 된다.
		assert.deepEqual(readAuthFromEnv({}), { kind: 'anonymous' });
	});

	test('빈 문자열·공백만 있는 값은 없는 것으로 본다', () => {
		assert.equal(readAuthFromEnv({ VELOG_ACCESS_TOKEN: '' }).kind, 'anonymous');
		assert.equal(readAuthFromEnv({ VELOG_ACCESS_TOKEN: '   ' }).kind, 'anonymous');
	});

	test('access_token 만 있어도 인증 상태다', () => {
		const state = readAuthFromEnv({ VELOG_ACCESS_TOKEN: FAKE_ACCESS });
		assert.equal(state.kind, 'authenticated');
		assert.equal(
			state.kind === 'authenticated' ? state.credentials.refreshToken : 'x',
			undefined,
		);
	});

	test('앞뒤 공백을 제거한다', () => {
		const state = readAuthFromEnv({ VELOG_ACCESS_TOKEN: `  ${FAKE_ACCESS}  ` });
		assert.equal(
			state.kind === 'authenticated' ? state.credentials.accessToken : '',
			FAKE_ACCESS,
		);
	});
});

describe('buildCookieHeader', () => {
	test('두 토큰이 다 있으면 둘 다 싣는다', () => {
		assert.equal(
			buildCookieHeader({ accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH }),
			`access_token=${FAKE_ACCESS}; refresh_token=${FAKE_REFRESH}`,
		);
	});

	test('refresh 가 없으면 access 만 싣는다', () => {
		assert.equal(
			buildCookieHeader({ accessToken: FAKE_ACCESS, refreshToken: undefined }),
			`access_token=${FAKE_ACCESS}`,
		);
	});
});

describe('마스킹 — 토큰이 사용자에게 보이는 문자열로 새지 않는다', () => {
	test('access_token 값을 가린다', () => {
		const leaked = `요청 실패: Cookie: access_token=${FAKE_ACCESS}`;
		const masked = maskWith(authed)(leaked);
		assert.ok(!masked.includes(FAKE_ACCESS), '토큰 원문이 남아있다');
		assert.ok(masked.includes('REDACTED'));
	});

	test('refresh_token 값도 가린다', () => {
		const masked = maskWith(authed)(`x ${FAKE_REFRESH} y`);
		assert.ok(!masked.includes(FAKE_REFRESH));
	});

	test('토큰 값을 모르는 상황(다른 세션의 헤더 잔재)도 패턴으로 가린다', () => {
		// 실제 값과 다른 토큰이 에러 본문에 섞여 나오는 경우.
		const masked = maskWith(authed)('access_token=SOMEOTHERVALUE123; path=/');
		assert.ok(!masked.includes('SOMEOTHERVALUE123'));
		assert.ok(masked.includes('access_token=***REDACTED***'));
	});

	test('anonymous 상태에서는 원문을 그대로 둔다', () => {
		const text = '평범한 에러 메시지';
		assert.equal(maskWith({ kind: 'anonymous' })(text), text);
	});

	test('짧은 값은 치환하지 않는다 — 본문 훼손 방지', () => {
		// 토큰이 비정상적으로 짧으면 무차별 치환이 본문을 망친다.
		const shortAuth: AuthState = {
			kind: 'authenticated',
			credentials: { accessToken: 'abc', refreshToken: undefined },
		};
		assert.equal(maskWith(shortAuth)('abcdef 라는 단어'), 'abcdef 라는 단어');
	});
});

describe('AuthRequiredError', () => {
	test('무엇을 해야 하는지 메시지에 담는다', () => {
		const err = new AuthRequiredError('velog_create_draft');
		assert.match(err.message, /velog_create_draft/);
		assert.match(err.message, /VELOG_ACCESS_TOKEN/);
		assert.equal(err.name, 'AuthRequiredError');
	});
});

describe('★ 이 모듈은 파일시스템을 건드리지 않는다 (ADR 0003)', () => {
	test('auth.ts 소스에 fs import 가 없다', async () => {
		const { readFile } = await import('node:fs/promises');
		const src = await readFile(new URL('../auth.ts', import.meta.url), 'utf8');
		assert.ok(!/from\s+['"]node:fs/.test(src), 'auth.ts 가 fs 를 import 한다');
		assert.ok(!/require\(['"]fs/.test(src));
	});
});
