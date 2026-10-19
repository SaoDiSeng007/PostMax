// ---------------------------------------------------------------------------
// Headers「快捷添加」那排芯片
//
// 芯片表是组件里的一个常量（没导出），挂载组件测又太重 —— 所以照
// tests/contract.test.js 的老办法，直接从源码里把它抠出来核。
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../frontend/js/components/RequestEditor.js', import.meta.url)),
  'utf8'
);

const chipBlock = () => {
  const m = src.match(/const commonHeaders = \[([\s\S]*?)\];/);
  assert.ok(m, 'commonHeaders 得抠得出来 —— 改了写法就同步改这个测试');
  return m[1];
};

test('快捷添加里有 authoration，且只插头名（值留空）', () => {
  assert.match(
    chipBlock(),
    /\{\s*key:\s*'authoration',\s*value:\s*''\s*\}/,
    'authoration 这条要留着，值留空由用户自己填'
  );
});

test('原有的几条常用头一个没少', () => {
  const block = chipBlock();
  for (const key of ['Content-Type', 'Accept', 'Authorization', 'User-Agent']) {
    assert.ok(block.includes(`key: '${key}'`), `${key} 不该被删掉`);
  }
});
