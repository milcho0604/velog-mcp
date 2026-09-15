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
cp package.json "$BAK.pkg.json"

# ⚠️ trap 을 첫 build **뒤에** 걸었더니, 그 build 중 끊기면 관문 파일이 변이된 채 남을
#    수 있었다. 백업을 먼저 뜨고 trap 을 먼저 건다. orphan 파일도 함께 치운다.
restore() {
  cp "$BAK.ts" "$GATE"
  [ -f "$BAK.js" ] && cp "$BAK.js" dist/index.js
  # 발행물 구성(files)을 건드리는 변이가 생겨 package.json 도 되돌린다.
  [ -f "$BAK.pkg.json" ] && cp "$BAK.pkg.json" package.json
  rm -f dist/stale-orphan.js
  rm -f schema/.gate-stray.json
}
# ⚠️ EXIT 만 걸면 Ctrl-C 때 npm 자식이 살아남아 package.json 이 변이된 채 남는다
#    (코덱스 7차: 4초 뒤에도 schema 가 빠져 있었다). 신호도 함께 받는다.
# ⚠️ `kill -- -$$` 를 **정상 종료 경로에서도** 부르면 자기 프로세스 그룹을 통째로 죽여
#    호출한 쪽까지 끊긴다(실측: 파이프라인이 Terminated). 자식 정리는 «신호로 끊겼을 때» 만.
kill_children() {
  # ⚠️ `pkill -P $$` 는 **직계 자식만** 본다. npm 은 손자를 만들고, `timeout` 은 자식을
  #    **별도 프로세스 그룹**에 둬서 `pgrep -g $$` 로도 안 잡힌다(코덱스 7·8차:
  #    Ctrl-C 4초·10초 뒤에도 살아 있었다).
  # ⚠️ 그렇다고 `pkill -f 'scripts/verify-dist.ts'` 로 이름을 훑으면 **다른 체크아웃에서
  #    도는 남의 검증까지** 죽인다(코덱스 9차). 이름은 이 실행의 것인지 알려주지 않는다.
  #
  # 그래서 «이 프로세스의 자손인가» 로만 고른다. 부모 사슬은 프로세스 그룹과 달리
  # timeout 이 바꾸지 않는다. 이름도 경로도 보지 않으므로 남의 것을 건드릴 수 없다.
  local kids
  kids=$(ps -A -o pid=,ppid= 2>/dev/null | awk -v root=$$ '
    { ppid[$1] = $2; pids[NR] = $1 }
    END {
      for (i = 1; i <= NR; i++) {
        p = pids[i]; hops = 0
        while (p != 1 && p != "" && hops < 50) {
          p = ppid[p]; hops++
          if (p == root) { print pids[i]; break }
        }
      }
    }' || true)
  [ -n "$kids" ] && kill $kids >/dev/null 2>&1 || true
  sleep 0.5
}

cleanup() {
  trap - EXIT INT TERM HUP
  restore
  rm -rf "$(dirname "$BAK")"
}

on_signal() {
  trap - EXIT INT TERM HUP
  kill_children
  restore
  rm -rf "$(dirname "$BAK")"
  exit "$1"
}

trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM HUP

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

# 발행물 «구성» 을 망가뜨린다. dist 가 아니라 package.json 의 files 를 고친다.
# 기준선 파일처럼 dist 밖에 있는 것이 안 실리는 경우를 재현한다.
break_pkg() {
  cp "$BAK.pkg.json" package.json
  python3 - <<PY
import pathlib
p = pathlib.Path('package.json'); s = p.read_text()
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

EXPECTED=15
ran=0
fail=0
overlap=0

# 구성(package.json) 변이용. check 와 같은 ①②③ 을 돌린다.
check_pkg() {
  local label="$1" pkg_break="$2" gate_find="$3" gate_repl="$4"

  cp "$BAK.ts" "$GATE"
  break_pkg "$pkg_break"
  local caught; caught=$(run_gate)

  break_gate "$gate_find" "$gate_repl" || { echo "  ??  $label — 관문 변이 패턴 불일치"; fail=$((fail+1)); return; }
  cp "$BAK.pkg.json" package.json
  local sane; sane=$(run_gate)

  break_pkg "$pkg_break"
  local slipped; slipped=$(run_gate)

  restore

  ran=$((ran+1))
  if [ "$caught" -eq 0 ]; then
    echo "  X   $label — 온전한 관문이 불량을 통과시킨다"; fail=$((fail+1)); return
  fi
  if [ "$caught" -ne 2 ]; then
    echo "  X   $label — 관문이 fail() 이 아닌 rc=$caught 로 끝났다"; fail=$((fail+1)); return
  fi
  if [ "$sane" -ne 0 ]; then
    echo "  X   $label — 검사를 없앤 관문이 «정상» 구성도 막는다"; fail=$((fail+1)); return
  fi
  # ⚠️ `slipped != 0` 을 전부 «겹침» 으로 세면 크래시·타임아웃도 성공으로 둔갑한다.
  #    관문의 fail() 은 exit 2 다. 1·124·127 은 관문이 «깨진» 것이지 잡은 게 아니다
  #    (코덱스 7차가 종료코드를 주입해 증명했다 — 13/13 exit 0 이었다).
  if [ "$slipped" -eq 2 ]; then
    echo "  ~   $label — 다른 검사가 겹쳐 잡는다"; overlap=$((overlap+1)); return
  fi
  if [ "$slipped" -ne 0 ]; then
    echo "  X   $label — 검사를 없앤 관문이 rc=$slipped 로 비정상 종료했다 (크래시·타임아웃)"
    fail=$((fail+1)); return
  fi
  echo "  O   $label"
}

# 발행물에 «있으면 안 되는 파일» 을 만드는 변이. dist 도 package.json 도 아니다.
check_stray() {
  local label="$1" stray="$2" gate_find="$3" gate_repl="$4"

  cp "$BAK.ts" "$GATE"
  : > "$stray"
  local caught; caught=$(run_gate)

  break_gate "$gate_find" "$gate_repl" || { echo "  ??  $label — 관문 변이 패턴 불일치"; fail=$((fail+1)); rm -f "$stray"; return; }
  rm -f "$stray"
  local sane; sane=$(run_gate)

  : > "$stray"
  local slipped; slipped=$(run_gate)

  rm -f "$stray"
  restore

  ran=$((ran+1))
  if [ "$caught" -ne "$GATE_FAIL" ]; then
    echo "  X   $label — 온전한 관문이 rc=$caught 로 끝났다 (fail() 이 아니다)"; fail=$((fail+1)); return
  fi
  if [ "$sane" -ne 0 ]; then
    echo "  X   $label — 검사를 없앤 관문이 «정상» 발행물도 막는다"; fail=$((fail+1)); return
  fi
  if [ "$slipped" -eq "$GATE_FAIL" ]; then
    echo "  ~   $label — 다른 검사가 겹쳐 잡는다"; overlap=$((overlap+1)); return
  fi
  if [ "$slipped" -ne 0 ]; then
    echo "  X   $label — 검사를 없앤 관문이 rc=$slipped 로 비정상 종료했다"; fail=$((fail+1)); return
  fi
  echo "  O   $label"
}

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
# ── 11차: 발행물 «구성» 변이 ─────────────────────────────────────────────
# ⚠️ 기준선 파일이 dist 밖(schema/)에 있어서 `files` 에서 빠지면 조용히 안 실린다.
#    한때 «서버가 죽는지» 로 잡았는데, 서버가 안 죽게 고치자 그 그물이 사라졌다.
#    그래서 «소스가 읽는 경로가 발행물에 실제로 있는지» 로 본다.
check_pkg "발행물 구성: 기준선 누락" \
  "s = s.replace('\"dist\",' + chr(10) + '    \"schema\",', '\"dist\",', 1)" \
  "		if (!baselineOk) {" \
  "		if (false) {"

# ⚠️ 설치본이 **아예 안 뜨는** 경우. `files` 에서 dist 가 빠지면 tarball 에 실행 파일이
#    없다. 저장소 검사는 전부 통과한다 — 로컬에는 dist 가 있기 때문이다.
check_pkg "발행물 구성: dist 누락" \
  "s = s.replace('\"dist\",' + chr(10), '', 1)" \
  "		if (packedOutcome.died !== null) {" \
  "		if (false) {"

# ── 12차: 발행물에 섞인 임시 파일 ────────────────────────────────────────
# ⚠️ `files` 가 `schema` 를 통째로 싣는다. 기준선 생성기가 만드는 검사용 파일이 남으면
#    그대로 발행된다. 로컬에서는 아무 증상이 없어 눈으로는 못 본다.
check_stray "발행물 찌꺼기: schema/ 의 임시 파일" \
  "schema/.gate-stray.json" \
  "if (strays.length > 0) {" \
  "if (false) {"

# ℹ️ 발행물의 `serverInfo.name`·`version` 대조는 여기서 변이로 재지 않는다. 저장소 검사
#    (verify-dist.ts 의 `info.name`·`info.version`)가 **같은 dist 를** 이미 보므로,
#    그 둘만 겨누는 불량을 만들 수 없다 — 만들면 두 검사가 함께 잡아 «겹침» 이 된다.
#    그래도 검사는 남긴다. tarball 구성이 바뀌어 둘이 갈라지는 날의 방어선이다.


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
