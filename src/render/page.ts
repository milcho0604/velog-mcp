/**
 * 다이어그램 HTML 생성.
 *
 * 이 파일의 핵심은 "스타일 규칙을 사람이 기억하는 게 아니라 코드가 강제한다" 는 것이다.
 * 손으로 그릴 때 반복해서 틀렸던 것들을 그대로 옮겨 놨다:
 *
 *   - 글자 폭은 **추정하지 않는다.** 전부 브라우저의 getBBox 실측이다.
 *     (글자수 × 상수로 잡으면 한글/영문 섞인 라벨에서 칩이 삐져나온다.)
 *   - 캔버스 크기를 사람이 정하지 않는다. 그린 뒤 내용 bbox 로 되맞춘다.
 *     잘림 사고가 구조적으로 안 난다.
 *   - 선이 노드를 관통하거나 노드 뒤에 숨는 것, 서로 다른 선이 겹치는 것,
 *     노드끼리 겹치는 것을 **자가감사**가 잡아서 보고한다.
 *
 * ★ 페이지 안 스크립트에 대한 보안 원칙
 *   데이터는 `<script type="application/json">` 블록으로만 들어가고, DOM 은 전부
 *   createElementNS + textContent 로 만든다. innerHTML 은 한 번도 쓰지 않는다.
 *   따라서 라벨 문자열에 마크업이 들어와도 그냥 글자로 그려진다.
 *   색은 입력 단계(zod)에서 `#rrggbb` 로 좁혀 두었다.
 */

import type { Prim } from './icons.ts';
import { ICONS } from './icons.ts';
import { DEFAULT_PLANES, type Plane, TONES, tone } from './tones.ts';

export interface DiagramNode {
	id?: string | undefined;
	x: number;
	y: number;
	w?: number | undefined;
	h?: number | undefined;
	title: string;
	sub?: string | undefined;
	icon?: string | undefined;
	icon_tone?: string | undefined;
	tag?: string | undefined;
	tag_tone?: string | undefined;
}

export interface DiagramGroup {
	name: string;
	sub?: string | undefined;
	tone?: string | undefined;
	x?: number | undefined;
	y?: number | undefined;
	w?: number | undefined;
	h?: number | undefined;
	members?: string[] | undefined;
}

export interface DiagramEdge {
	plane?: string | undefined;
	from?: string | undefined;
	to?: string | undefined;
	points?: Array<[number, number]> | undefined;
	label?: string | undefined;
	label_at?: [number, number] | undefined;
	label_anchor?: 'start' | 'middle' | 'end' | undefined;
}

export interface DiagramSpec {
	title: string;
	subtitle?: string | undefined;
	nodes: DiagramNode[];
	groups?: DiagramGroup[] | undefined;
	edges?: DiagramEdge[] | undefined;
	planes?: Plane[] | undefined;
	legend?: boolean | undefined;
}

/**
 * 캔버스 상한. **페이지 안에서** 강제된다 (page 스크립트 참고).
 * 바깥에서 검사하면 이미 브라우저가 표면을 잡은 뒤라 늦는다.
 */
export const MAX_DIM = 6000;
export const MAX_AREA = 9_000_000;

export interface AuditReport {
	w: number;
	h: number;
	/** 노드 밖으로 삐져나온 글자 */
	over: string[];
	/** 자간을 눌러 억지로 맞춘 글자 — 0건이어야 한다 */
	compressed: string[];
	/** 노드를 관통하거나 노드 뒤로 숨은 선 */
	cross: string[];
	/** 서로 다른 선이 같은 자리에 겹친 구간 */
	overlap: string[];
	/** 노드끼리 겹침 · 배지가 아이콘 침범 */
	collide: string[];
	/** 라벨이 카드 위나 다른 라벨 위에 얹힘 */
	label: string[];
}

/** 페이지에 넘길 최종 형태 — 톤 이름은 여기서 실제 색으로 바꿔 넘긴다. */
interface ResolvedSpec {
	title: string;
	subtitle: string;
	legend: boolean;
	planes: Array<{ key: string; name: string; color: string; dash: string }>;
	groups: Array<{
		name: string;
		sub: string;
		fill: string;
		stroke: string;
		x?: number;
		y?: number;
		w?: number;
		h?: number;
		members: string[];
	}>;
	nodes: Array<{
		id: string;
		x: number;
		y: number;
		w: number;
		h: number;
		title: string;
		sub: string;
		icon: string;
		iconColor: string;
		tag: string;
		tagColor: string;
	}>;
	edges: Array<{
		plane: string;
		from: string;
		to: string;
		points: Array<[number, number]>;
		label: string;
		labelAt: [number, number] | null;
		labelAnchor: string;
	}>;
	icons: Record<string, readonly Prim[]>;
	maxDim: number;
	maxArea: number;
}

function resolve(spec: DiagramSpec): ResolvedSpec {
	const planes = (spec.planes?.length ? spec.planes : DEFAULT_PLANES).map((p) => ({
		key: p.key,
		name: p.name,
		color: p.color,
		dash: p.dash ?? '',
	}));

	const nodes = spec.nodes.map((n, i) => ({
		id: n.id ?? `n${i}`,
		x: n.x,
		y: n.y,
		w: n.w ?? 0, // 0 = 내용에서 실측해 정한다
		h: n.h ?? 0,
		title: n.title,
		sub: n.sub ?? '',
		icon: n.icon && ICONS[n.icon] ? n.icon : '',
		iconColor: tone(n.icon_tone, 'slate').solid,
		tag: n.tag ?? '',
		tagColor: tone(n.tag_tone, 'slate').solid,
	}));

	// 실제 쓰인 아이콘만 싣는다. 안 쓰는 걸 다 넣으면 HTML 이 쓸데없이 커진다.
	const icons: Record<string, readonly Prim[]> = {};
	for (const n of nodes) {
		const prim = ICONS[n.icon];
		if (n.icon && prim) icons[n.icon] = prim;
	}

	const groups = (spec.groups ?? []).map((g) => {
		const t = tone(g.tone, 'gray');
		const out: ResolvedSpec['groups'][number] = {
			name: g.name,
			sub: g.sub ?? '',
			fill: t.fill,
			stroke: t.stroke,
			members: g.members ?? [],
		};
		if (g.x !== undefined) out.x = g.x;
		if (g.y !== undefined) out.y = g.y;
		if (g.w !== undefined) out.w = g.w;
		if (g.h !== undefined) out.h = g.h;
		return out;
	});

	const fallbackPlane = planes[0]?.key ?? 'r';
	const edges = (spec.edges ?? []).map((e) => ({
		plane: e.plane ?? fallbackPlane,
		from: e.from ?? '',
		to: e.to ?? '',
		points: e.points ?? [],
		label: e.label ?? '',
		labelAt: e.label_at ?? null,
		labelAnchor: e.label_anchor ?? 'middle',
	}));

	return {
		title: spec.title,
		subtitle: spec.subtitle ?? '',
		legend: spec.legend ?? true,
		planes,
		groups,
		nodes,
		edges,
		icons,
		maxDim: MAX_DIM,
		maxArea: MAX_AREA,
	};
}

/**
 * JSON 을 `<script>` 블록에 안전하게 싣는다.
 * `<` 를 유니코드 이스케이프로 바꾸면 `</script>` 가 만들어질 수 없다.
 * JSON 규격상 `<` 는 파싱하면 다시 `<` 가 되므로 데이터는 그대로다.
 */
function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE = `
  html,body { margin:0; padding:0; background:#ffffff; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",sans-serif;
         text-rendering:geometricPrecision; -webkit-font-smoothing:antialiased; }
  #wrap { position:relative; }
  svg { display:block; }
  .hd-title { font-size:21px; font-weight:800; fill:#0f172a; }
  .hd-sub   { font-size:12.5px; fill:#64748b; }
  .lg-t     { font-size:11.5px; fill:#475569; font-weight:600; }
  .grp-title{ font-size:12.5px; font-weight:700; fill:#1f2937; letter-spacing:.2px; }
  .grp-sub  { font-size:11px; fill:#6b7280; }
  .n-title  { font-size:13.5px; font-weight:600; fill:#111827; }
  .n-sub    { font-size:11px; fill:#6b7280; }
  .tag-t    { font-size:10.5px; font-weight:700; fill:#ffffff; letter-spacing:.2px; }
  .e-label  { font-size:11px; font-weight:600; paint-order:stroke; stroke:#ffffff; stroke-width:4.5px; stroke-linejoin:round; }
`;

// ── 페이지 안에서 도는 스크립트 ──────────────────────────────────────────
// ★ 이 문자열 안에서는 백틱과 ${ 를 쓰지 않는다. 바깥이 템플릿 리터럴이라
//   그대로 보간돼 버린다. 문자열은 전부 작은따옴표 + 이어붙이기로 쓴다.
const SCRIPT = `
(function(){
'use strict';
try {
var S = JSON.parse(document.getElementById('spec').textContent);
var NS = 'http://www.w3.org/2000/svg';
var svg = document.getElementById('cv');
var PAD = 34, GAP = 26;

function el(n, a, p){
  var e = document.createElementNS(NS, n);
  for (var k in a) { if (a[k] !== null && a[k] !== undefined) e.setAttribute(k, a[k]); }
  (p || svg).appendChild(e);
  return e;
}
function txt(x, y, cls, s, anchor, fill, p){
  var t = el('text', {x:x, y:y, 'class':cls, 'text-anchor':anchor||'middle'}, p);
  if (fill) t.setAttribute('fill', fill);
  t.textContent = s;
  return t;
}

// 글자 폭은 전부 여기서 실측한다. 추정값은 쓰지 않는다.
var scratch = el('g', {visibility:'hidden'});
function measure(s, cls){
  var t = txt(0, 0, cls, s, 'start', null, scratch);
  var w = t.getBBox().width;
  scratch.removeChild(t);
  return w;
}

function boxOf(t){ var b = t.getBBox(); return {x:b.x, y:b.y, w:b.width, h:b.height}; }
function boxesOverlap(a, b){
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

var defs = el('defs', {});
var PLANE = Object.create(null);
for (var pi = 0; pi < S.planes.length; pi++) {
  var pl = S.planes[pi];
  PLANE[pl.key] = pl;
  var mk = el('marker', {id:'arr-'+pl.key, viewBox:'0 0 10 10', refX:'9', refY:'5',
                         markerWidth:'6.2', markerHeight:'6.2', orient:'auto-start-reverse'}, defs);
  el('path', {d:'M0,0 L10,5 L0,10 z', fill:pl.color}, mk);
}
function planeOf(k){ return PLANE[k] || S.planes[0] || {color:'#64748b', dash:''}; }

// ── 머리말 (내용 그룹 바깥. 항상 좌상단 고정) ──
var headerBottom = PAD + 8;
var headerW = 0;
txt(PAD, PAD + 14, 'hd-title', S.title, 'start');
headerW = measure(S.title, 'hd-title');
headerBottom = PAD + 22;
if (S.subtitle) {
  txt(PAD, headerBottom + 16, 'hd-sub', S.subtitle, 'start');
  headerW = Math.max(headerW, measure(S.subtitle, 'hd-sub'));
  headerBottom += 22;
}
if (S.legend && S.planes.length) {
  var lx = PAD, ly = headerBottom + 22;
  for (var li = 0; li < S.planes.length; li++) {
    var lp = S.planes[li];
    var ln = el('path', {d:'M'+lx+','+ly+' H'+(lx+30), stroke:lp.color, 'stroke-width':2,
                         fill:'none', 'marker-end':'url(#arr-'+lp.key+')'});
    if (lp.dash) ln.setAttribute('stroke-dasharray', lp.dash);
    txt(lx + 38, ly + 4, 'lg-t', lp.name, 'start');
    lx += 38 + measure(lp.name, 'lg-t') + 22;
  }
  headerW = Math.max(headerW, lx - PAD - 22);
  headerBottom = ly + 12;
}

// ── 내용은 통째로 한 그룹에 담는다. 다 그린 뒤 위치·캔버스를 되맞추기 위해서다 ──
var content = el('g', {});

// ── 노드 크기 확정 (폭·높이를 안 준 것은 글자 실측으로 정한다) ──
var NMAP = Object.create(null);
for (var ni = 0; ni < S.nodes.length; ni++) {
  var n = S.nodes[ni];
  n.fixedW = !!n.w;
  var tw = measure(n.title, 'n-title');
  var sw = n.sub ? measure(n.sub, 'n-sub') : 0;
  n.tagBoxW = n.tag ? measure(n.tag, 'tag-t') + 16 : 0;
  if (!n.w) {
    var need = Math.max(126, tw + 30, sw + 26, n.tagBoxW + 30);
    // 아이콘은 가운데 위, 배지는 오른쪽 위다. 폭이 좁으면 둘이 겹친다.
    // 겹치지 않는 최소 폭: w/2 + 15(아이콘 반폭) + 8(간격) <= w - tagBoxW - 9
    if (n.icon && n.tag) need = Math.max(need, 2 * n.tagBoxW + 64);
    n.w = Math.ceil(need);
  }
  if (!n.h) n.h = n.sub ? 84 : (n.icon ? 76 : 54);
  NMAP[n.id] = n;
}

// ── 그룹 안 카드는 폭을 맞춘다 ──
// 폭은 글자로 재므로 카드마다 제각각이다. 나란히 놓인 형제 카드가 144·143·164·208
// 처럼 들쭉날쭉하면 줄이 안 맞아 눈에 걸린다(서버 구성도 실측). 1px 차이는 오히려
// 렌더 오류처럼 보인다. 그래서 같은 그룹의 멤버는 그중 가장 넓은 폭으로 맞춘다.
// w 를 직접 준 노드는 건드리지 않는다 — 준 값이 뜻이다. 다만 그 값도 최댓값에 넣는다.
// 넓어져서 옆 카드와 겹치면 자가감사(collide)가 잡는다. 조용히 망가지지 않는다.
for (var gw = 0; gw < S.groups.length; gw++) {
  var gm = S.groups[gw].members;
  if (!gm || !gm.length) continue;
  var wide = 0, mem = [];
  for (var wmi = 0; wmi < gm.length; wmi++) {
    var wmn = NMAP[gm[wmi]];
    if (!wmn) continue;
    mem.push(wmn);
    if (wmn.w > wide) wide = wmn.w;
  }
  for (var mj = 0; mj < mem.length; mj++) {
    if (!mem[mj].fixedW) mem[mj].w = wide;
  }
}

// ── 그룹 박스: members 를 주면 그 노드들을 감싸도록 자동 계산 ──
// 이름표 칩 자리는 감사가 다시 쓴다. 선이 칩을 지나면 그룹 이름이 가려진다.
var CHIPS = [];
var GPAD = 22;
for (var gi = 0; gi < S.groups.length; gi++) {
  var g = S.groups[gi];
  if (g.members && g.members.length) {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var mi = 0; mi < g.members.length; mi++) {
      var mn = NMAP[g.members[mi]];
      if (!mn) continue;
      minx = Math.min(minx, mn.x); miny = Math.min(miny, mn.y);
      maxx = Math.max(maxx, mn.x + mn.w); maxy = Math.max(maxy, mn.y + mn.h);
    }
    if (minx !== Infinity) {
      g.x = minx - GPAD; g.y = miny - GPAD;
      g.w = (maxx - minx) + GPAD * 2; g.h = (maxy - miny) + GPAD * 2;
    }
  }
  if (g.x === undefined) continue;
  // 좌상단 타이틀 칩 — 폭은 실측 합산
  var gtw = measure(g.name, 'grp-title');
  var chipW = 13 + gtw + 13;
  if (g.sub) chipW += 9 + measure(g.sub, 'grp-sub');
  // 박스는 제 이름표보다 좁을 수 없다. 멤버 폭으로만 재면 긴 부제가 박스 밖으로
  //   삐져나간다(서버 구성도 실측: DB 그룹 이름표가 오른쪽으로 100px 넘게 나왔다).
  //   멤버로 잰 박스만 넓힌다. 좌표를 직접 준 박스는 준 값이 뜻이라 감사가 알린다.
  var chipNeed = 13 + chipW + 13;
  if (g.members && g.members.length && g.w < chipNeed) g.w = chipNeed;
  else if (g.w < chipNeed) g.chipOver = true;
  el('rect', {x:g.x, y:g.y, width:g.w, height:g.h, rx:13, fill:g.fill,
              stroke:g.stroke, 'stroke-width':1.4}, content);
  el('rect', {x:g.x + 13, y:g.y - 13, width:chipW, height:26, rx:7,
              fill:'#ffffff', stroke:g.stroke, 'stroke-width':1.2}, content);
  CHIPS.push({x:g.x + 13, y:g.y - 13, w:chipW, h:26, name:g.name});
  txt(g.x + 26, g.y + 4, 'grp-title', g.name, 'start', null, content);
  if (g.sub) txt(g.x + 26 + gtw + 9, g.y + 4, 'grp-sub', g.sub, 'start', null, content);
}

// ── 엣지 경로 계산 ──
function cx(n){ return n.x + n.w / 2; }
function cy(n){ return n.y + n.h / 2; }
function parseEnd(ref){
  // ★ 그 이름의 노드가 실제로 있으면 그게 우선이다.
  //   'svc:right' 라는 id 를 가진 노드가 있는데 이걸 'svc' 의 오른쪽 면으로 읽으면
  //   감사도 깨끗한 채로 **엉뚱한 데 연결된 그림**이 나간다.
  if (NMAP[ref]) return {id:ref, side:''};
  var i = ref.lastIndexOf(':');
  var side = '';
  var id = ref;
  if (i > 0) {
    var maybe = ref.slice(i + 1);
    if (maybe === 'left' || maybe === 'right' || maybe === 'top' || maybe === 'bottom') {
      side = maybe; id = ref.slice(0, i);
    }
  }
  return {id:id, side:side};
}
function autoSides(a, b){
  var dx = cx(b) - cx(a), dy = cy(b) - cy(a);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ['right','left'] : ['left','right'];
  }
  return dy >= 0 ? ['bottom','top'] : ['top','bottom'];
}
function laneOffset(i, c, extent){
  if (c <= 1) return 0;
  // ⚠️ Math.max(7, …) 가 **면이 못 담는 간격도 강제**했다. 높이 54 인 노드에
  //    연결 10개를 붙이면 첫 연결점 y = -4.5, 마지막 58.5 로 **노드 밖에서 선이
  //    시작**했다(실측). 전부 면 안에 들어오는 간격으로 한 번 더 조인다.
  var margin = 6;                                   // 모서리 라운딩을 피한다
  var fit = Math.max(0, extent - margin * 2) / (c - 1);
  var step = Math.min(15, Math.max(7, (extent - 30) / (c - 1)));
  return (i - (c - 1) / 2) * Math.min(step, fit);
}
function anchor(n, side, idx, cnt){
  if (side === 'left' || side === 'right') {
    return [side === 'left' ? n.x : n.x + n.w, cy(n) + laneOffset(idx, cnt, n.h)];
  }
  return [cx(n) + laneOffset(idx, cnt, n.w), side === 'top' ? n.y : n.y + n.h];
}
function isH(side){ return side === 'left' || side === 'right'; }
// 면 위의 한 좌표(가로 면이면 y, 세로 면이면 x)가 모서리 둥근 곳(6px)을 뺀 면 안에 있는가.
function withinFace(n, side, v){
  return isH(side) ? (v >= n.y + 6 && v <= n.y + n.h - 6) : (v >= n.x + 6 && v <= n.x + n.w - 6);
}
// off = 중간 꺾임선을 옆으로 밀어내는 양. 같은 두 열 사이를 지나는 선들이
// 전부 같은 중간 좌표를 쓰면 한 줄로 겹친다 — 그걸 벌리는 데 쓴다.
function route(a, as, b, bs, off){
  var ax = a[0], ay = a[1], bx = b[0], by = b[1];
  var d = off || 0;
  // 8px 이하 어긋남은 꺾지 않고 곧게 잇는다. 꺾임 반경(9)보다 작아서
  // Z 로 꺾으면 직각이 아니라 잔물결이 된다.
  // 같은 쪽 면끼리(left→left 등)는 가운데서 꺾으면 한쪽 카드 속으로 되돌아 들어간다.
  //   더 바깥쪽 면에서 24px 밖으로 나가 돌아온다.
  var OUT = 24;
  if (as === bs && isH(as)) {
    var ox2 = as === 'left' ? Math.min(ax, bx) - OUT + d : Math.max(ax, bx) + OUT + d;
    return [[ax,ay],[ox2,ay],[ox2,by],[bx,by]];
  }
  if (as === bs) {
    var oy2 = as === 'top' ? Math.min(ay, by) - OUT + d : Math.max(ay, by) + OUT + d;
    return [[ax,ay],[ax,oy2],[bx,oy2],[bx,by]];
  }
  // 8px 이하 어긋남은 꺾지 않는다. 그렇다고 비스듬히 이으면 직각 선들 사이에서 튄다(고객사:
  //   차선 때문에 7.5px 밀린 nginx→keydb 선). 출발점 줄을 따라 곧게 가고 도착점을 그 줄로 맞춘다.
  //   도착점은 면 안에서 8px 이하로만 움직인다.
  if (isH(as) && isH(bs)) {
    if (Math.abs(ay - by) <= 8) return [[ax,ay],[bx,ay]];
    var mx = (ax + bx) / 2 + d;
    return [[ax,ay],[mx,ay],[mx,by],[bx,by]];
  }
  if (!isH(as) && !isH(bs)) {
    if (Math.abs(ax - bx) <= 8) return [[ax,ay],[ax,by]];
    var my = (ay + by) / 2 + d;
    return [[ax,ay],[ax,my],[bx,my],[bx,by]];
  }
  if (isH(as)) return [[ax,ay],[bx,ay],[bx,by]];
  return [[ax,ay],[ax,by],[bx,by]];
}
// hops[k] = k 번째 구간(pts[k] → pts[k+1]) 위에서 반원으로 넘어갈 x 좌표들.
//   가로 구간만 넘는다. 반원은 늘 위로 볼록하다.
function hopTo(d, a, b, xs){
  if (!xs || !xs.length) return d;
  var dir = b[0] > a[0] ? 1 : -1;
  var list = xs.slice().sort(function(p, q){ return (p - q) * dir; });
  for (var h = 0; h < list.length; h++) {
    d += ' L' + (list[h] - dir * HOP) + ',' + a[1] +
         ' A' + HOP + ',' + HOP + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + (list[h] + dir * HOP) + ',' + a[1];
  }
  return d;
}
function rpath(pts, r, hops){
  r = r || 9;
  hops = hops || [];
  var d = 'M' + pts[0][0] + ',' + pts[0][1];
  for (var i = 1; i < pts.length - 1; i++) {
    var p = pts[i-1], c = pts[i], nx = pts[i+1];
    var inLen = Math.hypot(c[0]-p[0], c[1]-p[1]);
    var outLen = Math.hypot(nx[0]-c[0], nx[1]-c[1]);
    var rr = Math.min(r, inLen/2, outLen/2);
    // ★ 축별 Math.sign 으로 r 만큼 물리면 직각에서는 맞지만 **대각선에서는 원래
    //   선을 벗어난다.** points=[[0,0],[100,1],[200,2]] 이면 거의 y=1 인 선이
    //   실제로는 y=-8~10 까지 벌어진다(감사는 원본 선분을 보므로 못 잡는다).
    //   방향 단위벡터로 물려야 어떤 각도에서도 선 위에 남는다.
    var iux = inLen ? (c[0]-p[0]) / inLen : 0, iuy = inLen ? (c[1]-p[1]) / inLen : 0;
    var oux = outLen ? (nx[0]-c[0]) / outLen : 0, ouy = outLen ? (nx[1]-c[1]) / outLen : 0;
    var ix = c[0] - iux * rr, iy = c[1] - iuy * rr;
    var ox = c[0] + oux * rr, oy = c[1] + ouy * rr;
    d = hopTo(d, p, c, hops[i-1]);
    d += ' L' + ix + ',' + iy + ' Q' + c[0] + ',' + c[1] + ' ' + ox + ',' + oy;
  }
  d = hopTo(d, pts[pts.length-2], pts[pts.length-1], hops[pts.length-2]);
  d += ' L' + pts[pts.length-1][0] + ',' + pts[pts.length-1][1];
  return d;
}

// 같은 노드의 같은 면에서 여러 선이 나가면 등간격으로 벌린다 (팬아웃 버스).
// ★ 키가 사용자(모델)가 준 노드 id 라서 사전은 전부 Object.create(null) 로 만든다.
//   보통 객체면 id 가 '__proto__' 일 때 대입이 키가 아니라 프로토타입을 바꿔
//   조회가 통째로 어긋난다.
var lanes = Object.create(null);
var plan = [];
for (var ei = 0; ei < S.edges.length; ei++) {
  var e = S.edges[ei];
  if (e.points && e.points.length >= 2) { plan.push({e:e, pts:e.points, a:null, b:null}); continue; }
  var fa = parseEnd(e.from), fb = parseEnd(e.to);
  var na = NMAP[fa.id], nb = NMAP[fb.id];
  if (!na || !nb) { plan.push({e:e, pts:null, a:null, b:null, bad:(na?e.to:e.from)}); continue; }
  var sides = autoSides(na, nb);
  var as = fa.side || sides[0], bs = fb.side || sides[1];
  var ka = fa.id + '|' + as, kb = fb.id + '|' + bs;
  lanes[ka] = (lanes[ka] || 0) + 1;
  lanes[kb] = (lanes[kb] || 0) + 1;
  plan.push({e:e, pts:null, a:{n:na, s:as, k:ka}, b:{n:nb, s:bs, k:kb}});
}
var auto = [];
for (var pj = 0; pj < plan.length; pj++) {
  var it = plan[pj];
  if (it.pts || !it.a) continue;
  auto.push(it);
}
// 같은 면의 차선은 배열 순서가 아니라 **상대편 위치 순서**로 준다.
// 순서대로 주면 마주 보는 타깃이 가장자리 차선에 걸려 괜히 꺾이고,
// 출발점 바로 앞에서 선끼리 교차한다.
var laneBuckets = Object.create(null);
for (var lb = 0; lb < auto.length; lb++) {
  var itb = auto[lb];
  (laneBuckets[itb.a.k] = laneBuckets[itb.a.k] || []).push({it:itb, end:'a'});
  (laneBuckets[itb.b.k] = laneBuckets[itb.b.k] || []).push({it:itb, end:'b'});
}
for (var lk in laneBuckets) {
  var arr = laneBuckets[lk];
  var hSide = isH(arr[0].end === 'a' ? arr[0].it.a.s : arr[0].it.b.s);
  arr.sort(function(x, y){
    var nx = x.end === 'a' ? x.it.b.n : x.it.a.n;
    var ny = y.end === 'a' ? y.it.b.n : y.it.a.n;
    return hSide ? (cy(nx) - cy(ny)) : (cx(nx) - cx(ny));
  });
  for (var li = 0; li < arr.length; li++) {
    if (arr[li].end === 'a') arr[li].it.ia = li; else arr[li].it.ib = li;
  }
}
// 한 면의 선이 전부 나가기만(또는 들어오기만) 하면 가운데 한 점을 같이 쓴다(버스).
//   차선으로 벌리면 둘 다 중심에서 빗나간다(서버 구성도 실측: 사용자 카드에서 DMZ 로 가는
//   두 선이 ±7.5px). 같은 점에서 나가 같은 자리에서 갈라지면 한 줄기로 읽힌다.
// 나가는 선과 들어오는 선이 섞인 면은 차선을 유지한다. 한 점을 쓰면 들어오는
//   화살촉이 나가는 선 머리에 꽂힌다.
var busFace = Object.create(null);
for (var bbk in laneBuckets) {
  var bba = laneBuckets[bbk];
  if (bba.length < 2) continue;
  var sameDir = true;
  for (var bbi = 1; bbi < bba.length; bbi++) {
    if (bba[bbi].end !== bba[0].end) { sameDir = false; break; }
    // 흐름 종류가 다르면 한 줄기를 쓰지 않는다. 실선과 점선이 포개지면 점선이 실선에
    //   묻혀 안 보인다(고객사 운영 구성도 실측: 7821 실선 위의 16380 backup 점선).
    if (planeOf(bba[bbi].it.e.plane).key !== planeOf(bba[0].it.e.plane).key) { sameDir = false; break; }
  }
  if (sameDir) busFace[bbk] = true;
}
for (var pa2 = 0; pa2 < auto.length; pa2++) {
  var ita = auto[pa2];
  ita.pa = anchor(ita.a.n, ita.a.s, ita.ia, busFace[ita.a.k] ? 1 : lanes[ita.a.k]);
  ita.pb = anchor(ita.b.n, ita.b.s, ita.ib, busFace[ita.b.k] ? 1 : lanes[ita.b.k]);
  ita.bus = busFace[ita.a.k] ? ita.a.k : (busFace[ita.b.k] ? ita.b.k : '');
}
// 버스는 한 자리에서 갈라져야 한 줄기로 보인다. 가장 가까운 상대까지의 절반에서 가른다.
var busSplit = Object.create(null);
for (var bs2 = 0; bs2 < auto.length; bs2++) {
  var bu = auto[bs2];
  if (!bu.bus) continue;
  var atA = bu.bus === bu.a.k;
  var bface = atA ? bu.pa : bu.pb, bother = atA ? bu.pb : bu.pa;
  var bside = atA ? bu.a.s : bu.b.s;
  var baxis = isH(bside) ? 0 : 1;
  var bdist = Math.abs(bother[baxis] - bface[baxis]);
  var bcur = busSplit[bu.bus];
  if (!bcur || bdist < bcur.dist) {
    busSplit[bu.bus] = {dist:bdist, at:bface[baxis], axis:baxis,
                        dir:(bside === 'right' || bside === 'bottom') ? 1 : -1};
  }
}
// 선의 양끝은 면의 가운데(차선이 있으면 그 차선)에서 옮기지 않는다.
// 예전엔 두 노드의 세로 구간이 겹치면 두 끝을 평균 자리로 끌어와 곧게 폈다. 곧기는
//   한데 **양끝이 둘 다 중심에서 빗나갔다**(서버 구성도 실측: was·db 사이 선이 양쪽 ±15px,
//   web02·푸시 서버 사이가 ±6.75px). 곧은 선은 입력에서 y(x)를 맞춰서 얻는다.
//   렌더러가 끝을 끌어다 맞추면 어긋남을 감출 뿐이다.
// 어긋난 두 면은 가운데서 한 번 꺾는다. 예전엔 기울기가 1:4 보다 완만하면 대각으로
//   이었는데, 세로로 300 내려가며 옆으로 40 밀린 선이 비스듬히 그려져 직각 선들 사이에서
//   혼자 튀었다(고객사 운영 구성도 실측). 꺾임 반경보다 작은 8px 이하 어긋남만 route 가 곧게 잇는다.

// ★ 같은 두 열 사이를 지나는 선들은 중간 꺾임 좌표가 전부 같아서 한 줄로 겹친다.
//   노드 배치가 규칙적일수록(= 보기 좋게 그릴수록) 더 잘 생긴다.
//   실제로 11노드 그림에서 세로선 3개가 겹쳤다. 버킷별로 등간격으로 벌린다.
function midKeyOf(it){
  if (it.a.s === it.b.s) return '';                           // 같은 쪽 면: 바깥으로 돈다. 통로가 아니다
  var hA = isH(it.a.s), hB = isH(it.b.s);
  if (hA && hB) {
    if (Math.abs(it.pa[1] - it.pb[1]) <= 8) return '';        // 일직선 — 꺾임 없음
    return 'h' + Math.round(((it.pa[0] + it.pb[0]) / 2) / 8);
  }
  if (!hA && !hB) {
    if (Math.abs(it.pa[0] - it.pb[0]) <= 8) return '';
    return 'v' + Math.round(((it.pa[1] + it.pb[1]) / 2) / 8);
  }
  return '';                                                  // ㄴ자 — 중간선이 없다
}
function laneRoute(it, col){
  return route(it.pa, it.a.s, it.pb, it.b.s, (col - (it.colors - 1) / 2) * 20);
}
function crossCount(U, cu, V, cv){
  var pu = laneRoute(U, cu), pv = laneRoute(V, cv), n = 0;
  for (var i = 0; i < pu.length - 1; i++) {
    for (var j = 0; j < pv.length - 1; j++) {
      var A = [pu[i][0], pu[i][1], pu[i+1][0], pu[i+1][1]], B = [pv[j][0], pv[j][1], pv[j+1][0], pv[j+1][1]];
      var d = (A[2]-A[0]) * (B[3]-B[1]) - (A[3]-A[1]) * (B[2]-B[0]);
      if (Math.abs(d) < 1e-9) continue;
      var t = ((B[0]-A[0]) * (B[3]-B[1]) - (B[1]-A[1]) * (B[2]-B[0])) / d;
      var u = ((B[0]-A[0]) * (A[3]-A[1]) - (B[1]-A[1]) * (A[2]-A[0])) / d;
      if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) n++;
    }
  }
  return n;
}
function spanOf(it, horiz){
  var ax = horiz ? 1 : 0;
  return [Math.min(it.pa[ax], it.pb[ax]), Math.max(it.pa[ax], it.pb[ax])];
}
function swapFree(grp, it, col, partner){
  var horiz = it.mk.charAt(0) === 'h', a = spanOf(it, horiz);
  for (var i = 0; i < grp.length; i++) {
    var w = grp[i];
    if (w === it || w === partner || w.midColor !== col) continue;
    var b = spanOf(w, horiz);
    if (a[0] <= b[1] + 6 && b[0] <= a[1] + 6) return false;
  }
  return true;
}
// 같은 쪽 면끼리 바깥으로 돌 때, 안쪽 카드에서 나가는(들어오는) 가로 구간이 바깥쪽 카드를 뚫을 수 있다
//   (두 카드가 같은 줄에 있으면 늘 그렇다). 그럴 땐 두 카드 위나 아래로 크게 돌아간다.
function rectHitSeg(n, x1, y1, x2, y2){
  var M = 3;
  var loX = Math.min(x1, x2), hiX = Math.max(x1, x2), loY = Math.min(y1, y2), hiY = Math.max(y1, y2);
  return hiX > n.x + M && loX < n.x + n.w - M && hiY > n.y + M && loY < n.y + n.h - M;
}
function sameSideDetour(it, pts){
  var A = it.a.n, B = it.b.n, s = it.a.s, OUT = 24;
  var firstBlocked = rectHitSeg(B, pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
  var lastBlocked = rectHitSeg(A, pts[pts.length-2][0], pts[pts.length-2][1], pts[pts.length-1][0], pts[pts.length-1][1]);
  if (!firstBlocked && !lastBlocked) return pts;
  var a = pts[0], b = pts[pts.length-1];
  if (isH(s)) {
    var dir = s === 'right' ? 1 : -1, ox = pts[1][0];
    var top = Math.min(A.y, B.y) - OUT, bot = Math.max(A.y + A.h, B.y + B.h) + OUT;
    var yd = Math.abs((a[1] + b[1]) / 2 - top) <= Math.abs(bot - (a[1] + b[1]) / 2) ? top : bot;
    if (firstBlocked) return [a, [a[0] + dir * OUT, a[1]], [a[0] + dir * OUT, yd], [ox, yd], [ox, b[1]], b];
    return [a, [ox, a[1]], [ox, yd], [b[0] + dir * OUT, yd], [b[0] + dir * OUT, b[1]], b];
  }
  var dv = s === 'bottom' ? 1 : -1, oy = pts[1][1];
  var lft = Math.min(A.x, B.x) - OUT, rgt = Math.max(A.x + A.w, B.x + B.w) + OUT;
  var xd = Math.abs((a[0] + b[0]) / 2 - lft) <= Math.abs(rgt - (a[0] + b[0]) / 2) ? lft : rgt;
  if (firstBlocked) return [a, [a[0], a[1] + dv * OUT], [xd, a[1] + dv * OUT], [xd, oy], [b[0], oy], b];
  return [a, [a[0], oy], [xd, oy], [xd, b[1] + dv * OUT], [b[0], b[1] + dv * OUT], b];
}
var midCount = Object.create(null);
for (var m1 = 0; m1 < auto.length; m1++) {
  auto[m1].mk = midKeyOf(auto[m1]);
  if (auto[m1].mk) midCount[auto[m1].mk] = (midCount[auto[m1].mk] || 0) + 1;
}
// 같은 복도라도 세로(가로) 구간이 안 겹치는 선은 같은 x(y) 에서 꺾어도 된다.
// 위로 가는 선과 아래로 가는 선을 괜히 벌리면 꺾이는 자리가 제각각이 된다.
// 겹치는 선끼리만 서로 다른 차선을 받는다 (그리디 색칠).
var midGroups = Object.create(null);
for (var mg = 0; mg < auto.length; mg++) {
  if (auto[mg].mk) (midGroups[auto[mg].mk] = midGroups[auto[mg].mk] || []).push(auto[mg]);
}
for (var gk in midGroups) {
  var grp = midGroups[gk];
  var horiz = gk.charAt(0) === 'h';
  var colors = 1;
  for (var gi = 0; gi < grp.length; gi++) {
    var ii = grp[gi];
    var ax = horiz ? 1 : 0;
    var lo3 = Math.min(ii.pa[ax], ii.pb[ax]), hi3 = Math.max(ii.pa[ax], ii.pb[ax]);
    var used = [];
    for (var gj = 0; gj < gi; gj++) {
      var jj = grp[gj];
      var lo4 = Math.min(jj.pa[ax], jj.pb[ax]), hi4 = Math.max(jj.pa[ax], jj.pb[ax]);
      if (lo3 <= hi4 + 6 && lo4 <= hi3 + 6) used.push(jj.midColor);
    }
    var col = 0;
    while (used.indexOf(col) >= 0) col++;
    ii.midColor = col;
    if (col + 1 > colors) colors = col + 1;
  }
  for (var gc = 0; gc < grp.length; gc++) grp[gc].colors = colors;
  // 칠한 순서대로 차선을 주면 같은 두 선이 통로 안에서 두 번 엇갈릴 수 있다(고객사: AP2 에서 내려오는
  //   5432 와 6820). 차선이 다른 두 선의 차선을 바꿔 서로 건너는 횟수가 줄면 바꾼다.
  for (var sw = 0; sw < grp.length; sw++) {
    for (var sw2 = sw + 1; sw2 < grp.length; sw2++) {
      var U = grp[sw], V = grp[sw2];
      if (U.midColor === V.midColor) continue;
      // 바꾼 차선이 구간이 겹치는 제3의 선과 같아지면 두 선이 한 줄로 포개진다. 그럴 땐 안 바꾼다.
      if (!swapFree(grp, U, V.midColor, V) || !swapFree(grp, V, U.midColor, U)) continue;
      var before = crossCount(U, U.midColor, V, V.midColor);
      var after = crossCount(U, V.midColor, V, U.midColor);
      if (after < before) { var tmpc = U.midColor; U.midColor = V.midColor; V.midColor = tmpc; }
    }
  }
}
for (var m2 = 0; m2 < auto.length; m2++) {
  var im = auto[m2];
  var off = 0;
  // 통로 차선은 20px 씩 벌린다. 15px 이면 옆 차선의 꺾임(반경 9)과 교차 반원(6)이 맞닿아
  //   반원을 넣을 자리가 없었다(고객사 운영 서버 간 AJP 두 선).
  if (im.mk) off = (im.midColor - (im.colors - 1) / 2) * 20;
  var sp = im.bus && im.a.s !== im.b.s ? busSplit[im.bus] : null;
  if (sp) {
    // route 는 꺾는 자리를 (a+b)/2 + off 로 잡는다. 버스가 갈라지는 자리에 맞춘다.
    var splitAt = sp.at + sp.dir * sp.dist / 2;
    if (sp.axis === 0 && isH(im.a.s) && isH(im.b.s)) off = splitAt - (im.pa[0] + im.pb[0]) / 2;
    else if (sp.axis === 1 && !isH(im.a.s) && !isH(im.b.s)) off = splitAt - (im.pa[1] + im.pb[1]) / 2;
  }
  im.pts = route(im.pa, im.a.s, im.pb, im.b.s, off);
  if (im.a.s === im.b.s) im.pts = sameSideDetour(im, im.pts);
  // 8px 이하 어긋남을 곧게 펴며 도착점을 출발점 줄로 옮겼다. 어긋남은 대개 한쪽 면의 차선 때문이다.
  //   차선이 있는 끝을 가운데로 끌어오면 차선 간격이 무너져 옆 선과 7.5px 로 붙는다(무작위 그림에서
  //   찾음). 차선이 있는 끝이 도착점이면 그 줄을 지키고 출발점을 옮긴다. 옮긴 끝이 면 밖으로 나가면
  //   반대쪽을 옮기고, 둘 다 안 되면 원래 두 점을 그대로 잇는다.
  if (im.pts.length === 2) {
    var ax2 = isH(im.a.s) ? 1 : 0;
    if (lanes[im.b.k] > 1 && lanes[im.a.k] === 1 && Math.abs(im.pa[ax2] - im.pb[ax2]) > 0.01 &&
        withinFace(im.a.n, im.a.s, im.pb[ax2])) {
      im.pts = ax2 ? [[im.pa[0], im.pb[1]], im.pb] : [[im.pb[0], im.pa[1]], im.pb];
    } else if (!withinFace(im.b.n, im.b.s, im.pts[1][ax2])) {
      if (withinFace(im.a.n, im.a.s, im.pb[ax2])) {
        im.pts = ax2 ? [[im.pa[0], im.pb[1]], im.pb] : [[im.pb[0], im.pa[1]], im.pb];
      } else {
        im.pts = [im.pa, im.pb];
      }
    }
  }
}

// ── 교차는 반원으로 넘는다 ──
// 서버 두 대가 서로의 tomcat 으로 넘기는 선처럼 구조상 피할 수 없는 교차가 있다(고객사 운영).
//   그냥 가로지르면 어느 선이 어디로 꺾였는지 헷갈린다. 가로 구간이 세로 구간을 반원으로 넘는다.
//   꺾임(반경 9)과 반원이 겹치지 않게 구간 양끝에서 HOP+10 안쪽일 때만 넘는다. 넘지 못한 교차와
//   한 선이 두 번 이상 넘는 것은 자가감사(overlap)가 알린다. 교차가 여럿이면 배치를 고칠 일이다.
var HOP = 6;
for (var h1 = 0; h1 < plan.length; h1++) plan[h1].hops = [];
for (var h1 = 0; h1 < plan.length; h1++) {
  var PH = plan[h1];
  if (!PH.pts) continue;
  for (var hk = 0; hk < PH.pts.length - 1; hk++) {
    var A1 = PH.pts[hk], A2 = PH.pts[hk+1];
    if (Math.abs(A1[1] - A2[1]) > 0.5 || Math.abs(A1[0] - A2[0]) < 1) continue;
    var lo = Math.min(A1[0], A2[0]), hi = Math.max(A1[0], A2[0]);
    for (var h2 = 0; h2 < plan.length; h2++) {
      var PV = plan[h2];
      if (h2 === h1 || !PV.pts) continue;
      for (var vk = 0; vk < PV.pts.length - 1; vk++) {
        var B1 = PV.pts[vk], B2 = PV.pts[vk+1];
        if (Math.abs(B1[0] - B2[0]) > 0.5 || Math.abs(B1[1] - B2[1]) < 1) continue;
        var vx = B1[0], vlo = Math.min(B1[1], B2[1]), vhi = Math.max(B1[1], B2[1]);
        if (vx > lo + HOP + 10 && vx < hi - HOP - 10 && A1[1] > vlo + HOP + 10 && A1[1] < vhi - HOP - 10) {
          (PH.hops[hk] = PH.hops[hk] || []).push(vx);
          PH.hopCount = (PH.hopCount || 0) + 1;
          (PH.hopped = PH.hopped || []).push(h2);
        }
      }
    }
  }
}

var badRefs = [];
for (var pk = 0; pk < plan.length; pk++) {
  var itm = plan[pk];
  if (itm.bad) { badRefs.push(itm.bad); continue; }
  if (!itm.pts) continue;
  var pln = planeOf(itm.e.plane);
  // ★ itm.e.plane 을 그대로 쓰면 없는 key 일 때 marker 를 못 찾아 화살촉이 조용히
  //   사라진다. planeOf() 가 되돌려준 **실재하는** 평면의 key 를 쓴다.
  var pathEl = el('path', {d:rpath(itm.pts, 9, itm.hops), fill:'none', stroke:pln.color,
                           'stroke-width':1.8, 'marker-end':'url(#arr-'+pln.key+')'}, content);
  if (pln.dash) pathEl.setAttribute('stroke-dasharray', pln.dash);
}

// ── 노드 (엣지 위에 올라간다) ──
function drawIcon(name, cxp, cyp, color){
  var prims = S.icons[name];
  if (!prims) return;
  var size = 30;
  el('rect', {x:cxp - size/2, y:cyp - size/2, width:size, height:size, rx:9, fill:color}, content);
  var s = 0.86;
  var g = el('g', {transform:'translate(' + (cxp - 12*s) + ',' + (cyp - 12*s) + ') scale(' + s + ')',
                   fill:'none', stroke:'#ffffff', 'stroke-width':2,
                   'stroke-linecap':'round', 'stroke-linejoin':'round'}, content);
  for (var q = 0; q < prims.length; q++) {
    var pr = prims[q];
    if (pr[0] === 'r') el('rect', {x:pr[1], y:pr[2], width:pr[3], height:pr[4], rx:pr[5]}, g);
    else if (pr[0] === 'c') el('circle', {cx:pr[1], cy:pr[2], r:pr[3]}, g);
    else if (pr[0] === 'e') el('ellipse', {cx:pr[1], cy:pr[2], rx:pr[3], ry:pr[4]}, g);
    else if (pr[0] === 'd') el('circle', {cx:pr[1], cy:pr[2], r:pr[3], fill:'#ffffff', stroke:'none'}, g);
    else if (pr[0] === 'l') el('line', {x1:pr[1], y1:pr[2], x2:pr[3], y2:pr[4]}, g);
    else if (pr[0] === 'p') el('path', {d:pr[1]}, g);
  }
}
var compressed = [], nodeTexts = [];
function fit(t, maxW){
  if (t.getBBox().width > maxW) {
    t.setAttribute('textLength', maxW);
    t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    compressed.push(t.textContent);
  }
}
for (var nj = 0; nj < S.nodes.length; nj++) {
  var nd = S.nodes[nj];
  el('rect', {x:nd.x, y:nd.y, width:nd.w, height:nd.h, rx:11, fill:'#ffffff',
              stroke:'#d1d5db', 'stroke-width':1.3,
              filter:'drop-shadow(0 1.5px 3px rgba(15,23,42,.09))'}, content);
  var ncx = nd.x + nd.w / 2;
  var t1y, iy;
  if (nd.sub) { iy = nd.y + 27; t1y = nd.y + 59; }
  else if (nd.icon) { iy = nd.y + 25; t1y = nd.y + 58; }
  else { t1y = nd.y + nd.h / 2 + 5; iy = 0; }
  if (nd.icon) drawIcon(nd.icon, ncx, iy, nd.iconColor);
  var t1 = txt(ncx, t1y, 'n-title', nd.title, 'middle', null, content);
  fit(t1, nd.w - 18); nodeTexts.push([t1, nd]);
  if (nd.sub) {
    var t2 = txt(ncx, nd.y + 76, 'n-sub', nd.sub, 'middle', null, content);
    fit(t2, nd.w - 16); nodeTexts.push([t2, nd]);
  }
  if (nd.tag) {
    var tgw = nd.tagBoxW || (measure(nd.tag, 'tag-t') + 16);
    var tgx = nd.x + nd.w - tgw - 9, tgy = nd.y + 9;
    el('rect', {x:tgx, y:tgy, width:tgw, height:19, rx:6, fill:nd.tagColor}, content);
    txt(tgx + tgw/2, tgy + 13.5, 'tag-t', nd.tag, 'middle', null, content);
  }
}

// ── 라벨 (맨 위. 흰 테두리로 선 위에서도 읽히게) ──
// ★ 라벨을 '가장 긴 구간'에만 두면 대개 노드 바로 옆 첫 구간에 붙는다.
//   거기는 카드와 다른 선이 몰리는 자리라 실제로 라벨끼리 겹쳤다(실물 확인).
//   꺾임이 있는 경로는 가운데 구간이 비어 있는 게 보통이라 그쪽을 먼저 본다.
var labelEls = [];
var placedBoxes = [];

function segsOf(pts){
  var out = [];
  for (var i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i+1]]);
  return out;
}
function segLen(sg){ return Math.hypot(sg[1][0]-sg[0][0], sg[1][1]-sg[0][1]); }

// ★ 라벨 자리는 한 곳으로 정하지 않는다.
//   '가장 긴 구간' 하나만 쓰면 대개 노드에 붙은 첫 구간에 놓여 카드 위로 올라가고,
//   같은 노드에서 갈라지는 두 선의 라벨이 서로 겹친다(둘 다 실물로 확인했다).
//   그래서 후보를 여러 개 만들어 두고, 겹치지 않는 첫 자리를 고른다.
//   전부 겹치면 첫 후보로 두고 자가감사가 보고한다 — 조용히 넘기지 않는다.
function labelCandidates(pts){
  var segs = segsOf(pts);
  var order = [];
  if (segs.length >= 3) order.push(segs[Math.floor(segs.length / 2)]);
  var sorted = segs.slice().sort(function(a, b){ return segLen(b) - segLen(a); });
  for (var i = 0; i < sorted.length; i++) order.push(sorted[i]);

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var sg = order[j];
    if (segLen(sg) < 26) continue;
    // 가운데가 막히면 긴 구간의 1/4, 3/4 자리도 본다. 가운데만 보면 남의 선이 지나는
    //   자리에서 갈 곳이 없어 첫 후보로 돌아간다.
    var fr = segLen(sg) >= 140 ? [0.5, 0.25, 0.75] : [0.5];
    for (var fi = 0; fi < fr.length; fi++) {
      var mx = sg[0][0] + (sg[1][0] - sg[0][0]) * fr[fi], my = sg[0][1] + (sg[1][1] - sg[0][1]) * fr[fi];
      if (Math.abs(sg[0][1] - sg[1][1]) < 0.6) {      // 수평 구간: 위/아래
        out.push([mx, my - 7, 'middle']);
        out.push([mx, my + 16, 'middle']);
      } else {                                        // 수직 구간: 왼쪽/오른쪽
        // 기준선을 중점에 두면 글자가 위로 올라가 한쪽 카드에 치우친다. 글자 높이의
        //   절반(11px 글꼴에서 4)만큼 내려 글자 가운데를 중점에 맞춘다. 간격도 8 이면
        //   흰 테두리(4.5px) 때문에 선에 붙어 보여 12 로 둔다(서버 구성도 'POST /url :6820').
        out.push([mx - 12, my + 4, 'end']);
        out.push([mx + 12, my + 4, 'start']);
      }
    }
  }
  if (!out.length) out.push([pts[0][0], pts[0][1] - 7, 'middle']);
  return out;
}
function place(t, x, y, anchor){
  t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor);
}
// 두 선이 한 면을 같이 쓰면(버스나 차선) 형제다. 형제 선 위의 라벨, 형제끼리 붙어 가는
//   구간은 의도한 모양이라 감사에서 뺀다.
function faceKeys(it){ return it.a ? [it.a.k, it.b.k] : []; }
function siblings(p, q){
  var kp = faceKeys(p), kq = faceKeys(q);
  for (var i = 0; i < kp.length; i++) if (kq.indexOf(kp[i]) >= 0) return true;
  return false;
}
// 선분이 상자를 지나는가(Liang-Barsky). m 만큼 상자를 넓혀 본다.
function segHitsBox(x1, y1, x2, y2, bx, m){
  var minX = bx.x - m, maxX = bx.x + bx.w + m, minY = bx.y - m, maxY = bx.y + bx.h + m;
  var dx = x2 - x1, dy = y2 - y1;
  var p = [-dx, dx, -dy, dy], q = [x1 - minX, maxX - x1, y1 - minY, maxY - y1];
  var t0 = 0, t1 = 1;
  for (var i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return false; continue; }
    var t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}
function pathHitsBox(pts, bx, m){
  for (var i = 0; i < pts.length - 1; i++) {
    if (segHitsBox(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], bx, m)) return true;
  }
  return false;
}
// 라벨이 남의 선 위에 얹히면 어느 선의 라벨인지 헷갈린다. 고객사 운영 구성도에서
//   'redis 16379' 가 AP2 의 5432 주황선 위에 얹혔다. 자리를 고를 때부터 피한다.
// 형제 선(한 면을 같이 씀)은 줄기를 같이 쓰는 구간만 봐주고, 갈라진 뒤의 구간은 남의 선처럼 본다.
//   형제를 통째로 빼면 'redis 16379' 가 같은 면에서 갈라진 5432 선 위에 얹혀도 통과했다(고객사).
function onPath(sg, pts){
  for (var i = 0; i < pts.length - 1; i++) {
    var A = [pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]];
    var ax = A[2]-A[0], ay = A[3]-A[1], la = Math.hypot(ax, ay);
    if (la < 1) continue;
    var ux = ax/la, uy = ay/la;
    var d0 = Math.abs((sg[0]-A[0]) * uy - (sg[1]-A[1]) * ux), d1 = Math.abs((sg[2]-A[0]) * uy - (sg[3]-A[1]) * ux);
    if (d0 > 1 || d1 > 1) continue;
    var t0 = (sg[0]-A[0]) * ux + (sg[1]-A[1]) * uy, t1 = (sg[2]-A[0]) * ux + (sg[3]-A[1]) * uy;
    if (Math.min(t0, t1) >= -1 && Math.max(t0, t1) <= la + 1) return true;
  }
  return false;
}
function otherHitsBox(other, mine, box){
  var sib = siblings(other, mine);
  var P = other.pts;
  for (var i = 0; i < P.length - 1; i++) {
    var sg = [P[i][0], P[i][1], P[i+1][0], P[i+1][1]];
    if (sib && onPath(sg, mine.pts)) continue;
    // 2px 여유를 둔다. 라벨 흰 테두리(4.5px)가 있어 상자 끝에 딱 붙은 선도 글자에 닿아 보인다
    //   (15px 간격 두 선 사이에 낀 라벨이 위 선을 스쳤다. 무작위 그림에서 찾음).
    if (segHitsBox(sg[0], sg[1], sg[2], sg[3], box, 2)) return true;
  }
  return false;
}
function labelCollides(box, self){
  for (var i = 0; i < S.nodes.length; i++) {
    var n = S.nodes[i];
    if (boxesOverlap(box, {x:n.x, y:n.y, w:n.w, h:n.h})) return true;
  }
  for (var j = 0; j < placedBoxes.length; j++) {
    if (boxesOverlap(box, placedBoxes[j])) return true;
  }
  for (var k = 0; k < plan.length; k++) {
    if (k === self || !plan[k].pts) continue;
    if (otherHitsBox(plan[k], plan[self], box)) return true;
  }
  // 그룹 이름표와 테두리도 피한다. 감사는 잡는데 자리 고르기가 안 보면 피할 수 있던 자리를 놓친다.
  for (var c = 0; c < CHIPS.length; c++) if (boxesOverlap(box, CHIPS[c])) return true;
  for (var g = 0; g < S.groups.length; g++) {
    var G = S.groups[g];
    if (G.x === undefined) continue;
    var inG = box.x >= G.x && box.y >= G.y && box.x + box.w <= G.x + G.w && box.y + box.h <= G.y + G.h;
    if (!inG && boxesOverlap(box, {x:G.x, y:G.y, w:G.w, h:G.h})) {
      var outG = box.x + box.w <= G.x || box.x >= G.x + G.w || box.y + box.h <= G.y || box.y >= G.y + G.h;
      if (!outG) return true;
    }
  }
  return false;
}

for (var pm = 0; pm < plan.length; pm++) {
  var itl = plan[pm];
  if (!itl.pts || !itl.e.label) continue;
  var t = txt(0, 0, 'e-label', itl.e.label, 'middle', planeOf(itl.e.plane).color, content);
  if (itl.e.labelAt) {
    place(t, itl.e.labelAt[0], itl.e.labelAt[1], itl.e.labelAnchor || 'middle');
  } else {
    var cands = labelCandidates(itl.pts);
    var settled = false;
    for (var ci = 0; ci < cands.length; ci++) {
      place(t, cands[ci][0], cands[ci][1], cands[ci][2]);
      if (!labelCollides(boxOf(t), pm)) { settled = true; break; }
    }
    if (!settled) place(t, cands[0][0], cands[0][1], cands[0][2]);
  }
  placedBoxes.push(boxOf(t));
  labelEls.push([t, itl.e.label, pm]);
}

// ── 캔버스 되맞춤: 그린 결과에 맞춰 크기와 위치를 정한다 (잘림 방지) ──
svg.removeChild(scratch);
var bb = content.getBBox();
var dx = PAD - bb.x, dy = headerBottom + GAP - bb.y;
content.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
var W = Math.ceil(Math.max(bb.width + PAD*2, headerW + PAD*2, 720));
var H = Math.ceil(headerBottom + GAP + bb.height + PAD);

// ★★ 크기를 **설정하기 전에** 본다. 이 순서가 전부다.
//   예전엔 여기서 그냥 크기를 박고, 상한 검사는 바깥(render/index.ts)에서 DOM 을
//   받은 뒤에 했다. 그런데 브라우저는 width/height 를 받는 순간 그만한 레이아웃·
//   페인트 표면을 잡는다 — 실측으로 40068×40150 을 설정했더니 **0.2초 만에 43GB** 를
//   잡았다(48GB 기계가 그대로 멈췄다). 바깥에서 아무리 빨리 막아도 이미 늦는다.
//   그래서 캔버스는 여기서 거르고, 넘으면 크기를 아예 설정하지 않는다.
if (W > S.maxDim || H > S.maxDim || W * H > S.maxArea) {
  document.title = 'AUDIT_TOO_BIG ' + JSON.stringify({w:W, h:H, maxDim:S.maxDim, maxArea:S.maxArea});
  return;
}

svg.setAttribute('width', W); svg.setAttribute('height', H);
svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
document.getElementById('wrap').style.width = W + 'px';
document.getElementById('wrap').style.height = H + 'px';

// ── 자가감사 ──
var over = [];
for (var oi = 0; oi < nodeTexts.length; oi++) {
  var tt = nodeTexts[oi][0], on = nodeTexts[oi][1];
  var b = tt.getBBox();
  if (b.x < on.x + 4) over.push('좌: ' + tt.textContent);
  else if (b.x + b.width > on.x + on.w - 4) over.push('우: ' + tt.textContent);
  else if (b.y + b.height > on.y + on.h - 1) over.push('하: ' + tt.textContent);
}
function segs(pts){
  var out = [];
  for (var i = 0; i < pts.length - 1; i++) out.push([pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]]);
  return out;
}
// ★ 처음엔 직각 선분만 검사했다. 그러면 points 로 직접 준 **대각선**이 노드를
//   그대로 지나가도 감사를 통과한다. 선분-사각형 교차를 일반적으로 푼다
//   (Liang-Barsky). 가장자리에 붙어 지나가는 건 문제가 아니므로 3px 안쪽으로 좁힌다.
function hitsRect(s, r){
  var M = 3;
  var minX = r.x + M, maxX = r.x + r.w - M;
  var minY = r.y + M, maxY = r.y + r.h - M;
  if (maxX <= minX || maxY <= minY) return false;
  var dx = s[2] - s[0], dy = s[3] - s[1];
  var p = [-dx, dx, -dy, dy];
  var q = [s[0] - minX, maxX - s[0], s[1] - minY, maxY - s[1]];
  var t0 = 0, t1 = 1;
  for (var i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) { if (q[i] < 0) return false; continue; }
    var t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 < t1;
}
var cross = [];
for (var ci = 0; ci < plan.length; ci++) {
  var ic = plan[ci];
  if (!ic.pts) continue;
  // 여기도 Object.create(null) 이어야 한다. 보통 객체면 own['constructor'] 가
  //   상속 프로퍼티라 **항상 참**이라, id 가 'constructor' 인 노드는 관통 검사에서
  //   통째로 빠진다. NMAP 등은 고쳤는데 이것만 남아 있었다.
  // 여기도 Object.create(null) 이어야 한다. 보통 객체면 own['constructor'] 가
  //   상속 프로퍼티라 **항상 참**이라, id 가 'constructor' 인 노드는 관통 검사에서
  //   통째로 빠진다.
  //
  // 양끝 노드는 **일반 관통 검사에서 뺀다.** 연결점이 자기 면에 붙어 있어서
  //   그대로 검사하면 정상 그림도 「관통」이 된다(실측: 노드 둘·연결 하나짜리
  //   기본 그림이 cross 2건). 대신 아래에서 «면을 등지고 출발했는가» 를 따로 본다 —
  //   그게 «자기 카드를 가로지르는» 경우의 진짜 특징이다.
  var own = Object.create(null);
  if (ic.a) { own[ic.a.n.id] = 1; own[ic.b.n.id] = 1; }
  var ss = segs(ic.pts);
  // points 로 직접 그린 선은 끝이 카드 면에 닿는지 아무도 안 봤다. 고객사 구성도에서
  //   화살촉이 카드 옆 빈자리를 가리키고, 선이 카드 아래 15px 허공에서 시작했다.
  //   끝점은 어느 카드든 테두리 위(2px 안)여야 한다.
  if (!ic.a) {
    var tips = [ic.pts[0], ic.pts[ic.pts.length - 1]];
    for (var tp = 0; tp < tips.length; tp++) {
      var onFace = false;
      for (var tn = 0; tn < S.nodes.length && !onFace; tn++) {
        var nd2 = S.nodes[tn], px = tips[tp][0], py = tips[tp][1];
        var inX = px >= nd2.x - 2 && px <= nd2.x + nd2.w + 2, inY = py >= nd2.y - 2 && py <= nd2.y + nd2.h + 2;
        var nearV = Math.abs(px - nd2.x) <= 2 || Math.abs(px - nd2.x - nd2.w) <= 2;
        var nearH = Math.abs(py - nd2.y) <= 2 || Math.abs(py - nd2.y - nd2.h) <= 2;
        // 닿은 카드도 관통 검사에서 빼지 않는다. 면에서 바깥으로 나가는 구간은 카드 안쪽(3px)을
        //   안 지나므로 걸리지 않고, 제 카드를 가로지르는 구간만 걸린다(무작위 그림에서 찾음).
        if ((nearV && inY) || (nearH && inX)) onFace = true;
      }
      if (!onFace) cross.push((ic.e.label || ('선#' + ci)) + (tp ? ' 화살촉' : ' 시작점') + '이 카드 면에 닿지 않음');
    }
  }
  // 연결점에서 **면 바깥쪽으로** 출발했는지 본다. left 면에서 출발했는데 첫
  //   걸음이 오른쪽이면 그 선은 자기 카드 속으로 들어간 것이다. 실측(코덱스 16차):
  //   A 의 left 에서 오른쪽의 B 로 가는 연결이 두 카드 속을 지나는데 cross 가 비었다.
  //   면에 «닿는» 것과 «뚫고 들어가는» 것을 방향으로 가른다 — 위치로는 못 가른다.
  if (ic.a && ss.length) {
    var ends = [[ic.a, ss[0], 1], [ic.b, ss[ss.length - 1], -1]];
    for (var ei2 = 0; ei2 < ends.length; ei2++) {
      var end = ends[ei2][0], seg = ends[ei2][1], dir = ends[ei2][2];
      var vx = (seg[2] - seg[0]) * dir, vy = (seg[3] - seg[1]) * dir;
      var into =
        (end.s === 'left' && vx > 0.5) || (end.s === 'right' && vx < -0.5) ||
        (end.s === 'top' && vy > 0.5) || (end.s === 'bottom' && vy < -0.5);
      if (into) {
        cross.push((ic.e.label || ('선#' + ci)) + ' → 노드 ' + (end.n.title || end.n.id) + ' 관통');
      }
    }
    // 양끝 카드라도 제 면에 붙은 구간이 아닌 곳에서 지나가면 관통이다. 같은 줄의 두 카드를 같은 쪽
    //   면끼리 이으면 바깥으로 나가는 길에 상대 카드를 뚫었는데, 양끝 카드는 검사에서 빠져 통과했다
    //   (독립 측정기로 무작위 그림을 돌려 찾음).
    var endHit = false;
    for (var eh = 1; eh < ss.length && !endHit; eh++) if (hitsRect(ss[eh], ic.a.n)) endHit = true;
    if (endHit) cross.push((ic.e.label || ('선#' + ci)) + ' → 노드 ' + (ic.a.n.title || ic.a.n.id) + ' 관통');
    endHit = false;
    for (var eh2 = 0; eh2 < ss.length - 1 && !endHit; eh2++) if (hitsRect(ss[eh2], ic.b.n)) endHit = true;
    if (endHit && ic.b.n !== ic.a.n) cross.push((ic.e.label || ('선#' + ci)) + ' → 노드 ' + (ic.b.n.title || ic.b.n.id) + ' 관통');
  }
  for (var cj = 0; cj < S.nodes.length; cj++) {
    var cn = S.nodes[cj];
    if (own[cn.id]) continue;
    for (var ck = 0; ck < ss.length; ck++) {
      if (hitsRect(ss[ck], cn)) {
        cross.push((ic.e.label || ('선#' + ci)) + ' → 노드 ' + (cn.title || cn.id) + ' 관통');
        ck = ss.length;
      }
    }
  }
  // 그룹 이름표도 본다. 노드만 보던 때 푸시 서버 그룹 이름이 선에 가려진 채 통과했다.
  for (var chx = 0; chx < CHIPS.length; chx++) {
    for (var ck2 = 0; ck2 < ss.length; ck2++) {
      if (hitsRect(ss[ck2], CHIPS[chx])) {
        cross.push((ic.e.label || ('선#' + ci)) + ' → 그룹 이름표 ' + CHIPS[chx].name + ' 가림');
        ck2 = ss.length;
      }
    }
  }
}
// ★ 처음엔 수평-수평, 수직-수직만 비교했다. 그러면 똑같은 **대각선** 두 개가
//   완전히 포개져도 통과한다. 각도에 상관없이 '평행하고 같은 직선 위이며 구간이
//   겹치는가'로 본다.
// ★ 한쪽 방향만 재면 '짧은 선을 기준으로 보면 겹침, 긴 선을 기준으로 보면 아님'
//   같은 일이 생긴다(엣지 순서에 따라 답이 달라진다). 양방향으로 본다.
function collinearOverlap(A, B){
  return collinearOverlapOneWay(A, B) || collinearOverlapOneWay(B, A);
}
function collinearOverlapOneWay(A, B){
  var ax = A[2]-A[0], ay = A[3]-A[1];
  var bx = B[2]-B[0], by = B[3]-B[1];
  var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1 || lb < 1) return false;
  // 평행? (단위벡터 외적이 거의 0)
  if (Math.abs((ax*by - ay*bx) / (la*lb)) > 0.02) return false;
  // 같은 직선 위? ★ B 의 **양 끝**을 다 본다. 시작점 하나만 재면 거의 평행한
  //   선분에서 점 순서를 뒤집는 것만으로 답이 달라진다(실측으로 확인된 오탐).
  var ux = ax/la, uy = ay/la;
  var d0 = Math.abs((B[0]-A[0]) * uy - (B[1]-A[1]) * ux);
  var d1 = Math.abs((B[2]-A[0]) * uy - (B[3]-A[1]) * ux);
  if (Math.max(d0, d1) > 3) return false;
  // 구간이 실제로 겹치는가 (A 방향으로 투영)
  function proj(px, py){ return ((px-A[0]) * ax + (py-A[1]) * ay) / la; }
  var a0 = 0, a1 = la;
  var b0 = proj(B[0], B[1]), b1 = proj(B[2], B[3]);
  var lo = Math.max(Math.min(a0,a1), Math.min(b0,b1));
  var hi = Math.min(Math.max(a0,a1), Math.max(b0,b1));
  return hi - lo > 20;
}
// 겹치지는 않아도 10px 안으로 나란히 40px 넘게 가면 한 줄로 읽힌다. 고객사 운영
//   구성도에서 서버 간 AJP 두 선이 8px 간격으로 나란히 가 양방향 화살표 하나처럼 보였다.
function nearParallel(A, B){
  var ax = A[2]-A[0], ay = A[3]-A[1], bx = B[2]-B[0], by = B[3]-B[1];
  var la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1 || lb < 1) return false;
  if (Math.abs((ax*by - ay*bx) / (la*lb)) > 0.02) return false;
  var ux = ax/la, uy = ay/la;
  var d0 = Math.abs((B[0]-A[0]) * uy - (B[1]-A[1]) * ux);
  if (d0 > 10) return false;
  var b0 = ((B[0]-A[0]) * ux + (B[1]-A[1]) * uy), b1 = ((B[2]-A[0]) * ux + (B[3]-A[1]) * uy);
  return Math.min(la, Math.max(b0, b1)) - Math.max(0, Math.min(b0, b1)) > 40;
}
// 선끼리 가로지르면 어느 선이 어디로 가는지 따라가기 어렵다. 선분 안쪽에서 만날 때만
//   센다(끝점이 닿는 것은 꺾임이나 연결점이라 교차가 아니다).
// 한 선의 꺾인 모서리가 다른 선 한가운데에 닿는 T자 접촉도 엇갈림이다. 두 선이 같은 높이에서 마주 와
//   17px 포개진 뒤 서로의 모서리를 밟고 내려간 그림이 겹침(20px 기준)에도 교차(선분 안쪽끼리만 셈)에도
//   안 걸렸다(무작위 그림에서 찾음). 양쪽 다 끝점에서 만나는 것(꺾임끼리 맞닿음)은 세지 않는다.
function touchCross(A, B){
  var d = (A[2]-A[0]) * (B[3]-B[1]) - (A[3]-A[1]) * (B[2]-B[0]);
  if (Math.abs(d) < 1e-9) return false;
  var t = ((B[0]-A[0]) * (B[3]-B[1]) - (B[1]-A[1]) * (B[2]-B[0])) / d;
  var u = ((B[0]-A[0]) * (A[3]-A[1]) - (B[1]-A[1]) * (A[2]-A[0])) / d;
  var la = Math.hypot(A[2]-A[0], A[3]-A[1]), lb = Math.hypot(B[2]-B[0], B[3]-B[1]);
  var tol = 0.5;
  if (t * la < -tol || (1 - t) * la < -tol || u * lb < -tol || (1 - u) * lb < -tol) return false;
  var aIn = t * la > 3 && (1 - t) * la > 3, bIn = u * lb > 3 && (1 - u) * lb > 3;
  return (aIn || bIn) && !(aIn && bIn);
}
function properCross(A, B){
  var d = (A[2]-A[0]) * (B[3]-B[1]) - (A[3]-A[1]) * (B[2]-B[0]);
  if (Math.abs(d) < 1e-9) return false;
  var t = ((B[0]-A[0]) * (B[3]-B[1]) - (B[1]-A[1]) * (B[2]-B[0])) / d;
  var u = ((B[0]-A[0]) * (A[3]-A[1]) - (B[1]-A[1]) * (A[2]-A[0])) / d;
  var la = Math.hypot(A[2]-A[0], A[3]-A[1]), lb = Math.hypot(B[2]-B[0], B[3]-B[1]);
  return t * la > 3 && (1 - t) * la > 3 && u * lb > 3 && (1 - u) * lb > 3;
}
function busSiblings(p, q){
  var kp = faceKeys(p), kq = faceKeys(q);
  for (var i = 0; i < kp.length; i++) if (busFace[kp[i]] && kq.indexOf(kp[i]) >= 0) return true;
  return false;
}
// 두 선의 연결점(카드 면 위의 양끝)끼리 닿는 것은 같은 면을 쓰는 것이지 엇갈림이 아니다.
function sharedTip(pa, pb, A, B){
  var tips = [pa[0], pa[pa.length-1], pb[0], pb[pb.length-1]];
  var d = (A[2]-A[0]) * (B[3]-B[1]) - (A[3]-A[1]) * (B[2]-B[0]);
  if (Math.abs(d) < 1e-9) return false;
  var t = ((B[0]-A[0]) * (B[3]-B[1]) - (B[1]-A[1]) * (B[2]-B[0])) / d;
  var px = A[0] + t * (A[2]-A[0]), py = A[1] + t * (A[3]-A[1]);
  for (var i = 0; i < tips.length; i++) if (Math.hypot(tips[i][0] - px, tips[i][1] - py) <= 3) return true;
  return false;
}
function countOf(arr, v){
  var n = 0;
  for (var i = 0; arr && i < arr.length; i++) if (arr[i] === v) n++;
  return n;
}
var overlap = [];
for (var oa = 0; oa < plan.length; oa++) {
  if (!plan[oa].pts) continue;
  var sa = segs(plan[oa].pts);
  for (var ob = oa + 1; ob < plan.length; ob++) {
    if (!plan[ob].pts) continue;
    var nmAB = (plan[oa].e.label || ('선#'+oa)) + ' ↔ ' + (plan[ob].e.label || ('선#'+ob));
    var sb = segs(plan[ob].pts);
    // 한 점에서 같이 나가(들어와) 줄기를 같이 쓰는 버스 선은 그 겹침이 의도다. 버스 id 하나만 비교하면
    //   양끝이 서로 다른 버스에 걸린 선을 놓친다(고객사: tomcat 두 대에서 PostgreSQL 윗면으로 모이는
    //   5432 두 선). 차선으로 벌어지는 면만 같이 쓰는 선은 버스가 아니라서 겹치면 결함이다.
    if (!busSiblings(plan[oa], plan[ob])) {
      var hit = false;
      for (var x1 = 0; x1 < sa.length && !hit; x1++) {
        for (var x2 = 0; x2 < sb.length && !hit; x2++) {
          if (collinearOverlap(sa[x1], sb[x2])) hit = true;
        }
      }
      if (hit) { overlap.push(nmAB); continue; }
    }
    // 교차는 쌍마다 센다. 반원으로 넘은 수보다 많으면 그냥 엇갈린 곳이 있는 것이고, 같은 두 선이
    //   두 번 넘게 만나면 넘었어도 따라가기 어렵다.
    var crosses = 0, parallel = false;
    for (var y1 = 0; y1 < sa.length; y1++) {
      for (var y2 = 0; y2 < sb.length; y2++) {
        if (properCross(sa[y1], sb[y2])) crosses++;
        // 버스 형제는 갈라지는 자리에서 한쪽 모서리가 줄기 위에 놓이는 게 모양이다.
        else if (!busSiblings(plan[oa], plan[ob]) && touchCross(sa[y1], sb[y2]) && !sharedTip(plan[oa].pts, plan[ob].pts, sa[y1], sb[y2])) crosses++;
        // 한 면을 같이 쓰는 형제 선은 갈라지기 전까지 차선 간격으로 붙어 가는 게 모양이다.
        else if (!siblings(plan[oa], plan[ob]) && nearParallel(sa[y1], sb[y2])) parallel = true;
      }
    }
    var jumps = countOf(plan[oa].hopped, ob) + countOf(plan[ob].hopped, oa);
    if (parallel) overlap.push(nmAB + ' 나란히 붙음');
    if (crosses > jumps) overlap.push(nmAB + ' 교차');
    else if (crosses >= 2) overlap.push(nmAB + ' 서로 ' + crosses + '번 교차 (카드 자리를 바꾸세요)');
  }
}
// 반원으로 넘었어도 한 선이 네 번 넘게 건너면 따라가기 어렵다. 배치를 고칠 일이다.
//   처음엔 두 번부터 걸었는데, 서버 세 대 구성도에서 서버 간 lb 세로선이 그룹을 가로지르면 DB 로
//   가는 가로선이 세 번 넘는 것을 배치로 피할 수 없었다(flow-server-diagram 예제). 반원이면 읽힌다.
for (var hc = 0; hc < plan.length; hc++) {
  if ((plan[hc].hopCount || 0) > 3) overlap.push((plan[hc].e.label || ('선#' + hc)) + ' 이 다른 선을 ' + plan[hc].hopCount + '번 건넘 (카드 자리를 바꾸세요)');
}
var collide = [];
for (var ka = 0; ka < S.nodes.length; ka++) {
  for (var kb2 = ka + 1; kb2 < S.nodes.length; kb2++) {
    var A2 = S.nodes[ka], B2 = S.nodes[kb2];
    if (A2.x < B2.x + B2.w && B2.x < A2.x + A2.w && A2.y < B2.y + B2.h && B2.y < A2.y + A2.h) {
      collide.push(A2.title + ' ↔ ' + B2.title);
    }
  }
}
// ── 배치 감사: 카드가 줄을 맞췄는가 ──
// 선 모양은 카드 자리가 정한다. 고객사 구성도에서 nginx 아래로 갈라진 dashboard·link·status 가
//   56px 씩 계단으로 내려앉아, 선이 제각각 꺾이고 빈자리가 크게 남았다. 감사는 기하만 봐서
//   통과했다.
// 이어졌거나 같은 그룹인 두 카드가 옆으로 나란한데(세로 구간이 겹침) 가운데 y 가 다르면
//   맞추려다 만 줄이다. 위아래로 나란한데(가로 구간이 겹침) 가운데 x 가 다르면 같다.
//   멀리 떨어진 카드(구간이 안 겹침)는 일부러 다른 줄에 둔 것이라 보지 않는다.
var related = Object.create(null);
function relKey(p, q){ return p < q ? p + '\u0000' + q : q + '\u0000' + p; }
var nbr = Object.create(null);
for (var rp = 0; rp < auto.length; rp++) {
  var ra = auto[rp].a.n.id, rb = auto[rp].b.n.id;
  related[relKey(ra, rb)] = 1;
  (nbr[ra] = nbr[ra] || []).push(rb);
  (nbr[rb] = nbr[rb] || []).push(ra);
}
// 한 카드에 같이 이어진 카드끼리도 본다. 그룹 없이 갈라진 형제가 계단이 되는 것도 같은 결함이다.
for (var nk in nbr) {
  var nl = nbr[nk];
  for (var q1 = 0; q1 < nl.length; q1++) for (var q2 = q1 + 1; q2 < nl.length; q2++) {
    if (nl[q1] !== nl[q2]) related[relKey(nl[q1], nl[q2])] = 1;
  }
}
for (var rg = 0; rg < S.groups.length; rg++) {
  var gm = S.groups[rg].members || [];
  for (var r1 = 0; r1 < gm.length; r1++) for (var r2 = r1 + 1; r2 < gm.length; r2++) related[relKey(gm[r1], gm[r2])] = 1;
}
// 한 카드가 한쪽 편의 여러 카드 한가운데에 있으면 일부러 가운데 둔 것이다(서버 구성도: 사용자 카드가
//   web01·web02 사이). 그 카드와 그 편 카드들 사이는 보지 않는다.
function centeredOn(C, others, axis){
  var sides = [[], []];
  for (var i = 0; i < others.length; i++) {
    var O = others[i];
    if (axis === 'y') {
      if (!(C.y < O.y + O.h && O.y < C.y + C.h) || (C.x < O.x + O.w && O.x < C.x + C.w)) continue;
      sides[cx(O) < cx(C) ? 0 : 1].push(O);
    } else {
      if (!(C.x < O.x + O.w && O.x < C.x + C.w) || (C.y < O.y + O.h && O.y < C.y + C.h)) continue;
      sides[cy(O) < cy(C) ? 0 : 1].push(O);
    }
  }
  var ok = [];
  for (var sd = 0; sd < 2; sd++) {
    if (sides[sd].length < 2) continue;
    var sum = 0;
    for (var j = 0; j < sides[sd].length; j++) sum += axis === 'y' ? cy(sides[sd][j]) : cx(sides[sd][j]);
    if (Math.abs(sum / sides[sd].length - (axis === 'y' ? cy(C) : cx(C))) <= 0.5) ok = ok.concat(sides[sd]);
  }
  return ok;
}
var relOf = Object.create(null);
for (var ro = 0; ro < S.nodes.length; ro++) {
  var lst = [];
  for (var ro2 = 0; ro2 < S.nodes.length; ro2++) {
    if (ro !== ro2 && related[relKey(S.nodes[ro].id, S.nodes[ro2].id)]) lst.push(S.nodes[ro2]);
  }
  relOf[S.nodes[ro].id] = lst;
}
function isCentered(C, O, axis){ return centeredOn(C, relOf[C.id], axis).indexOf(O) >= 0; }
for (var na1 = 0; na1 < S.nodes.length; na1++) {
  for (var nb1 = na1 + 1; nb1 < S.nodes.length; nb1++) {
    var P = S.nodes[na1], Q = S.nodes[nb1];
    if (!related[relKey(P.id, Q.id)]) continue;
    // 높이가 다른 카드(64px 머리 카드와 95px 카드, 44px 목록 줄)는 윗변을 맞추는 식으로 일부러 다르게
    //   둔다. 계단 배치는 같은 종류 카드에서 생기므로 높이 차가 8px 이내인 쌍만 본다.
    if (Math.abs(P.h - Q.h) > 8) continue;
    var spanY = P.y < Q.y + Q.h && Q.y < P.y + P.h, spanX = P.x < Q.x + Q.w && Q.x < P.x + P.w;
    var ddy = Math.abs(cy(P) - cy(Q)), ddx = Math.abs(cx(P) - cx(Q));
    if (spanY && !spanX && (isCentered(P, Q, 'y') || isCentered(Q, P, 'y'))) continue;
    if (spanX && !spanY && (isCentered(P, Q, 'x') || isCentered(Q, P, 'x'))) continue;
    if (spanY && !spanX && ddy > 0.5) collide.push(P.title + ' ↔ ' + Q.title + ': 옆으로 나란한데 가로줄이 ' + Math.round(ddy) + 'px 어긋남 (y 를 맞추세요)');
    else if (spanX && !spanY && ddx > 0.5) collide.push(P.title + ' ↔ ' + Q.title + ': 위아래로 나란한데 세로줄이 ' + Math.round(ddx) + 'px 어긋남 (x 를 맞추세요)');
  }
}
for (var bi = 0; bi < badRefs.length; bi++) over.push('없는 노드 참조: ' + badRefs[bi]);

// 아이콘과 배지가 겹치는지 (폭을 직접 지정한 경우에만 생길 수 있다)
for (var gi2 = 0; gi2 < S.nodes.length; gi2++) {
  var gn = S.nodes[gi2];
  if (!gn.tag) continue;
  var tagLeft = gn.x + gn.w - (gn.tagBoxW || 0) - 9;
  // 폭을 직접 준 경우 배지가 카드 왼쪽으로 삐져나갈 수 있다. 아이콘이 없으면
  // 아이콘 침범 검사만으로는 이걸 못 잡는다.
  if (tagLeft < gn.x + 6) {
    collide.push(gn.title + ': 배지가 카드를 벗어남 (폭을 넓히세요)');
    continue;
  }
  if (!gn.icon) continue;
  var iconRight = gn.x + gn.w / 2 + 15;
  if (tagLeft < iconRight + 4) collide.push(gn.title + ': 배지가 아이콘을 침범 (폭을 넓히세요)');
}

// 라벨은 선 위에 얹히는 건 괜찮지만 카드 위나 다른 라벨 위에 오면 못 읽는다
var label = [];
var boxes = [];
for (var lb = 0; lb < labelEls.length; lb++) boxes.push(boxOf(labelEls[lb][0]));
for (var lb2 = 0; lb2 < boxes.length; lb2++) {
  for (var ln = 0; ln < S.nodes.length; ln++) {
    var rn = S.nodes[ln];
    if (boxesOverlap(boxes[lb2], {x:rn.x, y:rn.y, w:rn.w, h:rn.h})) {
      label.push("'" + labelEls[lb2][1] + "' 가 노드 " + rn.title + ' 위에 겹침');
      break;
    }
  }
  var mine = plan[labelEls[lb2][2]];
  // 라벨 자리를 label_at 으로 옮겨 감사를 피하면 라벨이 선에서 멀어져 어느 선 것인지
  //   모른다(고객사 AP1 그림: 'join·start URL 치환' 이 선에서 170px). 제 선 20px 안이어야 한다.
  if (!pathHitsBox(mine.pts, boxes[lb2], 20)) {
    label.push("'" + labelEls[lb2][1] + "' 가 제 선에서 떨어짐");
  }
  for (var lo2 = 0; lo2 < plan.length; lo2++) {
    if (lo2 === labelEls[lb2][2] || !plan[lo2].pts) continue;
    if (otherHitsBox(plan[lo2], mine, boxes[lb2])) {
      label.push("'" + labelEls[lb2][1] + "' 가 다른 선 " + (plan[lo2].e.label || ('선#' + lo2)) + ' 위에 겹침');
      break;
    }
  }
  for (var lc = lb2 + 1; lc < boxes.length; lc++) {
    if (boxesOverlap(boxes[lb2], boxes[lc])) {
      label.push("'" + labelEls[lb2][1] + "' ↔ '" + labelEls[lc][1] + "' 라벨끼리 겹침");
    }
  }
  // 그룹 이름표와 테두리도 본다. 노드와 라벨끼리만 보던 때 라벨 끝이 그룹 테두리에
  //   걸친 채 통과했다(서버 구성도 실측: 'WEB nginx · NLB 경유' 가 푸시 서버 그룹 선 위).
  //   그룹 «안» 에 통째로 있거나 «밖» 에 통째로 있으면 괜찮다. 걸쳐 있으면 결함이다.
  for (var lg = 0; lg < CHIPS.length; lg++) {
    if (boxesOverlap(boxes[lb2], CHIPS[lg])) {
      label.push("'" + labelEls[lb2][1] + "' 가 그룹 이름표 " + CHIPS[lg].name + ' 위에 겹침');
    }
  }
  for (var lgg = 0; lgg < S.groups.length; lgg++) {
    var gb = S.groups[lgg];
    if (gb.x === undefined) continue;
    var lbox = boxes[lb2];
    var inside = lbox.x >= gb.x && lbox.y >= gb.y && lbox.x + lbox.w <= gb.x + gb.w && lbox.y + lbox.h <= gb.y + gb.h;
    if (!inside && boxesOverlap(lbox, {x:gb.x, y:gb.y, w:gb.w, h:gb.h})) {
      label.push("'" + labelEls[lb2][1] + "' 가 그룹 " + gb.name + ' 테두리에 걸침');
    }
  }
}
for (var co = 0; co < S.groups.length; co++) {
  if (S.groups[co].chipOver) over.push('그룹 ' + S.groups[co].name + ' 이름표가 박스보다 넓다');
}

document.title = 'AUDIT ' + JSON.stringify({
  w:W, h:H, over:over, compressed:compressed, cross:cross,
  overlap:overlap, collide:collide, label:label
});
} catch (err) {
  // ★ 조용히 죽으면 바깥에서는 '스크립트가 안 돌았다'는 말밖에 못 한다.
  //   실제 예외 메시지를 제목에 실어 원인을 그대로 올려보낸다.
  document.title = 'AUDIT_ERROR ' + ((err && err.message) ? err.message : String(err));
}
})();
`;

export function buildDiagramHtml(spec: DiagramSpec): string {
	const resolved = resolve(spec);
	return [
		'<!DOCTYPE html>',
		'<html lang="ko"><head><meta charset="utf-8"><title>rendering…</title>',
		`<style>${STYLE}</style>`,
		'</head><body>',
		'<div id="wrap"><svg id="cv" xmlns="http://www.w3.org/2000/svg"></svg></div>',
		`<script type="application/json" id="spec">${safeJson(resolved)}</script>`,
		`<script>${SCRIPT}</script>`,
		'</body></html>',
	].join('\n');
}

/** `--dump-dom` 출력에서 자가감사 결과만 뽑는다. */
export function parseAudit(dom: string): AuditReport {
	const tooBig = /<title>AUDIT_TOO_BIG (\{.*?\})<\/title>/s.exec(dom);
	if (tooBig?.[1]) {
		const size = JSON.parse(tooBig[1]) as { w: number; h: number };
		throw new Error(
			`그림이 너무 큽니다: ${size.w}×${size.h}px ` +
				`(상한 ${MAX_DIM}px / 면적 ${(MAX_AREA / 1_000_000).toFixed(0)}백만px).\n` +
				'좌표 간격을 줄이세요 — 캔버스는 내용 bbox 로 자동 계산되므로 ' +
				'노드를 멀리 떨어뜨릴수록 그대로 커집니다.',
		);
	}
	const failed = /<title>AUDIT_ERROR (.*?)<\/title>/s.exec(dom);
	if (failed?.[1]) throw new Error(`그림을 그리다 실패했습니다: ${failed[1]}`);
	const match = /<title>AUDIT (\{.*?\})<\/title>/s.exec(dom);
	if (!match?.[1]) {
		throw new Error(
			'렌더 결과를 읽지 못했습니다 — 페이지 스크립트가 끝까지 돌지 않았습니다.\n' +
				'입력 좌표에 숫자가 아닌 값이 섞였을 수 있습니다.',
		);
	}
	// 스크립트가 만든 JSON 이라 형태는 보장되지만, 파싱 실패를 조용히 넘기지는 않는다.
	return JSON.parse(match[1]) as AuditReport;
}

/** 사람이 읽는 감사 요약. 문제가 없으면 짧게 끝난다. */
export function formatAudit(a: AuditReport): string {
	const lines: string[] = [];
	const add = (label: string, items: string[]): void => {
		if (items.length) lines.push(`- ${label} ${items.length}건: ${items.join(' / ')}`);
	};
	add('글자 삐져나옴', a.over);
	add('자간 압축(노드 폭을 넓히세요)', a.compressed);
	add('선이 노드·그룹 이름표를 관통하거나 끝이 카드에 안 닿음', a.cross);
	add('선끼리 겹침·나란함·교차', a.overlap);
	add('노드/배지 겹침·줄 어긋남', a.collide);
	add('라벨 겹침(노드·라벨·그룹·선)·선에서 떨어짐', a.label);
	if (!lines.length) return '자가감사 통과 — 삐져나옴·압축·관통·선겹침·라벨겹침 0건';
	return `⚠️ 자가감사에서 걸린 것:\n${lines.join('\n')}`;
}

export const TONE_LIST = Object.keys(TONES).join(', ');
