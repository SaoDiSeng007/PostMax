// ---------------------------------------------------------------------------
// 自动化那几条「出错了也不报错、只是结果悄悄不对」的规则
//
// 这些用例就是照着踩过的坑写的：
//   · 变量名对不上中文列名 → 引用它的步骤被当成「不依赖数据」只跑一次
//   · 「哪些步骤整轮只跑一次」分错 → 某个接口被多调几十遍 / 该按行跑的只跑一次
//   · 报告只数数据行 → 全局步骤失败时显示「失败 0」
//
// 跑：npm test（等价于 node --test tests/）
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { usesData, requestVarNames, requestVarTexts, stepVerdict } from '../frontend/js/planSteps.js';
import { interpolate, interpolateJson, collectVarNames } from '../frontend/js/api.js';
import { parseCsv, parseTsv } from '../frontend/js/csv.js';
import { parseCurl, toCurl } from '../frontend/js/curl.js';
import {
  runCounts, buildRunCsv, buildFailureSummary, summarizeSteps, allRunRows,
  runStats, buildRunJson, stepOutcomes, stepGroups,
} from '../frontend/js/planExport.js';

/** 造一个步骤。request 里给啥就是啥 */
const step = (name, request) => ({ id: name, enabled: true, request: { name, method: 'GET', ...request } });

// ---------------------------------------------------------------------------
// 变量名：必须认得中文列名
// ---------------------------------------------------------------------------
test('变量名支持中文（CSV 表头是中文是常态）', () => {
  const vars = { 摄像头名称: 'A1', camIp: 'Y1' };
  assert.equal(interpolate('{{摄像头名称}}/{{camIp}}', vars), 'A1/Y1');
  assert.equal(interpolate('{{ 摄像头名称 }}', vars), 'A1');
  assert.equal(interpolateJson('{"n":"{{摄像头名称}}"}', vars), '{"n":"A1"}');
  assert.deepEqual(collectVarNames('{{摄像头名称}} {{camIp}}'), ['摄像头名称', 'camIp']);
});

test('变量名仍支持点、连字符、$', () => {
  const vars = { 'a.b': '1', 'a-b': '2', $ts: '3' };
  assert.equal(interpolate('{{a.b}}|{{a-b}}|{{$ts}}', vars), '1|2|3');
});

// ---------------------------------------------------------------------------
// 「哪些字段算用到了变量」
// ---------------------------------------------------------------------------
test('路径参数、bodyForm、脚本里引用的变量都算数', () => {
  const r = {
    url: '/x/{id}',
    pathParams: [{ key: 'id', value: '{{camId}}' }],
    bodyForm: [{ key: 'a', value: '{{formVar}}' }],
    script: "env.set('x', '{{scriptVar}}')",
  };
  assert.deepEqual(requestVarNames(r), ['camId', 'formVar', 'scriptVar']);
});

test('enabledOnly 时停用的 params / headers 不算', () => {
  const r = {
    params: [{ key: 'a', value: '{{on}}', enabled: true }, { key: 'b', value: '{{off}}', enabled: false }],
    headers: [{ key: 'c', value: '{{off2}}', enabled: false }],
  };
  assert.deepEqual(requestVarNames(r, { enabledOnly: true }), ['on']);
  assert.deepEqual(requestVarNames(r).sort(), ['off', 'off2', 'on']);
});

// ---------------------------------------------------------------------------
// 数据依赖 + 步骤分段（这套自动化最核心的一条规则）
// ---------------------------------------------------------------------------
test('引用数据列的步骤算「依赖数据」', () => {
  const cols = ['guid', 'name'];
  assert.equal(usesData(step('a', { url: '/x?g={{guid}}' }), cols), true);
  assert.equal(usesData(step('b', { body: '{"n":"{{name}}"}' }), cols), true);
  assert.equal(usesData(step('c', { url: '/x' }), cols), false);
});

test('中文列名同样算依赖数据（曾经的坑）', () => {
  const cols = ['摄像头名称'];
  assert.equal(usesData(step('a', { url: '/x?n={{摄像头名称}}' }), cols), true);
});

test('空步骤 / undefined 不炸', () => {
  assert.equal(usesData(undefined, ['guid']), false);
});

// ---------------------------------------------------------------------------
// 一步算不算通过（曾经的坑：只按断言判，500 会被标成通过）
// ---------------------------------------------------------------------------
test('HTTP ≥ 400 也算失败，不只看断言', () => {
  assert.deepEqual(stepVerdict({ status: 200 }, []), { ok: true, error: '' });
  assert.deepEqual(stepVerdict({ status: 200 }, [{ ok: true }]), { ok: true, error: '' });
  assert.deepEqual(stepVerdict({ status: 500 }, []), { ok: false, error: 'HTTP 500' });
  assert.deepEqual(stepVerdict({ status: 404 }, []), { ok: false, error: 'HTTP 404' });
  assert.deepEqual(stepVerdict({ status: 200 }, [{ ok: false }]), { ok: false, error: '断言未通过' });
  // 两个都不满足时先报状态码 —— 那更接近根因
  assert.deepEqual(stepVerdict({ status: 502 }, [{ ok: false }]), { ok: false, error: 'HTTP 502' });
});

// ---------------------------------------------------------------------------
// 报告：全局步骤要算进去，否则数字自相矛盾
// ---------------------------------------------------------------------------
const runStep = (id, status, extra = {}) => ({
  stepId: id, no: 1, name: '接口' + id, method: 'GET', url: 'http://x',
  status, httpStatus: 200, time: 10, attempts: 1, assertions: [], extracted: [], error: '', ...extra,
});
const runRow = (no, status, steps) => ({ no, label: 'L' + no, status, steps });

test('计数把「全局步骤」也算一段', () => {
  const run = {
    at: 1, finishedAt: 2, status: 'failed',
    setup: { status: 'failed', steps: [runStep('g', 'failed')] },
    rows: [runRow(1, 'pending', []), runRow(2, 'pending', [])],
  };
  assert.deepEqual(runCounts(run), { total: 3, ok: 0, failed: 1, missing: 0, pending: 2, stopped: 0 });
});

test('只有全局步骤的方案不会显示成 0 / 0', () => {
  const run = { at: 1, finishedAt: 2, status: 'done', setup: { status: 'ok', steps: [runStep('g', 'ok')] }, rows: [] };
  assert.deepEqual(runCounts(run), { total: 1, ok: 1, failed: 0, missing: 0, pending: 0, stopped: 0 });
  assert.match(buildFailureSummary(run, '方案'), /已完成 1 \/ 1/);
});

test('CSV 里开头 / 收尾各占一段，数据行各占几行', () => {
  const run = {
    at: 1, finishedAt: 2, status: 'ok',
    setup: { status: 'ok', steps: [runStep('g', 'ok')] },
    rows: [runRow(1, 'ok', [runStep('s1', 'ok'), runStep('s2', 'ok')])],
    teardown: { status: 'ok', steps: [runStep('t', 'ok')] },
  };
  const lines = buildRunCsv(run).replace(/^\uFEFF/, '').trim().split('\r\n');
  assert.equal(lines.length, 1 + 1 + 2 + 1); // 表头 + 开头 1 步 + 数据行 2 步 + 收尾 1 步
  assert.ok(lines[1].startsWith('开头'));
  assert.ok(lines[2].startsWith('1,L1'));
  assert.ok(lines[4].startsWith('收尾'));
});

test('按步骤汇总包含开头与收尾两段', () => {
  const run = {
    setup: { status: 'ok', steps: [runStep('g', 'ok')] },
    rows: [runRow(1, 'ok', [runStep('s1', 'ok')])],
    teardown: { status: 'ok', steps: [runStep('t', 'ok')] },
  };
  assert.deepEqual(summarizeSteps(allRunRows(run)).map((s) => s.stepId), ['g', 's1', 't']);
});

test('收尾失败同样算进「失败」', () => {
  const run = {
    at: 1, finishedAt: 2, status: 'failed',
    setup: { status: 'ok', steps: [runStep('g', 'ok')] },
    rows: [runRow(1, 'ok', [runStep('s1', 'ok')])],
    teardown: { status: 'failed', steps: [runStep('t', 'failed')] },
  };
  assert.deepEqual(runCounts(run), { total: 3, ok: 2, failed: 1, missing: 0, pending: 0, stopped: 0 });
  assert.match(buildFailureSummary(run, '方案'), /收尾/);
});

// ---------------------------------------------------------------------------
// 报告按**步骤**摊开：一步一条，顺序就是执行顺序
// ---------------------------------------------------------------------------
test('按步骤摊开：一步一条、按执行顺序排，每步挂着它在各行的每一遍', () => {
  const at = (id, no, status, extra = {}) => ({ ...runStep(id, status), no, ...extra });
  const run = {
    shared: [at('准备', 1, 'ok'), undefined, undefined, undefined, at('收尾', 5, 'ok')],
    rows: [
      {
        no: 1, label: 'a=1', status: 'failed',
        steps: [
          undefined, at('取用户', 2, 'ok'),
          at('文章评论', 3, 'failed', { error: 'HTTP 404' }),
          undefined, undefined,
        ],
      },
      {
        no: 2, label: 'a=2', status: 'ok',
        steps: [undefined, at('取用户', 2, 'ok'), at('文章评论', 3, 'ok'), undefined, undefined],
      },
    ],
  };

  const groups = stepGroups(run);
  assert.deepEqual(groups.map((g) => g.no), [1, 2, 3, 5], '按步骤编号排，就是执行顺序');

  assert.equal(groups[1].runs.length, 2, '「取用户」在两行各跑一遍');
  assert.deepEqual(groups[1].runs.map((r) => r.where), ['第 1 行', '第 2 行']);
  assert.equal(groups[1].ok, 2);

  assert.equal(groups[2].ok, 1);
  assert.equal(groups[2].failed, 1, '「文章评论」挂了第 1 行那遍');
  assert.equal(groups[2].failure, 'HTTP 404');

  assert.equal(groups[0].runs[0].where, '整轮', '整轮一遍的那些，落点写「整轮」');
});

test('按步骤摊开：同一行里两步的落点各自独立，不串', () => {
  const at = (id, no, status, extra = {}) => ({ ...runStep(id, status), no, ...extra });
  const run = {
    rows: [
      { no: 3, steps: [at('a', 1, 'ok'), at('b', 2, 'failed', { error: 'HTTP 500' })] },
    ],
  };
  const groups = stepGroups(run);
  assert.deepEqual(groups.map((g) => g.name), ['接口a', '接口b']);
  assert.equal(groups[0].failure, '');
  assert.equal(groups[1].failure, 'HTTP 500');
});

// ---------------------------------------------------------------------------
// 「整轮跑一遍的步骤」不占数据行的格子 —— 行记录里会留空位
//
// 空位有两种形态：内存里是稀疏数组的空洞（forEach 自己会跳过，map / v-for 不会），
// 落盘再读回来是 null。两种都得挡住：报告页那一处漏了，整个页面直接白掉。
// ---------------------------------------------------------------------------
test('行里的空位不会让统计与导出崩', () => {
  const run = {
    at: 1, finishedAt: 2, status: 'failed',
    shared: [{ ...runStep('g', 'ok'), no: 0 }],
    rows: [
      // 下标 0 是「整轮一遍」那步留的空位，第 1 步才是这一行真跑过的
      { no: 1, label: 'L1', status: 'failed', steps: [undefined, runStep('s1', 'failed')] },
      // 落盘读回来的形态：null
      { no: 2, label: 'L2', status: 'ok', steps: [null, runStep('s2', 'ok')] },
    ],
  };

  assert.deepEqual(runCounts(run), { total: 3, ok: 2, failed: 1, missing: 0, pending: 0, stopped: 0 });
  assert.equal(runStats(run).stepsDone, 3, '统计里不该把空位算成一步');
  assert.deepEqual(summarizeSteps(allRunRows(run)).map((s) => s.stepId), ['g', 's1', 's2']);
  assert.deepEqual([...stepOutcomes(run).keys()].sort(), ['g', 's1', 's2']);

  // 导出里认的是接口名（runStep 造出来的叫「接口s1」），不是 stepId
  assert.ok(buildRunCsv(run).includes('接口s1'), 'CSV 要有那一行');
  assert.ok(buildFailureSummary(run, '方案').includes('接口s1'), '失败摘要要有那一步');
  assert.ok(buildRunJson(run, '方案').includes('接口s1'), 'JSON 也要有');
});

// ---------------------------------------------------------------------------
// CSV 解析（测试数据的入口，表头错了后面全错）
// ---------------------------------------------------------------------------
test('CSV：去 BOM、引号里的逗号与换行、短行补齐', () => {
  const { columns, rows } = parseCsv('\uFEFF摄像头名称,备注\ncam-1,"a,b"\ncam-2\n');
  assert.deepEqual(columns, ['摄像头名称', '备注']);
  assert.deepEqual(rows, [['cam-1', 'a,b'], ['cam-2', '']]);
});

test('CSV：空表头给占位列名，尾部空行丢掉', () => {
  const { columns, rows } = parseCsv('a,,c\n1,2,3\n,,\n');
  assert.deepEqual(columns, ['a', '列2', 'c']);
  assert.equal(rows.length, 1);
});

test('CSV：分号和 Tab 分隔也能读', () => {
  assert.deepEqual(parseCsv('a;b\n1;2\n').columns, ['a', 'b']);
  assert.deepEqual(parseCsv('a;b\n1;2\n').rows, [['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2\n').columns, ['a', 'b']);
});

test('粘贴：Excel 复制出来是 Tab 分列、换行分行，末尾的空行丢掉', () => {
  assert.deepEqual(parseTsv('a\tb\r\n1\t2\r\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseTsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  // 单个值：就是一个格子一格内容
  assert.deepEqual(parseTsv('只有一个'), [['只有一个']]);
});

test('粘贴：不做 CSV 那套转义 —— 贴进来什么样就是什么样', () => {
  // CSV 会把 "a,b" 当成一个值；剪贴板里带引号那就是引号本身
  assert.deepEqual(parseTsv('"a\tb"'), [['"a', 'b"']]);
});

test('粘贴：空内容给空数组，中间的空行要留着', () => {
  assert.deepEqual(parseTsv(''), []);
  assert.deepEqual(parseTsv(null), []);
  assert.deepEqual(parseTsv('a\n\nb'), [['a'], [''], ['b']]);
});

test('CSV：重名列自动加序号，并把原始名报出来', () => {
  const { columns, rows, duplicates } = parseCsv('a,b,a\n1,2,3\n');
  assert.deepEqual(columns, ['a', 'b', 'a_2']);
  assert.deepEqual(rows, [['1', '2', '3']]);
  assert.deepEqual(duplicates, ['a']);
});

// ---------------------------------------------------------------------------
// curl 往返（报告里「复制 curl」复现失败步骤靠它）
// ---------------------------------------------------------------------------
test('curl：导入再导出，方法 / 地址 / body 能还原', () => {
  const text = `curl -X POST 'https://httpbin.org/post' -H 'Content-Type: application/json' --data-raw '{"a":1}'`;
  const parsed = parseCurl(text);
  assert.equal(parsed.method, 'POST');
  assert.equal(parsed.url, 'https://httpbin.org/post');
  const back = parseCurl(toCurl(parsed));
  assert.equal(back.method, parsed.method);
  assert.equal(back.url, parsed.url);
  assert.equal(back.body, parsed.body);
});
