import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, toUrlSlug, MAX_SLUG_LENGTH } from '../slug.ts';

describe('slugify', () => {
	test('한글을 그대로 둔다 — 벨로그가 한글 슬러그를 허용한다', () => {
		// 실제 사례: https://velog.io/@witwint/프로메테우스
		assert.equal(slugify('프로메테우스'), '프로메테우스');
	});

	test('공백을 하이픈으로 바꾸고 소문자로 만든다', () => {
		assert.equal(slugify('Hello World Post'), 'hello-world-post');
	});

	test('URL 구분자를 하이픈으로 바꾼다', () => {
		assert.equal(slugify('a/b?c#d&e'), 'a-b-c-d-e');
	});

	test('구두점을 제거한다', () => {
		assert.equal(slugify('제목입니다!!! 정말?'), '제목입니다-정말');
	});

	test('하이픈이 연속되거나 양 끝에 남지 않는다', () => {
		assert.equal(slugify('  --- 제목 ---  '), '제목');
		assert.equal(slugify('a   ///   b'), 'a-b');
	});

	test('한글과 영문이 섞여도 유지된다', () => {
		assert.equal(slugify('Node 24 로 MCP 서버 만들기'), 'node-24-로-mcp-서버-만들기');
	});

	test('기호만 있는 제목도 빈 슬러그를 내지 않는다', () => {
		// 빈 url_slug 를 보내면 벨로그가 거부한다.
		assert.equal(slugify('!!!'), 'untitled');
		assert.equal(slugify('   '), 'untitled');
	});
});

describe('toUrlSlug', () => {
	test('사용자가 준 값을 우선한다', () => {
		assert.equal(toUrlSlug('원래 제목', 'my-custom-slug'), 'my-custom-slug');
	});

	test('준 값도 정규화를 거친다', () => {
		assert.equal(toUrlSlug('제목', 'My Custom Slug!'), 'my-custom-slug');
	});

	test('빈 문자열이나 공백만 주면 제목에서 만든다', () => {
		assert.equal(toUrlSlug('원래 제목', '   '), '원래-제목');
		assert.equal(toUrlSlug('원래 제목', ''), '원래-제목');
	});

	test('상한을 넘으면 자르되 하이픈으로 끝나지 않는다', () => {
		const long = `${'가'.repeat(200)} 끝`;
		const slug = toUrlSlug(long);
		assert.ok(slug.length <= MAX_SLUG_LENGTH);
		assert.ok(!slug.endsWith('-'), '잘린 자리에 하이픈이 남았다');
	});
});
