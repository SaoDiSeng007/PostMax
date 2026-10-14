// ---------------------------------------------------------------------------
// 运行页那几个数字（runStats）。
//
// 盯的是「出错了也不响、只是数字悄悄不对」的那几条：
//   · 进度：分母必须是**预期总步数**。拿「跑完的 ÷ 跑完的」算，永远 100% ——
//     跑了一半的界面显示「100%」，人会以为快好了
//   · 平均耗时：超时/连不上的步骤 time 是 0，算进去把平均拉低，看着像接口很快
//   · 全局步骤（开头 / 收尾）也得算进通过失败数 —— 只数数据行，登录挂了会整段漏掉，
//     而它恰恰是最要紧的一种失败
//
// 跑：npm test（等价于 node --test tests/）
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFailureSummary, outcomePending, outcomeTextOf, runStats, stepCounts, stepOutcomes,
} from '../frontend/js/planExport.js';

const step = (o = {}) => ({
  status: 'ok', time: 100, httpStatus: 200, assertions: [], ...o,
});

const row = (no, status, steps) => ({ no, label: `第 ${no} 行`, status, steps });

test('进度：分母是预期总步数，不是「跑完的步骤数」', () => {
  const run = {
    at: 1000,
    finishedAt: 3000,
    status: 'running',
    totals: { rows: 5, steps: 17 },
    setup: { status: 'ok', steps: [step()] },
    rows: [
      row(1, 'ok', [step(), step(), step()]),
      row(2, 'pending', []),
      row(3, 'pending', []),
    ],
    teardown: undefined,
  };

  const s = runStats(run, 9000);
  assert.equal(s.stepsDone, 4);
  assert.equal(s.stepsTotal, 17);
  assert.equal(s.percent, 4 / 17);
  // 跑完了就别按现在算用时
  assert.equal(s.elapsed, 2000);
});

// ---------------------------------------------------------------------------
// stepCounts：按**次数**数的账
//
// 报告页头部和运行页都按次数报，导出的 JSON / 失败摘要以前按「段」报 ——
// 同一轮，屏幕上写「通过 1 · 失败 1 · 未执行 2」，文件里却是「通过 0 · 失败 1」。
// ---------------------------------------------------------------------------

test('stepCounts：一步在一行上算一格', () => {
  const run = {
    totals: { rows: 2, steps: 4 },
    rows: [
      row(1, 'failed', [step(), step({ status: 'failed' })]),
      row(2, 'pending', [step({ status: 'missing' }), step({ status: 'missing' })]),
    ],
  };
  assert.deepEqual(stepCounts(run), {
    total: 4, ok: 1, failed: 1, missing: 2, stopped: 0, running: 0, pending: 0,
  });
});

test('stepCounts：还没轮到的算「未运行」；老记录没有 totals 也不虚报', () => {
  const running = { totals: { rows: 5, steps: 10 }, rows: [row(1, 'running', [step()])] };
  const c = stepCounts(running);
  assert.equal(c.total, 10);
  assert.equal(c.ok, 1);
  assert.equal(c.pending, 9);

  // 老存档里没有 totals：退回「有几个算几个」，不能比眼前看到的还少
  assert.equal(stepCounts({ rows: [row(1, 'ok', [step()])] }).total, 1);
});

test('失败摘要：口径按次数，「未执行」和「未运行」各说各的', () => {
  const run = {
    at: Date.now() - 1000,
    finishedAt: Date.now(),
    status: 'failed',
    totals: { rows: 2, steps: 4 },
    rows: [
      row(1, 'failed', [step(), step({ status: 'failed', error: 'HTTP 500' })]),
      row(2, 'pending', [step({ status: 'missing' }), step({ status: 'missing' })]),
    ],
  };
  const text = buildFailureSummary(run, '方案甲');
  assert.match(text, /已完成 4 \/ 4 次请求/);
  assert.match(text, /通过 1 · 失败 1 · 未执行 2/);

  // 还没跑到的那部分要写「未运行」，不能混进「未执行」
  const half = {
    at: Date.now() - 1000,
    finishedAt: 0,
    status: 'running',
    totals: { rows: 5, steps: 6 },
    rows: [row(1, 'ok', [step()])],
  };
  const halfText = buildFailureSummary(half, '方案乙');
  assert.match(halfText, /未运行 5/);
  assert.doesNotMatch(halfText, /未执行/);
});

test('进度：没有 totals 的老记录退化成「有多少算多少」，不显示成 0%', () => {
  const run = {
    at: 0,
    finishedAt: 1000,
    status: 'done',
    setup: { status: 'ok', steps: [step(), step()] },
    rows: [],
  };
  const s = runStats(run, 9999);
  assert.equal(s.stepsTotal, 2);
  assert.equal(s.percent, 1);
});

test('还没开始跑：0%，不除以 0', () => {
  const s = runStats({ at: 500, finishedAt: 0, status: 'running', rows: [] }, 1500);
  assert.equal(s.percent, 0);
  assert.equal(s.elapsed, 1000);
});

test('平均耗时不算那些 time 为 0 的步骤（超时 / 连不上）', () => {
  const run = {
    at: 0,
    finishedAt: 10,
    status: 'failed',
    rows: [
      row(1, 'ok', [step({ time: 200 }), step({ time: 300 }), step({ time: 0, status: 'failed' })]),
    ],
  };
  const s = runStats(run, 0);
  assert.equal(s.requestTime, 500);
  assert.equal(s.avgTime, 250);
  assert.equal(s.requestCount, 3);
});

test('全局步骤（开头 / 收尾）算进通过失败与断言，别只数数据行', () => {
  const run = {
    at: 0,
    finishedAt: 10,
    status: 'failed',
    setup: {
      status: 'failed',
      steps: [step({ status: 'failed', assertions: [{ ok: false }, { ok: true }] })],
    },
    rows: [row(1, 'pending', [])],
    teardown: { status: 'ok', steps: [step({ assertions: [{ ok: true }] })] },
  };
  const s = runStats(run, 0);
  assert.equal(s.failedSteps, 1);
  assert.equal(s.okSteps, 1);
  assert.equal(s.assertionsRun, 3);
  assert.equal(s.assertionsFailed, 1);
});

test('循环数看数据行：跑过的 / 失败的各多少', () => {
  const run = {
    at: 0,
    finishedAt: 10,
    status: 'failed',
    rows: [
      row(1, 'ok', [step()]),
      row(2, 'failed', [step({ status: 'failed' })]),
      row(3, 'pending', []),
    ],
  };
  const s = runStats(run, 0);
  assert.equal(s.loopsTotal, 3);
  assert.equal(s.loopsDone, 2);
  assert.equal(s.loopsFailed, 1);
});

test('被叫停的步骤单独算，不混进失败', () => {
  const run = {
    at: 0,
    finishedAt: 10,
    status: 'stopped',
    rows: [row(1, 'stopped', [step({ status: 'stopped' }), step({ status: 'ok' })])],
  };
  const s = runStats(run, 0);
  assert.equal(s.stoppedSteps, 1);
  assert.equal(s.failedSteps, 0);
  assert.equal(s.okSteps, 1);
  assert.equal(s.stepsDone, 2);
});

// ---------------------------------------------------------------- 步骤行那句话

const stepRec = (stepId, status, error) => ({ stepId, status, error });

test('步骤行：还在跑的不算「未通过」，也就不标红', () => {
  const run = {
    rows: [
      { no: 1, steps: [stepRec('s1', 'ok'), stepRec('s2', 'ok')] },
      { no: 2, steps: [stepRec('s1', 'ok'), stepRec('s2', 'running')] },
      // 第 3 行还没轮到，s2 连记录都没有 —— 分母也得算上它
      { no: 3, steps: [stepRec('s1', 'ok')] },
    ],
  };

  const map = stepOutcomes(run);
  const s1 = map.get('s1');
  const s2 = map.get('s2');

  assert.equal(s1.bad, false);
  assert.equal(outcomeTextOf(s1, true), '3 次全过');

  assert.equal(s2.expected, 3);
  assert.equal(s2.ok, 1);
  assert.equal(s2.running, 1);
  assert.equal(s2.bad, false, '正在跑的不能算失败');
  assert.equal(outcomeTextOf(s2, true), '1/3 进行中');
});

test('步骤行：真有失败才算「x/N 通过」，并带上原因', () => {
  const run = {
    rows: [
      { no: 1, steps: [stepRec('s', 'ok')] },
      { no: 2, steps: [stepRec('s', 'failed', 'HTTP 500')] },
      { no: 3, steps: [stepRec('s', 'failed', 'HTTP 500')] },
    ],
  };
  const o = stepOutcomes(run).get('s');
  assert.equal(o.bad, true);
  assert.equal(o.error, 'HTTP 500');
  assert.equal(outcomeTextOf(o, false), '1/3 通过');
});

test('步骤行：被叫停的算失败那一档（它确实没跑成）', () => {
  const run = { rows: [{ no: 1, steps: [stepRec('s', 'stopped')] }] };
  assert.equal(stepOutcomes(run).get('s').bad, true);
});

test('步骤行：开头 / 收尾那样的全局步骤，分母是 1', () => {
  const run = {
    setup: { steps: [stepRec('pre', 'ok')] },
    rows: [{ no: 1, steps: [] }, { no: 2, steps: [] }],
    teardown: { steps: [stepRec('post', 'ok')] },
  };
  const map = stepOutcomes(run);
  assert.equal(map.get('pre').expected, 1);
  assert.equal(outcomeTextOf(map.get('pre'), false), '1 次全过');
  assert.equal(outcomeTextOf(map.get('post'), false), '1 次全过');
});

test('步骤行：跑完了但有几行没轮到，如实说通过几条（不说「全过」）', () => {
  const run = { rows: [{ no: 1, steps: [stepRec('s', 'ok')] }, { no: 2, steps: [] }] };
  const o = stepOutcomes(run).get('s');
  assert.equal(o.bad, false);
  assert.equal(outcomeTextOf(o, false), '1/2 通过');
});

test('步骤行：5 遍才跑到第 2 遍就挂了 1 条，不能这会儿就报「通过」', () => {
  const run = {
    rows: [
      { no: 1, steps: [stepRec('s', 'failed', 'HTTP 500')] },
      { no: 2, steps: [stepRec('s', 'running')] },
      { no: 3, steps: [] },
      { no: 4, steps: [] },
      { no: 5, steps: [] },
    ],
  };
  const o = stepOutcomes(run).get('s');
  assert.equal(o.bad, true, '确实挂了一条 —— 展开明细时得看得到');
  assert.equal(o.running, 1);

  // 整轮还在跑：只报进度，不下结论
  assert.equal(outcomePending(o, true), true);
  assert.equal(outcomeTextOf(o, true), '0/5 进行中');

  // 5 遍跑完了，这才如实说结果（4 过 1 挂）
  const done = stepOutcomes({
    rows: [
      { no: 1, steps: [stepRec('s', 'failed', 'HTTP 500')] },
      { no: 2, steps: [stepRec('s', 'ok')] },
      { no: 3, steps: [stepRec('s', 'ok')] },
      { no: 4, steps: [stepRec('s', 'ok')] },
      { no: 5, steps: [stepRec('s', 'ok')] },
    ],
  }).get('s');
  assert.equal(outcomePending(done, false), false);
  assert.equal(outcomeTextOf(done, false), '4/5 通过');
});

test('步骤行：没有运行 / 没有这一步时不显示', () => {
  assert.equal(outcomeTextOf(undefined, false), '');
  assert.equal(stepOutcomes(null).size, 0);
});
