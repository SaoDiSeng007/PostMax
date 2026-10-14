// ---------------------------------------------------------------------------
// 变量插入：applyVarPick 交给输入框的那几个数
//
// 插入改成「走浏览器原生通道」之后（useVarInsert.js 的 writeText），调用方要的
// 不再只是「新文本」，还有**要替换哪一段**和**插进去的是什么** —— 这几个数错了，
// 表现就是插歪或者撤销撤不回。纯函数，能直接测。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyVarPick, detectVarTrigger } from '../frontend/js/varsuggest.js';

test('补全：从 {{ 到光标的那一段被整段替换', () => {
  // 打了 'a{{to'，光标在末尾
  const result = applyVarPick('a{{to', 1, 5, 'token');

  assert.equal(result.inserted, '{{token}}');
  assert.equal(result.start, 1, '起点是 {{ 那个位置');
  assert.equal(result.end, 5, '终点是光标');
  assert.equal(result.text, 'a{{token}}');
  assert.equal(result.caret, 10, '光标落在插进去那段后面');
});

test('插入：起点终点都是光标，等于在光标处插', () => {
  const result = applyVarPick('ab', 1, 1, 'token');

  assert.equal(result.start, 1);
  assert.equal(result.end, 1);
  assert.equal(result.text, 'a{{token}}b');
  assert.equal(result.caret, 10);
});

test('替换的那一段和原文对得上（拼回去必须等于 text）', () => {
  const source = 'url={{base}}/users/{{id}}';
  const caret = 6; // 光标在 '{{' 后面
  const trigger = detectVarTrigger(source, caret);
  assert.equal(trigger.active, true);

  const result = applyVarPick(source, trigger.start, caret, 'host');
  assert.equal(
    source.slice(0, result.start) + result.inserted + source.slice(result.end),
    result.text,
    'start / end / inserted 必须能还原出 text —— 不然插入会歪'
  );
});

test('光标在 {{ 之前（异常输入）也不会倒着切', () => {
  const result = applyVarPick('abc', 2, 1, 'token');
  assert.ok(result.end >= result.start, 'end 不能小于 start');
  assert.equal(result.text, 'ab{{token}}c');
});

// ---------------------------------------------------------------------------
// 浮层顶上那个「时间偏移」框的键盘行为
//
// 组件挂载起来太重，照 tests/quick-headers.test.js 的老办法，直接从模板源码里核。
// ---------------------------------------------------------------------------
const pickerSrc = readFileSync(
  fileURLToPath(new URL('../frontend/js/components/VarPicker.js', import.meta.url)),
  'utf8'
);

/** 把 var-picker-offset 那个 div 的开标签抠出来 */
const offsetRow = () => {
  const m = pickerSrc.match(/<div class="var-picker-offset"[^>]*>/);
  assert.ok(m, 'var-picker-offset 那个 div 得抠得出来 —— 改了写法就同步改这个测试');
  return m[0];
};

test('偏移框：拦住 keydown，别让方向键跑去挪列表高亮', () => {
  assert.match(
    offsetRow(),
    /@keydown\.stop/,
    '不拦的话，在偏移框里按上下键会去挪列表高亮、回车会被列表当成「选中候选项」'
  );
});

test('偏移框：Esc 也能关掉浮层（搜索框能关、这里关不掉，就成了两套行为）', () => {
  assert.match(
    offsetRow(),
    /@keydown\.esc="closePanel"/,
    '@keydown.stop 把外层的 Esc 一起拦掉了，必须在这儿补回来'
  );
});
