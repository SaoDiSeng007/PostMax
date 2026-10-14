// ---------------------------------------------------------------------------
// 样式表的静态体检
//
// 主题是纯 CSS 的东西，没有 DOM 就没法「跑」它，但有两类错是文本层面就能抓到的：
//   1. 大括号不配平 —— 一处手滑，后面整段样式全废（页面看着像没上色）；
//   2. 用了没定义的变量 / 暗色漏覆盖关键变量 —— 深色下局部还是白底黑字。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../frontend/css/style.css', import.meta.url), 'utf8');

/** 取某段规则里的变量定义：`--x: y;` */
const defsIn = (block) => new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';
const darkBlock = /html\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] || '';

test('大括号配平（不配平的话后面整段样式会失效）', () => {
  const opens = (css.match(/\{/g) || []).length;
  const closes = (css.match(/\}/g) || []).length;
  assert.equal(opens, closes, `{ ${opens} 个，} ${closes} 个`);
});

test('主题相关的两块都还在', () => {
  assert.ok(rootBlock.includes('--bg:'), ':root 里应该有基础变量');
  assert.ok(darkBlock.includes('--bg:'), '暗色块里应该覆盖 --bg');
});

test('用到的 CSS 变量都有定义（拼错名字在浏览器里是静默失效）', () => {
  // 定义可以在任何选择器里：--hl-pad 这类是局部的（跟着 .hl-input 的尺寸走），
  // 只有 --bg 那一层才需要放在 :root。这里只要求「这张表里定义过」。
  const defined = defsIn(css);
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `这些变量整张表里都没有定义：${missing.join(', ')}`);
});

test('暗色覆盖了所有「不覆盖就会露白」的变量', () => {
  // 底色 / 面板 / 文字 / 描边这四个漏一个，深色下就会看到一块白
  const must = [
    '--bg', '--panel', '--panel-2', '--border', '--border-strong',
    '--text', '--text-dim', '--text-mute',
    '--primary', '--primary-soft', '--on-primary',
    '--green', '--green-soft', '--red', '--red-soft', '--amber', '--amber-soft',
    '--blue', '--purple', '--disabled-bg', '--border-hover',
    '--warn-bg', '--warn-text', '--hit-bg', '--hit-text',
    '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-xl', '--mask-bg',
  ];
  const darkDefs = defsIn(darkBlock);
  const missing = must.filter((name) => !darkDefs.has(name));
  assert.deepEqual(missing, [], `暗色没覆盖：${missing.join(', ')}`);
});

test('暗色带 color-scheme，原生控件才会跟着变暗', () => {
  assert.match(darkBlock, /color-scheme:\s*dark/);
});

// ---------------------------------------------------------------------------
// 配色对比度：静态算，不用开浏览器
//
// 这一组盯的是「灰字调浅了一档，肉眼看不出来，但已经读不动」这类回退。
// 每对都按 WCAG 相对亮度算，要求 4.5:1（AA 的正文线）—— 这里出现的都是小字。
// ---------------------------------------------------------------------------

/** 一段规则里所有「--x: #色值」，收成一张表 */
const colorsIn = (block) => {
  const map = {};
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    map[m[1]] = m[2];
  }
  return map;
};

const COLORS_LIGHT = colorsIn(rootBlock);
const COLORS_DARK = colorsIn(darkBlock);

/** 取一个颜色变量的 RGB（支持 #rgb 缩写） */
const token = (colors, name) => {
  const hex = colors[name];
  assert.ok(hex, `找不到 ${name} 的颜色定义`);
  const h = hex.length === 4
    ? hex.slice(1).split('').map((c) => c + c).join('')
    : hex.slice(1, 7);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

const luminance = ([r, g, b]) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

const AA_TEXT = 4.5;

/**
 * 要成对检查的配色：[前景变量, 背景变量, 这条出现在哪]
 *
 * 背景不只看 --panel：文字大量落在 panel-2（悬停行、徽标底）和 primary-soft
 * （当前标签页、选中行）上，只看纯白底会漏 —— 方法名就是这么在选中行上掉到 4.3 的。
 */
const PAIRS = [
  ['--text', '--panel', '正文 / 输入框'],
  ['--text-dim', '--panel', '次级文字'],
  ['--text-mute', '--panel', '提示文字、JSON 树标点'],
  ['--text-dim', '--panel-2', '悬停行上的次级文字'],
  ['--text-mute', '--panel-2', '计数徽标、浅底提示'],
  ['--red-text', '--red-soft', '报错徽标（有冲突 / 失败）'],
  ['--red-text', '--red-wash', '整块浅红底上的红字'],
  ['--warn-text', '--warn-bg', '提醒条 / 「被账号覆盖」角标'],
  ['--amber', '--amber-soft', '警告色块'],
  ['--green', '--green-soft', '通过色块'],
  ['--primary', '--primary-soft', '当前标签页上的文字'],
  ['--m-get', '--primary-soft', '方法名（选中行 / 当前标签页）'],
  ['--m-post', '--primary-soft', '方法名'],
  ['--m-put', '--primary-soft', '方法名'],
  ['--m-patch', '--primary-soft', '方法名'],
  ['--m-delete', '--primary-soft', '方法名'],
  ['--m-other', '--primary-soft', 'HEAD / OPTIONS 的方法名'],
];

const ratio = (colors, fg, bg) => {
  const l1 = luminance(token(colors, fg));
  const l2 = luminance(token(colors, bg));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const belowAA = (colors) =>
  PAIRS.filter(([fg, bg]) => ratio(colors, fg, bg) < AA_TEXT)
    .map(([fg, bg, where]) => `${fg} on ${bg}（${where}）= ${ratio(colors, fg, bg).toFixed(2)}`);

test('浅色主题：每一对前景 / 背景都过 WCAG AA（4.5:1）', () => {
  assert.deepEqual(belowAA(COLORS_LIGHT), [], '这些配色读不动（低于 4.5:1）');
});

test('深色主题：同一批配对也都要过 AA', () => {
  assert.deepEqual(belowAA(COLORS_DARK), [], '深色下这些配色读不动');
});

test('文字三档保持层次：正文 > 次级 > 提示，且每一档都能读', () => {
  // 比的是「和本主题底色对比后的强弱」，不能直接比亮度 ——
  // 深色里方向是反的（正文最亮），比亮度会假失败。
  // 每一档过没过 AA 由上面的 PAIRS 守，这里只守「三档还分得开」。
  for (const [label, colors] of [['浅色', COLORS_LIGHT], ['深色', COLORS_DARK]]) {
    const c = (name) => ratio(colors, name, '--panel');
    assert.ok(c('--text') > c('--text-dim'), `${label}：--text 应该比 --text-dim 更强`);
    assert.ok(c('--text-dim') > c('--text-mute'), `${label}：--text-dim 应该比 --text-mute 更强`);
    assert.ok(c('--text-dim') >= AA_TEXT, `${label}：次级文字掉到 AA 线以下了（${c('--text-dim').toFixed(2)}）`);
  }
});
