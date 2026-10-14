// ---------------------------------------------------------------------------
// 断言的执行语义
//
// 盯的是「写得对不对」和「写错了有没有说清楚」两件事：类型 / 长度 / schema
// 这三种后加的操作符，以及正则带 flag 的写法。断言写错却默默判过，比断言不过更坑。
//
// 跑：npm test（等价于 node --test tests/）
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OP_LABELS, flattenTree, runAssertions, runExtracts, typeName } from '../frontend/js/assert.js';

const response = (over = {}) => ({
  status: 200,
  time: 12,
  size: 34,
  headers: [{ key: 'Content-Type', value: 'application/json' }],
  body: JSON.stringify({
    data: { token: 'abc123', items: [1, 2, 3], name: 'Tr-x', nested: { id: 7 } },
    empty: [],
    count: 3,
    off: false,
  }),
  ...over,
});

/** 跑一条断言，返回结果 */
const run = (a, resp = response()) => runAssertions([a], resp)[0];
const json = (path, op, expect) => ({ target: 'json', path, op, expect });

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
test('类型：常见类型与 null / 数组都分得清', () => {
  assert.equal(run(json('data.token', 'type', 'string')).ok, true);
  assert.equal(run(json('data.items', 'type', 'array')).ok, true);
  assert.equal(run(json('data', 'type', 'object')).ok, true);
  assert.equal(run(json('count', 'type', 'number')).ok, true);
  assert.equal(run(json('off', 'type', 'boolean')).ok, true);
  assert.equal(run(json('data.nested.missing', 'type', 'null')).ok, false, '路径取不到时是 undefined');
});

test('类型：写 number 时整数也算过，写 integer 才要求整数', () => {
  assert.equal(run(json('count', 'type', 'integer')).ok, true);
  assert.equal(run(json('count', 'type', 'number')).ok, true);
  // 3.5 用 data 里的 count 换掉
  const resp = response({ body: JSON.stringify({ v: 3.5 }) });
  assert.equal(run(json('v', 'type', 'number'), resp).ok, true);
  assert.equal(run(json('v', 'type', 'integer'), resp).ok, false);
});

test('类型：收常见简写', () => {
  assert.equal(run(json('data.token', 'type', 'str')).ok, true);
  assert.equal(run(json('data.items', 'type', 'arr')).ok, true);
  assert.equal(run(json('off', 'type', 'bool')).ok, true);
});

test('类型：写错类型名要说清楚能写哪些，而不是默默判过', () => {
  const result = run(json('data.token', 'type', 'text'));
  assert.equal(result.ok, false);
  assert.match(result.reason, /string \/ number \/ integer/);
});

test('typeName：整数与小数分开报', () => {
  assert.equal(typeName(3), 'integer');
  assert.equal(typeName(3.5), 'number');
  assert.equal(typeName(null), 'null');
  assert.equal(typeName([]), 'array');
});

// ---------------------------------------------------------------------------
// 长度
// ---------------------------------------------------------------------------
test('长度：数组 / 字符串 / 对象字段数', () => {
  assert.equal(run(json('data.items', 'length', '3')).ok, true);
  assert.equal(run(json('data.token', 'length', '6')).ok, true);
  assert.equal(run(json('data', 'length', '4')).ok, true, '对象按字段数算');
  assert.equal(run(json('empty', 'length', '0')).ok, true);
});

test('长度：支持 >0 / >=2 / <3 这样的比较', () => {
  assert.equal(run(json('data.items', 'length', '>0')).ok, true);
  assert.equal(run(json('empty', 'length', '>0')).ok, false);
  assert.equal(run(json('data.items', 'length', '>=3')).ok, true);
  assert.equal(run(json('data.items', 'length', '<3')).ok, false);
  assert.equal(run(json('data.items', 'length', '<=3')).ok, true);
});

test('长度：不过时给出实际长度，写法不对时给出提示', () => {
  assert.match(run(json('data.items', 'length', '2')).reason, /实际长度 3/);
  assert.match(run(json('data.items', 'length', '三')).reason, /长度要写数字/);
  assert.match(run(json('count', 'length', '1')).reason, /没有长度/);
});

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------
test('schema：结构对就过', () => {
  const schema = JSON.stringify({
    type: 'object',
    required: ['token', 'items'],
    properties: {
      token: { type: 'string', minLength: 3 },
      items: { type: 'array', items: { type: 'integer' } },
    },
  });
  assert.equal(run(json('data', 'schema', schema)).ok, true);
});

test('schema：缺字段 / 类型不对 / 元素不对，都指出位置', () => {
  assert.match(
    run(json('data', 'schema', JSON.stringify({ required: ['nope'] }))).reason,
    /\$ 缺字段 nope/
  );
  assert.match(
    run(json('data', 'schema', JSON.stringify({ type: 'array' }))).reason,
    /的类型不是 array/
  );
  assert.match(
    run(
      json('data', 'schema', JSON.stringify({ properties: { items: { items: { type: 'string' } } } }))
    ).reason,
    /\$\.items\[0\]/
  );
});

test('schema：enum / minimum / pattern 生效', () => {
  assert.equal(run(json('count', 'schema', JSON.stringify({ enum: [3, 4] }))).ok, true);
  assert.equal(run(json('count', 'schema', JSON.stringify({ enum: [1] }))).ok, false);
  assert.equal(run(json('count', 'schema', JSON.stringify({ minimum: 5 }))).ok, false);
  assert.equal(run(json('data.token', 'schema', JSON.stringify({ pattern: '^[a-z]+\\d+$' }))).ok, true);
  assert.equal(run(json('data.token', 'schema', JSON.stringify({ maxLength: 2 }))).ok, false);
});

test('schema：写歪了要说清是 JSON 问题还是取值问题', () => {
  assert.match(run(json('data', 'schema', '{ not json')).reason, /不是合法 JSON/);
  assert.match(run(json('data', 'schema', '')).reason, /schema 是空的/);
  assert.match(run(json('data.missing', 'schema', '{}')).reason, /取不到值/);
});

// ---------------------------------------------------------------------------
// 正则（带 flag）与提取
// ---------------------------------------------------------------------------
test('正则：裸模式和 /pattern/flags 两种写法都认', () => {
  assert.equal(run(json('data.name', 'matches', '^Tr-')).ok, true);
  assert.equal(run(json('data.name', 'matches', '^tr-')).ok, false, '大小写敏感是默认行为');
  assert.equal(run(json('data.name', 'matches', '/^tr-/i')).ok, true, '/…/i 忽略大小写');
});

test('正则：写错了给出原因，而不是笼统的「未知操作符」', () => {
  const bad = run(json('data.name', 'matches', '/(/'));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /正则写错了/);

  const badFlag = run(json('data.name', 'matches', '/abc/zz'));
  assert.equal(badFlag.ok, false);
  assert.match(badFlag.reason, /正则写错了/);
});

test('提取：正文正则同样认 /pattern/flags', () => {
  const resp = response({ body: 'token=ABC123;user=Tr-x' });
  const [hit] = runExtracts([{ from: 'text', path: '/token=([a-z0-9]+)/i', to: 'tk' }], resp);
  assert.equal(hit.ok, true);
  assert.equal(hit.value, 'ABC123');

  const [miss] = runExtracts([{ from: 'text', path: '/token=([a-z0-9]+)/', to: 'tk' }], resp);
  assert.equal(miss.ok, false);
});

// ---------------------------------------------------------------------------
// 下拉框的那份清单
// ---------------------------------------------------------------------------
test('操作符清单里有新加的三个（界面下拉按它生成）', () => {
  assert.equal(OP_LABELS.type, '类型是');
  assert.equal(OP_LABELS.length, '长度');
  assert.equal(OP_LABELS.schema, '符合 schema');
});

test('长 schema 在断言标签里被截断，不会把结果列表撑破', () => {
  const long = JSON.stringify({ type: 'object', required: Array.from({ length: 12 }, (_, i) => `k${i}`) });
  const result = run(json('data', 'schema', long));
  assert.ok(result.label.length < 100, `标签过长：${result.label.length}`);
  assert.match(result.label, /…/);
});

// ---------------------------------------------------------------------------
// 大响应下的搜索：遍历要有上限
// ---------------------------------------------------------------------------
test('展平遍历：不传上限时走完整棵树', () => {
  const nodes = flattenTree({ a: { b: { c: 1 } }, d: [1, 2] });
  assert.deepEqual(
    nodes.map((n) => n.path),
    ['', 'a', 'a.b', 'a.b.c', 'd', 'd.0', 'd.1']
  );
});

test('展平遍历：给了上限就到顶即停（大响应里每次按键全量遍历会卡手）', () => {
  const tree = { a: { b: { c: 1 } }, d: [1, 2, 3] };
  const capped = flattenTree(tree, '', '', [], 3);
  assert.equal(capped.length, 3);
  assert.deepEqual(
    capped.map((n) => n.path),
    ['', 'a', 'a.b'],
    '深度优先，取到上限为止'
  );
  // 调用方靠「长度 === 上限」判断被截（ResponsePanel 的 searchCapped 就是这么做的）
  assert.equal(capped.length, 3);
});
