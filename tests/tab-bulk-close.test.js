// ---------------------------------------------------------------------------
// 标签页的批量关闭（标签条上那颗 ＋ 里的「关闭所有 / 关闭其他」）
//
// 这两条路最容易错的地方是**未保存的改动**：一次关十几个，逐个问太折磨人，
// 所以汇总问一次（列出名字），而「取消」靠点弹层外面 / Esc —— 弹层只有两个按钮。
//
// 需要 DOM 桩 + vue（见 tests/vue-loader.mjs 的说明）。跑：npm test
// ---------------------------------------------------------------------------
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./vue-loader.mjs', import.meta.url);

await import('vue');

globalThis.window = {
  innerHeight: 900,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = { documentElement: { dataset: {} } };

const S = await import('../frontend/js/store.js');

const request = (id, name) => ({
  id,
  name,
  method: 'GET',
  url: '/a',
  params: [],
  headers: [],
  pathParams: [],
  bodyType: 'none',
  bodyForm: [],
  bodyRaw: '',
  dirId: '',
  sort: 0,
});

/** 起一个项目，里头三个请求，全部打开成标签页 */
const openThree = () => {
  S.state.projects = [
    {
      id: 'p1',
      name: '项目',
      dirs: [],
      requests: [request('r1', '一'), request('r2', '二'), request('r3', '三')],
      plans: [],
      planGroups: [],
    },
  ];
  S.state.activeProjectId = 'p1';
  // 标签页也得清空：openRequest 对「已经开着」的请求只切过去，不清的话
  // 上一个用例改脏的那份会带到这一个来
  S.state.tabs = [];
  S.state.activeTabId = '';
  ['r1', 'r2', 'r3'].forEach((id) => S.openRequest(id));
};

beforeEach(() => {
  openThree();
  S.closeConfirm();
});

test('全都保存过：直接全关，不弹框', () => {
  S.closeAllTabs();
  assert.equal(S.state.confirm.open, false);
  assert.equal(S.state.tabs.length, 0);
});

test('有未保存的改动：汇总问一次（列出名字，两个按钮）', () => {
  S.state.tabs[0].draft.name = '一（改过）';
  S.state.tabs[2].draft.name = '三（改过）';

  S.closeAllTabs();

  assert.equal(S.state.confirm.open, true);
  assert.equal(S.state.confirm.hideCancel, true, '取消靠点外面 / Esc');
  assert.equal(S.state.confirm.confirmText, '全部保存并关闭');
  assert.equal(S.state.confirm.thirdText, '不保存');
  assert.match(S.state.confirm.message, /一（改过）/);
  assert.match(S.state.confirm.message, /三（改过）/);
  assert.match(S.state.confirm.message, /2 个/, '只数有改动的那几个');
  assert.equal(S.state.tabs.length, 3, '还没关');
});

test('「全部保存并关闭」：先存再关，改动进项目里', () => {
  S.state.tabs[0].draft.name = '一（改过）';
  S.closeAllTabs();
  S.confirmYes();

  assert.equal(S.state.tabs.length, 0);
  assert.equal(S.state.projects[0].requests[0].name, '一（改过）');
});

test('「不保存」：改动丢掉，但确实关了', () => {
  S.state.tabs[0].draft.name = '一（改过）';
  S.closeAllTabs();
  S.confirmThird();

  assert.equal(S.state.tabs.length, 0);
  assert.equal(S.state.projects[0].requests[0].name, '一');
});

test('取消（点弹层外面）：一个都不关', () => {
  S.state.tabs[0].draft.name = '一（改过）';
  S.closeAllTabs();
  S.closeConfirm();

  assert.equal(S.state.tabs.length, 3);
  assert.equal(S.state.tabs[0].draft.name, '一（改过）');
});

test('关闭其他：留着当前那个，其余全关', () => {
  const keep = S.state.tabs[1].id;
  S.activateTab(keep);
  S.closeAllTabs(keep);

  assert.equal(S.state.confirm.open, false, '都没改动，不用问');
  assert.deepEqual(
    S.state.tabs.map((t) => t.id),
    [keep]
  );
  assert.equal(S.state.activeTabId, keep);
});

test('关闭其他：自己那份改动不受影响，别人的改动照常问', () => {
  const keep = S.state.tabs[1].id;
  S.activateTab(keep);
  S.state.tabs[1].draft.name = '二（改过）';   // 自己这个也是脏的
  S.state.tabs[2].draft.name = '三（改过）';

  S.closeAllTabs(keep);

  assert.equal(S.state.confirm.open, true, '问的是除了它之外那几个');
  assert.doesNotMatch(S.state.confirm.message, /二（改过）/, '它自己不参与');
  assert.match(S.state.confirm.message, /三（改过）/);

  S.confirmThird();
  assert.equal(S.state.tabs.length, 1);
  assert.equal(S.state.tabs[0].id, keep);
  assert.equal(S.state.tabs[0].draft.name, '二（改过）', '它自己的改动还在');
});
