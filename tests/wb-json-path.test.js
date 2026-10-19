// ---------------------------------------------------------------------------
// JSON 取路径：整行任意位置单击都能复制路径
//
// 原来只有最右边那个按钮能点，行宽一点就得瞄着点。现在是整行可点，悬停在
// 每行的 title 上说明白「鼠标左键单击复制路径」。这里钉三件事：
//   1. 哪些行能复制（路径判空 + 键能不能拼出路径）；
//   2. 悬停提示的文案（能复制的、根节点的、键带点的，三种都说清楚）；
//   3. 点击落点怎么分流 —— 整行都算复制，唯独**容器行**的箭头管展开收起。
// 第 3 条用 e.target 判断而不是给箭头挂 @click.stop，否则叶子行那一小条
// 空白也变成死区，就没法「整行任意位置」了。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

register('./vue-loader.mjs', import.meta.url);
const { COPY_HINT, pathRowTitle, canCopyPath, rowClickTarget } = await import(
  '../frontend/js/components/WbJson.js'
);

const src = readFileSync(
  fileURLToPath(new URL('../frontend/js/components/WbJson.js', import.meta.url)),
  'utf8'
);

// ---------------------------------------------------------------------------
// 哪些行能复制
// ---------------------------------------------------------------------------

test('canCopyPath：根节点和拼不出路径的键都算复制不了', () => {
  assert.equal(canCopyPath('', false), false, '根节点没有路径，复制空串没意义');
  assert.equal(canCopyPath('data.token', false), true);
  assert.equal(canCopyPath('data.token', true), false, '键带点 / 括号拼不出路径');
  assert.equal(canCopyPath('', true), false);
});

// ---------------------------------------------------------------------------
// 悬停提示
// ---------------------------------------------------------------------------

test('悬停提示就说「鼠标左键单击复制路径」', () => {
  assert.equal(COPY_HINT, '鼠标左键单击复制路径');
  assert.equal(pathRowTitle('data.token', false), COPY_HINT);
  assert.equal(pathRowTitle('items[0].id', false), COPY_HINT);
});

test('复制不了的行，悬停说明为什么，别复用同一句话', () => {
  assert.equal(pathRowTitle('data.a.b', true), '这个键带点或括号，按路径取不了');
  assert.equal(pathRowTitle('', false), '根节点没有路径，点下面任意一行复制');
  // 三种情况一个文案都不能混
  assert.notEqual(pathRowTitle('a.b', true), pathRowTitle('', false));
  assert.notEqual(pathRowTitle('a.b', true), COPY_HINT);
});

test('不再是原来那句「点复制路径」', () => {
  assert.ok(!src.includes('点复制路径'), '改成整行提示后，这句旧文案该没了');
});

// ---------------------------------------------------------------------------
// 点击落点分流：整行任意位置都算复制，唯独容器行的箭头管展开收起
// ---------------------------------------------------------------------------

const clickAt = (isCaret) => ({
  target: { closest: (sel) => (isCaret && sel === '.wb-caret' ? {} : null) },
});

test('整行任意位置单击都复制 —— 点键名、值、空白处都算', () => {
  assert.equal(rowClickTarget(clickAt(false), true), 'copy', '容器行点空白处也复制');
  assert.equal(rowClickTarget(clickAt(false), false), 'copy', '叶子行更不必说');
});

test('容器行的箭头只管展开收起（这是唯一的例外）', () => {
  assert.equal(rowClickTarget(clickAt(true), true), 'toggle');
});

test('叶子行箭头那一小条不是例外 —— 点了照样复制', () => {
  assert.equal(rowClickTarget(clickAt(true), false), 'copy');
});

test('没有 target / target 没有 closest 时按复制算，不抛异常', () => {
  assert.equal(rowClickTarget(undefined, true), 'copy');
  assert.equal(rowClickTarget(null, true), 'copy');
  assert.equal(rowClickTarget({}, true), 'copy');
  assert.equal(rowClickTarget({ target: {} }, true), 'copy');
});

// ---------------------------------------------------------------------------
// DOM 形状：复制类挂在行上、悬停提示挂在行上、单击不 stop；原来最右边那个
// 按钮拆了（不拆的话整行还是只有一小块能点）。
// ---------------------------------------------------------------------------

// DOM 形状只看 PathNode 那段模板 —— 外层 WbJson 自己的工具栏还有别的按钮，
// 拿整份源码断言会误判。
const nodeStart = src.indexOf('const PathNode = {');
assert.ok(nodeStart > 0, 'PathNode 得抠得出来 —— 改了写法就同步改这个测试');
const nodeSrc = src.slice(nodeStart, src.indexOf('\n/**', nodeStart));

test('行本身带 wb-pcopy 和悬停提示，单击不 stop', () => {
  assert.match(nodeSrc, /class="wb-pline wb-pcopy"/, '复制类得挂在行上');
  assert.match(nodeSrc, /:title="rowTitle"/, '悬停提示挂在行上');
  assert.match(nodeSrc, /@click="onRowClick"/, '单击绑在行上');
  assert.ok(!/@click\.stop=/.test(nodeSrc), '不能再有 stop，否则整行点不动');
});

test('箭头上没有点击事件', () => {
  const start = nodeSrc.indexOf('<span class="wb-caret"');
  assert.ok(start > 0, '箭头得还在');
  const caret = nodeSrc.slice(start, nodeSrc.indexOf('</span>', start));
  assert.ok(!caret.includes('@click'), '箭头不给点击事件，靠 e.target 分流');
});

test('原来最右边那个复制按钮拆了', () => {
  assert.ok(!nodeSrc.includes('wb-path-btn'), '按钮没了，改成整行');
  assert.ok(!nodeSrc.includes('<button'), 'PathNode 里不该再有按钮');
});
