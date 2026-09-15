/**
 * 스키마 자가진단 도구.
 *
 * 모델이 실패를 겪기 **전에** 스스로 물어볼 수 있는 자리다. "지금 벨로그 스키마가
 * 네가 만들어진 때와 같냐" 를 한 번에 답한다.
 *
 * 이 서버가 쓰는 벨로그 API 는 비공식이라 예고 없이 바뀐다. 그때 사람이 이슈를
 * 읽고 고치기를 기다리는 대신, 모델이 그 자리에서 알고 우회하게 만드는 것이 목적이다.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { VelogClient } from '../client.ts';

import {
	fullDiff,
	listNames,
	capNote,
	BASELINE,
	BASELINE_STATUS,
	type Baseline,
	type BaselineLoad,
} from '../drift.ts';
import { textResult } from '../format.ts';
import { READ_ONLY } from './posts.ts';

/**
 * ★★ 기준선을 **주입할 수 있어야** 이 도구의 출력이 시험 대상이 된다.
 *
 *   주입할 수 없을 때는 테스트가 렌더 규칙을 **복제**하고 소스를 정규식으로 훑는
 *   수밖에 없었다. 그러면 실제 렌더 조건을 `if (false && …)` 로 바꿔도 88/88 이
 *   초록이다(코덱스 9차 실측). 복제본을 검사하는 것은 검사가 아니다.
 *   fullDiff 가 같은 이유로 이미 주입을 받는다.
 */
export function registerDiagnoseTools(
	server: McpServer,
	client: VelogClient,
	baseline: Baseline = BASELINE,
	baselineStatus: BaselineLoad = BASELINE_STATUS,
): void {
	server.registerTool(
		'velog_diagnose',
		{
			title: '벨로그 스키마 점검',
			description:
				'지금 벨로그 GraphQL 스키마가 이 서버가 만들어질 때의 기준선과 같은지 대조한다. ' +
				'도구가 이유 없이 실패하거나 응답 모양이 이상할 때 원인을 가르는 1차 진단이다. ' +
				'벨로그는 비공식 API 라 예고 없이 바뀐다. 읽기 전용이고 인증이 필요 없다.',
			inputSchema: {},
			annotations: READ_ONLY,
		},
		async () => {
			// ★ 우리 기준선이 깨졌으면 벨로그를 묻지도 말고 우리 탓이라고 말한다.
			//   여기서 fullDiff 를 부르면 빈 기준선과 비교해 «전부 사라짐» 이 나온다.
			if (!baselineStatus.ok) {
				return textResult(
					`이 서버의 스키마 기준선을 쓸 수 없어 진단할 수 없습니다.\n\n` +
						`- 원인: ${baselineStatus.reason}\n` +
						`- 이것은 **벨로그가 아니라 velog-mcp 설치본의 문제**입니다.\n\n` +
						`다른 도구는 정상 동작합니다. 도구가 실패했다면 인증(토큰 만료), 인자값, ` +
						`벨로그 쪽 일시 장애를 보세요. 이 서버를 다시 설치하면 기준선이 복구됩니다.`,
				);
			}
			// ★ 클라이언트가 실제로 치는 곳을 본다. 기준선의 주소가 아니다.
			const report = await fullDiff(client.fetchImpl, 15_000, baseline, client.endpoint);

			if (report.error) {
				// ★ 조회 실패를 "전부 사라졌다" 로 보고하면 상대 장애를 표류로 오진한다.
				return textResult(
					`스키마를 확인하지 못했습니다: ${report.error}\n\n` +
						`벨로그가 일시적으로 응답하지 않는 것일 수 있습니다. 잠시 뒤 다시 시도하세요.\n` +
						`이 결과로 "스키마가 바뀌었다" 고 판단하면 안 됩니다.\n` +
						`빌드 기준선: ${baseline.capturedAt} 실측`,
				);
			}

			if (!report.drifted) {
				return textResult(
					`✅ 스키마가 기준선과 같습니다.\n\n` +
						`- 기준선: ${baseline.capturedAt} 실측\n` +
						`- 확인: ${report.checkedAt}\n` +
						`- Query ${baseline.query.length}개, Mutation ${baseline.mutation.length}개, 타입 ${Object.keys(baseline.types).length}개\n\n` +
						`먼저 인증(토큰 만료), 인자값, 벨로그 쪽 일시 장애를 보세요.\n\n` +
						`⚠️ 다만 이 점검은 **입력 타입(Input)의 필드까지는 보지 않습니다.** ` +
						`WritePostInput 같은 입력에 필수 필드가 새로 생겼다면 여기서는 «같다» 로 ` +
						`나오는데 실제 호출은 실패합니다. 그런 경우 오류 메시지를 그대로 보세요.`,
				);
			}

			const lines: string[] = [
				`⚠️ 스키마가 기준선과 다릅니다.`,
				``,
				`- 기준선: ${baseline.capturedAt} 실측`,
				`- 확인: ${report.checkedAt}`,
				``,
			];

			const section = (label: string, d: { added: string[]; removed: string[] }) => {
				if (!d.added.length && !d.removed.length) return;
				lines.push(`## ${label}`);
				// ★ 이름은 상대가 준 값이다. 자동 진단과 같은 규율로 식별자만, 상한을 두고 보인다.
				//   한때 여기만 빠져서 수동 진단이 975,512자를 뱉고 지시문도 그대로 실었다(코덱스 4차).
				if (d.removed.length) lines.push(`- 없어짐: ${listNames(d.removed)}`);
				if (d.added.length) lines.push(`- 새로 생김: ${listNames(d.added)}`);
				lines.push('');
			};
			section('Query', report.query);
			section('Mutation', report.mutation);

			// ★ 인자 변화는 «당장 질의를 깨뜨리는» 종류다. 안 보여주면 계산한 의미가 없다.
			if (report.argsChanged.length) {
				lines.push('## 인자');
				for (const a of report.argsChanged) {
					const parts: string[] = [];
					if (a.addedRequired.length) parts.push(`필수 인자 추가 ${listNames(a.addedRequired)}`);
					const optional = a.added.filter((n) => !a.addedRequired.includes(n));
					if (optional.length) parts.push(`선택 인자 추가 ${listNames(optional)}`);
					if (a.typeChanged.length) parts.push(`인자 타입 바뀜 ${listNames(a.typeChanged)}`);
					if (a.becameRequired.length) parts.push(`이제 필수 ${listNames(a.becameRequired)}`);
					if (a.relaxed.length) parts.push(`제약 완화(무해) ${listNames(a.relaxed)}`);
					if (a.removed.length) parts.push(`없어짐 ${listNames(a.removed)}`);
					// ⚠️ `field` 는 `Query.posts` 모양이다. 점이 없으면 listNames([''])
					//   가 불려 필드 이름 자리에 「식별자 형식이 아닌 1개는 뺐습니다」가
					//   찍힌다. 조각이 다 성한 경우에만 «타입.필드» 로 쓴다.
					const [owner, fieldName] = a.field.split('.');
					const label = owner && fieldName
						? `${listNames([owner])}.${listNames([fieldName])}`
						: listNames([a.field]);
					lines.push(`- **${label}**: ${parts.join(', ')}`);
				}
				lines.push('');
			}

			const typeNames = Object.keys(report.types);
			if (typeNames.length) {
				lines.push('## 타입 필드');
				for (const name of typeNames) {
					const t = report.types[name];
					if (!t) continue;
					const parts: string[] = [];
					if (t.removed.length) parts.push(`없어짐 ${listNames(t.removed)}`);
					if (t.added.length) parts.push(`새로 생김 ${listNames(t.added)}`);
					if (t.changed.length) parts.push(`타입 바뀜 ${listNames(t.changed)}`);
					// ★ 출력 필드가 «조여진» 것은 무해하다. 이제 항상 값이 온다는 뜻이다.
					if (t.tightened.length) parts.push(`제약 강화(무해) ${listNames(t.tightened)}`);
					if (t.deprecated.length) parts.push(`폐기 예고 ${listNames(t.deprecated)}`);
					// 변화가 없는 타입은 애초에 report 에 안 들어오지만, 빈 줄을 찍지는 않는다.
					if (!parts.length) continue;
					lines.push(`- **${listNames([name])}**: ${parts.join(', ')}`);
				}
				lines.push('');
			}

			// ★ «깨뜨리는 변화» 가 있을 때만 고치라고 한다. 안 쓰는 쿼리 하나 늘어난 것까지
			//   «서버를 고쳐야 하는 신호» 라고 하면 모델이 멀쩡한 서버를 의심한다(코덱스 4차).
			const breaking =
				report.query.removed.length > 0 ||
				report.mutation.removed.length > 0 ||
				report.argsChanged.some(
					(a) =>
						a.addedRequired.length > 0 ||
						a.removed.length > 0 ||
						a.typeChanged.length > 0 ||
						a.becameRequired.length > 0,
				) ||
				Object.values(report.types).some((t) => t.removed.length > 0 || t.changed.length > 0);

			// ★ 해당하는 안내만 보인다. 없어진 게 없는데 「없어진 필드를 쓰는 도구는 실패한다」를
			//   실으면 모델이 멀쩡한 도구를 의심한다. 코덱스 4차가 «무해한 추가» 로 보였다.
			const anyRemoved =
				report.query.removed.length > 0 ||
				report.mutation.removed.length > 0 ||
				Object.values(report.types).some((t) => t.removed.length > 0 || t.changed.length > 0);
			const anyAdded =
				report.query.added.length > 0 ||
				report.mutation.added.length > 0 ||
				Object.values(report.types).some((t) => t.added.length > 0);
			const anyArgs = report.argsChanged.some(
				(a) =>
					a.addedRequired.length > 0 ||
					a.removed.length > 0 ||
					a.typeChanged.length > 0 ||
					a.becameRequired.length > 0,
			);
			// ★ 제약이 «풀린» 것과 선택 인자 추가는 무해하다. 이걸 수정 권고에 섞으면
			//   멀쩡한 서버를 고치라고 하게 된다(코덱스 7차).
			const anyHarmless =
				report.argsChanged.some((a) => a.added.length > a.addedRequired.length || a.relaxed.length > 0) ||
				Object.values(report.types).some((t) => t.tightened.length > 0);
			const anyDeprecated = Object.values(report.types).some((t) => t.deprecated.length > 0);

			lines.push('## 이제 뭘 하면 되나', '');
			if (anyRemoved) {
				lines.push(
					'- **없어지거나 바뀐 필드**를 쓰는 도구는 실패합니다. 이 서버의 질의문은 고정이라 ' +
						'호출 쪽에서 필드를 뺄 수 없습니다. 다른 도구로 우회하거나 이 서버를 고쳐야 합니다.',
				);
			}
			if (anyAdded) {
				lines.push('- **새로 생긴 필드·쿼리**는 이 서버가 아직 안 씁니다. 당장 깨지는 것은 없습니다.');
			}
			if (anyArgs) {
				lines.push(
					'- ⚠️ **필수 인자 추가, 인자 삭제, 인자 타입 변경, 기존 인자가 필수로 바뀜**은 기존 질의를 깨뜨립니다.',
				);
			}
			if (anyHarmless) {
				lines.push(
					'- **선택 인자 추가, 인자 제약 완화, 출력 필드의 제약 강화**는 무해합니다. ' +
						'이 서버가 안 넘겨도 되고, 넘기던 것을 계속 넘겨도 되고, 받는 값은 더 확실해집니다.',
				);
			}
			if (anyDeprecated) {
				lines.push('- **폐기 예고**는 아직 동작합니다. 다만 다음 변경에서 사라질 수 있습니다.');
			}
			if (anyRemoved || anyArgs) {
				lines.push(
					'- 읽기 도구는 그대로 다시 불러도 안전합니다.',
					'- ⚠️ 쓰기 도구가 실패했다면 그대로 다시 부르지 마세요. 이미 반영됐을 수 있습니다.',
					'  velog_list_drafts 나 velog_list_posts 로 먼저 확인하세요.',
				);
			}
			if (breaking) {
				lines.push(
					'',
					'없어지거나 바뀐 것이 있으므로 velog-mcp 를 고쳐야 합니다.',
					'위 내용을 그대로 저장소 이슈에 알려주시면 됩니다 (package.json 의 repository 에 주소가 있습니다).',
				);
			} else {
				lines.push(
					'',
					'호환되는 변화만 확인됐습니다. 이 서버는 그대로 동작하고 고칠 것은 없습니다.',
				);
			}

			return textResult(capNote(lines.join('\n'), 8_000));
		},
	);
}
