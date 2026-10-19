// ---------------------------------------------------------------------------
// 候选浮层往哪儿摆（纯数学，不需要 DOM）
//
// 这块没有「看起来对不对」之外的标准，越容易踩的是边界：光标在第一行、在最后一行、
// 光标贴着容器右边。所以一条条钉住 —— 改定位时先看这里红不红。
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeNearCaret, placeNearCaretFixed } from '../frontend/js/caret.js';

const PANEL = { width: 380, height: 176 };

// ---------------------------------------------------------------------------
// 视口坐标版：候选浮层走这一套（position: fixed）。
// 关键差别是判断「放不放得下」看的是**视口**，不是编辑器那一小块 ——
// 编辑器的祖先有 overflow 裁切，只有脱离文档流，第一项才真能落在光标这一行。
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1440, height: 900 };

test('视口版：多行编辑器第一项和光标同一行，往下排', () => {
  const anchor = { top: 200, bottom: 380, height: 180 };
  const caret = { left: 500, top: 250, lineHeight: 19 };
  const pos = placeNearCaretFixed(caret, anchor, VIEWPORT, { width: 380, height: 176 });

  assert.equal(pos.top, 245, '减掉浮层自身内边距，第一项文字才和光标对齐');
  assert.ok(pos.top + 176 <= VIEWPORT.height, '视口里放得下就不用翻');
  assert.equal(pos.left, 508, '横向贴光标右边 8px');
});

test('视口版：编辑器很矮也不翻 —— 这正是改 fixed 的原因', () => {
  // 编辑框底边 580，光标在它底部附近；视口下面还有 300 多像素，够铺开
  const anchor = { top: 400, bottom: 580, height: 180 };
  const caret = { left: 100, top: 540, lineHeight: 19 };
  const pos = placeNearCaretFixed(caret, anchor, VIEWPORT, { width: 380, height: 176 });

  assert.equal(pos.top, 535);
  assert.ok(pos.top + 176 > anchor.bottom, '浮层会伸到编辑器外面，这是允许的');
  assert.ok(pos.top + 176 <= VIEWPORT.height, '只要视口放得下就不翻');
});

test('视口版：贴着窗口底才翻到光标行上方', () => {
  const anchor = { top: 700, bottom: 880, height: 180 };
  const caret = { left: 100, top: 860, lineHeight: 19 };
  const pos = placeNearCaretFixed(caret, anchor, VIEWPORT, { width: 380, height: 176 });

  assert.equal(pos.top, 684, '翻上去：光标行上方留出整块浮层高');
  assert.ok(pos.top >= 0);
});

test('视口版：单行输入框贴框底，横向收到视口内', () => {
  const anchor = { top: 100, bottom: 128, height: 28 };
  const caret = { left: 40, top: 112, lineHeight: 16 };
  assert.equal(placeNearCaretFixed(caret, anchor, VIEWPORT, PANEL).top, 134);

  const wide = placeNearCaretFixed({ left: 1300, top: 112 }, anchor, VIEWPORT, PANEL);
  assert.equal(wide.left, 1060, '右边放不下收到视口右沿');

  const narrow = placeNearCaretFixed({ left: 10, top: 112 }, anchor, { width: 200, height: 900 }, PANEL);
  assert.equal(narrow.left, 0, '视口比浮层还窄时退到 0，不出负数');
});

test('视口版：坐标永不为负', () => {
  const anchor = { top: 0, bottom: 180, height: 180 };
  const pos = placeNearCaretFixed({ left: 0, top: 2, lineHeight: 19 }, anchor, VIEWPORT, PANEL);
  assert.equal(pos.top, 0);
});

test('单行输入框：贴在框的下边缘，不算光标行', () => {
  const host = { width: 600, height: 28 };
  const pos = placeNearCaret({ left: 40, top: 12, lineHeight: 16 }, host, PANEL);
  assert.deepEqual(pos, { left: 48, top: 34 }, '单行框的光标行在框内部，贴框底才对');
});

test('多行编辑器：第一项就落在光标这一行，往下排', () => {
  // Body 那种 240px 高、光标在第 3 行（y=40）
  const host = { width: 600, height: 240 };
  const caret = { left: 100, top: 40, lineHeight: 16 };
  const pos = placeNearCaret(caret, host, { width: 320, height: 120 });

  assert.equal(pos.top, 35, '减掉浮层自己的内边距，第一项文字才和光标同一行');
  assert.ok(pos.top + 120 <= host.height, '下面放得下就该往下排');
  assert.equal(pos.left, 108, '横向还是贴在光标右边 8px');
});

test('多行编辑器：下面放不下就翻到光标行上方，不顶出容器', () => {
  const host = { width: 600, height: 240 };
  const caret = { left: 20, top: 200, lineHeight: 16 };
  const pos = placeNearCaret(caret, host, { width: 320, height: 120 });

  assert.equal(pos.top, 80, '翻上去：光标行上方留出整块浮层的高度');
  assert.ok(pos.top >= 0);
});

test('光标在头几行：坐标不出现负数', () => {
  const host = { width: 600, height: 240 };
  const pos = placeNearCaret({ left: 0, top: 2, lineHeight: 16 }, host, PANEL);
  assert.equal(pos.top, 0);
});

test('横向：右边放不下就收边，容器比浮层还窄时退到 0', () => {
  const wide = { width: 800, height: 240 };
  assert.equal(placeNearCaret({ left: 500, top: 40, lineHeight: 16 }, wide, PANEL).left, 420);
  assert.equal(placeNearCaret({ left: 40, top: 40, lineHeight: 16 }, wide, PANEL).left, 48);

  const narrow = { width: 200, height: 240 };
  assert.equal(placeNearCaret({ left: 10, top: 40, lineHeight: 16 }, narrow, PANEL).left, 0);
});
