#!/bin/bash
#
# 발행 관문(`verify-dist.ts`) 자체의 변이 검증.
#
# ★ 왜 따로 필요한가
#   관문은 테스트 스위트가 실행하지 않는다. `npm test` 를 아무리 돌려도
#   `verify-dist.ts` 를 망가뜨린 게 안 잡힌다. **검사하는 물건이 검사받지 않는다.**
#
# ★ 왜 양방향인가
#   한 방향(변이 후 통과)만 보면, **원래 관문도 이미 그 불량을 통과시키던 경우**를
#   "그 검사가 제 몫을 했다"고 오판한다. 그래서 둘 다 본다:
#
#     ① 온전한 관문 + 불량 dist  →  **반드시 막아야 한다**   (검사가 실제로 잡는다)
#     ② 그 검사만 없앤 관문 + 같은 불량 dist  →  **통과해야 한다** (그 검사가 유일한 그물)
#
#   ①이 통과하면 관문이 애초에 그 불량을 못 잡는 것이고,
#   ②가 막히면 다른 검사가 겹쳐 잡는 것이라 그 검사는 중복이다.
#
# 실행: bash scripts/gate-mutation.sh   (dist 를 건드리므로 끝나고 다시 빌드한다)
set -uo pipefail
cd "$(dirname "$0")/.."

GATE=scripts/verify-dist.ts
BAK=$(mktemp -d)/gate
mkdir -p "$(dirname "$BAK")"

cp "$GATE" "$BAK.ts"

# ⚠️ trap 을 첫 build **뒤에** 걸었더니, 그 build 중 끊기면 관문 파일이 변이된 채 남을
#    수 있었다. 백업을 먼저 뜨고 trap 을 먼저 건다. orphan 파일도 함께 치운다.
restore() {
  cp "$BAK.ts" "$GATE"
  [ -f "$BAK.js" ] && cp "$BAK.js" dist/index.js
  rm -f dist/stale-orphan.js
}
trap 'restore; rm -rf "$(dirname "$BAK")"' EXIT

npm run build >/dev/null 2>&1 || { echo "  빌드 실패 — 중단"; exit 1; }
cp dist/index.js "$BAK.js"

# 불량 dist 를 만든다. 인자는 python 조각이며 `s` 를 고친다.
break_dist() {
  cp "$BAK.js" dist/index.js
  python3 - <<PY
import pathlib
p = pathlib.Path('dist/index.js'); s = p.read_text()
$1
p.write_text(s)
PY
}

# 관문에서 검사 하나를 지운다.
break_gate() {
  cp "$BAK.ts" "$GATE"
  python3 - "$1" "$2" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1] if False else 'scripts/verify-dist.ts'); s = p.read_text()
if sys.argv[1] not in s:
    print('PATTERN_MISS'); sys.exit(9)
p.write_text(s.replace(sys.argv[1], sys.argv[2], 1))
PY
}

# ⚠️ 종료코드를 **정확히** 본다. 관문의 fail() 은 **exit 2** 이고 npm run 은 그 코드를
#    그대로 전파한다(실측: exit 3 스크립트 → rc=3). 한때 `caught != 0` 이면 전부
#    "잡았다"로 셌는데, 그러면 timeout(124)·timeout 명령 부재(127)·관문 크래시도
#    성공으로 둔갑한다 — 관문 전체가 매달려도 7/7 통과가 된다(9차 반례).
#    fail() 을 2 로 둔 이유: node 크래시(구문 오류·미처리 예외)는 1 이라, 1 을
#    "잡았다"로 치면 **관문이 죽은 것**도 성공이 된다(9차 반영 검토 반례).
GATE_FAIL=2
run_gate() { timeout 120 npm run verify:dist >/dev/null 2>&1; echo $?; }

EXPECTED=12
ran=0
fail=0
overlap=0

check() {
  local label="$1" dist_break="$2" gate_find="$3" gate_repl="$4"

  # ① 온전한 관문 + 불량 dist → 막아야 한다
  cp "$BAK.ts" "$GATE"
  break_dist "$dist_break"
  local caught; caught=$(run_gate)

  # ② 그 검사만 없앤 관문의 **기준선**: 정상 dist 는 통과시켜야 한다.
  #    ⚠️ 이게 없으면 "검사 제거"가 아니라 "관문 파괴"인 변이도 ③에서 rc!=0 을 내고,
  #       그걸 '겹침'으로 오판한다 — protocolVersion 변이가 실제로 그랬다
  #       (루프를 비우니 정상 dist 도 막혔는데 겹침으로 보고됨. 9차 반영 검토 반례).
  break_gate "$gate_find" "$gate_repl" || { echo "  ??  $label — 관문 변이 패턴 불일치"; fail=$((fail+1)); return; }
  # ⚠️ dist/index.js 만 복원하면 '낡은 산출물' 변이가 만든 side file 이 남아
  #    기준선이 "정상 dist" 가 아니게 된다(10차 반례). 부산물도 함께 치운다.
  cp "$BAK.js" dist/index.js
  rm -f dist/stale-orphan.js
  local sane; sane=$(run_gate)

  # ③ 그 검사만 없앤 관문 + 같은 불량 dist → 통과해야 한다
  break_dist "$dist_break"
  local slipped; slipped=$(run_gate)

  restore

  if [ "$caught" -eq 0 ]; then
    echo "  X   $label — **온전한 관문이 이 불량을 못 잡는다**"
    fail=$((fail+1))
    return
  fi
  if [ "$caught" -ne "$GATE_FAIL" ]; then
    echo "  X   $label — 관문 실행 이상(rc=$caught) — timeout·크래시·실행실패는 '잡았다'가 아니다"
    fail=$((fail+1))
    return
  fi
  if [ "$sane" -ne 0 ]; then
    echo "  X   $label — 변이 관문이 정상 dist 도 막는다(rc=$sane) — 검사 제거가 아니라 관문 파괴, 판정 무효"
    fail=$((fail+1))
    return
  fi
  if [ "$slipped" -ne 0 ] && [ "$slipped" -ne "$GATE_FAIL" ]; then
    echo "  X   $label — 변이 관문 실행 이상(rc=$slipped) — 판정 불가"
    fail=$((fail+1))
    return
  fi
  ran=$((ran+1))
  if [ "$slipped" -eq 0 ]; then
    echo "  OK  $label — 잡는다 / 이 검사가 유일한 그물"
  else
    echo "  OK  $label — 잡는다 / 다른 검사와 겹침(더 나은 메시지를 위해 유지)"
    overlap=$((overlap+1))
  fi
}

echo "── 관문 변이 검증 (양방향) ──"

check "shebang 검증" \
  "s = s.replace('#!/usr/bin/env node' + chr(10), '', 1)" \
  "		child = spawn(binLink, [], {" \
  "		child = spawn(process.execPath, [binLink], {"

check "MCP 외피 스키마" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:\"2.0\",id:999,level:\"debug\"}) + String.fromCharCode(10)), 400);'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "				if (parsed !== undefined && JSONRPCMessageSchema.safeParse(parsed).success) {" \
  "				if (parsed !== undefined) {"

check "MCP 결과 스키마 (inputSchema 누락)" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.tools) { o.result.tools = o.result.tools.map(t => ({name: t.name})); return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "const listResult = ListToolsResultSchema.safeParse(list?.['result']);" \
  "const listResult = { success: true, data: (list?.['result'] ?? { tools: [] }) } as never as ReturnType<typeof ListToolsResultSchema.safeParse> & { data: { tools: Array<{ name: string }> } };"

check "발행물 개인정보" \
  "s = s + chr(10) + '// ' + '/Users/' + 'somebody' + '/secret' + chr(10)" \
  "if (leaks.length > 0) {" \
  "if (false) {"

check "조기 종료" \
  "s = s.replace('await server.connect(new StdioServerTransport());', 'await server.connect(new StdioServerTransport());' + chr(10) + '    setTimeout(() => process.exit(7), 500);')" \
  "if (died) {" \
  "if (false) {"

check "낡은 산출물" \
  "import pathlib as _p; _p.Path('dist/stale-orphan.js').write_text('export const x = 1;' + chr(10))" \
  "if (orphans.length > 0) {" \
  "if (false) {"

rm -f dist/stale-orphan.js

# ── 9차에서 추가된 관문 2종 + 조건부 분기도 변이 대상에 넣는다 ──────────────
# ⚠️ 8차의 핵심 수정(실제 클라이언트·소스 대조)이 정작 여기 없었다(9차 반례).
#    "이름 집합→개수" 로 약화하거나 실제 클라이언트를 우회해도 7/7 이 그대로였다.

# 소스 대조(이름): tools/list 응답에서 velog_whoami 를 개수 그대로 개명한 dist.
# 관문을 "집합 동일→개수 동일"로 약화하면 이 개명이 안 잡혀야 정상.
check "소스 대조: 이름 약화" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.tools) { o.result.tools = o.result.tools.map(t => t.name === \"velog_whoami\" ? {...t, name: \"velog_whoamz\"} : t); return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "	if (JSON.stringify(distNames) !== JSON.stringify(srcNames)) {" \
  "	if (distNames.length !== srcNames.length) {"

# 소스 대조(스냅샷): 이름·개수는 그대로 두고 설명만 바꾼 dist.
# 스냅샷(스키마·설명) 대조를 없애면 이 드리프트를 아무도 못 잡아야 정상.
check "소스 대조: 스냅샷 드리프트" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.tools) { o.result.tools = o.result.tools.map(t => t.name === \"velog_whoami\" ? {...t, description: (t.description || \"\") + \" X\"} : t); return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "	if (drifted.length > 0) {" \
  "	if (false) {"

# 실제 클라이언트: 지원하지 않는 protocolVersion 을 돌려주는 dist.
# 외피·결과 스키마는 값을 안 보므로, 실제 SDK 클라이언트 연결만 이걸 잡는다.
check "실제 클라이언트 (protocolVersion)" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.protocolVersion) { o.result.protocolVersion = \"1999-01-01\"; return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "for (const [mode, extraEnv] of MODES) {" \
  "for (const [mode, extraEnv] of [] as typeof MODES) {"

# 조건부 모드: VELOG_ALLOW_PROFILE=1 일 때**만** 깨지는 dist.
# 옵션 모드들을 관문에서 빼면 이 불량은 기본 분기만 봐서는 영원히 못 잡는다 —
# 9차 발견 1(조건부 도구가 대조에서 빠짐)을 정확히 재현하는 변이다.
check "조건부 모드 (ALLOW_PROFILE)" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    if (process.env.VELOG_ALLOW_PROFILE === \"1\") { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.tools) { o.result.tools = o.result.tools.map(t => t.name === \"velog_update_profile\" ? {...t, name: \"velog_update_profilz\"} : t); return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "	...OPTION_MODES," \
  ""

# 조건부 모드 그 두 번째: VELOG_ALLOW_PUBLIC=1 일 때**만** 스키마가 깨지는 dist.
# PROFILE 쪽만 겨누면 PUBLIC 플래그 분기(공개 발행 안전장치)는 검증 밖이다
# (9차 반영 검토 반례 — 독립 플래그는 각자 겨눠야 한다).
check "조건부 모드 (ALLOW_PUBLIC)" \
  "inject = 'await server.connect(new StdioServerTransport());' + chr(10) + '    if (process.env.VELOG_ALLOW_PUBLIC === \"1\") { const w = process.stdout.write.bind(process.stdout); process.stdout.write = (c, ...a) => { try { const o = JSON.parse(String(c)); if (o?.result?.tools) { o.result.tools = o.result.tools.map(t => t.name === \"velog_publish_post\" ? {...t, description: (t.description || \"\") + \" X\"} : t); return w(JSON.stringify(o) + String.fromCharCode(10), ...a); } } catch {} return w(c, ...a); }; }'
s = s.replace('await server.connect(new StdioServerTransport());', inject)" \
  "	...OPTION_MODES," \
  ""

# ── 관문이 **검증 대상을 바꾸지 않는지** ────────────────────────────────
# 한때 관문이 npm 을 흉내내려 `chmod` 를 해서 tarball 모드가 달라졌다.
# ⚠️ 여기서도 rc 를 본다 — 관문이 아예 안 돌았으면(127 등) 모드가 같은 건 당연하다.
cp "$BAK.ts" "$GATE"
cp "$BAK.js" dist/index.js
before=$(ls -l dist/index.js | awk '{print $1}')
clean_rc=$(run_gate)
after=$(ls -l dist/index.js | awk '{print $1}')
if [ "$clean_rc" -ne 0 ]; then
  echo "  X   온전한 관문이 온전한 dist 를 통과 못 시킴(rc=$clean_rc) — 기준선 자체가 깨짐"
  fail=$((fail+1))
elif [ "$before" = "$after" ]; then
  echo "  OK  관문이 대상을 바꾸지 않음 ($before)"
  ran=$((ran+1))
else
  echo "  X   관문이 대상을 바꿈 ($before → $after) — 검증이 검증 대상을 바꾸면 안 된다"
  fail=$((fail+1))
fi

echo "── 결과: 검사 ${ran}/${EXPECTED} 통과 · 실패 ${fail} · 겹침 ${overlap} ──"
npm run build >/dev/null 2>&1 || { echo "  마지막 재빌드 실패"; exit 1; }

# ⚠️ `fail == 0` 만 보면 **검사를 통째로 건너뛰어도** 0/0 으로 성공한다(8차 반례).
#    기대한 개수만큼 실제로 통과했는지 함께 요구한다.
if [ "$ran" -ne "$EXPECTED" ]; then
  echo "  실행된 검사가 ${ran}개뿐이다 (기대 ${EXPECTED}) — 검사가 건너뛰어졌다"
  exit 1
fi
[ "$fail" -eq 0 ]
