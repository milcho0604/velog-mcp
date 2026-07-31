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

// ── 그룹 박스: members 를 주면 그 노드들을 감싸도록 자동 계산 ──
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
  el('rect', {x:g.x, y:g.y, width:g.w, height:g.h, rx:13, fill:g.fill,
              stroke:g.stroke, 'stroke-width':1.4}, content);
  // 좌상단 타이틀 칩 — 폭은 실측 합산
  var gtw = measure(g.name, 'grp-title');
  var chipW = 13 + gtw + 13;
  if (g.sub) chipW += 9 + measure(g.sub, 'grp-sub');
  el('rect', {x:g.x + 13, y:g.y - 13, width:chipW, height:26, rx:7,
              fill:'#ffffff', stroke:g.stroke, 'stroke-width':1.2}, content);
  txt(g.x + 26, g.y + 4, 'grp-title', g.name, 'start', null, content);
  if (g.sub) txt(g.x + 26 + gtw + 9, g.y + 4, 'grp-sub', g.sub, 'start', null, content);
}

// ── 엣지 경로 계산 ──
function cx(n){ return n.x + n.w / 2; }
function cy(n){ return n.y + n.h / 2; }
function parseEnd(ref){
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
  var step = Math.min(15, Math.max(7, (extent - 30) / (c - 1)));
  return (i - (c - 1) / 2) * step;
}
function anchor(n, side, idx, cnt){
  if (side === 'left' || side === 'right') {
    return [side === 'left' ? n.x : n.x + n.w, cy(n) + laneOffset(idx, cnt, n.h)];
  }
  return [cx(n) + laneOffset(idx, cnt, n.w), side === 'top' ? n.y : n.y + n.h];
}
function isH(side){ return side === 'left' || side === 'right'; }
// off = 중간 꺾임선을 옆으로 밀어내는 양. 같은 두 열 사이를 지나는 선들이
// 전부 같은 중간 좌표를 쓰면 한 줄로 겹친다 — 그걸 벌리는 데 쓴다.
function route(a, as, b, bs, off){
  var ax = a[0], ay = a[1], bx = b[0], by = b[1];
  var d = off || 0;
  if (isH(as) && isH(bs)) {
    if (Math.abs(ay - by) < 0.6) return [[ax,ay],[bx,by]];
    var mx = (ax + bx) / 2 + d;
    return [[ax,ay],[mx,ay],[mx,by],[bx,by]];
  }
  if (!isH(as) && !isH(bs)) {
    if (Math.abs(ax - bx) < 0.6) return [[ax,ay],[bx,by]];
    var my = (ay + by) / 2 + d;
    return [[ax,ay],[ax,my],[bx,my],[bx,by]];
  }
  if (isH(as)) return [[ax,ay],[bx,ay],[bx,by]];
  return [[ax,ay],[ax,by],[bx,by]];
}
function rpath(pts, r){
  r = r || 9;
  var d = 'M' + pts[0][0] + ',' + pts[0][1];
  for (var i = 1; i < pts.length - 1; i++) {
    var p = pts[i-1], c = pts[i], nx = pts[i+1];
    var inLen = Math.hypot(c[0]-p[0], c[1]-p[1]);
    var outLen = Math.hypot(nx[0]-c[0], nx[1]-c[1]);
    var rr = Math.min(r, inLen/2, outLen/2);
    var ix = c[0] - Math.sign(c[0]-p[0]) * rr, iy = c[1] - Math.sign(c[1]-p[1]) * rr;
    var ox = c[0] + Math.sign(nx[0]-c[0]) * rr, oy = c[1] + Math.sign(nx[1]-c[1]) * rr;
    d += ' L' + ix + ',' + iy + ' Q' + c[0] + ',' + c[1] + ' ' + ox + ',' + oy;
  }
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
var seen = Object.create(null);
var auto = [];
for (var pj = 0; pj < plan.length; pj++) {
  var it = plan[pj];
  if (it.pts || !it.a) continue;
  seen[it.a.k] = (seen[it.a.k] === undefined) ? 0 : seen[it.a.k] + 1;
  seen[it.b.k] = (seen[it.b.k] === undefined) ? 0 : seen[it.b.k] + 1;
  it.pa = anchor(it.a.n, it.a.s, seen[it.a.k], lanes[it.a.k]);
  it.pb = anchor(it.b.n, it.b.s, seen[it.b.k], lanes[it.b.k]);
  auto.push(it);
}

// ★ 같은 두 열 사이를 지나는 선들은 중간 꺾임 좌표가 전부 같아서 한 줄로 겹친다.
//   노드 배치가 규칙적일수록(= 보기 좋게 그릴수록) 더 잘 생긴다.
//   실제로 11노드 그림에서 세로선 3개가 겹쳤다. 버킷별로 등간격으로 벌린다.
function midKeyOf(it){
  var hA = isH(it.a.s), hB = isH(it.b.s);
  if (hA && hB) {
    if (Math.abs(it.pa[1] - it.pb[1]) < 0.6) return '';       // 일직선 — 꺾임 없음
    return 'h' + Math.round(((it.pa[0] + it.pb[0]) / 2) / 8);
  }
  if (!hA && !hB) {
    if (Math.abs(it.pa[0] - it.pb[0]) < 0.6) return '';
    return 'v' + Math.round(((it.pa[1] + it.pb[1]) / 2) / 8);
  }
  return '';                                                  // ㄴ자 — 중간선이 없다
}
var midCount = Object.create(null);
for (var m1 = 0; m1 < auto.length; m1++) {
  auto[m1].mk = midKeyOf(auto[m1]);
  if (auto[m1].mk) midCount[auto[m1].mk] = (midCount[auto[m1].mk] || 0) + 1;
}
var midSeen = Object.create(null);
for (var m2 = 0; m2 < auto.length; m2++) {
  var im = auto[m2];
  var off = 0;
  if (im.mk) {
    midSeen[im.mk] = (midSeen[im.mk] === undefined) ? 0 : midSeen[im.mk] + 1;
    off = laneOffset(midSeen[im.mk], midCount[im.mk], 200);
  }
  im.pts = route(im.pa, im.a.s, im.pb, im.b.s, off);
}

var badRefs = [];
for (var pk = 0; pk < plan.length; pk++) {
  var itm = plan[pk];
  if (itm.bad) { badRefs.push(itm.bad); continue; }
  if (!itm.pts) continue;
  var pln = planeOf(itm.e.plane);
  var pathEl = el('path', {d:rpath(itm.pts), fill:'none', stroke:pln.color,
                           'stroke-width':1.8, 'marker-end':'url(#arr-'+itm.e.plane+')'}, content);
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
    var mx = (sg[0][0] + sg[1][0]) / 2, my = (sg[0][1] + sg[1][1]) / 2;
    if (Math.abs(sg[0][1] - sg[1][1]) < 0.6) {      // 수평 구간 — 위/아래
      out.push([mx, my - 7, 'middle']);
      out.push([mx, my + 16, 'middle']);
    } else {                                        // 수직 구간 — 왼쪽/오른쪽
      out.push([mx - 8, my, 'end']);
      out.push([mx + 8, my, 'start']);
    }
  }
  if (!out.length) out.push([pts[0][0], pts[0][1] - 7, 'middle']);
  return out;
}
function place(t, x, y, anchor){
  t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor);
}
function labelCollides(box){
  for (var i = 0; i < S.nodes.length; i++) {
    var n = S.nodes[i];
    if (boxesOverlap(box, {x:n.x, y:n.y, w:n.w, h:n.h})) return true;
  }
  for (var j = 0; j < placedBoxes.length; j++) {
    if (boxesOverlap(box, placedBoxes[j])) return true;
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
      if (!labelCollides(boxOf(t))) { settled = true; break; }
    }
    if (!settled) place(t, cands[0][0], cands[0][1], cands[0][2]);
  }
  placedBoxes.push(boxOf(t));
  labelEls.push([t, itl.e.label]);
}

// ── 캔버스 되맞춤: 그린 결과에 맞춰 크기와 위치를 정한다 (잘림 방지) ──
svg.removeChild(scratch);
var bb = content.getBBox();
var dx = PAD - bb.x, dy = headerBottom + GAP - bb.y;
content.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
var W = Math.ceil(Math.max(bb.width + PAD*2, headerW + PAD*2, 720));
var H = Math.ceil(headerBottom + GAP + bb.height + PAD);
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
  var own = {};
  if (ic.a) { own[ic.a.n.id] = 1; own[ic.b.n.id] = 1; }
  var ss = segs(ic.pts);
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
}
var overlap = [];
for (var oa = 0; oa < plan.length; oa++) {
  if (!plan[oa].pts) continue;
  var sa = segs(plan[oa].pts);
  for (var ob = oa + 1; ob < plan.length; ob++) {
    if (!plan[ob].pts) continue;
    var sb = segs(plan[ob].pts);
    var hit = false;
    for (var x1 = 0; x1 < sa.length && !hit; x1++) {
      for (var x2 = 0; x2 < sb.length && !hit; x2++) {
        var A = sa[x1], B = sb[x2];
        var aH = Math.abs(A[1]-A[3]) < 0.6, bH = Math.abs(B[1]-B[3]) < 0.6;
        var aV = Math.abs(A[0]-A[2]) < 0.6, bV = Math.abs(B[0]-B[2]) < 0.6;
        if (aH && bH && Math.abs(A[1]-B[1]) < 3) {
          var lo = Math.max(Math.min(A[0],A[2]), Math.min(B[0],B[2]));
          var hi = Math.min(Math.max(A[0],A[2]), Math.max(B[0],B[2]));
          if (hi - lo > 20) hit = true;
        } else if (aV && bV && Math.abs(A[0]-B[0]) < 3) {
          var lo2 = Math.max(Math.min(A[1],A[3]), Math.min(B[1],B[3]));
          var hi2 = Math.min(Math.max(A[1],A[3]), Math.max(B[1],B[3]));
          if (hi2 - lo2 > 20) hit = true;
        }
      }
    }
    if (hit) overlap.push((plan[oa].e.label || ('선#'+oa)) + ' ↔ ' + (plan[ob].e.label || ('선#'+ob)));
  }
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
for (var bi = 0; bi < badRefs.length; bi++) over.push('없는 노드 참조: ' + badRefs[bi]);

// 아이콘과 배지가 겹치는지 (폭을 직접 지정한 경우에만 생길 수 있다)
for (var gi2 = 0; gi2 < S.nodes.length; gi2++) {
  var gn = S.nodes[gi2];
  if (!gn.icon || !gn.tag) continue;
  var iconRight = gn.x + gn.w / 2 + 15;
  var tagLeft = gn.x + gn.w - (gn.tagBoxW || 0) - 9;
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
  for (var lc = lb2 + 1; lc < boxes.length; lc++) {
    if (boxesOverlap(boxes[lb2], boxes[lc])) {
      label.push("'" + labelEls[lb2][1] + "' ↔ '" + labelEls[lc][1] + "' 라벨끼리 겹침");
    }
  }
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
	add('선이 노드를 관통', a.cross);
	add('선끼리 겹침', a.overlap);
	add('노드/배지 겹침', a.collide);
	add('라벨 겹침', a.label);
	if (!lines.length) return '자가감사 통과 — 삐져나옴·압축·관통·선겹침·라벨겹침 0건';
	return `⚠️ 자가감사에서 걸린 것:\n${lines.join('\n')}`;
}

export const TONE_LIST = Object.keys(TONES).join(', ');
