// ---------------------------------------------------------------------------
// 「存到哪个目录」
//
// 凭空新建的请求（标签条那颗 ＋）在保存时才定落点 —— 弹一个下拉让人挑。
// 从某个目录的 ＋ 建的，落点早就定了，不该再问一遍。
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

/** 起一个项目：顶层有「用户」目录，根上有个「列表」 */
const seed = () => {
  S.state.projects = [
    {
      id: 'p1',
      name: '项目',
      dirs: [{ id: 'd1', name: '用户', parentId: '', sort: 0 }],
      requests: [
        {
          id: 'r1',
          name: '列表',
          method: 'GET',
          url: '/users',
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
      plans: [],
      planGroups: [],
    },
  ];
  S.state.activeProjectId = 'p1';
  S.state.tabs = [];
  S.state.activeTabId = '';
  S.closeConfirm();
};

beforeEach(seed);

test('凭空新建的请求：保存时先弹「存到哪个目录」', () => {
  S.createRequest('', true);
  const tab = S.state.tabs[0];
  assert.equal(tab.chooseDir, true, '这个标签页记着「还没定落点」');

  S.saveTab(tab.id);

  assert.equal(S.state.confirm.open, true);
  assert.equal(S.state.confirm.title, '保存到哪个目录');
  assert.equal(S.state.confirm.withSelect, true);
  assert.deepEqual(
    S.state.confirm.selectOptions.map((o) => o.label),
    ['未分组（顶层）', '用户'],
    '顶层目录列出来，外加「未分组」'
  );
  assert.equal(S.state.projects[0].requests.length, 1, '还没落库');
});

test('选了目录：请求落进那个目录，之后不再问', () => {
  S.createRequest('', true);
  const tab = S.state.tabs[0];
  tab.draft.name = '详情';

  S.saveTab(tab.id);
  S.confirmYes('d1');   // 选「用户」

  const p = S.state.projects[0];
  assert.equal(p.requests.length, 2);
  const saved = p.requests.find((r) => r.name === '详情');
  assert.equal(saved.dirId, 'd1');
  assert.equal(S.state.tabs[0].chooseDir, false, '落点定了，下次不用再问');

  // 再改一次再保存，不该再弹框
  S.state.tabs[0].draft.url = '/users/1';
  S.saveTab(S.state.tabs[0].id);
  assert.equal(S.state.confirm.open, false);
});

test('选「未分组」：落到顶层（dirId 为空）', () => {
  S.createRequest('', true);
  S.saveTab(S.state.tabs[0].id);
  S.confirmYes('');

  const saved = S.state.projects[0].requests[1];
  assert.equal(saved.dirId, '');
  assert.ok(
    S.interfaceTree.value.ungrouped.some((r) => r.id === saved.id),
    '它出现在「未分组」那一栏'
  );
});

test('取消（点弹层外面）：什么都不发生', () => {
  S.createRequest('', true);
  const tab = S.state.tabs[0];
  S.saveTab(tab.id);
  S.closeConfirm();

  assert.equal(S.state.projects[0].requests.length, 1, '没落库');
  assert.equal(S.state.tabs.length, 1, '标签页还开着');
  assert.equal(S.state.tabs[0].chooseDir, true, '落点还是没定');
});

test('从某个目录的 ＋ 建的：直接保存，不问', () => {
  S.createRequest('d1');   // 在「用户」目录下建
  const tab = S.state.tabs[0];
  assert.equal(tab.chooseDir, false, '落点早就定了');

  S.saveTab(tab.id);
  assert.equal(S.state.confirm.open, false, '不问');
  assert.equal(S.state.projects[0].requests[1].dirId, 'd1');
});

test('关闭时选「保存并关闭」：先问目录，存完才关（不能先关再问）', () => {
  S.createRequest('', true);
  const tab = S.state.tabs[0];
  tab.draft.name = '要关的';

  S.closeTab(tab.id);
  assert.equal(S.state.confirm.title, '有未保存的改动');
  S.confirmYes();                       // 「保存并关闭」

  // 还要问目录 —— 这时候标签页必须还在
  assert.equal(S.state.confirm.title, '保存到哪个目录');
  assert.equal(S.state.tabs.length, 1, '还没关');

  S.confirmYes('d1');

  assert.equal(S.state.tabs.length, 0, '存完才关掉');
  const saved = S.state.projects[0].requests.find((r) => r.name === '要关的');
  assert.ok(saved, '请求没丢');
  assert.equal(saved.dirId, 'd1');
});

test('批量保存不再逐个问目录（落草稿上那个目录）', () => {
  S.createRequest('', true);          // 凭空新建，还没定落点
  const tab = S.state.tabs[0];
  tab.draft.name = '批量';

  S.closeAllTabs();
  S.confirmYes();   // 「全部保存并关闭」

  assert.equal(S.state.confirm.open, false, '没有再弹「存到哪个目录」');
  assert.equal(S.state.tabs.length, 0);
  assert.equal(S.state.projects[0].requests[1].dirId, '', '落在草稿上那个目录（顶层）');
});
