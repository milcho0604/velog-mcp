#!/usr/bin/env node
/**
 * 벨로그 스키마 덤프.
 *
 * 비공식 API 라 예고 없이 바뀐다. 무언가 깨졌을 때 "어디가" 바뀌었는지
 * 찾는 것이 1차 진단 경로다. 이 스크립트가 현재 스키마를 뽑아
 * docs/api-reference.md 와 대조할 수 있게 한다.
 *
 *   npm run schema:dump              # 사람이 읽는 요약
 *   npm run schema:dump -- --json    # 원본 JSON (schema-dump/ 에 저장, gitignore 됨)
 */

import { mkdir, writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://v3.velog.io/graphql';

const INTROSPECTION = `
  query DumpSchema {
    __schema {
      queryType { fields { name args { name type { name kind ofType { name } } } } }
      mutationType { fields { name args { name type { name kind ofType { name } } } } }
    }
  }
`;

interface TypeRef {
	name?: string | null;
	kind?: string | null;
	ofType?: { name?: string | null } | null;
}
interface Field {
	name: string;
	args: Array<{ name: string; type: TypeRef }>;
}
interface Schema {
	__schema: {
		queryType: { fields: Field[] } | null;
		mutationType: { fields: Field[] } | null;
	};
}

function typeName(t: TypeRef): string {
	return t.name ?? t.ofType?.name ?? t.kind ?? '?';
}

function render(label: string, fields: Field[]): string {
	const lines = fields.map((f) => {
		const args = f.args.map((a) => `${a.name}: ${typeName(a.type)}`).join(', ');
		return `  ${f.name}(${args})`;
	});
	return `## ${label} — ${fields.length}개\n\n${lines.join('\n')}`;
}

async function main(): Promise<void> {
	const response = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: INTROSPECTION }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} — introspection 이 막혔을 수 있습니다.`);
	}

	const payload = (await response.json()) as { data?: Schema; errors?: unknown };
	if (!payload.data) {
		throw new Error(`introspection 실패: ${JSON.stringify(payload.errors)}`);
	}

	const queries = payload.data.__schema.queryType?.fields ?? [];
	const mutations = payload.data.__schema.mutationType?.fields ?? [];

	if (process.argv.includes('--json')) {
		await mkdir('schema-dump', { recursive: true });
		const path = 'schema-dump/v3.introspection.json';
		await writeFile(path, JSON.stringify(payload.data, null, 2), 'utf8');
		process.stdout.write(`${path} 에 저장했습니다.\n`);
		return;
	}

	process.stdout.write(
		[
			`# 벨로그 v3 스키마 (${ENDPOINT})`,
			'',
			render('Query', queries),
			'',
			render('Mutation', mutations),
			'',
			'docs/api-reference.md 와 대조하세요. 항목이 늘거나 줄었으면 그 문서를 갱신할 것.',
			'',
		].join('\n'),
	);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
