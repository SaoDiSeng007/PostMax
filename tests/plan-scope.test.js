// ---------------------------------------------------------------------------
// 一个步骤跑几遍：每行一遍 / 整轮一遍
//
// 这是这套自动化里最贵的判断 —— 判错的两种表现都很安静：
//   · 判成「每行跑」而它其实不依赖数据 → 登录跑 N 次互相踢 token、清理删 N 遍
//   · 判成「整轮一遍」而它其实依赖数据 → 后面每一步都在用第一行的数据
//
// 容易漏的是**间接依赖**：接口自己没写 {{列名}}，用的是上游提取出来的变量。
// 只看「有没有引用数据列」就会把它判成整轮一遍。
//
// 跑：npm test（等价于 node --test tests/）
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stepScopes, stepProduces, rerunTargets, usesTestData } from '../frontend/js/planSteps.js';

/** 造一个步骤。第三个参数放 scope（手动指定）之类 */
const step = (name, request, extra = {}) => ({
  id: name,
  enabled: true,
  request: { name, method: 'GET', ...request },
  ...extra,
});

test('完全不引用变量的步骤：整轮只跑一遍', () => {
  assert.deepEqual(stepScopes([step('登录', { url: '/login' })], ['userId']), ['once']);
});

test('引用数据列的步骤：每行跑一遍', () => {
  assert.deepEqual(stepScopes([step('取用户', { url: '/users/{{userId}}' })], ['userId']), ['each']);
});

test('中文列名一样认（CSV 表头是中文是常态）', () => {
  const steps = [step('取设备', { url: '/dev?n={{摄像头名称}}' })];
  assert.deepEqual(stepScopes(steps, ['摄像头名称']), ['each']);
});

test('引用环境变量 / 方案变量不算逐行', () => {
  const steps = [step('探活', { url: '{{baseUrl}}/ping', headers: [{ key: 'x', value: '{{tenant}}' }] })];
  assert.deepEqual(stepScopes(steps, ['userId']), ['once']);
});

test('用到了「每行跑」那一步的产出：也算每行跑（间接依赖）', () => {
  const steps = [
    step('登录', { url: '/login', extracts: [{ to: 'token' }] }),
    step('取用户', { url: '/users/{{userId}}', extracts: [{ to: 'uid' }] }),
    // 不写 {{userId}}，只用上游提取出来的 uid —— 追得到上游，所以也是每行跑
    step('下单', { url: '/orders', body: '{"uid":"{{uid}}"}' }),
    // 用的是「整轮一遍」那一步的产出 → 固定值 → 还是整轮一遍
    step('对账', { url: '/check', headers: [{ key: 'x', value: '{{token}}' }] }),
  ];
  assert.deepEqual(stepScopes(steps, ['userId']), ['once', 'each', 'each', 'once']);
});

test('链条有几节就追几节', () => {
  const steps = [
    step('a', { url: '/a?u={{userId}}', extracts: [{ to: 'a1' }] }),
    step('b', { url: '/b?x={{a1}}', extracts: [{ to: 'b1' }] }),
    step('c', { url: '/c?y={{b1}}' }),
    step('d', { url: '/d' }),
  ];
  assert.deepEqual(stepScopes(steps, ['userId']), ['each', 'each', 'each', 'once']);
});

test('只认前面步骤的产出：靠后的步骤产出的变量不算数', () => {
  const steps = [
    step('下单', { body: '{"uid":"{{uid}}"}' }),
    step('取用户', { url: '/users/{{userId}}', extracts: [{ to: 'uid' }] }),
  ];
  assert.deepEqual(stepScopes(steps, ['userId']), ['once', 'each']);
});

test('脚本里 env.set 写死的变量也算产出', () => {
  // 签名那步不依赖数据 → 整轮一遍；用它签名的下单同样整轮一遍
  const fixed = [
    step('签名', { url: '/sign', script: "env.set('signed', 'abc')" }),
    step('下单', { body: '{"sig":"{{signed}}"}' }),
  ];
  assert.deepEqual(stepScopes(fixed, []), ['once', 'once']);

  // 算价那步引用数据列 → 每行跑；用它产出的下单也是每行跑
  const perRow = [
    step('算价', { url: '/p', body: '{"u":"{{userId}}"}', script: "pm.variables.set('price', 1)" }),
    step('下单', { body: '{"p":"{{price}}"}' }),
  ];
  assert.deepEqual(stepScopes(perRow, ['userId']), ['each', 'each']);
});

test('手动指定压过自动判定', () => {
  const steps = [
    // 登录本来判成整轮一遍，手动改成每行跑（每个账号登一次这类需求）
    step('登录', { url: '/login' }, { scope: 'each' }),
    // 查数据本来判成每行跑，手动改成整轮一遍
    step('查', { url: '/x?u={{userId}}' }, { scope: 'once' }),
    step('下单', { url: '/o?u={{userId}}' }),
  ];
  assert.deepEqual(stepScopes(steps, ['userId']), ['each', 'once', 'each']);
});

test('没有数据表时，每行跑也只会跑一遍（不报错、不重复）', () => {
  assert.deepEqual(stepScopes([step('查', { url: '/x?u={{userId}}' })], []), ['once']);
});

test('stepProduces 收提取配置与脚本里写死的名字', () => {
  const s = step('x', {
    extracts: [{ to: 'token' }, { to: '' }],
    script: "env.set('sig', 1); pm.variables.set('n', 2); env.set(name, 3)",
  });
  assert.deepEqual([...stepProduces(s)].sort(), ['n', 'sig', 'token']);
});

test('undefined / 空列表不炸', () => {
  assert.deepEqual(stepScopes(undefined, ['a']), []);
  assert.deepEqual(stepScopes([], ['a']), []);
  assert.deepEqual(stepScopes([step('a', {})], undefined), ['once']);
});

test('stepProduces：动态拼出来的变量名不算产出', () => {
  /*
   * env.set('t' + '-' + i, v) 静态认不出真正叫什么。以前的正则会把**第一个
   * 字面量**当成变量名 —— 这里会凭空多出一个叫 t 的产出。它要是碰巧撞上某个
   * 数据列的名字，这一步就会被误判成「每行跑」，而谁也不明白为什么。
   */
  const dynamic = step('x', { script: "env.set('t' + '-' + i, v)" });
  assert.deepEqual([...stepProduces(dynamic)], []);

  // 正常写法照旧认得出来：名字后面紧跟逗号
  const normal = step('y', { script: "env.set('sig', 1)" });
  assert.deepEqual([...stepProduces(normal)], ['sig']);

  // 没有第二个参数的写法也算
  const oneArg = step('z', { script: "env.set('only')" });
  assert.deepEqual([...stepProduces(oneArg)], ['only']);
});

// ---------------------------------------------------------------------------
// 「用了几条测试数据」—— 只看直接引用，不顺着上游传
//
// 和 stepScopes 的口径**故意不同**：那个要传递（不然下游拿不到行内的值），这个不传
// （步骤行上说的是「我给它喂了几条数据」，不是「它会发几次请求」）。
// ---------------------------------------------------------------------------
test('用了几条测试数据：只看直接引用，用了上游取回来的值不算', () => {
  const cols = ['userId', 'name'];
  assert.equal(usesTestData(step('登录', { url: '/login?u={{user}}&p={{pass}}' }), cols), false);
  assert.equal(usesTestData(step('取用户', { url: '/u?i={{userId}}' }), cols), true);

  // 只用上游接口取回来的 token：引擎那边它照样每行跑，但这里算「没用到测试数据」
  const upstream = step('取用户', { url: '/u?i={{userId}}', extracts: [{ to: 'token' }] });
  const downstream = step('下单', { url: '/o?t={{token}}' });
  assert.equal(usesTestData(downstream, cols), false);
  assert.equal(
    stepScopes([upstream, downstream], cols)[1],
    'each',
    '但执行上还是每行一遍（不传的话下游拿到的全是最后一行的值）'
  );
});

test('用了几条测试数据：没有数据表时一律不算', () => {
  assert.equal(usesTestData(step('取用户', { url: '/u?i={{userId}}' }), []), false);
  assert.equal(usesTestData(step('取用户', { url: '/u?i={{userId}}' }), undefined), false);
  assert.equal(usesTestData(null, ['userId']), false);
});

// ---------------------------------------------------------------------------
// 「只重跑失败的」挑哪些格子
//
// 挑错的两种表现：漏了上游 → 重跑的格子全变「未执行」；多挑了 → 本来没事的
// 步骤被重跑一遍（对「建过就不能再建」的接口，这是真会出错的）。
// ---------------------------------------------------------------------------
const rec = (id, status) => ({
  stepId: id, no: 1, name: id, method: 'GET', status,
  assertions: [], extracted: [], error: '',
});
const rowOf = (no, status, steps) => ({ no, label: 'L' + no, status, steps });

test('重跑：失败那格是本体，它的上游是陪跑', () => {
  const steps = [
    step('登录', { url: '/login', extracts: [{ to: 'token' }] }),
    step('取用户', { url: '/u?i={{userId}}', headers: [{ key: 'tk', value: '{{token}}' }], extracts: [{ to: 'uid' }] }),
    step('下单', { url: '/o', body: '{"uid":"{{uid}}"}' }),
  ];
  const run = {
    shared: [rec('登录', 'ok')],
    // 登录是「整轮一遍」，不占行的格子 —— 行里的 steps 按下标放，第 0 格是空的
    rows: [
      rowOf(1, 'failed', [undefined, rec('取用户', 'ok'), rec('下单', 'failed')]),
      rowOf(2, 'ok', [undefined, rec('取用户', 'ok'), rec('下单', 'ok')]),
    ],
  };
  const marks = rerunTargets(run, steps, ['userId']);

  assert.equal(marks.get('0:2'), 'target', '行1 的下单失败 → 本体');
  assert.equal(marks.get('0:1'), 'dep', '它用的 uid 来自「取用户」→ 那一步陪跑');
  // 取用户用到了登录提取的 token，而登录是「整轮一遍」，记在 -1 上
  assert.equal(marks.get('-1:0'), 'dep');
  assert.equal(marks.size, 3, '行 2 全过，不该被挑进去');
});

test('重跑：链条有几节就带几节', () => {
  const steps = [
    step('a', { url: '/a?u={{userId}}', extracts: [{ to: 'a1' }] }),
    step('b', { url: '/b?x={{a1}}', extracts: [{ to: 'b1' }] }),
    step('c', { url: '/c?y={{b1}}' }),
  ];
  const run = { rows: [rowOf(1, 'failed', [rec('a', 'ok'), rec('b', 'ok'), rec('c', 'failed')])] };
  const marks = rerunTargets(run, steps, ['userId']);
  assert.deepEqual([...marks.entries()].sort(), [['0:0', 'dep'], ['0:1', 'dep'], ['0:2', 'target']]);
});

test('重跑：缺数据没跑成的也算本体', () => {
  const steps = [
    step('取用户', { url: '/u?i={{userId}}', extracts: [{ to: 'uid' }] }),
    step('下单', { url: '/o', body: '{"uid":"{{uid}}"}' }),
  ];
  const run = { rows: [rowOf(1, 'missing', [rec('取用户', 'failed'), rec('下单', 'missing')])] };
  const marks = rerunTargets(run, steps, ['userId']);
  assert.equal(marks.get('0:0'), 'target');
  assert.equal(marks.get('0:1'), 'target');
});

test('重跑：本体不会被它下游的「陪跑」覆盖掉', () => {
  const steps = [
    step('a', { url: '/a?u={{userId}}', extracts: [{ to: 'a1' }] }),
    step('b', { url: '/b?x={{a1}}' }),
  ];
  // 两步都挂了 → 两步都是本体（b 追上游时会碰到 a，但 a 已经是本体，不能降级成 dep）
  const run = { rows: [rowOf(1, 'failed', [rec('a', 'failed'), rec('b', 'failed')])] };
  const cols = ['userId'];
  const marks = rerunTargets(run, steps, cols);
  assert.equal(marks.get('0:0'), 'target');
  assert.equal(marks.get('0:1'), 'target');
});

test('重跑：全过了就没什么可挑的', () => {
  const steps = [step('a', { url: '/a' })];
  const run = { rows: [rowOf(1, 'ok', [rec('a', 'ok')])] };
  assert.equal(rerunTargets(run, steps, []).size, 0);
  assert.equal(rerunTargets(null, steps, []).size, 0);
});
