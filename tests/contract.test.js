import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 前后端契约的「双写常量」只有注释互相提醒，没有代码引用 —— 注释会腐烂，
// 这里用测试把三对值钉住：改了任何一边、忘了另一边，跑测试就知道。
// ---------------------------------------------------------------------------

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const storagePy = read('../backend/storage.py');
const proxyPy = read('../backend/proxy.py');
const storeJs = read('../frontend/js/store.js');
const apiJs = read('../frontend/js/api.js');

test('SCHEMA_VERSION 两端一致', () => {
  const py = storagePy.match(/^SCHEMA_VERSION = (\d+)$/m);
  const js = storeJs.match(/^export const SCHEMA_VERSION = (\d+);$/m);
  assert.ok(py && js, 'SCHEMA_VERSION 两边都得能提取到 —— 改了写法就同步改这个测试');
  assert.equal(js[1], py[1]);
});

test('DEFAULT_TIMEOUT_MS 两端一致', () => {
  const py = proxyPy.match(/^DEFAULT_TIMEOUT_MS = (\d+)$/m);
  const js = apiJs.match(/^export const DEFAULT_TIMEOUT_MS = (\d+);$/m);
  assert.ok(py && js, 'DEFAULT_TIMEOUT_MS 两边都得能提取到');
  assert.equal(js[1], py[1]);
});

test('PERSISTED_KEYS 两端一致（前端多一个 version，由后端单独处理）', () => {
  const pyBlock = storagePy.match(/^PERSISTED_KEYS = \(([\s\S]*?)^\)/m);
  const jsBlock = storeJs.match(/^const PERSISTED_KEYS = \[([\s\S]*?)^\];/m);
  assert.ok(pyBlock && jsBlock, 'PERSISTED_KEYS 两边都得能提取到');

  const pyKeys = [...pyBlock[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const jsKeys = [...jsBlock[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]).filter((k) => k !== 'version');

  assert.deepEqual(jsKeys, pyKeys);
  // 顺序也有语义吗？没有 —— 但两边各自重复项要揪出来
  assert.equal(new Set(pyKeys).size, pyKeys.length);
  assert.equal(new Set(jsKeys).size, jsKeys.length);
});
