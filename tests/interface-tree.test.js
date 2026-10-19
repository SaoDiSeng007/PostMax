// ---------------------------------------------------------------------------
// 接口树：老存档迁移 + 增删改移
//
// 「集合」这一层已经从数据模型里删掉（项目下直接是 dirs[] + requests[]），
// 这份测试盯三件最容易出错的事：
//   1. 老存档（project.collections）读进来要并成一棵树，且**不能丢东西**；
//   2. 根上的请求归「未分组」，目录里的请求照旧；
//   3. 建目录 / 建请求 / 移动都落在这棵树上。
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

/** 一份**老格式**的存档：两个集合，第一个里还有个目录 */
const oldArchive = () => ({
  version: 1,
  projects: [
    {
      id: 'p1',
      name: '项目',
      description: '',
      collections: [
        {
          id: 'c1',
          name: '主集合',
          dirs: [{ id: 'd1', name: '用户', parentId: '', sort: 0 }],
          requests: [
            { id: 'r1', name: '列表', method: 'GET', url: '/users', dirId: '', sort: 0 },
            { id: 'r2', name: '详情', method: 'GET', url: '/users/1', dirId: 'd1', sort: 0 },
          ],
        },
        {
          id: 'c2',
          name: '订单',
          dirs: [],
          requests: [
            { id: 'r3', name: '下单', method: 'POST', url: '/orders', dirId: '', sort: 0 },
          ],
        },
      ],
      plans: [],
      planGroups: [],
    },
  ],
  environments: [],
  history: [],
  planRuns: {},
  settings: { timeout: 30000, followRedirects: true, skipTlsVerify: false, theme: 'light' },
});

beforeEach(() => {
  S.state.projects = [];
  S.state.activeProjectId = '';
  S.state.tabs = [];
  S.state.activeTabId = '';
  S.closeConfirm();
});

/** 把一份老存档喂进 loadState，返回读完之后的项目 */
async function loadOld() {
  const payload = oldArchive();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  await S.loadState();
  S.state.activeProjectId = 'p1';
  return S.state.projects[0];
}

test('老存档读进来：集合层没了，东西一个不少', async () => {
  const p = await loadOld();

  assert.equal(p.collections, undefined, '集合字段已经被删掉');
  assert.equal(p.requests.length, 3);
  assert.equal(p.dirs.length, 2, '主集合的「用户」目录 + 「订单」变成的顶层目录');

  // 第一个集合是提升到根上的：它那个目录还在根上，id 不变
  const user = p.dirs.find((d) => d.id === 'd1');
  assert.ok(user, '第一个集合里的目录原样提到根上');
  assert.equal(user.parentId, '');

  // 第二个集合整体变成一个顶层目录，名字就是原集合名
  const wrapper = p.dirs.find((d) => d.name === '订单');
  assert.ok(wrapper, '其余集合变成顶层目录');
  assert.equal(wrapper.parentId, '');
  assert.equal(
    p.requests.find((r) => r.id === 'r3').dirId,
    wrapper.id,
    '它里面的请求挂到了这个目录下'
  );
});

test('树：根上的请求进「未分组」，目录里的请求在目录里', async () => {
  await loadOld();
  const tree = S.interfaceTree.value;

  assert.equal(tree.hasDirs, true);
  assert.deepEqual(
    tree.ungrouped.map((r) => r.id),
    ['r1'],
    '原来在集合根上的请求，现在在「未分组」里'
  );
  const dirs = tree.rows.filter((r) => r.kind === 'dir');
  assert.equal(dirs.length, 2, '顶层两个目录：原来的「用户」+「订单」变成的那一个');
  assert.ok(dirs.some((r) => r.id === 'd1'));
  assert.ok(dirs.some((r) => r.name === '订单'));
  assert.ok(dirs.every((r) => r.depth === 1), '顶层目录的 depth 都是 1');
});

test('建目录：建在根上就是顶层目录', async () => {
  await loadOld();
  S.confirmYes('新目录');   // askInput 的确认：输入框的值当参数传
  // 走 createDir 那条路：它会弹输入层，用 confirmYes 把名字给它
  S.createDir('');
  S.confirmYes('新目录');

  const p = S.state.projects[0];
  const created = p.dirs.find((d) => d.name === '新目录');
  assert.ok(created, '目录建出来了');
  assert.equal(created.parentId, '', '建在根上 = 顶层目录');
});

test('建请求 → 保存 → 落在它所属的那个目录下', async () => {
  await loadOld();
  S.createRequest('d1');          // 在「用户」目录下新建一个
  const tab = S.state.tabs[0];
  assert.equal(tab.draft.dirId, 'd1', '草稿记着它挂在哪个目录');

  S.saveTab(tab.id);

  const p = S.state.projects[0];
  assert.equal(p.requests.length, 4, '保存后才进项目里');
  const saved = p.requests[p.requests.length - 1];
  assert.equal(saved.dirId, 'd1');
});

test('移动：把请求挪到根上，它就进「未分组」', async () => {
  await loadOld();
  const before = S.interfaceTree.value.ungrouped.map((r) => r.id);
  assert.deepEqual(before, ['r1']);

  S.moveNodes({ nodes: [{ kind: 'req', id: 'r2' }], targetParentId: '' });

  const p = S.state.projects[0];
  assert.equal(p.requests.find((r) => r.id === 'r2').dirId, '');
  assert.deepEqual(
    S.interfaceTree.value.ungrouped.map((r) => r.id).sort(),
    ['r1', 'r2'],
    '挪到根上的请求进了「未分组」'
  );
});

test('整批勾选：目录下所有后代请求都算上（含子目录里的、含折叠着的）', async () => {
  await loadOld();
  // 再建一层子目录，把 r2 挪进去，这样「用户」下面就有嵌套了
  S.confirmYes('子目录');
  S.createDir('d1');
  S.confirmYes('子目录');
  const child = S.state.projects[0].dirs.find((d) => d.name === '子目录');
  S.moveNodes({ nodes: [{ kind: 'req', id: 'r2' }], targetParentId: child.id });

  const rows = S.interfaceTree.value.rows;
  const under = S.requestsUnderEach(rows);

  // r2 现在在子目录里，仍然是「用户」的后代
  assert.deepEqual(under.d1, ['r2'], '子目录里的请求也算在父目录下');
  assert.deepEqual(under[child.id], ['r2']);

  // 目录默认就是折着的（见 store.js 的 expandedDirs）：折叠只影响显示，
  // 不影响「这个目录下有什么」
  assert.equal(rows.find((r) => r.id === 'd1').collapsed, true, '新目录默认折着');
  const underCollapsed = S.requestsUnderEach(S.interfaceTree.value.rows);
  assert.deepEqual(underCollapsed.d1, ['r2'], '折叠起来也照样算');
});

test('整批勾选：搜索时只算命中的请求', async () => {
  await loadOld();
  const rows = S.interfaceTree.value.rows;
  assert.deepEqual(S.requestsUnderEach(rows, '详情').d1, ['r2']);
  assert.deepEqual(
    S.requestsUnderEach(rows, '下单').d1,
    [],
    '「下单」在另一个顶层目录里，不该算到 d1 下'
  );
  assert.deepEqual(S.requestsUnderEach(rows, '没有这个名').d1, []);
});

test('整批勾选：空目录是空数组（勾选框该是禁用的）', async () => {
  await loadOld();
  S.confirmYes('空目录');
  S.createDir('');
  S.confirmYes('空目录');
  const created = S.state.projects[0].dirs.find((d) => d.name === '空目录');

  const under = S.requestsUnderEach(S.interfaceTree.value.rows);
  assert.deepEqual(under[created.id], []);
});

test('全选的范围：折叠不看，搜索要看（和目录那格一个口径）', async () => {
  await loadOld();
  // 再建一层子目录，把 r2 挪进去：「用户」下面就有嵌套了
  S.confirmYes('子目录');
  S.createDir('d1');
  S.confirmYes('子目录');
  const child = S.state.projects[0].dirs.find((d) => d.name === '子目录');
  S.moveNodes({ nodes: [{ kind: 'req', id: 'r2' }], targetParentId: child.id });

  const scopeOf = (kw) =>
    S.selectableRequestIds(S.interfaceTree.value.rows, S.interfaceTree.value.ungrouped, kw);

  // 不搜索 = 项目里全部请求（r1 在「未分组」，r2 在子目录里，r3 在「订单」里）
  assert.deepEqual(scopeOf('').sort(), ['r1', 'r2', 'r3'], '折叠与否都不影响范围');

  // 折叠起来照样算 —— 这正是「全选 + 删除」会漏掉东西的那个 bug
  // （目录默认折着，不用再手动收一次）
  assert.deepEqual(
    S.selectableRequestIds(S.interfaceTree.value.rows, S.interfaceTree.value.ungrouped).sort(),
    ['r1', 'r2', 'r3'],
    '折叠着的目录里那几条也算在「全选」里'
  );

  // 搜索是有意为之的筛选：只算命中的
  assert.deepEqual(scopeOf('详情'), ['r2'], '命中的在折叠的子目录里也算');
  assert.deepEqual(scopeOf('没有这个名'), []);

  // 大小写不敏感：加一条英文名的请求再试（中文名试不出这条）
  S.state.projects[0].requests.push({
    id: 'r-lat',
    name: 'GetUser',
    method: 'GET',
    url: '/u',
    dirId: 'd1',
    sort: 9,
  });
  assert.deepEqual(scopeOf('getuser'), ['r-lat']);
  assert.deepEqual(scopeOf('GETUSER'), ['r-lat']);
});

test('全选的范围：空项目 / 全折叠 / 未分组也折着，都不出错', async () => {
  await loadOld();
  S.state.projects[0].requests = [];
  assert.deepEqual(
    S.selectableRequestIds(S.interfaceTree.value.rows, S.interfaceTree.value.ungrouped),
    []
  );

  S.state.projects[0].requests = [
    { id: 'r9', name: '孤零零', method: 'GET', url: '/x', dirId: '', sort: 0 },
  ];
  // 「未分组」默认也是折着的：先把前提钉住，下面验的才是「折叠不参与筛选」
  assert.equal(S.interfaceTree.value.ungroupedCollapsed, true);
  assert.deepEqual(
    S.selectableRequestIds(S.interfaceTree.value.rows, S.interfaceTree.value.ungrouped),
    ['r9'],
    '「未分组」折起来也算（折叠不参与筛选）'
  );
});

test('移动：把目录拖进它自己的子孙里会被拦住（否则树会成环）', async () => {
  const p = await loadOld();
  S.confirmYes('子目录');
  S.createDir('d1');
  S.confirmYes('子目录');
  const child = p.dirs.find((d) => d.name === '子目录');
  assert.ok(child, '子目录建好了');

  // 把「用户」拖到它的子目录里
  S.moveNodes({ nodes: [{ kind: 'dir', id: 'd1' }], targetParentId: child.id });

  assert.equal(
    S.state.projects[0].dirs.find((d) => d.id === 'd1').parentId,
    '',
    '这种拖拽被无视，父级没被改坏'
  );
});

// ---------------------------------------------------------------------------
// 搜索命中：接口名**和 URL** 都算
//
// 名字是人随手起的，真正记得住的往往是路径（/users/1、/orders 这种），
// 只能按名字搜等于搜不到自己知道的那个接口。
// ---------------------------------------------------------------------------

test('requestMatches：名字命中、URL 命中、空关键词全命中', () => {
  const request = {
    name: '配额详情查询',
    method: 'GET',
    url: '/api/vss-om-service/v1/ai/algAllocat/queryPage',
  };

  assert.ok(S.requestMatches(request, '配额'), '名字命中');
  assert.ok(S.requestMatches(request, 'algAllocat'), 'URL 片段命中');
  assert.ok(S.requestMatches(request, 'ALGALLOCAT/QUERY'), '不分大小写，片段对上就算');
  assert.ok(S.requestMatches(request, '  '), '关键词只有空白 = 不过滤');
  assert.equal(S.requestMatches(request, '没有这个'), false);
  assert.equal(S.requestMatches({ name: '没有 url 字段' }, 'x'), false, '缺 url 也不炸');
});

test('树上的搜索：按 URL 命中', async () => {
  const p = await loadOld();
  p.requests.find((r) => r.id === 'r2').name = '详情'; // 名字里没有 users
  const rows = S.interfaceTree.value.rows;

  assert.deepEqual(S.requestsUnderEach(rows, 'users/1').d1, ['r2'], 'URL 片段命中');
  assert.deepEqual(S.requestsUnderEach(rows, 'users').d1, ['r2'], '更短的片段也够');
  assert.deepEqual(S.requestsUnderEach(rows, '/orders').d1, [], '别的目录里的不算到 d1 下');
});

test('全选那一批也认 URL（和树上看得见的口径一致）', async () => {
  await loadOld();
  const tree = S.interfaceTree.value;

  assert.deepEqual(
    S.selectableRequestIds(tree.rows, tree.ungrouped, 'orders'),
    ['r3'],
    'URL 命中的要算进「全选」'
  );
  assert.deepEqual(
    S.selectableRequestIds(tree.rows, tree.ungrouped, 'users').sort(),
    ['r1', 'r2'],
    '「未分组」里的 r1（/users）和目录里的 r2（/users/1）都算'
  );
});
