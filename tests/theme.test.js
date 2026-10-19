// ---------------------------------------------------------------------------
// 主题的接线：设置里的 theme 是否真的落到 <html data-theme> 上
//
// 样式表那一半由 theme-css.test.js 静态体检，这一半测「变量有没有被点亮」：
// watcher 有没有挂上、错值会不会把界面弄成没上色的样子。
//
// 需要 DOM 桩（store.js 在模块初始化时会摸 window），所以要在设置完桩之后再动态
// import；vue 得先初始化 —— 它按「有没有 document」决定走不走浏览器分支。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./vue-loader.mjs', import.meta.url);

const { nextTick } = await import('vue');

globalThis.window = {
  innerHeight: 900,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = { documentElement: { dataset: {} } };

const { state } = await import('../frontend/js/store.js');
await import('../frontend/js/ui.js');

const theme = () => globalThis.document.documentElement.dataset.theme;

test('默认是浅色（进页面就应用一次）', () => {
  assert.equal(theme(), 'light');
  assert.equal(state.settings.theme, 'light');
});

test('切到深色：设置一变，根元素跟着变', async () => {
  state.settings.theme = 'dark';
  await nextTick();
  assert.equal(theme(), 'dark');
});

test('切回浅色', async () => {
  state.settings.theme = 'light';
  await nextTick();
  assert.equal(theme(), 'light');
});

test('存档里存着个不认识的值时退回浅色，而不是让整套变量落空', async () => {
  state.settings.theme = 'midnight';
  await nextTick();
  assert.equal(theme(), 'light');
});
