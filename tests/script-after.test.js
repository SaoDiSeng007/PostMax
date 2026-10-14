// ---------------------------------------------------------------------------
// 后置脚本：判定口径、日志摊平、导出往返
//
// 沙箱本身（script-worker.js）跑不起来在 node 里测 —— 它是 classic worker，
// 用 importScripts 加载 CryptoJS，也不能当模块 import。这里测的是**能钉住的部分**：
//   · 后置脚本的产出 / 引用也参与「跑几遍」判定（和前置一个口径）
//   · 报告里那一步的日志怎么摊平（先前置、后置在后）
//   · x-posmax-after-script 的导出 / 回导
// 沙箱执行的实测在浏览器冒烟里做。
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stepScopes, stepProduces } from '../frontend/js/planSteps.js';
import { stepScriptLogs } from '../frontend/js/planExport.js';
import { buildDocument } from '../frontend/js/openapiExport.js';
import { toBundles } from '../frontend/js/openapi.js';

const step = (name, request, extra = {}) => ({
  id: name,
  enabled: true,
  request: { name, method: 'GET', ...request },
  ...extra,
});

const req = (over = {}) => ({
  id: 'req-x',
  name: 'A request',
  method: 'GET',
  url: '{{baseUrl}}/things',
  params: [],
  pathParams: [],
  headers: [],
  body: '',
  bodyType: 'json',
  bodyForm: [],
  script: '',
  afterScript: '',
  assertions: [],
  extracts: [],
  ...over,
});

// ---------------------------------------------------------------- 判定口径

test('数据列只出现在后置脚本里：也算依赖数据，每行跑', () => {
  const steps = [step('后置用列', { url: '/x', afterScript: "console.log('{{userId}}')" })];
  assert.deepEqual(stepScopes(steps, ['userId']), ['each']);
});

test('后置脚本写死的产出算数：下游用它，两步都整轮一遍', () => {
  const steps = [
    step('A', { url: '/a', afterScript: "env.set('sig', response.status)" }),
    step('B', { body: '{"s":"{{sig}}"}' }),
  ];
  assert.deepEqual(stepScopes(steps, []), ['once', 'once']);
});

test('stepProduces 把后置脚本里的 env.set 也算产出', () => {
  const produced = stepProduces(
    step('A', {
      url: '/a',
      script: "env.set('pre1', 1)",
      afterScript: "env.set('post1', response.status)",
    })
  );
  assert.ok(produced.has('pre1'));
  assert.ok(produced.has('post1'));
});

test('动态拼名字仍然不算产出（前后置一个口径）', () => {
  const produced = stepProduces(
    step('A', { url: '/a', afterScript: "env.set('s' + 'ig', 1)" })
  );
  assert.deepEqual([...produced], []);
});

// ---------------------------------------------------------------- 日志摊平

test('stepScriptLogs：先前置后后置，等级和参数原样带出', () => {
  const logs = stepScriptLogs({
    scripts: {
      pre: { logs: [{ level: 'log', args: ['pre-line'] }], droppedLogs: 0 },
      post: { logs: [{ level: 'error', args: ['post-line', { a: 1 }] }], droppedLogs: 0 },
    },
  });
  assert.deepEqual(logs, [
    { id: 'pre-0', phase: 'pre', level: 'log', args: ['pre-line'] },
    { id: 'post-0', phase: 'post', level: 'error', args: ['post-line', { a: 1 }] },
  ]);
});

test('stepScriptLogs：没跑过脚本 / 只有一段 / 空值都不炸', () => {
  assert.deepEqual(stepScriptLogs(null), []);
  assert.deepEqual(stepScriptLogs({}), []);
  assert.deepEqual(
    stepScriptLogs({ scripts: { post: { logs: [{ level: 'warn', args: [] }] } } }).map((l) => l.phase),
    ['post']
  );
});

// ---------------------------------------------------------------- 导出往返

test('afterScript 导出成 x-posmax-after-script，回导一字不差', () => {
  const code = "if (response.json.code !== 0) throw new Error('业务失败')\nenv.set('ok', 1)";
  const { doc } = buildDocument({
    title: 'T',
    collections: [{ name: 'C', requests: [req({ afterScript: code })] }],
  });
  assert.equal(doc.paths['/things'].get['x-posmax-after-script'], code);

  const { requests } = toBundles(doc);
  assert.equal(requests[0].afterScript, code);
});

test('没写后置脚本时，导出的文档里不留空字段', () => {
  const { doc } = buildDocument({ title: 'T', collections: [{ name: 'C', requests: [req()] }] });
  assert.equal(doc.paths['/things'].get['x-posmax-after-script'], undefined);
  assert.equal(toBundles(doc).requests[0].afterScript, '');
});
