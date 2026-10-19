// ---------------------------------------------------------------------------
// 内置变量：$timestamp / $datetime（带偏移）
//
// 时间这类东西不钉住时钟就没法断言，所以整份测试把 Date.now 定死 —— 顺带也
// 证明了「每次现算、不缓存」这件事（缓存住的话偏移量就对不上了）。
// ---------------------------------------------------------------------------
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_VARS,
  buildGroupedCandidates,
  buildVarCandidates,
  formatDatetime,
  isBuiltinVar,
  parseDatetimeOffset,
  resolveBuiltin,
} from '../frontend/js/varsuggest.js';
import { VAR_TOKEN_G } from '../frontend/js/vartoken.js';
import { finalUrl } from '../frontend/js/api.js';

/** 本地时间 2026-10-10 07:37:00 —— 用户举的那个例子 */
const FIXED = new Date(2026, 9, 10, 7, 37, 0).getTime();
const realNow = Date.now;

beforeEach(() => {
  Date.now = () => FIXED;
});
after(() => {
  Date.now = realNow;
});

test('$datetime：本地时间按 YYYY-MM-DD HH:mm:ss 摆出来', () => {
  assert.equal(resolveBuiltin('$datetime'), '2026-10-10 07:37:00');
  assert.equal(formatDatetime(new Date(FIXED)), '2026-10-10 07:37:00');
});

test('$datetime 的偏移：减小时、加小时、叠单位、整天', () => {
  assert.equal(resolveBuiltin('$datetime-8h'), '2026-10-09 23:37:00', '减 8 小时');
  assert.equal(resolveBuiltin('$datetime+8h'), '2026-10-10 15:37:00', '加 8 小时');
  assert.equal(resolveBuiltin('$datetime+2h30m'), '2026-10-10 10:07:00', '单位能叠着写');
  assert.equal(resolveBuiltin('$datetime-1d'), '2026-10-09 07:37:00', '天也是单位');
  assert.equal(resolveBuiltin('$datetime-90m'), '2026-10-10 06:07:00', '分钟');
  assert.equal(resolveBuiltin('$datetime+0m'), '2026-10-10 07:37:00', '偏移 0 = 此刻');
});

test('$datetime 偏移跨月跨年也对', () => {
  Date.now = () => new Date(2026, 0, 1, 2, 0, 0).getTime();
  assert.equal(resolveBuiltin('$datetime-3h'), '2025-12-31 23:00:00', '跨年');
  Date.now = () => new Date(2026, 2, 1, 1, 0, 0).getTime();
  assert.equal(resolveBuiltin('$datetime-2h'), '2026-02-28 23:00:00', '跨月（2026 不是闰年）');
});

test('不是内置变量的一律返回 null（调用方靠它决定要不要走变量表）', () => {
  assert.equal(resolveBuiltin('token'), null);
  assert.equal(resolveBuiltin('$nope'), null);
  assert.equal(resolveBuiltin('$datetime-8x'), null, '单位不认识就不认这名字');
  assert.equal(resolveBuiltin(''), null);
  assert.equal(resolveBuiltin(undefined), null);
});

test('isBuiltinVar：漏配检查用，带偏移的也算内置', () => {
  assert.equal(isBuiltinVar('$timestamp'), true);
  assert.equal(isBuiltinVar('$timestampMs'), true);
  assert.equal(isBuiltinVar('$datetime'), true);
  assert.equal(isBuiltinVar('$datetime-8h'), true);
  assert.equal(isBuiltinVar('$datetime+2h30m'), true);
  assert.equal(isBuiltinVar('$nope'), false);
  assert.equal(isBuiltinVar('token'), false);
});

test('时间戳那两个照旧', () => {
  assert.equal(resolveBuiltin('$timestamp'), String(Math.floor(FIXED / 1000)));
  assert.equal(resolveBuiltin('$timestampMs'), String(FIXED));
});

test('{{$datetime+2h30m}} 得整个认成一个变量', () => {
  // 变量名字符集原来没有 +，加号会被当成「不是变量名」而整段作废
  const text = '{"t":"{{$datetime+2h30m}}","old":"{{$datetime-8h}}"}';
  assert.deepEqual([...text.matchAll(VAR_TOKEN_G)].map((m) => m[1]), [
    '$datetime+2h30m',
    '$datetime-8h',
  ]);
});

test('替换时算得出值，且不留 {{}}', () => {
  const url = finalUrl({ url: 'http://x/api?t={{$datetime-8h}}' }, {});
  assert.equal(url, 'http://x/api?t=2026-10-09 23:37:00');
  assert.equal(url.includes('{{'), false);
});

test('候选：系统变量组只有内置那三条，时间偏移交给浮层顶上的输入框', () => {
  const flat = buildVarCandidates({}, '').map((it) => it.name);
  assert.ok(flat.includes('$datetime'), '补全里要有它');
  assert.ok(flat.includes('$timestamp'), '老的两个别丢');

  const system = buildGroupedCandidates({}, '').find((g) => g.title === '系统变量');
  assert.deepEqual(
    system.items.map((it) => it.name),
    ['$timestamp', '$timestampMs', '$datetime'],
    '不再塞 $datetime-8h 这类预设：同一个东西给两个入口只会让人不知道点哪个'
  );
  assert.equal(system.items.find((it) => it.name === '$datetime').value, '2026-10-10 07:37:00');
});

test('偏移输入：留空就是此刻', () => {
  assert.deepEqual(parseDatetimeOffset(''), { ok: true, name: '$datetime', error: '' });
  assert.equal(parseDatetimeOffset('   ').name, '$datetime', '光空格也算没填');
  assert.equal(resolveBuiltin(parseDatetimeOffset('').name), '2026-10-10 07:37:00');
});

test('偏移输入：想写多少写多少，叠单位、不带符号、两头空格都收', () => {
  assert.equal(parseDatetimeOffset('-8h').name, '$datetime-8h');
  assert.equal(parseDatetimeOffset('+2h30m').name, '$datetime+2h30m');
  assert.equal(parseDatetimeOffset('-1d12h').name, '$datetime-1d12h');
  assert.equal(parseDatetimeOffset('90m').name, '$datetime+90m', '不带符号当作加');
  assert.equal(parseDatetimeOffset('  -1d  ').name, '$datetime-1d', '两头空格忽略');
});

test('偏移输入：写错了说清原因，绝不硬拼一个不生效的名字出来', () => {
  ['8', '8x', '8hh', '8h-2m', 'h', '1h 30m', '1H', '--8h'].forEach((text) => {
    const r = parseDatetimeOffset(text);
    assert.equal(r.ok, false, `「${text}」应当判为不合法`);
    assert.ok(r.error, `「${text}」要给出原因`);
    assert.equal(r.name, '', `「${text}」不该拼出名字`);
  });
});

test('偏移输入：拼出来的名字一定能被解析回来（拼错就等于插了个永远取不到值的变量）', () => {
  ['', '-8h', '+2h30m', '-1d12h', '90m', '8h', '-1m'].forEach((text) => {
    const { ok, name } = parseDatetimeOffset(text);
    assert.equal(ok, true, `「${text}」应当合法`);
    assert.equal(isBuiltinVar(name), true, `${text} → ${name} 得认得出是内置变量`);
    assert.notEqual(resolveBuiltin(name), null, `${text} → ${name} 得算得出值`);
  });
});

test('偏移输入：大到算不出正经时间的不收（否则会插进一个 NaN 变量）', () => {
  // 光看语法，下面这些都是规规矩矩的「数字 + 单位」，问题出在算出来的结果上：
  // 越过 Date 的表示范围 → NaN-NaN-NaN；只是年份越界 → 29405-11-07，格式已经不是 YYYY 了。
  // 光校验语法的版本会放它们过去，面板给绿灯、按钮可点，插进去的却是个废变量。
  ['999999999d', '-999999999d', '100000000000000000d', '9999999d', '-9999999d', '999999999999m']
    .forEach((text) => {
      const r = parseDatetimeOffset(text);
      assert.equal(r.ok, false, `「${text}」应当判为不合法`);
      assert.equal(r.name, '', `「${text}」不该拼出名字`);
      assert.match(r.error, /偏移太大/, `「${text}」要说清是偏移太大`);
    });
});

test('偏移输入：边界之内的值照收 —— 拦的是「算不出来」，不是「看着大」', () => {
  ['3000d', '-3000d', '100000h', '-100000h', '20000d'].forEach((text) => {
    const r = parseDatetimeOffset(text);
    assert.equal(r.ok, true, `「${text}」在范围内，应当放行`);
    assert.match(
      resolveBuiltin(r.name),
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      `${text} 算出来还得是 YYYY-MM-DD HH:mm:ss`
    );
  });
});

test('手敲一个越界偏移：给 null，占位符原样留下，绝不把 NaN 发出去', () => {
  assert.equal(resolveBuiltin('$datetime+999999999d'), null);
  assert.equal(resolveBuiltin('$datetime-999999999d'), null);

  // 和「变量漏配」一个表现：占位符留在报文里，肉眼一看就知道哪个没落地
  const url = finalUrl({ url: 'http://x/api?t={{$datetime+999999999d}}' }, {});
  assert.equal(url, 'http://x/api?t={{$datetime+999999999d}}');
  assert.equal(url.includes('NaN'), false, '绝不能出现 NaN-NaN-NaN');
});

test('BUILTIN_VARS 里 $datetime 的说明写清了偏移写法', () => {
  const item = BUILTIN_VARS.find((v) => v.name === '$datetime');
  assert.ok(item, '$datetime 要在册');
  assert.match(item.desc, /datetime-8h/);
});
