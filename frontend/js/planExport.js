// ---------------------------------------------------------------------------
// 把「一次运行」变成别处的文本
//
// 这里全是纯函数：不碰状态、不碰 DOM（下载那一步在 download.js）。
// 单独放一个文件，是因为报告组件本来就长，再塞进导出的拼装逻辑，
// 渲染和「怎么排一个 CSV」会混在一起，改哪边都得先读另一边的代码。
// ---------------------------------------------------------------------------
import { toCurl } from './curl.js';
import { formatValue } from './assert.js';

/*
 * 五种状态，别混：
 *   ok      —— 跑完了，没问题
 *   failed  —— 跑完了，结果不对
 *   missing —— 缺数据，**压根没发请求**（前一步没成 / 环境里没配 / 数据表那一格空着）
 *   running —— 正在跑（含重试中）
 *   pending —— 还没轮到
 *   stopped —— 被叫停了
 *
 * 「未执行」和「未运行」是两件事：前者是缺东西发不出去，后者是没轮到它。
 * 以前都叫「未执行」，报告上分不清「因为登录挂了没跑成」和「你点终止时还没轮到」。
 */
const STATUS_TEXT = {
  ok: '通过',
  failed: '失败',
  missing: '未执行',
  running: '跑到一半',
  stopped: '已停止',
  pending: '未运行',
  skipped: '已跳过',
};

export const stepStatusText = (status) => STATUS_TEXT[status] || status || '';

const pad = (n) => String(n).padStart(2, '0');

/** `2026-09-20 15:03:22` */
export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `09-20 15:03`。历次运行那份清单里用 —— 年份和秒都是噪音 */
export function formatShortTime(ts) {
  const full = formatTime(ts);
  return full ? full.slice(5, 16) : '';
}

/** 用时。跑完读 finishedAt，没跑完就按现在算 */
export function formatElapsed(run, now = Date.now()) {
  if (!run?.at) return '';
  const secs = Math.max(0, Math.round(((run.finishedAt || now) - run.at) / 1000));
  if (secs < 60) return `${secs} 秒`;
  const m = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
}

/**
 * 通过 / 失败 / 未执行 各多少**段**。报告头部和导出都用它，两处数字不会打架。
 *
 * 算的是「跑过的段落」，所以**把全局步骤也算一段**（它就是报告里的第一行）。
 * 只数数据行的话，会出现两种自相矛盾的显示：
 *   · 方案的步骤全不依赖数据时（没有数据行）→「已完成 0 / 0 · 通过 0 · 失败 0」，
 *     可下面明明挂着一行 ✓；
 *   · 全局步骤失败、后续数据行一次都没轮到 → 状态是「有失败」，「失败 0」。
 */
export function runCounts(run) {
  const rows = allRunRows(run);
  const by = (s) => rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    ok: by('ok'),
    failed: by('failed'),
    /** 缺数据没发的 —— 和 failed 分开数，报告上要能看出「失败 1 · 未执行 6」 */
    missing: by('missing'),
    pending: by('pending'),
    stopped: by('stopped'),
  };
}

/**
 * 同一轮，按**请求次数**数的账：一步在一行上算一格。
 *
 * 和 runCounts 是两把尺子，别混：那个数「段」（整轮段 + 每个数据行），这个数
 * 「次数」。运行页一直是按次数报的（「已完成 4 / 4 步」），报告页原来按段报 ——
 * 同一轮打开两个页面就是两个数打架（4 / 4 对 2 / 2）。
 *
 * 分母取运行开始前钉下的 `run.totals.steps`（= 这一轮预期要发的请求数），
 * 所以跑到一半也能看出还差多少；「只重跑失败的」那一轮，分母是挑中的格子数。
 * 老记录没有 totals，退回「有几个算几个」，至少不会比眼前多。
 */
export function stepCounts(run) {
  const cells = allRunRows(run).flatMap((row) => realSteps(row));
  const by = (s) => cells.filter((c) => c.status === s).length;
  const expected = Math.max(Number(run?.totals?.steps) || 0, cells.length);
  return {
    total: expected,
    ok: by('ok'),
    failed: by('failed'),
    missing: by('missing'),
    stopped: by('stopped'),
    running: by('running'),
    /** 还没轮到的：预期总数减去已经记下来的 */
    pending: Math.max(0, expected - cells.length),
  };
}

/**
 * 运行页上那几个数字：进度、循环、请求耗时、断言。
 *
 * 和 runCounts 是两套口径，别混：那边数的是「跑过的段落各多少」（报告页头部用），
 * 这边是**步骤**维度的完成度 —— 进度环要的就是它。
 *
 * 分母不能用「跑完的步骤数」：没轮到的数据行 steps 还是空的，一比永远是 100%。
 * 所以用 run.totals（开跑时按 once + 行×行内步 + after 钉好的预期总数，见 runPlan）；
 * 老的落盘记录没有 totals，退化成「有多少算多少」，进度显示成跑完。
 *
 * 全按步骤记录现算、不缓存 —— 运行中每 500ms 会重调一次，数字得跟着长。
 *
 * @param {Object} run 一次运行（可以还在跑）
 * @param {number} now 计算「用时」用的当下时刻（跑完就读 finishedAt）
 */
export function runStats(run, now = Date.now()) {
  const steps = allRunRows(run).flatMap((p) => realSteps(p));

  const stepsDone = steps.length;
  const stepsTotal = Math.max(Number(run?.totals?.steps) || 0, stepsDone);

  const assertions = steps.flatMap((s) => s.assertions || []);
  // 只算真拿回响应的那些：超时/连不上的步骤 time 是 0，算进去会把平均拉低
  const times = steps.map((s) => s.time).filter((t) => t > 0);
  const requestTime = times.reduce((a, b) => a + b, 0);

  const rows = run?.rows || [];

  return {
    stepsDone,
    stepsTotal,
    /** 0..1。步骤维度：跑完了多少 */
    percent: stepsTotal ? stepsDone / stepsTotal : (run?.status === 'done' ? 1 : 0),
    okSteps: steps.filter((s) => s.status === 'ok').length,
    failedSteps: steps.filter((s) => s.status === 'failed').length,
    missingSteps: steps.filter((s) => s.status === 'missing').length,
    stoppedSteps: steps.filter((s) => s.status === 'stopped').length,

    /** 循环 = 数据行。没数据行时是 0（那就不显示这一项） */
    loopsTotal: rows.length,
    loopsDone: rows.filter((r) => r.status !== 'pending').length,
    loopsFailed: rows.filter((r) => r.status === 'failed').length,

    requestCount: stepsDone,
    requestTime,
    avgTime: times.length ? Math.round(requestTime / times.length) : 0,

    assertionsRun: assertions.length,
    assertionsFailed: assertions.filter((a) => !a.ok).length,

    elapsed: Math.max(0, (run?.finishedAt || now) - (run?.at || 0)),
  };
}

/**
 * 这一步为什么失败，压成一行。
 *
 * 断言没过时给「哪条断言 + 实际是什么」—— 光写「断言未通过」等于没说，
 * 而这一行正是要拿去贴给别人看的。
 */
export function stepFailureText(step) {
  // 先分清「谁弄停的」：叫停是我们自己按的，不是接口挂了。
  // 混成一句「失败」，事后翻报告的人会去查一个根本不存在的接口问题
  if (step.status === 'stopped') return '已叫停';
  if (step.status === 'pending') return '未运行';
  // 「未执行」不是接口挂了，但必须说清缺的是什么 —— error 里已经写好了
  if (step.status === 'missing') return step.error || '未执行';

  const bad = (step.assertions || []).find((a) => !a.ok);
  if (bad) return `${bad.label}（实际 ${formatValue(bad.actual)}）`;
  return step.error || '失败';
}

/**
 * 失败步骤一键复现。
 *
 * 用的是**实际发出的**那份请求（`response.request`，变量已经换成真值），
 * 不是方案里写的原始定义 —— 否则换个环境就复现不出来。
 * 响应体在落盘时被剥掉了，但 request 留着，所以刷新之后这个按钮照样能用。
 */
export function stepCurl(step) {
  const sent = step.response?.request;
  if (!sent) return '';
  return toCurl({
    method: sent.method,
    url: sent.url,
    headers: sent.headers || [],
    body: sent.body || '',
  });
}

/**
 * 把同一个步骤在**所有数据行**里的结果合起来。
 *
 * 报告本来是「按行」的：挂了 20 行，就得在 20 行里各看一遍才敢下结论。
 * 这张表回答的是另一个问题：**第 3 步在 200 行里挂了 47 次，还是只有那一行
 * 挂了**。接口不稳和数据不对是两种毛病，处置完全不同。
 *
 * 顺序取第一次出现的位置（也就是方案里步骤的顺序）—— 汇总表跟着流程走，
 * 比按失败次数排更好认。
 */
export function summarizeSteps(rows) {
  const map = new Map();

  (rows || []).forEach((row) => {
    realSteps(row).forEach((s) => {
      const cur = map.get(s.stepId) || {
        stepId: s.stepId,
        no: s.no,
        name: s.name,
        method: s.method,
        ran: 0, ok: 0, failed: 0, stopped: 0,
        times: [],
        reason: '',
      };
      cur.ran += 1;
      if (s.status === 'ok') cur.ok += 1;
      else if (s.status === 'failed') {
        cur.failed += 1;
        // 只留第一条原因：同一步挂 47 次，原因基本是同一个，列 47 条没人看
        if (!cur.reason) cur.reason = stepFailureText(s);
      } else if (s.status === 'stopped') cur.stopped += 1;
      if (s.time) cur.times.push(s.time);
      map.set(s.stepId, cur);
    });
  });

  return [...map.values()].map((s) => ({
    ...s,
    avg: s.times.length ? Math.round(s.times.reduce((a, b) => a + b, 0) / s.times.length) : 0,
    max: s.times.length ? Math.max(...s.times) : 0,
  }));
}

/**
 * 每一步在**各个数据行**里的结果，按 stepId 汇总。
 *
 * 步骤行右边那句「N 次全过 / x/N 通过」就是它算的。三件事必须在一次遍历里分清楚，
 * 因为它们长得像但含义完全不同：
 *
 *   · 跑完了、没问题      → ok
 *   · 跑完了、有问题      → bad（failed / stopped）
 *   · **还在跑**（含重试中）→ running
 *
 * 早先只分「ok / 不是 ok」，于是运行中那几行正在跑的步骤被算成「未通过」并标红 ——
 * 第 4 步跑到一半就显示「3/5 通过」，看着像挂了 2 条，其实那 2 条还没回来，
 * 而报告页那边（按段统计）此刻失败数是 0。两处数字各说各话，人只能怀疑哪边坏了。
 *
 * `expected` 是这个步骤这一轮**该跑几次**（数据行数；开头 / 收尾段是 1）——
 * 有了它，分母才不会用「已经记录了几条」，运行中才敢说「5 次里跑完 3 次」。
 *
 * @returns {Map<string, {expected:number,total:number,ok:number,running:number,bad:boolean,error:string}>}
 */
export function stepOutcomes(run) {
  const map = new Map();
  if (!run) return map;

  const rowTotal = (run.rows || []).length || 1;
  const take = (part, expected) => {
    realSteps(part).forEach((s) => {
      const cur = map.get(s.stepId) ||
        { expected: 0, total: 0, ok: 0, running: 0, bad: false, error: '' };
      cur.expected = Math.max(cur.expected, expected);
      cur.total += 1;
      if (s.status === 'ok') cur.ok += 1;
      else if (s.status === 'running') cur.running += 1;
      else {
        cur.bad = true;
        // 只留第一条：同一步挂 5 次，原因基本是同一个
        if (!cur.error && s.error) cur.error = s.error;
      }
      map.set(s.stepId, cur);
    });
  };

  // 整轮跑一遍的那些：不属于任何数据行，期望就是 1 次
  take({ steps: run?.shared }, 1);
  take(run.setup, 1);
  (run.rows || []).forEach((row) => take(row, rowTotal));
  take(run.teardown, 1);
  return map;
}

/**
 * 这一步**还没跑满** —— 这会儿不该给它下结论。
 *
 * 勾了 5 行数据，第 1 行挂了就写「0/5 通过」、标成红的，看着像这个接口已经废了；
 * 可后面 4 行就在眼下的几秒里（按接口推进，它们紧挨着同一批）。跑满了再说得失。
 *
 * 两种「还没满」：当前的这一遍正在跑（等重试也算），或者整轮还在跑而遍数没走到头。
 *
 * @param {Object} o stepOutcomes 里那一格
 * @param {boolean} running 这一轮是不是还在跑（整轮已经结束了还差几条，那是没轮到，不是进行中）
 */
export function outcomePending(o, running = false) {
  if (!o) return false;
  const n = Math.max(o.expected || 0, o.total);
  return !!o.running || (running && o.total < n);
}

/**
 * 步骤行右边那句话。三态分开写，别让「还在跑」冒充「没通过」。
 *
 * @param {Object} o stepOutcomes 里那一格
 * @param {boolean} running 这一轮是不是还在跑
 */
export function outcomeTextOf(o, running = false) {
  if (!o) return '';
  const n = Math.max(o.expected || 0, o.total);
  // 「还在跑」排在「有失败」前面：没跑满就先别报得失
  if (outcomePending(o, running)) return `${o.ok}/${n} 进行中`;
  if (o.bad) return `${o.ok}/${n} 通过`;
  // 跑完了仍有行没轮到（失败停下 / 被叫停）：如实说通过了几条，但不算「全过」也不标红
  if (o.total < n) return `${o.ok}/${n} 通过`;
  return `${n} 次全过`;
}

/** 文件名里不能有的字符换掉，太长截断 —— 方案名是用户随便起的 */
export function reportFileName(planName, at, ext) {
  const safe = String(planName || '方案')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 40);
  const d = new Date(at || Date.now());
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `报告-${safe}-${stamp}.${ext}`;
}

/**
 * 一段里**真的跑过**的那些步骤记录。
 *
 * 行里的数组是按下标留位的：整轮跑一遍的步骤不占数据行的格子，那几格就是空的。
 * 内存里是稀疏数组的空洞（`forEach` 自己会跳，`map` / `v-for` 不会），落盘再读回来
 * 是 `null`。所以凡是要遍历它们的地方都先过这里 —— 不然就是一个 TypeError，
 * 界面表现是「报告页整块白掉」。
 */
export const realSteps = (part) => (part?.steps || []).filter(Boolean);

/**
 * 某一步的脚本日志，摊平成控制台那种条目（报告里就地显示用）。
 *
 * 顺序按实际执行：先前置、后置置后。这些日志只活在会话里 —— `scripts` 不在
 * STEP_KEEP 里，落盘时不带，刷新后历史记录上就没有了（控制台本来也是会话级的）。
 */
export function stepScriptLogs(step) {
  const out = [];
  ['pre', 'post'].forEach((phase) => {
    const run = step?.scripts?.[phase];
    if (!run) return;
    (run.logs || []).forEach((entry, i) => {
      out.push({ id: `${phase}-${i}`, phase, level: entry.level || 'log', args: entry.args || [] });
    });
  });
  return out;
}

/** 一段步骤的整体状态。整轮一遍的那段没有自己的 status，按里面的步骤现算 */
export function sectionStatus(steps) {
  const list = (steps || []).filter(Boolean);
  if (list.some((s) => s.status === 'failed')) return 'failed';
  if (list.some((s) => s.status === 'missing')) return 'missing';
  if (list.some((s) => s.status === 'stopped')) return 'stopped';
  return list.length && list.every((s) => s.status === 'ok') ? 'ok' : 'running';
}

/**
 * 一次运行里所有「跑过的段落」：整轮跑一遍的步骤 · 每个数据行。
 *
 * 导出和失败摘要都走这个 —— 登录这类整轮一遍的步骤挂了是最要紧的失败，
 * 只按数据行列的话，它会整个漏掉，报告上只剩一片「缺 token」。
 */
export function allRunRows(run) {
  const out = [];

  /*
   * 整轮只跑一遍的那些（登录、探活、清理）：不属于任何数据行，单占一段。
   *
   * 执行上它们按步骤的顺序原位穿插（轮到它就跑一遍，然后接着往下），但报告里
   * 归成一段更好读 —— 它们跟哪一行都没关系，摊在行里反而每行都得看一眼。
   */
  const shared = (run?.shared || []).filter(Boolean);
  if (shared.length) {
    out.push({
      no: '整轮',
      label: '整轮跑一遍（不依赖测试数据）',
      status: sectionStatus(shared),
      steps: shared,
      // 这一段不是某个数据行，是「整轮跑一遍」的那些步骤（运行页分组时按它区分）
      once: true,
    });
  }

  // 老记录（三段机制那会儿）的开头 / 收尾段照样认，不然刷新之后旧报告读不出来
  if (run?.setup) {
    out.push({ no: '开头', label: '开头跑一次（不依赖测试数据）', status: run.setup.status, steps: run.setup.steps, once: true });
  }
  (run?.rows || []).forEach((row) => out.push(row));
  if (run?.teardown) {
    out.push({ no: '收尾', label: '收尾跑一次（所有数据行之后）', status: run.teardown.status, steps: run.teardown.steps, once: true });
  }
  return out;
}

/**
 * 按步骤把一次运行摊开：一步一条，底下挂着它在各行上的结果。
 *
 * 排的就是**执行顺序** —— 一个步骤把它的每一遍跑完才轮到下一个。报告按数据行分组
 * 的话，同一个步骤会散在 5 个地方（第 1 行的第 3 步、第 2 行的第 3 步…），想看清
 * 「哪一步总挂」得来回翻；而按步骤排，一眼就是那条流程本身。
 *
 * @returns {Array} 每项：
 *   { key, stepId, no, name, method, runs:[{where, step}],
 *     ok, failed, missing, stopped, running, failure }
 *   where 是落点（「第 2 行」这种），让人知道是这一遍挂的
 */
export function stepGroups(run) {
  const out = [];
  const seen = new Map();

  const take = (part, where) => {
    realSteps(part).forEach((s) => {
      const key = s.stepId || `${s.no}-${s.name}`;
      let g = seen.get(key);
      if (!g) {
        g = {
          key, stepId: s.stepId, no: s.no, name: s.name, method: s.method,
          runs: [], ok: 0, failed: 0, missing: 0, stopped: 0, running: 0, failure: '',
        };
        seen.set(key, g);
        out.push(g);
      }
      g.runs.push({ where, step: s });
      if (s.status === 'ok') g.ok += 1;
      else if (s.status === 'failed') g.failed += 1;
      else if (s.status === 'missing') g.missing += 1;
      else if (s.status === 'stopped') g.stopped += 1;
      else g.running += 1;
      // 只留第一条：同一步挂 5 次，原因基本是同一个
      if (!g.failure && s.status !== 'ok') g.failure = stepFailureText(s);
    });
  };

  take({ steps: run?.shared }, '整轮');
  take(run?.setup, '开头');
  (run?.rows || []).forEach((row) => take(row, `第 ${row.no} 行`));
  take(run?.teardown, '收尾');

  // 步骤编号就是它在方案里的位置，按它排就是执行顺序
  out.sort((a, b) => (a.no || 0) - (b.no || 0));
  return out;
}

/** 一步的摘要，导出用。响应体不进导出 —— 那是几百 KB，导出文件没人读得动 */
const stepBrief = (step) => ({
  no: step.no,
  name: step.name,
  method: step.method,
  url: step.url,
  status: step.status,
  httpStatus: step.httpStatus,
  time: step.time,
  /** 一共发了几次（含第一次） */
  attempts: step.attempts || 1,
  error: step.error || '',
  assertions: (step.assertions || []).map((a) => ({
    label: a.label,
    ok: a.ok,
    actual: formatValue(a.actual),
  })),
  extracted: (step.extracted || []).map((e) => ({
    key: e.key,
    // 从哪儿取的：JSON 路径 / 响应头名 / 正文正则 / 状态码
    from: e.from || 'body',
    path: e.path || '',
    value: e.ok ? e.value : null,
    ok: e.ok,
    reason: e.reason || '',
  })),
});

/** 导出 JSON：结构完整、能再被程序读，但不含响应体 */
export function buildRunJson(run, planName) {
  const rows = run?.rows || [];
  return JSON.stringify(
    {
      plan: planName || '',
      at: run?.at ? new Date(run.at).toISOString() : null,
      finishedAt: run?.finishedAt ? new Date(run.finishedAt).toISOString() : null,
      status: run?.status || '',
      // 按**次数**数，和报告页头部、运行页一致。以前这里用 runCounts（按段），
      // 导出来的账和屏幕上看到的对不上：屏幕上「通过 1 · 失败 1 · 未执行 2」，
      // 文件里却是「通过 0 · 失败 1 · 未执行 1」
      counts: stepCounts(run),
      /** 另外给一份按数据行累计的，程序读的时候两种口径都可能要 */
      segments: runCounts(run),
      inFlightWhenHalted: run?.inFlightWhenHalted || 0,
      setup: run?.setup ? { status: run.setup.status, steps: (run.setup.steps || []).map(stepBrief) } : undefined,
      teardown: run?.teardown
        ? { status: run.teardown.status, steps: (run.teardown.steps || []).map(stepBrief) }
        : undefined,
      engineError: run?.engineError || undefined,
      rows: rows.map((row) => ({
        no: row.no,
        label: row.label,
        status: row.status,
        steps: realSteps(row).map(stepBrief),
      })),
    },
    null,
    2
  );
}

/** CSV 单元格：含逗号 / 引号 / 换行时加引号，引号翻倍 */
const csvCell = (value) => {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 导出 CSV：**一行一个步骤**，不是一行一个数据行。
 *
 * 挂了的时候要的是一张能排序、能筛选的表 —— 按数据行汇总的话，
 * 「第 3 步在 200 行里挂了 47 次」这种问题还得自己在 Excel 里再拆一遍。
 * 未执行 / 已停止的行没有步骤，各自占一行，至少能看出它没跑。
 */
export function buildRunCsv(run) {
  const head = [
    '行号', '数据行', '步骤', '接口', '方法', '地址', '结果',
    'HTTP', '耗时(ms)', '断言', '重试次数', '失败原因',
  ];
  const lines = [head.join(',')];

  // 全局步骤也算一行，行号那一列写「全局」——
  // 登录挂了的方案，只按数据行列的话会看不出真正的原因
  allRunRows(run).forEach((row) => {
    const steps = realSteps(row);
    if (!steps.length) {
      // 没跑到的行也占一行（列数保持一致，Excel 里不会错位）
      lines.push(
        [
          row.no, row.label, '', '', '', '', stepStatusText(row.status),
          '', '', '', '', '',
        ].map(csvCell).join(',')
      );
      return;
    }
    steps.forEach((s) => {
      const passed = (s.assertions || []).filter((a) => a.ok).length;
      const total = (s.assertions || []).length;
      const retries = (s.attempts || 1) - 1;
      lines.push(
        [
          row.no,
          row.label,
          s.no,
          s.name,
          s.method,
          s.url,
          stepStatusText(s.status),
          s.httpStatus || '',
          s.time || '',
          total ? `${passed}/${total}` : '',
          retries > 0 ? retries : '',
          s.status === 'ok' ? '' : stepFailureText(s),
        ].map(csvCell).join(',')
      );
    });
  });

  // 带 BOM，Excel 才会按 UTF-8 打开，中文列名不会变乱码
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/**
 * 失败摘要：纯文本，直接贴进 issue / 聊天窗口。
 *
 * 和 CSV 的分工：CSV 给 Excel，这个给人读 —— 所以只列失败的行，
 * 每行只给「第一个失败的步骤 + 原因」，不铺全部细节。
 */
export function buildFailureSummary(run, planName, now = Date.now()) {
  // 按**次数**数，和报告页头部一致（见 stepCounts 的说明）
  const counts = stepCounts(run);
  // 全局步骤的失败也在里面 —— 那是最要紧的一种失败
  const failed = allRunRows(run).filter((r) => r.status === 'failed');

  const done = counts.ok + counts.failed + counts.stopped + counts.missing;
  const lines = [
    `方案：${planName || '（未命名）'}`,
    `时间：${formatTime(run?.at)} · 用时 ${formatElapsed(run, now)}`,
    `结果：已完成 ${done} / ${counts.total} 次请求` +
      ` · 通过 ${counts.ok} · 失败 ${counts.failed}` +
      (counts.missing ? ` · 未执行 ${counts.missing}` : '') +
      (counts.pending ? ` · 未运行 ${counts.pending}` : ''),
  ];

  if (!failed.length) {
    lines.push('', '没有失败的行。');
    return lines.join('\n');
  }

  lines.push('', `失败 ${failed.length} 段：`);
  failed.forEach((row) => {
    const bad = realSteps(row).find((s) => s.status !== 'ok');
    const label = row.label && row.label !== '空行' ? `${row.no}  ${row.label}` : `${row.no}`;
    lines.push(`  ${label}`);
    if (bad) {
      lines.push(`    步骤 ${bad.no} ${bad.method} ${bad.name}：${stepFailureText(bad)}`);
      lines.push(`    ${bad.url}`);
    } else {
      lines.push('    （这一行没有取到失败步骤的记录）');
    }
  });

  return lines.join('\n');
}
