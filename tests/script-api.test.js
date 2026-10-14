// ---------------------------------------------------------------------------
// 词表 == 沙箱实际暴露的 API
//
// scriptApi.js 是补全和页脚提示的来源，它说的东西必须和 script-worker.js 真注入的
// 一致。文档式的对齐迟早漂移（worker 加了个方法，补全里没有，人就得记两处），
// 所以这里把 worker **真跑一遍**：在 Node 里造一个 self，把 worker 源码丢进去执行，
// 再让一段探测脚本从沙箱内部把 env / console / pm / response / CryptoJS 的成员列出来，
// 和词表逐项对。
//
// importScripts 也照实现了（读同一个 vendor 文件），所以 CryptoJS 那一块是真加载过的，
// 不是假的桩 —— 词表里写 CryptoJS.enc.Utf8，这里就真去问 CryptoJS 有没有。
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SCRIPT_API, SCRIPT_HINTS } from '../frontend/js/scriptApi.js';
import { lookupApiPath } from '../frontend/js/scriptsuggest.js';

const WORKER_URL = new URL('../frontend/js/script-worker.js', import.meta.url);
const workerSource = readFileSync(WORKER_URL, 'utf8');

/**
 * 造一个能跑 worker 的 Node 环境并返回「执行一段脚本、拿回日志」的函数。
 *
 * self 直接指向沙箱本身（浏览器里 self 就是全局对象），crypto-js 的 UMD 会把
 * 自己挂到全局的 CryptoJS 上，于是 self.CryptoJS 也就有了 —— 和真实 worker 一样。
 */
function makeSandbox() {
  const posted = [];
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    importScripts(path) {
      // 相对 worker 文件解析，和浏览器里的行为一致
      const url = new URL(path, WORKER_URL);
      vm.runInContext(readFileSync(url, 'utf8'), sandbox);
    },
    postMessage(msg) {
      posted.push(msg);
    },
  };

  vm.createContext(sandbox);
  sandbox.self = sandbox;
  vm.runInContext(workerSource, sandbox);

  return {
    /** 跑一段脚本，返回 worker 回传的结果（logs / changes / error…） */
    run(code, { vars = {}, response = null } = {}) {
      posted.length = 0;
      sandbox.self.onmessage({ data: { code, vars, response } });
      assert.ok(posted.length, 'worker 没有回传结果');
      return posted[0];
    },
  };
}

/** 跑一段只用来问话的脚本，把 console.log 出来的 JSON 解析回来 */
function probe(worker, code, options) {
  const result = worker.run(`console.log(JSON.stringify(${code}))`, options);
  assert.equal(result.ok, true, `探测脚本执行失败：${result.error}`);
  const first = (result.logs || []).find((l) => l.level === 'log');
  assert.ok(first, '探测脚本没有输出');
  return JSON.parse(first.args[0]);
}

const worker = makeSandbox();

const apiNames = (node) => (node.members || []).map((m) => m.name).sort();

test('沙箱里的 env / console / pm 与词表逐项一致', () => {
  const got = probe(
    worker,
    `({
      env: Object.keys(env).sort(),
      console: Object.keys(console).sort(),
      pm: Object.keys(pm).sort()
    })`
  );

  assert.deepEqual(got.env, apiNames(SCRIPT_API.env), 'env 的成员和词表对不上');
  assert.deepEqual(got.console, apiNames(SCRIPT_API.console), 'console 的成员和词表对不上');
  assert.deepEqual(got.pm, apiNames(SCRIPT_API.pm), 'pm 的成员和词表对不上');
});

test('pm.environment / pm.variables 确实就是 env 本身（词表里 ref 的根据）', () => {
  const got = probe(worker, `({ a: pm.environment === env, b: pm.variables === env })`);
  assert.equal(got.a, true, 'pm.environment 不是 env，词表里的 ref 就错了');
  assert.equal(got.b, true, 'pm.variables 不是 env');
});

test('后置拿到的 response 字段与词表一致', () => {
  const got = probe(
    worker,
    'Object.keys(response).sort()',
    { response: { status: 200, statusText: 'OK', time: 12, size: 34, headers: [], body: '{}' } }
  );
  assert.deepEqual(got, apiNames(SCRIPT_API.response), 'response 的字段和词表对不上');
});

test('前置脚本里没有 response —— 和词表上的 afterOnly 一致', () => {
  const got = probe(worker, `({ type: typeof response })`);
  assert.equal(got.type, 'undefined', '前置不该拿得到 response');

  const flagged = Object.entries(SCRIPT_API)
    .filter(([, node]) => node.afterOnly)
    .map(([name]) => name);
  assert.deepEqual(flagged, ['response'], '只有 response 是「后置才有」，词表标记变了要同步补全');
});

test('CryptoJS 的成员在沙箱里真存在（含 enc.X / lib.X 这种两节的）', () => {
  const entries = [];
  SCRIPT_API.CryptoJS.members.forEach((m) => {
    if (m.members) {
      m.members.forEach((sub) => {
        entries.push(`[${JSON.stringify(`${m.name}.${sub.name}`)}, typeof CryptoJS.${m.name}.${sub.name}]`);
      });
    } else {
      entries.push(`[${JSON.stringify(m.name)}, typeof CryptoJS.${m.name}]`);
    }
  });

  const got = probe(worker, `Object.fromEntries([${entries.join(',')}])`);
  const missing = Object.entries(got)
    .filter(([, type]) => type === 'undefined')
    .map(([name]) => name);

  assert.deepEqual(missing, [], '词表里承诺了沙箱里没有的 CryptoJS 成员');
});

test('词表里的根对象在沙箱里都拿得到', () => {
  const roots = Object.keys(SCRIPT_API);
  const got = probe(worker, `Object.fromEntries(${JSON.stringify(roots)}.map(function (n) { return [n, eval('typeof ' + n)]; }))`);
  Object.entries(got).forEach(([name, type]) => {
    // response 只在后置存在，单独有测试管，这里跳过
    if (SCRIPT_API[name].afterOnly) return;
    assert.notEqual(type, 'undefined', `词表里写了根对象 ${name}，沙箱里却没有`);
  });
});

test('页脚提示里的每个写法都查得到（根和成员都在词表里）', () => {
  const all = [...SCRIPT_HINTS.pre, ...SCRIPT_HINTS.post];
  all.forEach((hint) => {
    const path = hint.split('(')[0].trim();
    assert.ok(lookupApiPath(path), `页脚教人写 ${hint}，但词表里查不到 ${path}`);
  });
});
