/**
 * 시퀀스 다이어그램 — "누가 누구에게 무엇을 언제" 만 받고 배치는 전부 계산한다.
 *
 * ## 왜 velog_render_diagram 과 도구를 나눴나
 *
 * 구성도는 **좌표계가 자유**다. 모델이 x 와 y 를 정하고 렌더러는 폭과 꺾임만 맞춘다.
 * 시퀀스는 반대다 — 열은 참가자, 행은 시간이라 좌표가 의미를 갖는다.
 * 같은 도구에 얹으면 모델이 매번 y 를 손으로 계산하게 되는데, 메시지 하나만
 * 끼워 넣어도 그 아래 전부가 틀어진다. 실제로 기존 도구로 그려보고 확인한 것이다.
 *
 * 그래서 이 도구는 좌표를 **받지 않는다.** 참가자 목록과 순서 있는 메시지 목록만
 * 받고 열 간격과 행 높이, 활성 막대, 프래그먼트 상자를 전부 실측으로 정한다.
 *
 * ## 겹치지 않는다는 보장이 어디서 오나
 *
 * 글자를 줄여 맞추지 않는다. 반대로 **글자에 맞춰 자리를 넓힌다.**
 *   - 라벨이 두 열 사이에 안 들어가면 그 구간의 열 간격을 늘린다
 *   - 자기호출 라벨이 옆 열을 침범하면 그 옆 간격을 늘린다
 *   - 라벨이 길면 줄바꿈하고, 줄이 늘어난 만큼 그 행을 높인다
 * 그러고 나서 자가감사가 결과를 다시 잰다. 감사는 내 계산이 틀렸을 때 걸리라고
 * 있는 것이지, 통과 도장이 아니다.
 */

import type { Prim } from './icons.ts';
import { ICONS } from './icons.ts';
import { TONES, tone } from './tones.ts';

/** 세로 열 하나 = 참가자 하나. */
export interface SequenceParticipant {
	id?: string | undefined;
	name: string;
	sub?: string | undefined;
	icon?: string | undefined;
	icon_tone?: string | undefined;
	tag?: string | undefined;
	tag_tone?: string | undefined;
}

/**
 * 메시지 종류.
 *   call   — 동기 호출 (실선 + 채운 화살촉)
 *   async  — 비동기 발행 (실선 + 열린 화살촉)
 *   return — 응답 (점선 + 열린 화살촉). 활성 막대를 닫는다
 *   note   — 선이 아니라 설명 상자. 순서 안에 끼워 넣는다
 */
export const SEQ_KINDS = ['call', 'async', 'return', 'note'] as const;
export type SequenceKind = (typeof SEQ_KINDS)[number];

export interface SequenceMessage {
	kind?: SequenceKind | undefined;
	from: string;
	/** note 는 생략하면 from 열에 붙는다. 주면 두 열 사이에 걸친다. */
	to?: string | undefined;
	label?: string | undefined;
}

/** alt, opt, loop 같은 묶음 상자. 메시지 인덱스 범위로 지정한다(양끝 포함). */
export interface SequenceFragment {
	kind: string;
	label?: string | undefined;
	from: number;
	to: number;
	tone?: string | undefined;
}

export interface SequenceSpec {
	title: string;
	subtitle?: string | undefined;
	participants: SequenceParticipant[];
	messages: SequenceMessage[];
	fragments?: SequenceFragment[] | undefined;
	legend?: boolean | undefined;
	/** 메시지 앞에 1. 2. 3. 을 붙인다 */
	numbers?: boolean | undefined;
	/** 호출/응답 짝에서 활성 막대를 뽑아 그린다 */
	activations?: boolean | undefined;
}

/**
 * 캔버스 상한. page.ts 와 같은 값이고 같은 이유다 — 크기를 **설정하기 전에**
 * 페이지 안에서 거른다. 바깥에서 막으면 이미 브라우저가 표면을 잡은 뒤라 늦는다.
 */
export const MAX_DIM = 6000;
export const MAX_AREA = 9_000_000;

export interface SequenceAudit {
	w: number;
	h: number;
	/** 글자가 제 상자(카드나 노트나 칩)를 벗어남 — 자동 폭 계산이 틀렸다는 뜻 */
	over: string[];
	/** 카드끼리, 활성막대끼리, 노트끼리 겹침 — 열 간격 계산이 틀렸다는 뜻 */
	collide: string[];
	/** 라벨끼리 겹치거나 라벨이 카드나 노트를 가림 — 행 높이 계산이 틀렸다는 뜻 */
	label: string[];
	/** 화살표가 카드나 노트를 관통 — 활성막대 오프셋이 틀렸다는 뜻 */
	cross: string[];
	/** 프래그먼트가 제 메시지를 다 못 감쌈 — 상자 범위 계산이 틀렸다는 뜻 */
	frame: string[];
}

/** 종류별 기본 생김새. 색을 메시지마다 고르게 하지 않는 이유는 tones.ts 주석과 같다. */
const KIND_STYLE: Record<SequenceKind, { toneName: string; dash: string; head: string; name: string }> = {
	call: { toneName: 'indigo', dash: '', head: 'solid', name: '호출' },
	async: { toneName: 'teal', dash: '', head: 'open', name: '비동기' },
	return: { toneName: 'slate', dash: '5 4', head: 'open', name: '응답' },
	note: { toneName: 'amber', dash: '', head: 'none', name: '설명' },
};

interface ResolvedSpec {
	title: string;
	subtitle: string;
	legend: boolean;
	numbers: boolean;
	activations: boolean;
	kinds: Array<{ key: string; name: string; color: string; dash: string; head: string }>;
	participants: Array<{
		id: string;
		name: string;
		sub: string;
		icon: string;
		iconColor: string;
		tag: string;
		tagColor: string;
	}>;
	messages: Array<{ kind: string; a: number; b: number; label: string }>;
	fragments: Array<{
		kind: string;
		label: string;
		from: number;
		to: number;
		fill: string;
		stroke: string;
		solid: string;
	}>;
	icons: Record<string, readonly Prim[]>;
	maxDim: number;
	maxArea: number;
}

/**
 * 여기서 걸러 **던지는** 것과 자가감사로 넘기는 것을 나눈 기준.
 *
 * 없는 참가자를 가리키거나 프래그먼트 범위가 뒤집힌 건 그려봐야 의미가 없다.
 * 그림 대신 무엇이 틀렸는지 말해주는 편이 낫다. 반대로 '겹쳤다, 삐져나왔다'는
 * 그려보기 전에는 알 수 없으므로 브라우저에서 재고 감사로 올린다.
 */
function resolve(spec: SequenceSpec): ResolvedSpec {
	const participants = spec.participants.map((p, i) => ({
		id: p.id ?? `p${i}`,
		name: p.name,
		sub: p.sub ?? '',
		icon: p.icon && ICONS[p.icon] ? p.icon : '',
		iconColor: tone(p.icon_tone, 'slate').solid,
		tag: p.tag ?? '',
		tagColor: tone(p.tag_tone, 'slate').solid,
	}));

	const index = new Map<string, number>();
	participants.forEach((p, i) => {
		if (index.has(p.id)) {
			throw new Error(
				`참가자 id 가 겹칩니다: ${p.id} (생략하면 p0, p1… 이 자동 부여됩니다)`,
			);
		}
		index.set(p.id, i);
	});

	const at = (ref: string, where: string): number => {
		const found = index.get(ref);
		if (found === undefined) {
			const known = participants.map((p) => p.id).join(', ');
			throw new Error(`${where}: 없는 참가자 '${ref}' 를 가리킵니다. 있는 참가자: ${known}`);
		}
		return found;
	};

	const messages = spec.messages.map((m, i) => {
		const kind: SequenceKind = m.kind ?? 'call';
		const a = at(m.from, `메시지 #${i + 1} 의 from`);
		// note 만 to 를 생략할 수 있다. 나머지는 from===to 여야 자기호출이 된다.
		const b = m.to === undefined ? a : at(m.to, `메시지 #${i + 1} 의 to`);
		if (kind !== 'note' && m.to === undefined) {
			throw new Error(
				`메시지 #${i + 1}: note 가 아니면 to 가 필요합니다 ` +
					'(자기 자신을 부르는 것이라면 from 과 같은 값을 주세요).',
			);
		}
		return { kind, a, b, label: m.label ?? '' };
	});

	const frags = (spec.fragments ?? []).map((f, i) => {
		if (!Number.isInteger(f.from) || !Number.isInteger(f.to)) {
			throw new Error(`프래그먼트 #${i + 1}: from 과 to 는 메시지 번호(정수)여야 합니다.`);
		}
		if (f.from > f.to) {
			throw new Error(`프래그먼트 #${i + 1}: from(${f.from}) 이 to(${f.to}) 보다 뒤입니다.`);
		}
		if (f.from < 0 || f.to >= messages.length) {
			throw new Error(
				`프래그먼트 #${i + 1}: 범위 ${f.from}~${f.to} 가 메시지 범위(0~${messages.length - 1}) 밖입니다.`,
			);
		}
		const t = tone(f.tone, 'slate');
		return {
			kind: f.kind,
			label: f.label ?? '',
			from: f.from,
			to: f.to,
			fill: t.fill,
			stroke: t.stroke,
			solid: t.solid,
		};
	});

	// ★ 부분 교차는 그릴 수가 없다. 상자 둘이 서로를 반씩 물면 어느 쪽을 안쪽으로
	//   그려도 한쪽 상자가 제 메시지를 못 감싼다. 감사로 잡으면 '그려놓고 실패'라
	//   여기서 막는다.
	for (let i = 0; i < frags.length; i++) {
		for (let j = i + 1; j < frags.length; j++) {
			const x = frags[i];
			const y = frags[j];
			if (!x || !y) continue;
			const disjoint = x.to < y.from || y.to < x.from;
			const nested = (x.from <= y.from && y.to <= x.to) || (y.from <= x.from && x.to <= y.to);
			if (!disjoint && !nested) {
				throw new Error(
					`프래그먼트 ${x.kind}(${x.from}~${x.to}) 와 ${y.kind}(${y.from}~${y.to}) 가 ` +
						'서로 어긋나게 겹칩니다. 완전히 포개거나 완전히 떨어져야 합니다.',
				);
			}
		}
	}

	// 실제로 쓰인 종류만 범례에 싣는다.
	const used = new Set(messages.map((m) => m.kind));
	const kinds = SEQ_KINDS.filter((k) => used.has(k)).map((k) => {
		const style = KIND_STYLE[k];
		return {
			key: k,
			name: style.name,
			color: TONES[style.toneName]?.solid ?? '#475569',
			dash: style.dash,
			head: style.head,
		};
	});

	const icons: Record<string, readonly Prim[]> = {};
	for (const p of participants) {
		const prim = ICONS[p.icon];
		if (p.icon && prim) icons[p.icon] = prim;
	}

	return {
		title: spec.title,
		subtitle: spec.subtitle ?? '',
		legend: spec.legend ?? true,
		numbers: spec.numbers ?? true,
		activations: spec.activations ?? true,
		kinds,
		participants,
		messages,
		fragments: frags,
		icons,
		maxDim: MAX_DIM,
		maxArea: MAX_AREA,
	};
}

/** page.ts 와 같은 이유 — `<` 를 이스케이프하면 `</script>` 가 만들어질 수 없다. */
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
  .p-title  { font-size:13.5px; font-weight:700; fill:#111827; }
  .p-sub    { font-size:11px; fill:#6b7280; }
  .tag-t    { font-size:10.5px; font-weight:700; fill:#ffffff; letter-spacing:.2px; }
  .m-label  { font-size:11.5px; font-weight:600; paint-order:stroke; stroke:#ffffff; stroke-width:4.5px; stroke-linejoin:round; }
  .nt-t     { font-size:11px; fill:#7c2d12; }
  .fr-kind  { font-size:10.5px; font-weight:800; fill:#ffffff; letter-spacing:.3px; }
  .fr-label { font-size:11px; font-weight:600; fill:#334155; paint-order:stroke; stroke:#ffffff; stroke-width:4px; stroke-linejoin:round; }
`;

// ── 페이지 안에서 도는 스크립트 ──────────────────────────────────────────
// ★ page.ts 와 같은 제약 — 이 문자열 안에서는 백틱과 달러중괄호를 쓰지 않는다.
//   바깥이 템플릿 리터럴이라 그대로 보간돼 버린다.
const SCRIPT = `
(function(){
'use strict';
try {
var S = JSON.parse(document.getElementById('spec').textContent);
var NS = 'http://www.w3.org/2000/svg';
var svg = document.getElementById('cv');

var PAD = 34, GAP = 26;
var LH = 15;          // 라벨 줄높이의 **바닥값**. 실제 값은 글자를 재서 정한다
var WRAP_W = 250;     // 라벨을 이 폭에서 접는다 (넘으면 열을 넓힌다)
var ROW_GAP = 26;     // 행 사이
var CARD_GAP = 36;    // 카드끼리 최소 여백
var MIN_COL = 132;    // 열 중심 사이 최소 거리
var BAR_W = 10, BAR_STEP = 6;
var SELF_W = 46, SELF_H = 34;
var HEAD_ROOM = 26;   // 카드 아래 첫 행까지
var NOTE_OFF = 26;    // 생명선에서 노트 상자까지
var FR_HEAD = 30, FR_TAIL = 16, FR_PAD = 26;

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

// 글자 폭은 전부 실측이다. 줄바꿈에서 같은 문자열을 여러 번 재게 되므로 외워둔다.
var scratch = el('g', {visibility:'hidden'});
var mcache = Object.create(null);
function box(s, cls){
  var key = cls + '\\u0000' + s;
  var hit = mcache[key];
  if (hit !== undefined) return hit;
  var t = txt(0, 0, cls, s, 'start', null, scratch);
  var b = t.getBBox();
  scratch.removeChild(t);
  hit = {w:b.width, h:b.height};
  mcache[key] = hit;
  return hit;
}
function measure(s, cls){ return box(s, cls).w; }
// ★ 줄높이를 상수로 고정하면 안 된다. 이모지는 같은 font-size 라도 글리프가 훨씬
//   높아서, 15px 로 쌓으면 **같은 라벨의 두 줄이 서로 물린다**(자가감사가 잡았다).
//   눈으로는 멀쩡해 보였다 — 재는 쪽이 맞고 배치가 틀린 경우였다.
function lineHeightOf(lines, cls){
  var h = 0;
  for (var i = 0; i < lines.length; i++) { var m = box(lines[i], cls).h; if (m > h) h = m; }
  return Math.max(LH, Math.ceil(h) + 3);
}
function boxOf(t){ var b = t.getBBox(); return {x:b.x, y:b.y, w:b.width, h:b.height}; }
function rectsOverlap(a, b){
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function pad(r, m){ return {x:r.x - m, y:r.y - m, w:r.w + m*2, h:r.h + m*2}; }

// ★ 글자를 눌러 맞추지 않는다. 접고, 그래도 넘치면 자리를 넓힌다.
//   한국어는 띄어쓰기가 없는 토큰이 흔해서 낱말 단위만으로는 안 접힌다.
//   그때는 글자 단위로 내려간다. Array.from 을 쓰는 건 이모지를 쪼개지 않기 위해서다.
// 공백 없는 긴 토큰을 어디서 끊을지. **이 글자 뒤에서** 끊는다.
// 식별자 안에 흔한 _ . - 는 일부러 뺐다 — 거기서 끊으면 USE_INTT_ID 가
// USE_ 와 INTT_ID 로 갈라져서 글자 단위로 끊는 것과 별로 다르지 않다.
var BREAK_AFTER = '&?=/,;|';
function chunkLong(word){
  var out = [], cur = '', chars = Array.from(word);
  for (var i = 0; i < chars.length; i++) {
    cur += chars[i];
    if (BREAK_AFTER.indexOf(chars[i]) >= 0) { out.push(cur); cur = ''; }
  }
  if (cur) out.push(cur);
  return out;
}
function wrapText(s, cls, maxW){
  if (!s) return [];
  var out = [], cur = '';
  var words = s.split(' ');
  for (var wi = 0; wi < words.length; wi++) {
    var word = words[wi];
    if (word === '') continue;
    if (measure(word, cls) > maxW) {
      if (cur) { out.push(cur); cur = ''; }
      // ★ 구분 기호 뒤에서 먼저 끊어본다. 글자 단위는 **마지막 수단**이다 —
      //   먼저 쓰면 식별자 한가운데가 갈라진다(USE / _INTT_ID).
      //   구분 기호가 없는 한글 문장은 조각이 하나뿐이라 예전 그대로 글자 단위로 간다.
      var chunks = chunkLong(word);
      var piece = '';
      for (var ci = 0; ci < chunks.length; ci++) {
        var chunk = chunks[ci];
        if (measure(chunk, cls) > maxW) {
          if (piece) { out.push(piece); piece = ''; }
          var chars = Array.from(chunk);
          for (var ki = 0; ki < chars.length; ki++) {
            var grow = piece + chars[ki];
            if (piece && measure(grow, cls) > maxW) { out.push(piece); piece = chars[ki]; }
            else piece = grow;
          }
          continue;
        }
        var joined = piece + chunk;
        if (piece && measure(joined, cls) > maxW) { out.push(piece); piece = chunk; }
        else piece = joined;
      }
      cur = piece;
      continue;
    }
    var cand = cur ? (cur + ' ' + word) : word;
    if (cur && measure(cand, cls) > maxW) { out.push(cur); cur = word; }
    else cur = cand;
  }
  if (cur) out.push(cur);
  return out;
}
function widest(lines, cls){
  var w = 0;
  for (var i = 0; i < lines.length; i++) { var m = measure(lines[i], cls); if (m > w) w = m; }
  return w;
}

// ── 화살촉 ──
// 생명선에는 marker 를 안 붙인다. 기존 구성도 도구가 모든 선에 무조건 붙이는 바람에
// 생명선 끝에 삼각형이 달렸던 것이 이 도구를 따로 만든 이유 중 하나다.
var defs = el('defs', {});
var KIND = Object.create(null);
for (var ki = 0; ki < S.kinds.length; ki++) {
  var kd = S.kinds[ki];
  KIND[kd.key] = kd;
  if (kd.head === 'none') continue;
  var mk = el('marker', {id:'ar-'+kd.key, viewBox:'0 0 10 10', refX:'8.6', refY:'5',
                         markerWidth:'6.2', markerHeight:'6.2', orient:'auto-start-reverse'}, defs);
  if (kd.head === 'open') {
    el('path', {d:'M0.8,0.8 L9,5 L0.8,9.2', fill:'none', stroke:kd.color,
                'stroke-width':1.7, 'stroke-linecap':'round', 'stroke-linejoin':'round'}, mk);
  } else {
    el('path', {d:'M0,0 L10,5 L0,10 z', fill:kd.color}, mk);
  }
}
function kindOf(k){ return KIND[k] || S.kinds[0] || {key:'call', color:'#4f46e5', dash:'', head:'solid'}; }

// ── 머리말 ──
var headerBottom = PAD + 22, headerW = 0;
txt(PAD, PAD + 14, 'hd-title', S.title, 'start');
headerW = measure(S.title, 'hd-title');
if (S.subtitle) {
  txt(PAD, headerBottom + 16, 'hd-sub', S.subtitle, 'start');
  headerW = Math.max(headerW, measure(S.subtitle, 'hd-sub'));
  headerBottom += 22;
}
if (S.legend && S.kinds.length) {
  var lx = PAD, ly = headerBottom + 22;
  for (var li = 0; li < S.kinds.length; li++) {
    var lp = S.kinds[li];
    if (lp.head === 'none') {
      el('rect', {x:lx, y:ly - 7, width:28, height:14, rx:4, fill:'#fffbeb',
                  stroke:lp.color, 'stroke-width':1.2});
    } else {
      var ln = el('path', {d:'M'+lx+','+ly+' H'+(lx+30), stroke:lp.color, 'stroke-width':2,
                           fill:'none', 'marker-end':'url(#ar-'+lp.key+')'});
      if (lp.dash) ln.setAttribute('stroke-dasharray', lp.dash);
    }
    txt(lx + 38, ly + 4, 'lg-t', lp.name, 'start');
    lx += 38 + measure(lp.name, 'lg-t') + 22;
  }
  headerW = Math.max(headerW, lx - PAD - 22);
  headerBottom = ly + 12;
}
// 생명선 범례는 종류가 아니라 그림의 뼈대라 항상 같은 자리에 둔다.
var content = el('g', {});

// ── ① 참가자 카드 크기 (글자 실측) ──
var P = S.participants;
var CARD_H = 54;
for (var i = 0; i < P.length; i++) {
  var p = P[i];
  var tw = measure(p.name, 'p-title');
  var sw = p.sub ? measure(p.sub, 'p-sub') : 0;
  p.tagW = p.tag ? measure(p.tag, 'tag-t') + 16 : 0;
  var need = Math.max(118, tw + 30, sw + 26, p.tagW + 30);
  // 아이콘은 가운데 위, 배지는 오른쪽 위다. 좁으면 둘이 겹친다.
  if (p.icon && p.tag) need = Math.max(need, 2 * p.tagW + 64);
  // ★ 아이콘이 없으면 제목이 카드 한가운데로 올라온다 — 배지와 같은 높이가 된다.
  //   그때는 **가운데 정렬한 제목의 오른쪽 끝**이 배지 밑으로 들어가지 않아야 한다.
  //   (실물 확인: 배지만 있고 아이콘이 없는 카드에서 배지가 이름을 덮었다.)
  if (p.tag && !p.icon) need = Math.max(need, Math.max(tw, sw) + 2 * p.tagW + 34);
  p.w = Math.ceil(need);
  p.contentH = (p.icon ? 36 : 0) + 18 + (p.sub ? 16 : 0);
  CARD_H = Math.max(CARD_H, p.contentH + 26);
}
// 높이를 하나로 맞춰야 생명선이 같은 줄에서 시작한다.
for (i = 0; i < P.length; i++) P[i].h = CARD_H;

// ── ② 라벨 접기 ──
var M = S.messages;
var seq = 0;
for (var mi = 0; mi < M.length; mi++) {
  var m = M[mi];
  m.note = (m.kind === 'note');
  m.self = (!m.note && m.a === m.b);
  var body = m.label;
  if (S.numbers && !m.note) {
    seq++;
    body = body ? (seq + '. ' + body) : String(seq);
  }
  m.cls = m.note ? 'nt-t' : 'm-label';
  m.lines = wrapText(body, m.cls, WRAP_W);
  m.raw = body;
  m.tw = widest(m.lines, m.cls);
  m.lh = lineHeightOf(m.lines, m.cls);
  m.th = m.lines.length * m.lh;
}

// ── ③ 열 간격: 라벨이 들어갈 만큼 넓힌다 ──
var gaps = [];
for (i = 0; i < P.length - 1; i++) {
  gaps.push(Math.max(MIN_COL, P[i].w / 2 + P[i+1].w / 2 + CARD_GAP));
}
function widenOne(i, need){ if (i >= 0 && i < gaps.length && gaps[i] < need) gaps[i] = need; }

for (mi = 0; mi < M.length; mi++) {
  var mm = M[mi];
  if (mm.note && mm.a === mm.b) {
    // ★ 한 열짜리 노트는 생명선 **오른쪽**에 붙인다. 열 위에 얹으면 그 참가자의
    //   활성 막대를 덮어 막대가 끊겨 보인다(실물 확인). 대신 어디에 붙은
    //   설명인지 모르게 되므로 생명선에서 상자까지 짧은 연결선을 긋는다.
    if (mm.a < P.length - 1) {
      widenOne(mm.a, NOTE_OFF + mm.tw + 28 + 16 + P[mm.a+1].w / 2);
    }
  } else if (mm.self) {
    // 자기호출은 고리와 라벨이 오른쪽으로 나간다. 마지막 열이면 캔버스가 늘어난다.
    if (mm.a < P.length - 1) {
      widenOne(mm.a, SELF_W + 10 + mm.tw + 16 + P[mm.a+1].w / 2);
    }
  }
}
// 여러 열에 걸친 것은 짧은 것부터 처리한다. 긴 것은 앞서 벌어진 폭을 물려받는다.
var spans = [];
for (mi = 0; mi < M.length; mi++) {
  var ms = M[mi];
  if (ms.a === ms.b) continue;
  spans.push({lo:Math.min(ms.a, ms.b), hi:Math.max(ms.a, ms.b), need:ms.tw + (ms.note ? 34 : 30)});
}
spans.sort(function(x, y){ return (x.hi - x.lo) - (y.hi - y.lo); });
for (var si = 0; si < spans.length; si++) {
  var sp = spans[si];
  var cur = 0;
  for (i = sp.lo; i < sp.hi; i++) cur += gaps[i];
  if (cur < sp.need) {
    var add = (sp.need - cur) / (sp.hi - sp.lo);
    for (i = sp.lo; i < sp.hi; i++) gaps[i] += add;
  }
}
var CX = [0];
for (i = 0; i < gaps.length; i++) CX.push(CX[i] + gaps[i]);
for (i = 0; i < P.length; i++) {
  P[i].cx = CX[i];
  P[i].x = CX[i] - P[i].w / 2;
  P[i].y = 0;
}

// ── ④ 프래그먼트 깊이 (겹친 만큼 안쪽으로 들어간다) ──
var FR = S.fragments;
for (var fi = 0; fi < FR.length; fi++) {
  var f = FR[fi], depth = 0;
  for (var fj = 0; fj < FR.length; fj++) {
    if (fj === fi) continue;
    var g = FR[fj];
    var contains = (g.from <= f.from && g.to >= f.to);
    var same = (g.from === f.from && g.to === f.to);
    if (contains && (!same || fj < fi)) depth++;
  }
  f.depth = depth;
}
var padTop = [], padBot = [];
for (mi = 0; mi < M.length; mi++) { padTop.push(0); padBot.push(0); }
for (fi = 0; fi < FR.length; fi++) { padTop[FR[fi].from] += FR_HEAD; padBot[FR[fi].to] += FR_TAIL; }

// ── ⑤ 행 배치 ──
var cursor = CARD_H + HEAD_ROOM;
for (mi = 0; mi < M.length; mi++) {
  var mr = M[mi];
  cursor += padTop[mi];
  mr.top = cursor;
  if (mr.note) {
    mr.h = mr.th + 18;
    mr.boxY = cursor;
  } else if (mr.self) {
    mr.h = Math.max(SELF_H + 20, mr.th + 16);
    mr.y1 = cursor + (mr.h - SELF_H) / 2;
    mr.y2 = mr.y1 + SELF_H;
  } else {
    mr.h = mr.th + 12;
    mr.ay = cursor + mr.h;
  }
  cursor += mr.h + padBot[mi] + ROW_GAP;
}
var BOTTOM = cursor - ROW_GAP + 20;

// ── ⑥ 활성 막대: 호출/응답 짝에서 뽑는다 ──
var ACT = [], stack = [], lastY = [];
for (i = 0; i < P.length; i++) { ACT.push([]); stack.push([]); lastY.push(CARD_H + 20); }
if (S.activations) {
  for (mi = 0; mi < M.length; mi++) {
    var ma = M[mi];
    if (ma.note) continue;
    var yy = ma.self ? ma.y2 : ma.ay;
    if (lastY[ma.a] < yy) lastY[ma.a] = yy;
    if (lastY[ma.b] < yy) lastY[ma.b] = yy;
    if (ma.self) continue;
    if (ma.kind === 'return') {
      var st = stack[ma.a];
      if (st.length) { var open = st.pop(); open.y2 = ma.ay; }
    } else {
      var bar = {y1:ma.ay, y2:-1, depth:stack[ma.b].length};
      ACT[ma.b].push(bar);
      stack[ma.b].push(bar);
    }
  }
  // 안 닫힌 막대는 그 참가자가 마지막으로 관여한 지점까지 끈다.
  for (i = 0; i < P.length; i++) {
    for (var q = 0; q < ACT[i].length; q++) {
      if (ACT[i][q].y2 < 0) ACT[i][q].y2 = Math.max(lastY[i], ACT[i][q].y1 + 20);
    }
  }
}
// 화살표는 생명선 한가운데가 아니라 막대 가장자리에서 끊는다.
function barEdge(pi, y, side){
  var best = -1;
  for (var b = 0; b < ACT[pi].length; b++) {
    var bar = ACT[pi][b];
    if (y >= bar.y1 - 0.5 && y <= bar.y2 + 0.5 && bar.depth > best) best = bar.depth;
  }
  if (best < 0) return 0;
  return best * BAR_STEP + side * (BAR_W / 2);
}

// ── ⑥-b 메시지가 실제로 닿는 x 범위 ──
// ★ 그리기 전에 확정한다. 프래그먼트를 '전체 열'이 아니라 '자기 메시지가 닿는
//   곳'만 감싸게 하려면 상자를 그리는 시점에 이 값이 이미 있어야 한다.
for (mi = 0; mi < M.length; mi++) {
  var mx = M[mi];
  if (mx.note) {
    var bw0 = mx.tw + 28;
    if (mx.a === mx.b) {
      mx.box = {x:P[mx.a].cx + NOTE_OFF, y:mx.boxY, w:bw0, h:mx.h};
      mx.lo = P[mx.a].cx - BAR_W;
      mx.hi = mx.box.x + bw0;
    } else {
      // ★ from~to 를 가리킨다고 해놓고 가운데에만 떠 있으면 어디 얘기인지 모른다.
      //   글자가 짧아도 상자는 그 구간을 실제로 덮는다.
      var nlo = P[Math.min(mx.a,mx.b)].cx, nhi = P[Math.max(mx.a,mx.b)].cx;
      bw0 = Math.max(bw0, nhi - nlo + 40);
      mx.box = {x:(nlo + nhi) / 2 - bw0 / 2, y:mx.boxY, w:bw0, h:mx.h};
      mx.lo = Math.min(mx.box.x, nlo);
      mx.hi = Math.max(mx.box.x + bw0, nhi);
    }
  } else if (mx.self) {
    var se1 = barEdge(mx.a, mx.y1, 1), se2 = barEdge(mx.a, mx.y2, 1);
    mx.x0 = P[mx.a].cx + se1;
    mx.x1 = P[mx.a].cx + se2;
    mx.far = P[mx.a].cx + Math.max(se1, se2) + SELF_W;
    mx.lo = P[mx.a].cx - BAR_W;
    mx.hi = mx.far;
  } else {
    var mdir = mx.b > mx.a ? 1 : -1;
    mx.x0 = P[mx.a].cx + barEdge(mx.a, mx.ay, mdir);
    mx.x1 = P[mx.b].cx + barEdge(mx.b, mx.ay, -mdir);
    mx.lo = Math.min(mx.x0, mx.x1, P[mx.a].cx, P[mx.b].cx) - BAR_W;
    mx.hi = Math.max(mx.x0, mx.x1, P[mx.a].cx, P[mx.b].cx) + BAR_W;
  }
}

// ── ⑦ 그리기 (프래그먼트 → 생명선 → 막대 → 화살표 → 노트 → 카드 → 라벨) ──
var startOff = Object.create(null), endOff = Object.create(null);
var byStart = FR.slice().sort(function(a, b){ return (a.from - b.from) || (a.depth - b.depth); });
for (fi = 0; fi < byStart.length; fi++) {
  var fs = byStart[fi], ks = 'i' + fs.from;
  fs.headOff = startOff[ks] || 0;
  startOff[ks] = fs.headOff + FR_HEAD;
}
var byEnd = FR.slice().sort(function(a, b){ return (a.to - b.to) || (b.depth - a.depth); });
for (fi = 0; fi < byEnd.length; fi++) {
  var fe = byEnd[fi], ke = 'i' + fe.to;
  fe.tailOff = endOff[ke] || 0;
  endOff[ke] = fe.tailOff + FR_TAIL;
}
var chipEls = [];
// ★ 상자는 전체 열이 아니라 **자기 메시지가 실제로 닿는 범위**만 감싼다.
//   전체를 감싸면 loop 하나가 관계없는 열까지 묶은 것처럼 읽힌다(실물 확인).
for (fi = 0; fi < FR.length; fi++) {
  var fr = FR[fi];
  var flo = Infinity, fhi = -Infinity;
  for (var fk = fr.from; fk <= fr.to; fk++) {
    if (M[fk].lo < flo) flo = M[fk].lo;
    if (M[fk].hi > fhi) fhi = M[fk].hi;
  }
  fr.x = flo - FR_PAD;
  fr.x2 = fhi + FR_PAD;
  // 종류 칩과 조건 라벨이 상자보다 넓으면 글자가 밖으로 나간다. 미리 넓혀 둔다.
  var chipNeed = measure(fr.kind, 'fr-kind') + 18 + (fr.label ? measure(fr.label, 'fr-label') + 9 : 0) + 14;
  if (fr.x2 - fr.x < chipNeed) fr.x2 = fr.x + chipNeed;
  fr.y = M[fr.from].top - padTop[fr.from] + fr.headOff;
  fr.y2 = M[fr.to].top + M[fr.to].h + 16 + fr.tailOff;
  FR[fi] = fr;
}
// 겹친 상자는 안쪽이 확실히 안에 들어가게 바깥을 넓힌다. 깊은 것부터 확정한다.
var byDepth = FR.slice().sort(function(a, b){ return b.depth - a.depth; });
for (fi = 0; fi < byDepth.length; fi++) {
  var kid = byDepth[fi];
  for (fj = 0; fj < FR.length; fj++) {
    var par = FR[fj];
    if (par === kid) continue;
    if (par.from <= kid.from && par.to >= kid.to && par.depth < kid.depth) {
      if (par.x > kid.x - 13) par.x = kid.x - 13;
      if (par.x2 < kid.x2 + 13) par.x2 = kid.x2 + 13;
    }
  }
}
for (fi = 0; fi < FR.length; fi++) {
  fr = FR[fi];
  el('rect', {x:fr.x, y:fr.y, width:fr.x2 - fr.x, height:fr.y2 - fr.y, rx:11,
              fill:fr.fill, stroke:fr.stroke, 'stroke-width':1.3,
              'fill-opacity':0.55}, content);
}
for (i = 0; i < P.length; i++) {
  el('path', {d:'M'+P[i].cx+','+(CARD_H + 8)+' V'+BOTTOM, stroke:'#cbd5e1',
              'stroke-width':1.4, fill:'none', 'stroke-dasharray':'5 5'}, content);
}
for (i = 0; i < P.length; i++) {
  for (q = 0; q < ACT[i].length; q++) {
    var ab = ACT[i][q];
    el('rect', {x:P[i].cx + ab.depth * BAR_STEP - BAR_W / 2, y:ab.y1,
                width:BAR_W, height:Math.max(20, ab.y2 - ab.y1), rx:3,
                fill:'#ffffff', stroke:'#94a3b8', 'stroke-width':1.2}, content);
  }
}
for (mi = 0; mi < M.length; mi++) {
  var md = M[mi];
  if (md.note) continue;
  var kk = kindOf(md.kind);
  var d;
  if (md.self) {
    var r = 8, far = md.far;
    d = 'M' + md.x0 + ',' + md.y1 +
        ' H' + (far - r) + ' Q' + far + ',' + md.y1 + ' ' + far + ',' + (md.y1 + r) +
        ' V' + (md.y2 - r) + ' Q' + far + ',' + md.y2 + ' ' + (far - r) + ',' + md.y2 +
        ' H' + md.x1;
  } else {
    d = 'M' + md.x0 + ',' + md.ay + ' H' + md.x1;
  }
  var pe = el('path', {d:d, fill:'none', stroke:kk.color, 'stroke-width':1.8,
                       'marker-end':'url(#ar-'+kk.key+')'}, content);
  if (kk.dash) pe.setAttribute('stroke-dasharray', kk.dash);
}
var noteBoxes = [], noteTexts = [];
for (mi = 0; mi < M.length; mi++) {
  var mn = M[mi];
  if (!mn.note) continue;
  var bw = mn.box.w, bx = mn.box.x;
  if (mn.a === mn.b) {
    el('path', {d:'M'+P[mn.a].cx+','+(mn.boxY + mn.h / 2)+' H'+bx,
                stroke:'#f59e0b', 'stroke-width':1.2, fill:'none',
                'stroke-dasharray':'3 3'}, content);
  }
  el('rect', {x:bx, y:mn.boxY, width:bw, height:mn.h, rx:8,
              fill:'#fffbeb', stroke:'#f59e0b', 'stroke-width':1.2}, content);
  el('path', {d:'M'+(bx+bw-14)+','+mn.boxY+' L'+(bx+bw)+','+(mn.boxY+14),
              stroke:'#f59e0b', 'stroke-width':1.2, fill:'none'}, content);
  for (var nl = 0; nl < mn.lines.length; nl++) {
    var nt = txt(bx + 14, mn.boxY + 12 + mn.lh * 0.8 + nl * mn.lh, 'nt-t', mn.lines[nl], 'start', null, content);
    noteTexts.push([nt, mn.box, mn.lines[nl]]);
  }
  noteBoxes.push([mn.box, mn.raw, {lo:Math.min(mn.a,mn.b), hi:Math.max(mn.a,mn.b)}]);
}
function drawIcon(name, cxp, cyp, color){
  var prims = S.icons[name];
  if (!prims) return;
  var size = 30;
  el('rect', {x:cxp - size/2, y:cyp - size/2, width:size, height:size, rx:9, fill:color}, content);
  var s = 0.86;
  var g = el('g', {transform:'translate(' + (cxp - 12*s) + ',' + (cyp - 12*s) + ') scale(' + s + ')',
                   fill:'none', stroke:'#ffffff', 'stroke-width':2,
                   'stroke-linecap':'round', 'stroke-linejoin':'round'}, content);
  for (var z = 0; z < prims.length; z++) {
    var pr = prims[z];
    if (pr[0] === 'r') el('rect', {x:pr[1], y:pr[2], width:pr[3], height:pr[4], rx:pr[5]}, g);
    else if (pr[0] === 'c') el('circle', {cx:pr[1], cy:pr[2], r:pr[3]}, g);
    else if (pr[0] === 'e') el('ellipse', {cx:pr[1], cy:pr[2], rx:pr[3], ry:pr[4]}, g);
    else if (pr[0] === 'd') el('circle', {cx:pr[1], cy:pr[2], r:pr[3], fill:'#ffffff', stroke:'none'}, g);
    else if (pr[0] === 'l') el('line', {x1:pr[1], y1:pr[2], x2:pr[3], y2:pr[4]}, g);
    else if (pr[0] === 'p') el('path', {d:pr[1]}, g);
  }
}
var cardTexts = [], tagBoxes = [];
for (i = 0; i < P.length; i++) {
  var pc = P[i];
  el('rect', {x:pc.x, y:pc.y, width:pc.w, height:pc.h, rx:11, fill:'#ffffff',
              stroke:'#d1d5db', 'stroke-width':1.3,
              filter:'drop-shadow(0 1.5px 3px rgba(15,23,42,.09))'}, content);
  var top = pc.y + (pc.h - pc.contentH) / 2;
  if (pc.icon) drawIcon(pc.icon, pc.cx, top + 15, pc.iconColor);
  var baseY = top + (pc.icon ? 36 : 0) + 14;
  cardTexts.push([txt(pc.cx, baseY, 'p-title', pc.name, 'middle', null, content), pc]);
  if (pc.sub) cardTexts.push([txt(pc.cx, baseY + 16, 'p-sub', pc.sub, 'middle', null, content), pc]);
  if (pc.tag) {
    var tgx = pc.x + pc.w - pc.tagW - 9;
    el('rect', {x:tgx, y:pc.y + 9, width:pc.tagW, height:19, rx:6, fill:pc.tagColor}, content);
    txt(tgx + pc.tagW / 2, pc.y + 22.5, 'tag-t', pc.tag, 'middle', null, content);
    tagBoxes.push([{x:tgx, y:pc.y + 9, w:pc.tagW, h:19}, pc]);
  }
}
var labelEls = [];
for (mi = 0; mi < M.length; mi++) {
  var ml = M[mi];
  if (ml.note || !ml.lines.length) continue;
  var kc = kindOf(ml.kind);
  var lx2, ly2, anch;
  if (ml.self) {
    lx2 = ml.far + 10;
    ly2 = (ml.y1 + ml.y2) / 2 - (ml.lines.length - 1) * ml.lh / 2 + 4;
    anch = 'start';
  } else {
    lx2 = (ml.x0 + ml.x1) / 2;
    ly2 = ml.ay - 9 - (ml.lines.length - 1) * ml.lh;
    anch = 'middle';
  }
  for (var lj = 0; lj < ml.lines.length; lj++) {
    var le = txt(lx2, ly2 + lj * ml.lh, 'm-label', ml.lines[lj], anch, kc.color, content);
    labelEls.push([le, ml.raw, ml]);
  }
}
// ★ 프래그먼트 칩은 **맨 마지막**에 그린다. 상자와 같이 그렸더니 그 위를 지나는
//   활성 막대와 화살표가 칩을 덮어 종류 글자가 반쯤 사라졌다(실물 확인).
//   상자는 배경이고 칩은 이름표다 — 이름표가 가려지면 상자를 못 읽는다.
for (fi = 0; fi < FR.length; fi++) {
  var fc = FR[fi];
  var kw = measure(fc.kind, 'fr-kind') + 18;
  el('rect', {x:fc.x, y:fc.y, width:kw, height:20, rx:6, fill:fc.solid}, content);
  var kt = txt(fc.x + kw / 2, fc.y + 14, 'fr-kind', fc.kind, 'middle', null, content);
  chipEls.push([kt, {x:fc.x, y:fc.y, w:kw, h:20}, fc.kind]);
  fc.chipBox = {x:fc.x, y:fc.y, w:kw, h:20};
  if (fc.label) {
    var lt = txt(fc.x + kw + 9, fc.y + 14, 'fr-label', fc.label, 'start', null, content);
    fc.labelBox = boxOf(lt);
  }
}

// ── ⑧ 캔버스 되맞춤 ──
svg.removeChild(scratch);
var bb = content.getBBox();
var dx = PAD - bb.x, dy = headerBottom + GAP - bb.y;
content.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
var W = Math.ceil(Math.max(bb.width + PAD*2, headerW + PAD*2, 720));
var H = Math.ceil(headerBottom + GAP + bb.height + PAD);

// ★★ page.ts 와 같은 이유로 **설정하기 전에** 거른다. 크기를 박는 순간 브라우저가
//   그만한 표면을 잡는다 — 바깥에서 막으면 늦는다.
if (W > S.maxDim || H > S.maxDim || W * H > S.maxArea) {
  document.title = 'AUDIT_TOO_BIG ' + JSON.stringify({w:W, h:H, maxDim:S.maxDim, maxArea:S.maxArea});
  return;
}
svg.setAttribute('width', W); svg.setAttribute('height', H);
svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
document.getElementById('wrap').style.width = W + 'px';
document.getElementById('wrap').style.height = H + 'px';

// ── ⑨ 자가감사 ──
// 여기서 재는 것은 전부 '내 배치 계산이 맞았는가'다. 통과가 곧 좋은 그림이라는
// 뜻은 아니다 — 기하만 본다.
var over = [], collide = [], label = [], cross = [], frame = [];

for (var ci2 = 0; ci2 < cardTexts.length; ci2++) {
  var ct = cardTexts[ci2][0], cp = cardTexts[ci2][1];
  var cb = boxOf(ct);
  if (cb.x < cp.x + 4 || cb.x + cb.w > cp.x + cp.w - 4) over.push('카드 ' + cp.name + ': ' + ct.textContent);
  else if (cb.y + cb.h > cp.y + cp.h - 1) over.push('카드 ' + cp.name + ' 아래로: ' + ct.textContent);
}
for (var ni2 = 0; ni2 < noteTexts.length; ni2++) {
  var ntt = noteTexts[ni2][0], ntb = noteTexts[ni2][1];
  var nb = boxOf(ntt);
  if (nb.x < ntb.x + 3 || nb.x + nb.w > ntb.x + ntb.w - 3 || nb.y + nb.h > ntb.y + ntb.h - 1) {
    over.push('노트 밖으로: ' + ntt.textContent);
  }
}
for (var pi2 = 0; pi2 < chipEls.length; pi2++) {
  var cte = chipEls[pi2][0], ctb = chipEls[pi2][1];
  var cbb = boxOf(cte);
  if (cbb.x < ctb.x + 2 || cbb.x + cbb.w > ctb.x + ctb.w - 2) over.push('프래그먼트 칩: ' + chipEls[pi2][2]);
}

// ★ 배지가 이름을 덮는 결함은 '글자가 카드 밖으로 나갔나'로는 안 잡힌다 —
//   글자는 카드 안에 얌전히 있고 배지가 그 위에 얹힐 뿐이다. 따로 재야 한다.
for (var tg = 0; tg < tagBoxes.length; tg++) {
  for (var tc = 0; tc < cardTexts.length; tc++) {
    if (cardTexts[tc][1] !== tagBoxes[tg][1]) continue;
    if (rectsOverlap(tagBoxes[tg][0], boxOf(cardTexts[tc][0]))) {
      collide.push(tagBoxes[tg][1].name + ': 배지가 글자를 덮음 (카드를 넓혀야 한다)');
    }
  }
}
for (i = 0; i < P.length; i++) {
  for (var j2 = i + 1; j2 < P.length; j2++) {
    if (rectsOverlap({x:P[i].x, y:P[i].y, w:P[i].w, h:P[i].h},
                     {x:P[j2].x, y:P[j2].y, w:P[j2].w, h:P[j2].h})) {
      collide.push('카드 ' + P[i].name + ' ↔ ' + P[j2].name);
    }
  }
}
for (i = 0; i < P.length; i++) {
  for (q = 0; q < ACT[i].length; q++) {
    for (var q2 = q + 1; q2 < ACT[i].length; q2++) {
      var b1 = ACT[i][q], b2 = ACT[i][q2];
      if (b1.depth === b2.depth && b1.y1 < b2.y2 && b2.y1 < b1.y2) {
        collide.push('활성막대가 같은 자리에 둘: ' + P[i].name);
      }
    }
  }
}
for (var nb1 = 0; nb1 < noteBoxes.length; nb1++) {
  for (i = 0; i < P.length; i++) {
    if (rectsOverlap(noteBoxes[nb1][0], {x:P[i].x, y:P[i].y, w:P[i].w, h:P[i].h})) {
      collide.push('노트가 카드 ' + P[i].name + ' 위에 겹침');
    }
  }
  for (var nb2 = nb1 + 1; nb2 < noteBoxes.length; nb2++) {
    if (rectsOverlap(noteBoxes[nb1][0], noteBoxes[nb2][0])) collide.push('노트끼리 겹침');
  }
  var own = noteBoxes[nb1][2];
  for (i = 0; i < P.length; i++) {
    if (i >= own.lo && i <= own.hi) continue;
    var nbx = noteBoxes[nb1][0];
    if (P[i].cx >= nbx.x && P[i].cx <= nbx.x + nbx.w) {
      collide.push('노트가 ' + P[i].name + ' 생명선을 덮음');
    }
  }
}

var lboxes = [];
for (var lb = 0; lb < labelEls.length; lb++) lboxes.push(boxOf(labelEls[lb][0]));

// ★★ 이 두 검사는 변이시험에서 **구멍이 드러나 뒤늦게 넣은 것**이다.
//   열 넓히기와 행 높이 계산을 일부러 망가뜨렸는데 나머지 항목이 전부 통과했다.
//   라벨이 다른 걸 덮지는 않으면서 제 구간만 벗어나는 경우가 있었기 때문이다.
//   '아무것도 안 걸렸다'는 곧 '맞다'가 아니다 — 재는 항목이 없으면 안 걸린다.
for (var lx3 = 0; lx3 < lboxes.length; lx3++) {
  var lm = labelEls[lx3][2], lbx = lboxes[lx3];
  var loX, hiX;
  if (lm.self) {
    loX = P[lm.a].cx;
    hiX = (lm.a < P.length - 1) ? (P[lm.a+1].x - 4) : Infinity;
  } else {
    loX = Math.min(P[lm.a].cx, P[lm.b].cx) - 6;
    hiX = Math.max(P[lm.a].cx, P[lm.b].cx) + 6;
  }
  if (lbx.x < loX || lbx.x + lbx.w > hiX) {
    label.push("'" + labelEls[lx3][1] + "' 가 제 구간 밖으로 나감 (열을 더 넓혀야 한다)");
  }
  if (lbx.y < lm.top - 3 || lbx.y + lbx.h > lm.top + lm.h + 3) {
    label.push("'" + labelEls[lx3][1] + "' 가 제 행을 벗어남 (행 높이가 모자란다)");
  }
}
for (var lb2 = 0; lb2 < lboxes.length; lb2++) {
  for (i = 0; i < P.length; i++) {
    if (rectsOverlap(lboxes[lb2], {x:P[i].x, y:P[i].y, w:P[i].w, h:P[i].h})) {
      label.push("'" + labelEls[lb2][1] + "' 가 카드 " + P[i].name + ' 를 가림');
      break;
    }
  }
  for (var nb3 = 0; nb3 < noteBoxes.length; nb3++) {
    if (rectsOverlap(lboxes[lb2], noteBoxes[nb3][0])) {
      label.push("'" + labelEls[lb2][1] + "' 가 노트를 가림");
      break;
    }
  }
  for (var lc = lb2 + 1; lc < lboxes.length; lc++) {
    // 같은 메시지의 여러 줄은 겹치지 않게 이미 쌓아 놓았다. 그래도 재는 건
    // 줄높이를 잘못 잡으면 여기서 걸려야 하기 때문이다.
    if (rectsOverlap(lboxes[lb2], lboxes[lc])) {
      label.push("'" + labelEls[lb2][1] + "' ↔ '" + labelEls[lc][1] + "'");
    }
  }
}

for (mi = 0; mi < M.length; mi++) {
  var mc = M[mi];
  if (mc.note) continue;
  var ys = mc.self ? [mc.y1, mc.y2] : [mc.ay];
  var xlo = Math.min(mc.x0, mc.x1), xhi = Math.max(mc.x0, mc.x1);
  if (mc.self) { xlo = Math.min(xlo, mc.far); xhi = Math.max(xhi, mc.far); }
  for (var yi = 0; yi < ys.length; yi++) {
    var seg = {x:xlo, y:ys[yi] - 1, w:xhi - xlo, h:2};
    for (i = 0; i < P.length; i++) {
      if (rectsOverlap(seg, {x:P[i].x, y:P[i].y, w:P[i].w, h:P[i].h})) {
        cross.push("'" + mc.raw + "' 가 카드 " + P[i].name + ' 를 관통');
      }
    }
    for (var nb4 = 0; nb4 < noteBoxes.length; nb4++) {
      if (rectsOverlap(seg, noteBoxes[nb4][0])) cross.push("'" + mc.raw + "' 가 노트를 관통");
    }
  }
}

for (fi = 0; fi < FR.length; fi++) {
  var fchk = FR[fi];
  for (var k2 = fchk.from; k2 <= fchk.to; k2++) {
    var im = M[k2];
    if (im.top < fchk.y + 2) frame.push(fchk.kind + ' 상자가 메시지 ' + k2 + '번 위쪽을 못 덮음');
    if (im.top + im.h > fchk.y2 - 4) frame.push(fchk.kind + ' 상자가 메시지 ' + k2 + '번 아래쪽을 못 덮음');
    if (im.lo < fchk.x || im.hi > fchk.x2) {
      frame.push(fchk.kind + ' 상자가 메시지 ' + k2 + '번 좌우를 못 덮음');
    }
  }
  for (var lb3 = 0; lb3 < lboxes.length; lb3++) {
    if (fchk.labelBox && rectsOverlap(fchk.labelBox, lboxes[lb3])) {
      label.push("프래그먼트 '" + fchk.label + "' 가 라벨 '" + labelEls[lb3][1] + "' 와 겹침");
    }
    if (fchk.chipBox && rectsOverlap(fchk.chipBox, lboxes[lb3])) {
      label.push("프래그먼트 칩 '" + fchk.kind + "' 가 라벨 '" + labelEls[lb3][1] + "' 와 겹침");
    }
  }
  if (fchk.labelBox && (fchk.labelBox.x + fchk.labelBox.w > fchk.x2 - 6)) {
    over.push("프래그먼트 조건 '" + fchk.label + "' 가 상자 밖으로 나감");
  }
  for (var nb5 = 0; nb5 < noteBoxes.length; nb5++) {
    if (fchk.chipBox && rectsOverlap(fchk.chipBox, noteBoxes[nb5][0])) {
      label.push("프래그먼트 칩 '" + fchk.kind + "' 가 노트와 겹침");
    }
  }
}

document.title = 'AUDIT ' + JSON.stringify({
  w:W, h:H, over:over, collide:collide, label:label, cross:cross, frame:frame
});
} catch (err) {
  document.title = 'AUDIT_ERROR ' + ((err && err.message) ? err.message : String(err));
}
})();
`;

export function buildSequenceHtml(spec: SequenceSpec): string {
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
export function parseSequenceAudit(dom: string): SequenceAudit {
	const tooBig = /<title>AUDIT_TOO_BIG (\{.*?\})<\/title>/s.exec(dom);
	if (tooBig?.[1]) {
		const size = JSON.parse(tooBig[1]) as { w: number; h: number };
		throw new Error(
			`그림이 너무 큽니다: ${size.w}×${size.h}px ` +
				`(상한 ${MAX_DIM}px / 면적 ${(MAX_AREA / 1_000_000).toFixed(0)}백만px).\n` +
				'참가자를 줄이거나 메시지를 나누세요 — 라벨이 길수록 열이 벌어집니다.',
		);
	}
	const failed = /<title>AUDIT_ERROR (.*?)<\/title>/s.exec(dom);
	if (failed?.[1]) throw new Error(`그림을 그리다 실패했습니다: ${failed[1]}`);
	const match = /<title>AUDIT (\{.*?\})<\/title>/s.exec(dom);
	if (!match?.[1]) {
		throw new Error(
			'렌더 결과를 읽지 못했습니다 — 페이지 스크립트가 끝까지 돌지 않았습니다.',
		);
	}
	return JSON.parse(match[1]) as SequenceAudit;
}

/** 사람이 읽는 감사 요약. */
export function formatSequenceAudit(a: SequenceAudit): string {
	const lines: string[] = [];
	const add = (label: string, items: string[]): void => {
		if (items.length) lines.push(`- ${label} ${items.length}건: ${items.join(' / ')}`);
	};
	add('글자 삐져나옴', a.over);
	add('카드/막대/노트 겹침', a.collide);
	add('라벨 겹침', a.label);
	add('화살표 관통', a.cross);
	add('프래그먼트 범위', a.frame);
	if (!lines.length) return '자가감사 통과 — 삐져나옴, 겹침, 관통, 프래그먼트 범위 0건';
	return `⚠️ 자가감사에서 걸린 것:\n${lines.join('\n')}`;
}
