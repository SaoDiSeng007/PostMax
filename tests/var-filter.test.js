// ---------------------------------------------------------------------------
// 变量过滤器：{{源|sha256}}
//
// 需求原话是「只想输明文，然后说明要 sha256，别再去别处转好再粘回来」。
// 所以这里要钉住三件事：
//   1. 语法能拆对 —— 名字 / 明文 / 过滤器各归各位，明文里的 | 和 ' 不能拆错
//   2. 替换按「先取源、再套过滤器」算；取不到就**原样留着**，绝不硬塞半截结果
//   3. 「哪些变量被用到了」只算变量，纯明文不算引用 —— 否则漏配检查会把
//      一步好好的请求拦下来
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { VAR_TOKEN_G, VAR_EXPR_ONLY, parseVarExpr, varNameOf } from '../frontend/js/vartoken.js';
import {
  canResolveVar,
  collectVarNames,
  interpolate,
  interpolateJson,
  splitUnresolved,
} from '../frontend/js/api.js';
import { VAR_FILTERS } from '../frontend/js/varsuggest.js';
import { sha256Hex } from '../frontend/js/sha256.js';
import { usesData } from '../frontend/js/planSteps.js';

/** 标尺 */
const H = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const VARS = { pass: 'Vss_2024', baseUrl: 'https://a.com/' };

// ---------------------------------------------------------------------------
// 一、拆表达式
// ---------------------------------------------------------------------------

test('拆表达式：变量 / 明文 / 带过滤器，各归各位', () => {
  assert.deepEqual(parseVarExpr('pass'), { name: 'pass', literal: null, filter: '' });
  assert.deepEqual(parseVarExpr("'Vss_2024'"), { name: null, literal: 'Vss_2024', filter: '' });
  assert.deepEqual(parseVarExpr('pass|sha256'), {
    name: 'pass',
    literal: null,
    filter: 'sha256',
  });
  assert.deepEqual(parseVarExpr("'Vss_2024'|sha256"), {
    name: null,
    literal: 'Vss_2024',
    filter: 'sha256',
  });
});

test('过滤器写成函数调用式也认 —— 用户就是照着这个写法提的', () => {
  assert.equal(parseVarExpr("'Vss_2024'|sha('sha256')").filter, 'sha256');
  assert.equal(parseVarExpr('pass|sha256').filter, 'sha256', '简写和上面等价');
});

test('两头空格、过滤器两边的空格都无所谓', () => {
  assert.deepEqual(parseVarExpr('  $datetime+8h | sha256  '), {
    name: '$datetime+8h',
    literal: null,
    filter: 'sha256',
  });
});

test('明文里的 | 不算分隔符（引号先吃掉），转义也解得开', () => {
  assert.deepEqual(parseVarExpr("'a|b'|sha256"), { name: null, literal: 'a|b', filter: 'sha256' });
  assert.equal(parseVarExpr("'don\\'t'").literal, "don't", "\\' 要还原成单引号");
  assert.equal(parseVarExpr("'a\\\\b'").literal, 'a\\b', '\\\\ 要还原成反斜杠');
});

test('拆不出来的返回 null —— 调用方据此保留原文，别硬猜', () => {
  for (const bad of ['', '   ', 'a|', 'a b', "'未闭合", 'a||b', '|sha256']) {
    assert.equal(parseVarExpr(bad), null, `「${bad}」应当拆不出来`);
    assert.equal(VAR_EXPR_ONLY.test(bad), false, `「${bad}」不是合法表达式`);
  }
});

test('varNameOf：只有变量才算「引用了变量」，纯明文返回 null', () => {
  assert.equal(varNameOf('pass|sha256'), 'pass');
  assert.equal(varNameOf('$datetime-8h'), '$datetime-8h');
  assert.equal(varNameOf("'Vss_2024'|sha256"), null);
  assert.equal(varNameOf("'Vss_2024'"), null);
});

// ---------------------------------------------------------------------------
// 二、认令牌
// ---------------------------------------------------------------------------

const tokens = (src) => [...src.matchAll(VAR_TOKEN_G)].map((m) => m[1]);

test('整个 {{…}} 是一个令牌，不会在 | 那里断开', () => {
  assert.deepEqual(tokens("{{'Vss_2024'|sha256}}"), ["'Vss_2024'|sha256"]);
  assert.deepEqual(tokens("{{'Vss_2024'|sha('sha256')}}"), ["'Vss_2024'|sha('sha256')"]);
  assert.deepEqual(tokens('{{pass|sha256}}'), ['pass|sha256']);
});

test('JSON 里那种空 {{ }} 不会被误认成变量', () => {
  assert.deepEqual(tokens('{ "a": {{ }} }'), []);
  assert.deepEqual(tokens('{{ a : 1 }}'), []);
  assert.deepEqual(tokens('{{ }}'), []);
});

test('引号一律只用单引号 —— 双引号在 JSON body 里是字符串的引号，混在一起没法解析', () => {
  // 明文
  assert.deepEqual(tokens('{{"Vss_2024"|sha256}}'), []);
  // 过滤器参数也一样，不搞两套
  assert.equal(parseVarExpr('pass|sha("sha256")'), null);
  assert.equal(parseVarExpr("pass|sha('sha256')").filter, 'sha256');
});

// ---------------------------------------------------------------------------
// 三、替换
// ---------------------------------------------------------------------------

test('明文直接哈希，不用先去环境里配一个变量', () => {
  assert.equal(interpolate("{{'Vss_2024'|sha256}}", {}), H('Vss_2024'));
  assert.equal(interpolate("{{'Vss_2024'|sha('sha256')}}", {}), H('Vss_2024'));
});

test('变量哈希：先取值、再哈希，两头空格无所谓', () => {
  assert.equal(interpolate('{{pass|sha256}}', VARS), H('Vss_2024'));
  assert.equal(interpolate('{{ pass | sha256 }}', VARS), H('Vss_2024'));
});

test('明文不带过滤器时就是明文本身', () => {
  assert.equal(interpolate("{{'Vss_2024'}}", {}), 'Vss_2024');
});

test('和别的占位符混在一段里互不干扰', () => {
  assert.equal(
    interpolate("t={{'a'|sha256}}&u={{baseUrl}}x", VARS),
    `t=${H('a')}&u=https://a.com/x`
  );
});

test('明文里的 | 不会被当成过滤器分隔符', () => {
  assert.equal(interpolate("{{'a|b'|sha256}}", {}), H('a|b'));
  assert.equal(interpolate("{{'don\\'t'|sha256}}", {}), H("don't"));
});

test('多字节明文按 UTF-8 算', () => {
  assert.equal(interpolate("{{'中文'|sha256}}", {}), H('中文'));
});

test('内置变量也能套过滤器', () => {
  const out = interpolate('{{$timestamp|sha256}}', {});
  assert.match(out, /^[0-9a-f]{64}$/, '算出来了，是个正经摘要');
});

test('JSON body：值已经在引号里就原样放进去', () => {
  assert.equal(interpolateJson('{"p": "{{pass|sha256}}"}', VARS), `{"p": "${H('Vss_2024')}"}`);
});

// ---------------------------------------------------------------------------
// 四、取不到就原样留着
// ---------------------------------------------------------------------------

test('变量没配：占位符原样保留，绝不拿明文顶上去', () => {
  assert.equal(interpolate('{{missing|sha256}}', {}), '{{missing|sha256}}');
});

test('过滤器不认识：同样原样保留 —— 不然就是把一段没哈希的明文悄悄发出去了', () => {
  assert.equal(interpolate("{{'x'|nope}}", {}), "{{'x'|nope}}");
  assert.equal(interpolate('{{pass|md5}}', VARS), '{{pass|md5}}', 'md5 还没实现，别假装能算');
});

test('没解析出来的占位符会被标出来（界面上标红用）', () => {
  const parts = splitUnresolved(interpolate('a{{missing|sha256}}b', {}));
  assert.deepEqual(
    parts.filter((p) => p.miss).map((p) => p.text),
    ['{{missing|sha256}}']
  );
});

// ---------------------------------------------------------------------------
// 五、漏配检查 / 数据依赖：只算变量，纯明文不算
// ---------------------------------------------------------------------------

test('collectVarNames：纯明文不算引用，带过滤器的变量算', () => {
  assert.deepEqual(collectVarNames("{{'Vss_2024'|sha256}}"), []);
  assert.deepEqual(collectVarNames("{{'Vss_2024'}}"), []);
  assert.deepEqual(collectVarNames('{{pass|sha256}}'), ['pass']);
  assert.deepEqual(collectVarNames('{{a}} {{b|sha256}}'), ['a', 'b']);
});

test('拿整串去当变量名是错的 —— 那样漏配检查必然找不到，会把好好的请求拦下来', () => {
  // 这是这次改动最容易踩的坑：捕获组给的是整个表达式，不是变量名
  const names = collectVarNames("{{'Vss_2024'|sha256}}");
  assert.equal(names.includes("'Vss_2024'|sha256"), false);
  assert.deepEqual(names, []);
});

test('数据依赖：{{列名|sha256}} 依然算「这一步用了这列数据」', () => {
  const step = { request: { body: '{"s": "{{camId|sha256}}"}' } };
  assert.equal(usesData(step, ['camId']), true, '不认的话这一步会只跑一次，而不是按行跑');
  assert.equal(usesData(step, ['other']), false);
});

// ---------------------------------------------------------------------------
// 六、高亮判据必须和替换一致
// ---------------------------------------------------------------------------

test('标绿的判据 == 真能替换掉（两边一旦走偏，就会出现「看着是绿的、发出去却是占位符」）', () => {
  const cases = [
    ["'Vss_2024'|sha256", {}],
    ['pass|sha256', VARS],
    ['pass', VARS],
    ['missing|sha256', VARS],
    ['missing', VARS],
    ["'x'|nope", {}],
    ['pass|nope', VARS],
    ['$timestamp', {}],
    ['$timestamp|sha256', {}],
    ['baseUrl', VARS],
  ];

  for (const [expr, vars] of cases) {
    const raw = `{{${expr}}}`;
    const replaced = interpolate(raw, vars) !== raw;
    assert.equal(
      canResolveVar(expr, vars),
      replaced,
      `「${expr}」高亮说能算=${canResolveVar(expr, vars)}，实际替换掉了=${replaced}`
    );
  }
});

test('内置变量和明文都算「能算出来」，不该标红', () => {
  // 老实现拿 hasOwnProperty(vars, name) 直接判，这两类都会误标红
  assert.equal(canResolveVar('$timestamp', {}), true);
  assert.equal(canResolveVar('$timestampMs', {}), true);
  assert.equal(canResolveVar("'x'|sha256", {}), true);
});

test('空串值的变量算「取不到」—— 和漏配检查一个口径', () => {
  assert.equal(canResolveVar('empty', { empty: '' }), false);
  assert.equal(canResolveVar('blank', { blank: null }), false);
});

// ---------------------------------------------------------------------------
// 七、过滤器和实现是同一份
// ---------------------------------------------------------------------------

test('VAR_FILTERS 里的 sha256 就是那个实现，别的地方不会再抄一份', () => {
  assert.equal(VAR_FILTERS.sha256, sha256Hex);
  assert.equal(VAR_FILTERS.sha256('abc'), H('abc'));
});

test('加了过滤器也不会把值算错 —— 钉死一个固定输入', () => {
  assert.equal(
    interpolate("{{'Vss_2024'|sha256}}", {}),
    'a979a4da3407f514857a614db44cabc0119a1cff2a2604731664ce4e89280f9f'
  );
});

// ---------------------------------------------------------------------------
// 八、内置变量 + 过滤器（时钟钉死，否则没法断言）
// ---------------------------------------------------------------------------

const FIXED = new Date(2026, 9, 10, 7, 37, 0).getTime();
const realNow = Date.now;

beforeEach(() => {
  Date.now = () => FIXED;
});
after(() => {
  Date.now = realNow;
});

test('{{$datetime-8h|sha256}} 哈希的是算出来的那个时间', () => {
  assert.equal(interpolate('{{$datetime-8h|sha256}}', {}), H('2026-10-09 23:37:00'));
});
