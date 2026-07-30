/**
 * 서버 주도 토큰 갱신.
 *
 * 벨로그 공식 소스(apps/server/src/common/plugins/global/authPlugin.mts)에서
 * 확인한 동작:
 *   - access_token 수명이 30분 미만이면 refresh_token 으로 재발급
 *   - access_token 이 없거나 깨져도 refresh_token 이 있으면 복구
 *   - 새 토큰은 응답 Set-Cookie 로 온다
 * 이걸 버리면 1시간마다 세션이 죽는다.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readAuthFromEnv, parseSetCookie, TokenStore, buildCookieHeader } from '../auth.ts';
import { VelogClient } from '../client.ts';

const A = 'access-aaaaaaaaaaaaaaaaaaaa';
const R = 'refresh-rrrrrrrrrrrrrrrrrrrr';

describe('refresh_token 만 있어도 인증을 시도한다', () => {
	test('refresh 만 주면 authenticated 다', () => {
		const state = readAuthFromEnv({ VELOG_REFRESH_TOKEN: R });
		assert.equal(state.kind, 'authenticated');
		assert.equal(
			state.kind === 'authenticated' ? state.credentials.accessToken : 'x',
			undefined,
		);
	});

	test('access 만 줘도 authenticated 다', () => {
		assert.equal(readAuthFromEnv({ VELOG_ACCESS_TOKEN: A }).kind, 'authenticated');
	});

	test('둘 다 없어야 anonymous 다', () => {
		assert.equal(readAuthFromEnv({}).kind, 'anonymous');
		assert.equal(readAuthFromEnv({ VELOG_ACCESS_TOKEN: '  ' }).kind, 'anonymous');
	});

	test('없는 토큰은 쿠키 헤더에 싣지 않는다', () => {
		assert.equal(
			buildCookieHeader({ accessToken: undefined, refreshToken: R }),
			`refresh_token=${R}`,
		);
		assert.equal(
			buildCookieHeader({ accessToken: A, refreshToken: undefined }),
			`access_token=${A}`,
		);
	});
});

describe('parseSetCookie', () => {
	test('두 토큰을 모두 뽑는다', () => {
		const got = parseSetCookie(
			`access_token=${A}; Path=/; HttpOnly, refresh_token=${R}; Path=/; HttpOnly`,
		);
		assert.deepEqual(got, { accessToken: A, refreshToken: R });
	});

	test('access 만 갱신된 경우 refresh 는 건드리지 않는다', () => {
		assert.deepEqual(parseSetCookie(`access_token=${A}; Path=/`), { accessToken: A });
	});

	test('빈 값(로그아웃용 삭제)은 무시한다 — 멀쩡한 토큰을 지우면 안 된다', () => {
		assert.deepEqual(parseSetCookie('access_token=; Max-Age=0'), {});
	});

	test('헤더가 없으면 빈 객체다', () => {
		assert.deepEqual(parseSetCookie(null), {});
	});

	test('무관한 쿠키는 무시한다', () => {
		assert.deepEqual(parseSetCookie('theme=dark; Path=/'), {});
	});
});

describe('TokenStore', () => {
	test('갱신하면 새 토큰을 쓴다', () => {
		const store = new TokenStore({
			kind: 'authenticated',
			credentials: { accessToken: 'old-token-aaaa', refreshToken: R },
		});
		assert.equal(store.update({ accessToken: A }), true);
		const s = store.state;
		assert.equal(s.kind === 'authenticated' ? s.credentials.accessToken : '', A);
		// refresh 는 안 왔으므로 유지돼야 한다
		assert.equal(s.kind === 'authenticated' ? s.credentials.refreshToken : '', R);
	});

	test('같은 값이면 갱신했다고 하지 않는다', () => {
		const store = new TokenStore({
			kind: 'authenticated',
			credentials: { accessToken: A, refreshToken: R },
		});
		assert.equal(store.update({ accessToken: A, refreshToken: R }), false);
	});

	test('anonymous 는 갱신되지 않는다', () => {
		const store = new TokenStore({ kind: 'anonymous' });
		assert.equal(store.update({ accessToken: A }), false);
		assert.equal(store.isAuthenticated, false);
	});

	test('★ 갱신 전 토큰도 계속 마스킹된다 — 옛 토큰이 로그에 남으면 안 된다', () => {
		const store = new TokenStore({
			kind: 'authenticated',
			credentials: { accessToken: 'old-token-aaaa', refreshToken: undefined },
		});
		store.update({ accessToken: A });
		const masked = store.mask(`old=old-token-aaaa new=${A}`);
		assert.ok(!masked.includes('old-token-aaaa'), '옛 토큰이 남았다');
		assert.ok(!masked.includes(A), '새 토큰이 남았다');
	});
});

describe('클라이언트가 Set-Cookie 를 반영한다', () => {
	function clientWith(setCookie: string | null) {
		const sentCookies: string[] = [];
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'old-token-aaaa', refreshToken: R },
			},
			sleepImpl: async () => {},
			fetchImpl: (async (_u: string, init: { headers: Record<string, string> }) => {
				sentCookies.push(init.headers['Cookie'] ?? '');
				const headers: Record<string, string> = { 'Content-Type': 'application/json' };
				if (setCookie) headers['Set-Cookie'] = setCookie;
				return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200, headers });
			}) as unknown as typeof fetch,
		});
		return { client, sentCookies };
	}

	test('갱신된 토큰이 다음 요청에 실린다', async () => {
		const { client, sentCookies } = clientWith(`access_token=${A}; Path=/; HttpOnly`);
		await client.request('{ ok }');
		await client.request('{ ok }');
		assert.ok(sentCookies[0]?.includes('old-token-aaaa'), '첫 요청은 기존 토큰');
		assert.ok(sentCookies[1]?.includes(A), '두번째 요청에 새 토큰이 안 실렸다');
	});

	test('Set-Cookie 가 없으면 기존 토큰을 유지한다', async () => {
		const { client, sentCookies } = clientWith(null);
		await client.request('{ ok }');
		await client.request('{ ok }');
		assert.ok(sentCookies[1]?.includes('old-token-aaaa'));
	});

	test('갱신 후에도 새 토큰이 오류 메시지로 새지 않는다', async () => {
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'old-token-aaaa', refreshToken: R },
			},
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				return new Response(JSON.stringify({ errors: [{ message: `leak ${A}` }] }), {
					status: 200,
					headers: {
						'Content-Type': 'application/json',
						'Set-Cookie': `access_token=${A}; Path=/`,
					},
				});
			}) as unknown as typeof fetch,
		});
		await assert.rejects(
			() => client.request('{ x }'),
			(e: Error) => {
				assert.ok(!e.message.includes(A), '갱신된 토큰이 에러로 샜다');
				return true;
			},
		);
	});
});
