// @ts-check
/**
 * ESLint 설정.
 *
 * 목적은 코드를 예쁘게 만드는 게 아니라 **버그를 잡는 것**이다. 들여쓰기·따옴표
 * 같은 서식 규칙은 넣지 않았다 — 그건 이미 일관돼 있고, 굳이 강제하면 리뷰가
 * 서식 얘기로 흘러간다.
 *
 * 대신 이 레포에서 **실제로 데었던 것**을 규칙으로 세운다:
 *   - await 을 빠뜨려 검증이 통과해버리는 것 (require-await, no-floating-promises)
 *   - null 을 그냥 흘려보내는 것 (no-unnecessary-condition 은 끄되 strict 타입으로)
 *   - Node 타입 스트리핑이 못 다루는 문법 (enum·namespace·파라미터 프로퍼티)
 *   - 안 쓰는 코드가 남아 마스킹 구현이 둘이 되는 것 (no-unused-vars)
 */

import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{
		ignores: ['dist/**', 'node_modules/**', 'schema-dump/**'],
	},



	js.configs.recommended,
	...tseslint.configs.strictTypeChecked,

	{
		languageOptions: {
			parserOptions: {
				// 이 설정 파일 자체는 tsconfig 대상이 아니다. allowDefaultProject 로
				// 기본 프로젝트에 태워 타입 기반 규칙 없이도 파싱되게 한다.
				projectService: { allowDefaultProject: ['eslint.config.js'] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// ── 이 레포에서 실제로 사고를 냈던 것들 ────────────────────
			// editPost 결과를 await 없이 흘려보내면 사후검증이 무의미해진다.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/no-misused-promises': 'error',

			// 죽은 코드가 남으면 구현이 둘이 되고, 테스트가 죽은 쪽을 검사해
			// 거짓 안심을 준다 (maskSecrets 로 겪음).
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],

			// ── Node 24 타입 스트리핑 제약 (docs/architecture.md) ──────
			// 스트리핑은 '지우기만' 하므로 코드 생성이 필요한 문법은 못 쓴다.
			// 실제로 파라미터 프로퍼티가 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX 로 죽었다.
			'@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
			'no-restricted-syntax': [
				'error',
				{
					selector: 'TSEnumDeclaration',
					message: 'Node 타입 스트리핑이 enum 을 못 다룬다. 문자열 유니온을 쓸 것.',
				},
				{
					selector: 'TSModuleDeclaration[kind="namespace"]',
					message: 'Node 타입 스트리핑이 namespace 를 못 다룬다.',
				},
				{
					selector: 'Decorator',
					message: 'Node 타입 스트리핑이 데코레이터를 못 다룬다.',
				},
			],

			// ── 실용적 완화 ────────────────────────────────────────────
			// GraphQL 응답은 unknown 에서 좁혀 쓰는 게 정상이라 과하게 막지 않는다.
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			// 벨로그 응답의 nullable 필드를 ?? 로 방어하는 코드가 많은데,
			// 타입 선언이 실제와 다른 경우가 있어(updated_at 사례) 방어를 지우면 안 된다.
			'@typescript-eslint/no-unnecessary-condition': 'off',
			// 도구 설명·에러 메시지에 한국어 템플릿을 많이 쓴다.
			'@typescript-eslint/restrict-template-expressions': [
				'error',
				{ allowNumber: true, allowBoolean: true, allowNullish: true },
			],
		},
	},

	{
		// 테스트는 의도적으로 이상한 값을 넣어보는 곳이다.
		files: ['src/__tests__/**/*.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			// node:test 의 describe/test 는 프로미스를 반환하지만 러너가 대기한다.
			// 여기서 켜두면 모든 블록에 void 를 붙여야 해 읽기만 나빠진다.
			'@typescript-eslint/no-floating-promises': 'off',
			// 가짜 fetch·sleep 은 await 없이 async 여야 시그니처가 맞는다.
			'@typescript-eslint/require-await': 'off',
		},
	},
);
