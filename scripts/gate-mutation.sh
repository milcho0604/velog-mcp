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

run_gate() { timeout 120 npm run verify:dist >/dev/null 2>&1; echo $?; }

EXPECTED=7
ran=0
fail=0
overlap=0

check() {
  local label="$1" dist_break="$2" gate_find="$3" gate_repl="$4"

  # ① 온전한 관문 + 불량 dist → 막아야 한다
  cp "$BAK.ts" "$GATE"
  break_dist "$dist_break"
  local caught; caught=$(run_gate)

  # ② 그 검사만 없앤 관문 + 같은 불량 dist → 통과해야 한다
  break_gate "$gate_find" "$gate_repl" || { echo "  ??  $label — 관문 변이 패턴 불일치"; fail=$((fail+1)); return; }
  local slipped; slipped=$(run_gate)

  restore

  if [ "$caught" -eq 0 ]; then
    echo "  X   $label — **온전한 관문이 이 불량을 못 잡는다**"
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

# ── 관문이 **검증 대상을 바꾸지 않는지** ────────────────────────────────
# 한때 관문이 npm 을 흉내내려 `chmod` 를 해서 tarball 모드가 달라졌다.
cp "$BAK.ts" "$GATE"
cp "$BAK.js" dist/index.js
before=$(ls -l dist/index.js | awk '{print $1}')
timeout 120 npm run verify:dist >/dev/null 2>&1
after=$(ls -l dist/index.js | awk '{print $1}')
if [ "$before" = "$after" ]; then
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
