/**
 * 글 표지(썸네일) 카드.
 *
 * 벨로그는 글 목록·SNS 공유에서 `thumbnail` 을 쓴다. 없으면 본문 첫 이미지를 쓰거나
 * 그냥 비어 보인다. 제목만 있는 글이라도 표지 한 장이 있으면 목록에서 확실히 다르다.
 *
 * 크기는 1200×630 — OG 이미지 표준 비율이라 트위터·슬랙 미리보기에서 잘리지 않는다.
 * 줄바꿈은 여기서도 브라우저 실측으로 한다. 글자수로 자르면 한글에서 반드시 틀린다.
 */

import { tone } from './tones.ts';

export interface CoverSpec {
	title: string;
	subtitle?: string | undefined;
	/** 상단 작은 라벨 (예: '디버깅 기록', 'OSS 기여') */
	kicker?: string | undefined;
	tags?: string[] | undefined;
	tone?: string | undefined;
	/** 우하단 서명 (예: 'velog.io/@milcho0604') */
	footer?: string | undefined;
}

export interface CoverAudit {
	w: number;
	h: number;
	/** 넘쳐서 잘라낸 줄 */
	truncated: string[];
	/** 실제로 쓰인 제목 글자 크기 — 줄어들었으면 제목이 길다는 뜻 */
	titleSize: number;
}

const STYLE = `
  html,body { margin:0; padding:0; }
  #wrap { position:relative; }
  svg { display:block; }
  .kicker { font-weight:700; letter-spacing:1.6px; }
  .title  { font-weight:800; }
  .sub    { font-weight:400; }
  .tag    { font-weight:600; }
  .foot   { font-weight:600; }
  text { font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",sans-serif;
          text-rendering:geometricPrecision; }
`;

// ★ page.ts 와 같은 규칙: 이 문자열 안에서는 백틱과 ${ 를 쓰지 않는다.
const SCRIPT = `
(function(){
'use strict';
var S = JSON.parse(document.getElementById('spec').textContent);
var NS = 'http://www.w3.org/2000/svg';
var svg = document.getElementById('cv');
var W = 1200, H = 630, M = 84;
svg.setAttribute('width', W); svg.setAttribute('height', H);
svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
document.getElementById('wrap').style.width = W + 'px';
document.getElementById('wrap').style.height = H + 'px';

function el(n, a, p){
  var e = document.createElementNS(NS, n);
  for (var k in a) { if (a[k] !== null && a[k] !== undefined) e.setAttribute(k, a[k]); }
  (p || svg).appendChild(e);
  return e;
}
function txt(x, y, s, size, weightCls, fill, anchor){
  var t = el('text', {x:x, y:y, 'class':weightCls, 'font-size':size, fill:fill,
                      'text-anchor':anchor || 'start'});
  t.textContent = s;
  return t;
}

// 구성도와 같은 시각 언어로 그린다: 흰 카드, 점 격자, 배지 칩.
// 그러데이션 포스터 풍은 어디서나 나오는 자동 생성 표지처럼 읽혀서 버렸다.
var defs = el('defs', {});
var pat = el('pattern', {id:'dots', width:26, height:26, patternUnits:'userSpaceOnUse'}, defs);
el('circle', {cx:3, cy:3, r:1.6, fill:S.solid, opacity:'0.35'}, pat);
el('rect', {x:0, y:0, width:W, height:H, fill:'#ffffff'});
el('rect', {x:0, y:0, width:W, height:H, fill:S.fill, opacity:'0.45'});
el('rect', {x:0, y:0, width:W, height:H, fill:'url(#dots)'});
var CARD = 40;
el('rect', {x:CARD, y:CARD, width:W - CARD*2, height:H - CARD*2, rx:18, fill:'#ffffff',
            stroke:'#e5e7eb', 'stroke-width':1.4,
            filter:'drop-shadow(0 2px 6px rgba(15,23,42,.08))'});

var scratch = el('g', {visibility:'hidden'});
function widthOf(s, size, cls){
  var t = el('text', {'font-size':size, 'class':cls}, scratch);
  t.textContent = s;
  var w = t.getBBox().width;
  scratch.removeChild(t);
  return w;
}
// 실측 기반 줄바꿈. 공백이 없으면(한글 긴 제목) 글자 단위로 끊는다.
function wrap(s, size, cls, maxW, maxLines){
  var words = s.split(' ');
  var lines = [], cur = '';
  for (var i = 0; i < words.length; i++) {
    var probe = cur ? cur + ' ' + words[i] : words[i];
    if (widthOf(probe, size, cls) <= maxW || !cur) {
      if (widthOf(probe, size, cls) > maxW && !cur) {
        // 단어 하나가 이미 넘친다 — 글자 단위로 끊는다
        var piece = '';
        for (var c = 0; c < probe.length; c++) {
          if (widthOf(piece + probe[c], size, cls) > maxW && piece) {
            lines.push(piece); piece = probe[c];
            if (lines.length >= maxLines) break;
          } else piece += probe[c];
        }
        cur = piece;
        continue;
      }
      cur = probe;
    } else { lines.push(cur); cur = words[i]; }
    if (lines.length >= maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

var truncated = [];
var bare = function(v){ return v.replace(/\\s/g, ''); };

if (S.kicker) {
  var kcw = widthOf(S.kicker, 19, 'kicker') + 28;
  el('rect', {x:M, y:M - 20, width:kcw, height:40, rx:9, fill:S.solid});
  txt(M + kcw/2, M + 7, S.kicker, 19, 'kicker', '#ffffff', 'middle');
}

// 제목: 3줄에 안 들어가면 글자 크기를 줄여 다시 시도한다
var size = 62, lines = [];
var MAXW = W - M * 2 - 40;
for (;;) {
  lines = wrap(S.title, size, 'title', MAXW, 3);
  if (bare(lines.join('')).length >= bare(S.title).length || size <= 40) break;
  size -= 4;
}
if (bare(lines.join('')).length < bare(S.title).length) truncated.push('제목');

var subLines = [];
if (S.subtitle) {
  subLines = wrap(S.subtitle, 25, 'sub', MAXW, 2);
  if (bare(subLines.join('')).length < bare(S.subtitle).length) truncated.push('부제');
}

// ★ 위에서부터 쌓기만 하면 제목이 짧을 때 아래가 휑하다.
//   케커 아래 ~ 태그 위 사이 공간에 글 덩어리를 세로 중앙으로 놓는다.
var blockH = lines.length * (size + 6) + (subLines.length ? 30 + subLines.length * 34 : 0);
var areaTop = M + (S.kicker ? 54 : 10);
var areaBottom = H - M - (S.tags && S.tags.length ? 54 : 10);
var y = areaTop + Math.max(0, (areaBottom - areaTop - blockH) / 2);

for (var li = 0; li < lines.length; li++) {
  y += size + 6;
  txt(M, y, lines[li], size, 'title', '#0f172a');
}
if (subLines.length) {
  y += 30;
  for (var si = 0; si < subLines.length; si++) {
    y += 34;
    txt(M, y, subLines[si], 25, 'sub', '#475569');
  }
}

if (S.tags && S.tags.length) {
  var tx = M, ty = H - M + 4;
  for (var ti = 0; ti < S.tags.length; ti++) {
    var label = '#' + S.tags[ti];
    var tw = widthOf(label, 19, 'tag') + 30;
    if (tx + tw > W - M) { truncated.push('태그 ' + label); continue; }
    el('rect', {x:tx, y:ty - 25, width:tw, height:38, rx:10, fill:S.fill,
                stroke:S.stroke, 'stroke-width':1.2});
    var tt = txt(tx + tw/2, ty, label, 19, 'tag', S.solid, 'middle');
    tx += tw + 12;
  }
}

if (S.footer) txt(W - M, M + 8, S.footer, 19, 'foot', '#94a3b8', 'end');

// ★ 상단 라벨(왼쪽)과 서명(오른쪽)은 같은 높이에 고정 배치된다. 둘 다 길면 가운데서
//   부딪히는데 여기엔 줄바꿈도 축소도 없다 — 감사만이라도 해야 조용히 안 나간다.
if (S.kicker || S.footer) {
  var kw = S.kicker ? widthOf(S.kicker, 19, 'kicker') + 28 : 0;
  var fw = S.footer ? widthOf(S.footer, 19, 'foot') : 0;
  if (M + kw > W - M - fw - 20) truncated.push('상단 라벨과 서명이 겹침');
}

svg.removeChild(scratch);
document.title = 'AUDIT ' + JSON.stringify({w:W, h:H, truncated:truncated, titleSize:size});
})();
`;

function safeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildCoverHtml(spec: CoverSpec): string {
	const t = tone(spec.tone, 'blue');
	const payload = {
		title: spec.title,
		subtitle: spec.subtitle ?? '',
		kicker: spec.kicker ?? '',
		tags: spec.tags ?? [],
		footer: spec.footer ?? '',
		fill: t.fill,
		stroke: t.stroke,
		solid: t.solid,
	};
	return [
		'<!DOCTYPE html>',
		'<html lang="ko"><head><meta charset="utf-8"><title>rendering…</title>',
		`<style>${STYLE}</style>`,
		'</head><body>',
		'<div id="wrap"><svg id="cv" xmlns="http://www.w3.org/2000/svg"></svg></div>',
		`<script type="application/json" id="spec">${safeJson(payload)}</script>`,
		`<script>${SCRIPT}</script>`,
		'</body></html>',
	].join('\n');
}

export function formatCoverAudit(a: CoverAudit): string {
	const notes: string[] = [];
	if (a.truncated.length) notes.push(`넘쳐서 잘린 것: ${a.truncated.join(', ')}`);
	if (a.titleSize < 62) notes.push(`제목이 길어 글자 크기를 ${a.titleSize}px 로 줄였습니다`);
	return notes.length ? `⚠️ ${notes.join(' / ')}` : '표지 생성 완료 — 잘린 곳 없음';
}
