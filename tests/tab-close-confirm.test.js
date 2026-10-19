// ---------------------------------------------------------------------------
// 关标签页时的未保存提示
//
// 这条流程的两个按钮就是「保存并关闭 / 不保存」——没有「取消」按钮，取消靠点弹层
// 外面或按 Esc（ConfirmDialog 的 @click.self / Esc）。所以这里盯三件事：
//   1. 装配出来的弹层是两按钮形态（hideCancel），且「取消」这条路确实还在（closeConfirm）；
//   2. 干净的标签页不弹框，直接关；
//   3. 别顺手把别的确认框也砍掉取消 —— setConfirm 是**整体替换**，少写一个字段
//      就会变成 undefined，v-if 跟着失效。
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

beforeEach(() => {
  S.state.projects = [
    {
      id: 'p1',
      name: '项目',
      dirs: [],
      requests: [
        {
          id: 'r1',
          name: '请求A',
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
        },
      ],
      plans: [{ id: 'pl1', name: '方案A', steps: [] }],
      planGroups: [],
    },
  ];
  S.state.activeProjectId = 'p1';
  S.state.tabs = [];
  S.state.activeTabId = '';
  S.state.planTabs = [];
  S.state.activePlanTabId = '';
  S.closeConfirm();
});

/** 打开请求并把草稿改脏，返回标签页 id */
const openDirtyTab = () => {
  S.openRequest('r1');
  const tab = S.state.tabs[0];
  tab.draft.name = '改过的名字';
  assert.equal(S.tabIsDirty(tab), true, '前提：这个标签页现在是脏的');
  return tab.id;
};

test('干净的标签页直接关掉，不弹框', () => {
  S.openRequest('r1');
  S.closeTab(S.state.tabs[0].id);
  assert.equal(S.state.confirm.open, false);
  assert.equal(S.state.tabs.length, 0);
});

test('有未保存改动：弹层是「保存并关闭 / 不保存」两个按钮', () => {
  const id = openDirtyTab();
  S.closeTab(id);

  assert.equal(S.state.confirm.open, true);
  assert.equal(S.state.confirm.confirmText, '保存并关闭');
  assert.equal(S.state.confirm.thirdText, '不保存');
  assert.equal(S.state.confirm.hideCancel, true, '「取消」按钮已经不用渲染了');
});

test('取消这条路还在：点弹层外面（closeConfirm）标签页不动', () => {
  const id = openDirtyTab();
  S.closeTab(id);
  S.closeConfirm();

  assert.equal(S.state.confirm.open, false);
  assert.equal(S.state.tabs.length, 1, '取消之后标签页还在');
  assert.equal(S.state.tabs[0].draft.name, '改过的名字', '草稿也没被清掉');
});

test('「保存并关闭」先存再关', () => {
  const id = openDirtyTab();
  S.closeTab(id);
  S.confirmYes();

  assert.equal(S.state.tabs.length, 0);
  assert.equal(S.state.projects[0].requests[0].name, '改过的名字');
});

test('「不保存」丢改动但要关掉', () => {
  const id = openDirtyTab();
  S.closeTab(id);
  S.confirmThird();

  assert.equal(S.state.tabs.length, 0);
  assert.equal(
    S.state.projects[0].requests[0].name,
    '请求A',
    '不保存 = 集合里那份没动'
  );
});

test('方案标签页走同一套（也是两个按钮）', () => {
  S.openPlanTab('pl1');
  const tab = S.state.planTabs[0];
  tab.draft.name = '改过的方案';
  S.closePlanTab(tab.id);

  assert.equal(S.state.confirm.open, true);
  assert.equal(S.state.confirm.confirmText, '保存并关闭');
  assert.equal(S.state.confirm.thirdText, '不保存');
  assert.equal(S.state.confirm.hideCancel, true);
});

test('别的确认框不会跟着丢掉「取消」（setConfirm 整体替换的坑）', () => {
  const seen = [];
  S.askConfirm('删除请求', '确定删掉？', () => seen.push('ok'));
  assert.equal(S.state.confirm.hideCancel, false, '普通确认框仍然要有取消');

  S.askAlert('出错', '网络断了');
  assert.equal(S.state.confirm.alertOnly, true);
  assert.equal(S.state.confirm.hideCancel, false, 'alertOnly 靠的是自己的开关，不是 hideCancel');
});
