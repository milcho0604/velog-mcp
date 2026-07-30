#!/usr/bin/env node
/**
 * velog-mcp — 벨로그 MCP 서버.
 *
 * 읽기는 넓게, 쓰기는 초안까지만. 발행·삭제·계정변경 경로는 이 레포에 없다.
 * 설계 근거: docs/PRD.md, docs/security.md
 */

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { readAuthFromEnv } from './auth.ts';
import { VelogClient } from './client.ts';
import { registerPostTools } from './tools/posts.ts';
import { registerDiscoverTools } from './tools/discover.ts';
import { registerDraftTools } from './tools/drafts.ts';
import { registerStatsTools } from './tools/stats.ts';
import { registerExportTools } from './tools/export.ts';
import { registerProfileTools } from './tools/profile.ts';

export const SERVER_NAME = 'velog-mcp';
export const SERVER_VERSION = '0.1.0';

export function createServer(client: VelogClient): McpServer {
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			instructions:
				'벨로그(velog.io) 블로그 도구. 조회·검색은 인증 없이 동작한다. ' +
				'쓰기는 임시저장(초안)만 가능하며 발행은 지원하지 않는다 — ' +
				'초안을 만든 뒤에는 사용자에게 "벨로그에서 확인하고 직접 발행하세요"라고 안내할 것.',
		},
	);

	registerPostTools(server, client);
	registerDiscoverTools(server, client);
	registerDraftTools(server, client);
	registerStatsTools(server, client);
	registerExportTools(server, client);
	registerProfileTools(server, client);

	return server;
}

async function main(): Promise<void> {
	const auth = readAuthFromEnv();
	const client = new VelogClient({ auth });
	const server = createServer(client);

	// stdout 은 MCP 프로토콜 전용이다. 로그는 반드시 stderr 로 낸다.
	process.stderr.write(
		`[${SERVER_NAME} ${SERVER_VERSION}] ` +
			(client.isAuthenticated
				? '인증됨 — 초안 작성 가능 (발행 기능 없음)\n'
				: '무인증 — 읽기 전용 ' +
					'(VELOG_REFRESH_TOKEN 만 넣어도 동작합니다)\n'),
	);

	await server.connect(new StdioServerTransport());
}

// 직접 실행될 때만 기동한다. 테스트에서 import 할 때는 돌지 않아야 한다.
//
// basename 비교(`endsWith('index.js')`)는 다른 디렉터리의 동명 파일에도 참이 된다.
// 경로를 URL 로 정규화해 정확히 대조한다.
function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return import.meta.url === pathToFileURL(entry).href;
	} catch {
		return false;
	}
}

if (isDirectRun()) {
	main().catch((error: unknown) => {
		process.stderr.write(`기동 실패: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
