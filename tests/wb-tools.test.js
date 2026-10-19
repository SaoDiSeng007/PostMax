import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5Hex } from '../frontend/js/md5.js';
import { diffLines, normalizeJson, MAX_LINES } from '../frontend/js/textdiff.js';
import { joinBodyPath, joinIndexPath, getByPath } from '../frontend/js/assert.js';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// randomFrom 住在组件文件里（它 import vue），node 里要靠这个桩才能加载
register('./vue-loader.mjs', import.meta.url);
const { randomFrom } = await import('../frontend/js/components/WbRandom.js');
const {
  parsePicker, parseTsInput, partsFromMs, msFromParts, valueFromParts,
  daysInMonth, setPart, pickerColumns,
} = await import('../frontend/js/components/WbTimestamp.js');

// ---------------------------------------------------------------------------
// 两个入口的解析。时间一律按**北京时间**解释（和机器时区无关），钉死。
// ---------------------------------------------------------------------------

test('parseTsInput：纯数字按位数认秒/毫秒，其余一律 null', () => {
  assert.equal(parseTsInput('1760000000'), 1760000000000);
  assert.equal(parseTsInput('1760000000000'), 1760000000000);
  assert.equal(parseTsInput(' 1760000000 '), 1760000000000);
  assert.equal(parseTsInput(''), null);
  assert.equal(parseTsInput('abc'), null);
  assert.equal(parseTsInput('12:30'), null);
});

test('parsePicker：面板存的那一种形状，按北京时间解释', () => {
  assert.equal(parsePicker('2026-05-01T09:30:00'), Date.UTC(2026, 4, 1, 9, 30) - 8 * 3600 * 1000);
  assert.equal(parsePicker('2026-05-01T00:00:00'), Date.UTC(2026, 4, 1) - 8 * 3600 * 1000);
});

test('parsePicker：空值和乱值给 null，不装懂', () => {
  assert.equal(parsePicker(''), null);
  assert.equal(parsePicker('abc'), null);
  assert.equal(parsePicker('2026-13-01T00:00:00'), null);
  assert.equal(parsePicker('2026-05-01'), null, '缺时分秒就是没选，不给默认 0 点');
});

// ---------------------------------------------------------------------------
// 六列选择面板的算法：显示的是北京时间那一份，改一列不能让日期悄悄跑到别的月。
// ---------------------------------------------------------------------------

test('partsFromMs / msFromParts：按北京时间往返，和机器时区无关', () => {
  const ms = Date.UTC(2026, 4, 1, 9, 30, 15) - 8 * 3600 * 1000;
  const p = partsFromMs(ms);
  assert.deepEqual(p, { year: 2026, month: 5, day: 1, hour: 9, minute: 30, second: 15 });
  assert.equal(msFromParts(p), ms, '往返要严丝合缝');
  assert.equal(valueFromParts(p), '2026-05-01T09:30:15');
  assert.equal(parsePicker(valueFromParts(p)), ms, '存起来的字符串和解析得是一对');
});

test('partsFromMs：跨日边界看的是北京时间（UTC 还是前一天）', () => {
  // 北京时间 2026-05-01 00:30 = UTC 2026-04-30 16:30
  const ms = Date.UTC(2026, 3, 30, 16, 30);
  const p = partsFromMs(ms);
  assert.equal(p.day, 1);
  assert.equal(p.month, 5);
  assert.equal(p.hour, 0);
});

test('daysInMonth：大小月和闰年', () => {
  assert.equal(daysInMonth(2026, 1), 31);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29, '2028 是闰年');
  assert.equal(daysInMonth(2100, 2), 28, '整百年不闰');
  assert.equal(daysInMonth(2000, 2), 29, '四百年又闰');
  assert.equal(daysInMonth(2026, 4), 30);
});

test('setPart：改月份时日往回收，不跳到下个月', () => {
  const jan31 = { year: 2026, month: 1, day: 31, hour: 9, minute: 30, second: 0 };
  assert.equal(setPart(jan31, 'month', 2).day, 28, '1/31 改 2 月 → 2/28');
  const leap = { ...jan31, year: 2028 };
  assert.equal(setPart(leap, 'month', 2).day, 29, '闰年收到 29');

  // 反过来：2/28 改回 1 月不会自动变成 31（那是用户没选过的一天，不替他填）
  assert.equal(setPart({ ...jan31, day: 28 }, 'month', 1).day, 28);

  // 改年份同样要过一遍（2 月 29 改到平年）
  assert.equal(setPart({ ...jan31, year: 2028, month: 2, day: 29 }, 'year', 2026).day, 28);
});

test('pickerColumns：六列、表头写清哪列是年月日时分秒', () => {
  const parts = { year: 2026, month: 5, day: 1, hour: 9, minute: 30, second: 15 };
  const cols = pickerColumns(parts);

  assert.deepEqual(cols.map((c) => c.head), ['年', '月', '日', '时', '分', '秒']);
  assert.deepEqual(cols.map((c) => c.field), ['year', 'month', 'day', 'hour', 'minute', 'second']);

  // 每列恰好一项是选中的，且就是当前值
  cols.forEach((c) => {
    const on = c.values.filter((v) => v.on);
    assert.equal(on.length, 1, `${c.head} 列该只有一项选中`);
    assert.equal(on[0].value, parts[c.field]);
  });

  // 取值范围
  assert.equal(cols[1].values.length, 12, '月 12 项');
  assert.equal(cols[2].values.length, 31, '5 月 31 天');
  assert.equal(cols[3].values.length, 24, '时 24 项');
  assert.equal(cols[4].values.length, 60, '分 60 项');
  assert.equal(cols[5].values.length, 60, '秒 60 项');
  assert.equal(cols[0].values.length, 51, '年份取前后各 25 年');

  // 补零是为了两列对齐（03 和 15 一样宽）
  assert.equal(cols[1].values[2].label, '03');
  assert.equal(cols[5].values[9].label, '09');
  assert.equal(cols[0].values[25].label, '2026', '年份不补零');

  // 年份范围跟着当前值挪：贴进来一个 2035 年的时间戳也能选到附近
  const far = pickerColumns({ ...parts, year: 2035 });
  assert.equal(far[0].values[0].value, 2010);
  assert.equal(far[0].values[50].value, 2060);
});

// ---------------------------------------------------------------------------
// MD5。期望值是 Python hashlib 算的（另在改动时和 node 交叉验过一遍）。
// 覆盖：空串、标准向量、UTF-8、以及 55/56/57 字节三个填充边界 —— 消息长度
// 恰好跨块是最容易写错的地方。
// ---------------------------------------------------------------------------

const MD5_CASES = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ['中文测试', '089b4943ea034acfa445d050c7913e55'],
  ['a'.repeat(100), '36a92cc94a9e0fa21f625f8bfb007adf'],
  ['x'.repeat(55), '04364420e25c512fd958a70738aa8f72'],
  ['y'.repeat(56), '6c830a5d23df58dbe0171eb5639bf3e4'],
  ['z'.repeat(57), 'a541ba5d7a4507dc4c90389e7b340341'],
];

for (const [input, want] of MD5_CASES) {
  test(`md5Hex ${JSON.stringify(input.slice(0, 12))}`, () => {
    assert.equal(md5Hex(input), want);
  });
}

test('md5Hex 也吃 Uint8Array，且和字符串结果一致', () => {
  assert.equal(md5Hex(new TextEncoder().encode('abc')), md5Hex('abc'));
});

// ---------------------------------------------------------------------------
// 路径拼接。和 getByPath 是一对：拼出来的必须能被取回去 —— 每条都用
// getByPath 走一圈，保证「拼」和「取」永远对得上。
// ---------------------------------------------------------------------------

test('joinBodyPath：根、普通键、带点键', () => {
  assert.equal(joinBodyPath('', 'data'), 'data');
  assert.equal(joinBodyPath('data', 'token'), 'data.token');
  // 带 . 的键拼不出路径 —— 返回 null，界面上标「取不了」
  assert.equal(joinBodyPath('data', 'a.b'), null);
  assert.equal(joinBodyPath('data', 'a[b]'), null);
});

test('joinIndexPath：拼出的下标路径 getByPath 能取回', () => {
  const body = { list: [{ id: 7 }, { id: 8 }] };
  const p = joinIndexPath(joinBodyPath('', 'list'), 1);
  assert.equal(p, 'list[1]');
  assert.equal(getByPath(body, p), body.list[1]);
});

test('拼与取对得上：嵌套结构逐个节点走一圈', () => {
  const body = {
    data: { token: 'T', '带.点': 1, 'ok-key': 2 },
    items: [{ name: 'x' }],
  };
  assert.equal(getByPath(body, joinBodyPath('', 'data')), body.data);
  assert.equal(getByPath(body, joinBodyPath('data', 'token')), 'T');
  const itemPath = joinBodyPath(joinIndexPath(joinBodyPath('', 'items'), 0), 'name');
  assert.equal(itemPath, 'items[0].name');
  assert.equal(getByPath(body, itemPath), 'x');
  // ok-key 不是标识符但也没有分隔符，照样取得到
  assert.equal(getByPath(body, joinBodyPath('data', 'ok-key')), 2);
  assert.equal(joinBodyPath('data', '带.点'), null);
});

// ---------------------------------------------------------------------------
// 逐行 diff。
// ---------------------------------------------------------------------------

test('diffLines：纯增、纯删、行号对得上', () => {
  const { ops } = diffLines('a\nb\nc', 'a\nb\nc\nd');
  assert.deepEqual(
    ops.map((o) => [o.type, o.text]),
    [['same', 'a'], ['same', 'b'], ['same', 'c'], ['add', 'd']]
  );
  assert.equal(ops[3].bNo, 4);

  const del = diffLines('a\nb', 'a').ops;
  assert.deepEqual(
    del.map((o) => [o.type, o.text]),
    [['same', 'a'], ['del', 'b']]
  );
  assert.equal(del[1].aNo, 2);
});

test('diffLines：中间改动，公共前后缀被裁掉但结果等价', () => {
  const { ops } = diffLines('head\nold\ntail', 'head\nnew\ntail');
  assert.deepEqual(
    ops.map((o) => [o.type, o.text]),
    [['same', 'head'], ['del', 'old'], ['add', 'new'], ['same', 'tail']]
  );
});

test('diffLines：移动 + 交错增删（纯前后缀裁剪覆盖不到的情形）', () => {
  const { ops } = diffLines('1\n2\n3\n4\n5', '1\n3\n6\n4\n5');
  // 2 被删、6 是新增，其余原位
  assert.deepEqual(ops.filter((o) => o.type !== 'same').map((o) => [o.type, o.text]), [
    ['del', '2'],
    ['add', '6'],
  ]);
});

test('diffLines：完全相同 / 一方为空', () => {
  assert.equal(diffLines('a\nb', 'a\nb').ops.every((o) => o.type === 'same'), true);
  // 空串 split 出来是一行空行，所以左边有一行「删掉空行」
  const fromEmpty = diffLines('', 'x\ny').ops;
  assert.deepEqual(
    fromEmpty.map((o) => [o.type, o.text]),
    [['del', ''], ['add', 'x'], ['add', 'y']]
  );
});

test('diffLines：超长直接拒算，不给个内存爆掉的表', () => {
  const big = Array.from({ length: MAX_LINES + 1 }, () => 'x').join('\n');
  assert.equal(diffLines(big, 'a').tooBig, true);
});

test('normalizeJson：键序和缩进不算差异', () => {
  const a = '{"b":1,"a":{"y":2,"x":3}}';
  const b = '{\n  "a": { "x": 3, "y": 2 },\n  "b": 1\n}';
  assert.equal(normalizeJson(a), normalizeJson(b));
  // 标量和坏 JSON 有交代
  assert.equal(normalizeJson('42'), '42');
  assert.equal(normalizeJson('{bad'), null);
});

test('归一后比：只差键序的两份 JSON 判「两边一致」', () => {
  const { ops } = diffLines(
    normalizeJson('{"b":1,"a":2}'),
    normalizeJson('{"a":2,"b":1}')
  );
  assert.equal(ops.some((o) => o.type !== 'same'), false);
});

// ---------------------------------------------------------------------------
// 随机串。
// ---------------------------------------------------------------------------

test('randomFrom：长度、字符都落在池子里', () => {
  const pool = 'ABC123';
  for (let i = 0; i < 20; i++) {
    const s = randomFrom(pool, 32);
    assert.equal(s.length, 32);
    for (const ch of s) assert.ok(pool.includes(ch));
  }
});

test('randomFrom：空池 / 单字符池 / 零长度', () => {
  assert.equal(randomFrom('', 5), '');
  assert.equal(randomFrom('X', 4), 'XXXX');
  assert.equal(randomFrom('ABC', 0), '');
  // 单字符池走的是不进随机源的快路，结果得一样对
  assert.equal(randomFrom('X', 4), randomFrom('X', 4));
});

test('randomFrom：池大小不整除 256 时各字符都出现得出来（拒绝采样没把池子砍了）', () => {
  const pool = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36，不整除 256
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(...randomFrom(pool, 8));
  assert.ok(seen.size >= 30, `200 次只见过 ${seen.size} 种字符，采样有问题`);
});

// ---------------------------------------------------------------------------
// 清单与视图的接线：新工具在清单上、视图里挂了组件，说明别写成对不上的。
// （这两个文件 import vue，node 里跑不了，改成读源码断言。）
// ---------------------------------------------------------------------------

const wbSource = readFileSync(
  fileURLToPath(new URL('../frontend/js/workbench.js', import.meta.url)),
  'utf8'
);
const viewSource = readFileSync(
  fileURLToPath(new URL('../frontend/js/components/WorkbenchView.js', import.meta.url)),
  'utf8'
);

test('清单里的每个 id 都在视图里挂了组件，反过来也是', () => {
  const listed = [...wbSource.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  const wired = [...viewSource.matchAll(/^\s{2}(\w+): \w+,$/gm)].map((m) => m[1]);
  assert.ok(listed.length >= 7, `清单至少 7 个工具，现在 ${listed.length}`);
  for (const id of listed) assert.ok(wired.includes(id), `工具 ${id} 没挂组件`);
  for (const key of wired) assert.ok(listed.includes(key), `TOOL_VIEWS 里的 ${key} 不在清单上`);
});
