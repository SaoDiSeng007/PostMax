// ---------------------------------------------------------------------------
// 分隔条调尺寸的算术（frontend/js/resize.js）
//
// 盯的是两件事：方向键真的挪了对应的那一维，以及挪到头会停在边界上。
// 鼠标拖拽和键盘共用同一份边界，所以这里也在间接盯住拖拽的口径。
//
// 只测纯逻辑：真正应用尺寸的 ui.js 要碰 store.js，而 store 依赖 vue
// （浏览器里走 importmap 指到 vendor），node 的测试进程加载不了。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RESIZE_STEP, nextSize, resizeBounds } from '../frontend/js/resize.js';

const host = { clientWidth: 1000, clientHeight: 800 };

test('边界：侧栏 220 起、跟着容器宽走；响应区下限 0', () => {
  assert.deepEqual(resizeBounds('sidebar', host), { min: 220, max: 616 });
  assert.deepEqual(resizeBounds('response', host), { min: 0, max: 670 });
  // 容器很窄时上限仍有 300 的兜底，不至于算出一个比下限还小的区间
  assert.deepEqual(resizeBounds('sidebar', { clientWidth: 320, clientHeight: 300 }), {
    min: 220,
    max: 300,
  });
});

test('侧栏：← / → 各挪一步，上下键不归它管', () => {
  assert.equal(nextSize('sidebar', 393, 'ArrowRight', host), 393 + RESIZE_STEP);
  assert.equal(nextSize('sidebar', 393, 'ArrowLeft', host), 393 - RESIZE_STEP);
  assert.equal(nextSize('sidebar', 393, 'ArrowUp', host), null);
  assert.equal(nextSize('sidebar', 393, 'ArrowDown', host), null);
  assert.equal(nextSize('sidebar', 393, 'Enter', host), null);
});

test('侧栏：撞到上下限就停住', () => {
  assert.equal(nextSize('sidebar', 220, 'ArrowLeft', host), 220, '下限 220');
  // 离下限只差不到一步时，落点就是下限本身（夹住，不是原样不动）
  assert.equal(nextSize('sidebar', 230, 'ArrowLeft', host), 220);
  assert.equal(nextSize('sidebar', 616, 'ArrowRight', host), 616, '上限跟着容器宽走');
});

test('响应区：↑ / ↓ 各挪一步，下限 0（编辑区能完全收起）', () => {
  assert.equal(nextSize('response', 300, 'ArrowDown', host), 300 + RESIZE_STEP);
  assert.equal(nextSize('response', 300, 'ArrowUp', host), 300 - RESIZE_STEP);
  assert.equal(nextSize('response', 10, 'ArrowUp', host), 0);
  assert.equal(nextSize('response', 670, 'ArrowDown', host), 670);
  assert.equal(nextSize('response', 300, 'ArrowLeft', host), null);
});
