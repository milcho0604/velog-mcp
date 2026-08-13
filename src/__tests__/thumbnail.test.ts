/**
 * 썸네일 자동 채움 · 시리즈 힌트.
 *
 * ★★ 이 파일의 규율: **각 단언은 기능을 끄면 반드시 깨져야 한다.**
 *   "통과했다"는 아무것도 증명하지 않는다 — 대조군을 같이 둔다.
 *   (거짓 초록 11패턴은 프로젝트 회고 참고)
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	extractImageUrls,
	chooseThumbnail,
	chooseThumbnailForUpdate,
	describeThumbnail,
} from '../thumbnail.ts';
import { seriesHintSafely, describeSeriesOptions } from '../series.ts';
import { VelogClient } from '../client.ts';

const IMG = 'https://velog.velcdn.com/images/me/post/aaa/image.png';
const IMG2 = 'https://velog.velcdn.com/images/me/post/bbb/image.png';

describe('본문에서 이미지 뽑기', () => {
	test('마크다운 이미지', () => {
		assert.deepEqual(extractImageUrls(`글\n\n![그림](${IMG})\n\n끝`), [IMG]);
	});

	test('HTML img 태그도 본다', () => {
		assert.deepEqual(extractImageUrls(`<img src="${IMG}" alt="x">`), [IMG]);
	});

	test('제목 붙은 형태에서 URL 만 뽑는다', () => {
		assert.deepEqual(extractImageUrls(`![a](${IMG} "제목")`), [IMG]);
	});

	test('등장 순서를 지키고 중복은 한 번만', () => {
		assert.deepEqual(extractImageUrls(`![a](${IMG})\n![b](${IMG2})\n![c](${IMG})`), [
			IMG,
			IMG2,
		]);
	});

	/**
	 * ★★ 제일 중요한 항목. 예제로 적어둔 마크다운이 썸네일이 되면 안 된다.
	 *   이 글(velog-mcp 소개글)처럼 코드블록에 이미지 문법을 싣는 경우가 실제로 있다.
	 */
	test('코드블록 안의 이미지는 무시한다', () => {
		const body = ['설명', '', '```md', `![예시](${IMG})`, '```', '', `![진짜](${IMG2})`].join(
			'\n',
		);
		assert.deepEqual(extractImageUrls(body), [IMG2], '코드블록 예제가 썸네일로 새어나왔다');
	});

	test('인라인 코드 안도 무시한다', () => {
		assert.deepEqual(extractImageUrls(`\`![예시](${IMG})\` 이렇게 씁니다`), []);
	});

	test('대조군 — 코드블록 밖이면 당연히 잡힌다', () => {
		assert.deepEqual(
			extractImageUrls(`![진짜](${IMG})`),
			[IMG],
			'계측 자체가 죽었다면 위 두 테스트는 의미가 없다',
		);
	});

	/**
	 * ★★ 괄호가 든 URL 은 `)` 에서 끊긴다. 잘린 값도 https 라 URL 검사를 통과해서
	 *   **깨진 주소가 조용히 썸네일이 되는** 게 진짜 위험이다. 버리는 쪽이 맞다.
	 */
	test('괄호 때문에 잘린 URL 은 버린다', () => {
		assert.deepEqual(
			extractImageUrls('![a](https://a.io/x(1).png)'),
			[],
			'잘린 URL 이 썸네일 후보로 새어나왔다',
		);
	});

	test('alt 안의 대괄호 한 겹은 허용한다', () => {
		assert.deepEqual(extractImageUrls(`![도표[1]](${IMG})`), [IMG]);
	});

	test('http(s) 아닌 것은 거른다 — javascript: 등', () => {
		assert.deepEqual(extractImageUrls('![x](javascript:alert(1))'), []);
		assert.deepEqual(extractImageUrls('![x](/local/relative.png)'), []);
	});
});

describe('무엇을 썸네일로 쓸지', () => {
	test('명시했으면 그대로 — 본문 이미지가 있어도 덮지 않는다', () => {
		const c = chooseThumbnail(IMG2, `![a](${IMG})`);
		assert.equal(c.url, IMG2);
		assert.equal(c.reason, 'explicit');
	});

	test('미지정이면 본문 첫 이미지', () => {
		const c = chooseThumbnail(undefined, `![a](${IMG})\n![b](${IMG2})`);
		assert.equal(c.url, IMG);
		assert.equal(c.reason, 'auto');
	});

	/** ★ 남들도 쓰는 도구다. "일부러 비워 둔다"를 표현할 방법이 반드시 있어야 한다. */
	test('null 을 주면 자동 채움을 끈다', () => {
		const c = chooseThumbnail(null, `![a](${IMG})`);
		assert.equal(c.url, undefined, 'null 을 줬는데 자동으로 채웠다 — 의도를 덮었다');
		assert.equal(c.reason, 'opted-out');
	});

	test('빈 문자열도 끄기로 읽는다', () => {
		assert.equal(chooseThumbnail('', `![a](${IMG})`).url, undefined);
	});

	test('본문에 이미지가 없으면 아무것도 안 넣는다', () => {
		const c = chooseThumbnail(undefined, '그림 없는 글');
		assert.equal(c.url, undefined);
		assert.equal(c.reason, 'none');
	});
});

describe('병합 수정에서는 기존 썸네일이 우선', () => {
	/**
	 * ★★ 이게 없으면 제목만 고치려던 사람이 목록 카드가 바뀌는 걸 당한다.
	 *   본문 첫 이미지가 기존 썸네일을 갈아치우면 안 된다.
	 */
	test('기존 썸네일이 있으면 본문 이미지로 덮지 않는다', () => {
		const c = chooseThumbnailForUpdate(undefined, IMG2, `![a](${IMG})`);
		assert.equal(c.url, IMG2, '기존 썸네일이 본문 첫 이미지에 덮였다');
	});

	/**
	 * ★★ 코덱스 교차검증에서 뒤집힌 계약. 예전엔 기존이 비었으면 본문 첫 이미지로
	 *   채웠는데, 이 도구는 "생략한 필드는 유지된다"고 약속해 뒀다. 제목만 고치는
	 *   호출이 **일부러 비워 둔 썸네일을 채우면** 그 약속이 깨진다.
	 */
	test('기존이 비어 있어도 생략하면 채우지 않는다', () => {
		const c = chooseThumbnailForUpdate(undefined, null, `![a](${IMG})`);
		assert.equal(c.url, undefined, '비워 둔 썸네일이 본문 이미지로 채워졌다');
	});

	test('명시하면 기존을 바꾼다', () => {
		assert.equal(chooseThumbnailForUpdate(IMG, IMG2, '').url, IMG);
	});

	/** ⚠️ null 은 "채우지 마라"이지 "지워라"가 아니다. 지우기는 파괴적이다. */
	test('null 을 줘도 기존 썸네일을 지우지 않는다', () => {
		assert.equal(chooseThumbnailForUpdate(null, IMG2, `![a](${IMG})`).url, IMG2);
	});
});

describe('결정을 조용히 하지 않는다', () => {
	test('자동으로 넣었으면 결과에 말한다', () => {
		const note = describeThumbnail(chooseThumbnail(undefined, `![a](${IMG})`));
		assert.ok(note.includes(IMG), '무엇을 넣었는지 안 알려준다');
		assert.match(note, /자동 설정/);
	});

	test('후보가 여럿이면 나머지도 보여준다', () => {
		const note = describeThumbnail(chooseThumbnail(undefined, `![a](${IMG})\n![b](${IMG2})`));
		assert.ok(note.includes(IMG2), '다른 후보를 고를 방법을 안 알려준다');
	});

	test('명시했으면 잔소리하지 않는다', () => {
		assert.equal(describeThumbnail(chooseThumbnail(IMG, `![a](${IMG2})`)), '');
	});

	test('끄겠다고 했으면 잔소리하지 않는다', () => {
		assert.equal(describeThumbnail(chooseThumbnail(null, `![a](${IMG})`)), '');
	});
});

/** seriesList 만 답하는 가짜 서버. */
function seriesServer(rows: Array<{ id: string; name: string; posts_count: number }>) {
	let calls = 0;
	const client = new VelogClient({
		auth: {
			kind: 'authenticated',
			credentials: { accessToken: 'tok12345678', refreshToken: undefined },
		},
		sleepImpl: async () => {},
		fetchImpl: (async () => {
			calls++;
			return new Response(JSON.stringify({ data: { seriesList: rows } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as unknown as typeof fetch,
	});
	return { client, calls: () => calls };
}

describe('시리즈 힌트', () => {
	test('이미 지정했으면 조회조차 하지 않는다', async () => {
		const fake = seriesServer([{ id: 's1', name: 'A', posts_count: 1 }]);
		const note = await describeSeriesOptions(fake.client, 'me', 's1');
		assert.equal(note, '');
		assert.equal(fake.calls(), 0, '필요 없는 API 호출이 나갔다');
	});

	test('안 지정했으면 고를 수 있는 목록을 준다', async () => {
		const fake = seriesServer([
			{ id: 's1', name: 'PostgreSQL', posts_count: 6 },
			{ id: 's2', name: 'docker', posts_count: 4 },
		]);
		const note = await describeSeriesOptions(fake.client, 'me', undefined);
		assert.ok(note.includes('s1') && note.includes('PostgreSQL'));
		assert.ok(note.includes('docker'));
	});

	/** ★ 만들 수 없다는 사실을 숨기지 않는다 — API 한계라 사용자가 알아야 한다. */
	test('시리즈가 하나도 없으면 "API로는 못 만든다"를 알린다', async () => {
		const fake = seriesServer([]);
		const note = await describeSeriesOptions(fake.client, 'me', undefined);
		assert.match(note, /만들 수 없/);
	});

	/**
	 * ★★ 힌트는 부가 기능이다. 이게 실패했다고 이미 끝난 저장이 실패로 보고되면
	 *   사용자는 글이 안 써진 줄 안다 — 그게 훨씬 큰 사고다.
	 */
	test('조회가 실패해도 던지지 않는다', async () => {
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				throw new Error('네트워크 끊김');
			}) as unknown as typeof fetch,
		});
		assert.equal(await seriesHintSafely(client, () => 'me', undefined), '');
	});

	/**
	 * ★★ 코덱스 [높음]의 핵심. 예전엔 username 을 **인자 위치에서** await 해서
	 *   그 조회가 실패하면 try 밖이라 그대로 터졌다 — 글은 이미 저장된 뒤인데.
	 */
	test('username 해석이 실패해도 던지지 않는다', async () => {
		const fake = seriesServer([{ id: 's1', name: 'A', posts_count: 1 }]);
		const note = await seriesHintSafely(
			fake.client,
			() => {
				throw new Error('계정 조회 실패');
			},
			undefined,
		);
		assert.equal(note, '', 'username 해석 실패가 저장된 글의 호출을 실패시킨다');
	});

	test('대조군 — 정상일 때는 실제로 내용이 나온다', async () => {
		const fake = seriesServer([{ id: 's1', name: 'A', posts_count: 1 }]);
		const note = await seriesHintSafely(fake.client, () => 'me', undefined);
		assert.notEqual(note, '', '삼키기만 하고 정상 경로가 죽었다면 위 테스트는 무의미하다');
	});

	/**
	 * ★★ 계약이 뒤집혔다 — 여기서는 **취소도 삼킨다.**
	 *   이 함수는 글이 **이미 저장된 뒤**에만 불린다. 던지면 저장이 끝난 호출이
	 *   실패로 보고되고, 사용자가 다시 부르면 글이 두 번 생긴다.
	 *   취소는 mutation 전·중에 이미 걸러진다. (코덱스 교차검증)
	 */
	test('저장 뒤 취소는 삼킨다 — 중복 생성을 막는 게 크다', async () => {
		const ac = new AbortController();
		ac.abort();
		const client = new VelogClient({
			auth: {
				kind: 'authenticated',
				credentials: { accessToken: 'tok12345678', refreshToken: undefined },
			},
			sleepImpl: async () => {},
			fetchImpl: (async () => {
				throw new Error('should not reach');
			}) as unknown as typeof fetch,
		});
		assert.equal(
			await seriesHintSafely(client, () => 'me', undefined, ac.signal),
			'',
			'저장이 끝난 뒤의 취소가 도구 호출 전체를 실패시킨다 — 재시도하면 글이 두 번 생긴다',
		);
	});
});
