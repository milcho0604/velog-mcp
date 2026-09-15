#!/usr/bin/env node
/**
 * 진단 기준선(schema/baseline.json)을 실측해서 만든다.
 *
 * ★★ 왜 스크립트가 필요한가 — 한때 이 파일을 손으로 만들었다. 그랬더니 비교 코드가
 *   기대하는 `shape`(래퍼 모양)가 **188개 필드 전부에 없었다.** 즉 `[Post!]!` 와
 *   `[Post]!` 를 가르려고 만든 비교가 발행본에서는 한 번도 돌지 않았다(코덱스 9차).
 *   만드는 쪽과 읽는 쪽이 **같은 코드**(unwrapArg / INTROSPECTION)를 쓰게 해서
 *   두 번 다시 어긋날 수 없게 한다.
 *
 *   npm run schema:baseline            # schema/baseline.json 을 덮어쓴다
 *   npm run schema:baseline -- --check # 쓰지 않고 «지금 파일이 맞는지» 만 본다
 */

import { writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	INTROSPECTION,
	MAX_WRAPPER_DEPTH,
	unwrapArg,
	loadBaseline,
	type Baseline,
	type BaselineArg,
	type BaselineField,
} from '../src/drift.ts';

const ENDPOINT = 'https://v3.velog.io/graphql';
const OUT = new URL('../schema/baseline.json', import.meta.url);

interface LiveField {
	name: string;
	isDeprecated?: boolean;
	type?: unknown;
	args?: Array<{ name: string; defaultValue?: string | null; type?: unknown }>;
}

/**
 * ★ 출력을 **정렬**한다. 벨로그가 돌려주는 순서는 보장이 없어서, 순서를 그대로
 *   적으면 내용이 같은데도 파일이 달라져 `--check` 가 거짓 경보를 낸다. 비교 코드는
 *   순서를 보지 않으므로 정렬해도 판정은 그대로다.
 */
function sortedKeys<T>(obj: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function argsOf(fields: LiveField[]): Record<string, BaselineArg[]> {
	const out: Record<string, BaselineArg[]> = {};
	for (const f of fields) {
		// ⚠️ `args` 가 «없는» 것은 «빈 목록» 이 아니다. 잘린 응답을 빈 목록으로 저장하면
		//   기준선이 «이 필드는 인자가 없다» 고 거짓말한다(코덱스 12차).
		if (!Array.isArray(f.args)) {
			throw new Error(`${f.name} 의 인자 목록을 받지 못했습니다 — 응답이 잘린 것으로 보입니다.`);
		}
		// 순서는 서버가 보장하지 않는다. 이름으로 정렬해 파일이 흔들리지 않게 한다.
		out[f.name] = [...f.args]
			.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
			.map((a) => {
			const t = unwrapArg(a.type);
			if (t.truncated) throw new Error(`래퍼가 조회 깊이(${MAX_WRAPPER_DEPTH})보다 깊습니다: ${f.name}.${a.name}`);
			return {
				name: a.name,
				required: t.nonNull && (a.defaultValue === null || a.defaultValue === undefined),
				hasDefault: a.defaultValue !== null && a.defaultValue !== undefined,
				type: t.name,
				list: t.list,
				shape: t.shape,
			};
		});
	}
	return sortedKeys(out);
}

async function main(): Promise<void> {
	const response = await fetch(ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query: INTROSPECTION }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} — introspection 이 막혔을 수 있습니다.`);
	const payload = (await response.json()) as {
		data?: {
			__schema?: {
				queryType?: { fields?: LiveField[] };
				mutationType?: { fields?: LiveField[] };
				types?: Array<{ name: string; fields?: LiveField[] | null }>;
			};
		};
		errors?: unknown[];
	};
	if (Array.isArray(payload.errors) && payload.errors.length) {
		throw new Error(`introspection 오류: ${JSON.stringify(payload.errors).slice(0, 300)}`);
	}
	const schema = payload.data?.__schema;
	const queryFields = schema?.queryType?.fields ?? [];
	const mutationFields = schema?.mutationType?.fields ?? [];
	const liveTypes = schema?.types ?? [];
	if (!queryFields.length || !mutationFields.length || !liveTypes.length) {
		throw new Error('스키마를 충분히 읽지 못했습니다.');
	}

	// ★ 기준선에 넣는 것은 «필드를 가진 타입» 이다. 입력 타입(fields 가 null)과
	//   introspection 메타타입(`__`)은 뺀다 — 이 서버가 고르는 자리가 아니다.
	const types: Record<string, Record<string, BaselineField>> = {};
	for (const t of liveTypes) {
		// 입력 타입(fields 가 null)과 introspection 메타타입은 건너뛴다.
		if (!t?.name || t.name.startsWith('__') || t.fields === null || t.fields === undefined) continue;
		// ⚠️ «필드가 있어야 할 타입인데 빈 배열» 은 잘린 응답이다. 조용히 건너뛰면
		//   기준선에서 그 타입이 통째로 빠진다(코덱스 12차).
		if (!Array.isArray(t.fields) || t.fields.length === 0) {
			throw new Error(`${t.name} 의 필드 목록이 비어 있습니다 — 응답이 잘린 것으로 보입니다.`);
		}
		const fields: Record<string, BaselineField> = {};
		for (const f of t.fields) {
			const u = unwrapArg(f.type);
			if (u.truncated) throw new Error(`래퍼가 조회 깊이(${MAX_WRAPPER_DEPTH})보다 깊습니다: ${t.name}.${f.name}`);
			fields[f.name] = {
				type: u.name,
				nonNull: u.nonNull,
				list: u.list,
				shape: u.shape,
				deprecated: f.isDeprecated === true,
			};
		}
		types[t.name] = sortedKeys(fields);
	}

	const baseline: Baseline = {
		capturedAt: new Date().toISOString().slice(0, 10),
		endpoint: ENDPOINT,
		query: queryFields.map((f) => f.name).sort(),
		mutation: mutationFields.map((f) => f.name).sort(),
		queryArgs: argsOf(queryFields),
		mutationArgs: argsOf(mutationFields),
		types: sortedKeys(types),
	};

	if (Object.keys(types).length === 0) {
		throw new Error('필드를 가진 타입을 하나도 읽지 못했습니다 — 응답이 잘린 것으로 보입니다.');
	}

	const text = `${JSON.stringify(baseline, null, '\t')}\n`;

	// ★★ **만든 것을 런타임의 눈으로 다시 읽는다.** 생성기가 통과시켜도 `loadBaseline`
	//   이 거부하면 그 파일은 쓸모가 없다 — 설치본에서 진단이 꺼진다. 만드는 쪽과 읽는
	//   쪽이 갈라지는 것을 여기서 막는다(코덱스 12차: `shape:"String!!"` 이 그랬다).
	// ⚠️ 검사용 파일을 `schema/` 에 두면 안 된다. `files` 가 `schema` 를 통째로 싣기 때문에
	//   **발행물에 섞일** 수 있고, 두 번 동시에 돌리면 서로의 파일을 지운다(코덱스 13차).
	//   저장소 밖에, 실행마다 다른 이름으로 만든다.
	const probeDir = await mkdtemp(join(tmpdir(), 'velog-baseline-'));
	const probe = pathToFileURL(join(probeDir, 'baseline.json'));
	let selfCheck;
	try {
		await writeFile(probe, text, 'utf8');
		selfCheck = loadBaseline(probe);
	} finally {
		await rm(probeDir, { recursive: true, force: true });
	}
	if (!selfCheck.ok) {
		throw new Error(`만든 기준선을 런타임이 거부합니다: ${selfCheck.reason}`);
	}

	if (process.argv.includes('--check')) {
		// ⚠️ 먼저 «지금 파일을 런타임이 읽을 수 있는가» 를 본다. `capturedAt: null` 같은
		//   파일이 내용만 같으면 «같습니다» 로 통과했다(코덱스 12차). 런타임이 못 읽는
		//   파일은 내용이 같아도 갱신해야 한다.
		const currentLoad = loadBaseline(OUT);
		if (!currentLoad.ok) {
			process.stderr.write(`⚠️ 지금 기준선을 런타임이 읽지 못합니다 — ${currentLoad.reason}\n`);
			process.stderr.write('   `npm run schema:baseline` 으로 다시 만드세요.\n');
			process.exitCode = 1;
			return;
		}
		const current = JSON.parse(await readFile(OUT, 'utf8')) as Baseline;
		// ⚠️ 문자열을 그대로 대면 **키 순서만 달라도** 「바뀌었다」가 된다. 내용이 같은
		//   파일에 갱신하라고 하면 아무도 안 믿는다(코덱스 10차). 재귀로 정규화해 견준다.
		const normalize = (v: unknown): unknown => {
			if (Array.isArray(v)) {
				const items = v.map(normalize);
				// 인자 배열은 이름 기준, 이름 목록은 값 기준으로 정렬한다.
				return items
					.map((x) => [JSON.stringify(x), x] as const)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([, x]) => x);
			}
			if (v && typeof v === 'object') {
				return Object.fromEntries(
					Object.entries(v as Record<string, unknown>)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([k, x]) => [k, normalize(x)]),
				);
			}
			return v;
		};
		const drop = (b: Baseline) => JSON.stringify(normalize({ ...b, capturedAt: '' }));
		if (drop(current) === drop(baseline)) {
			process.stdout.write('✅ 기준선이 지금 벨로그 스키마와 같습니다.\n');
			return;
		}
		process.stderr.write('⚠️ 기준선이 지금 스키마와 다릅니다. `npm run schema:baseline` 으로 갱신하세요.\n');
		process.exitCode = 1;
		return;
	}

	await writeFile(OUT, text, 'utf8');
	process.stdout.write(
		`schema/baseline.json 갱신 — Query ${baseline.query.length}개, ` +
			`Mutation ${baseline.mutation.length}개, 타입 ${Object.keys(types).length}개\n`,
	);
}

await main();
