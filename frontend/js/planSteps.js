// ---------------------------------------------------------------------------
// 方案的步骤：纯判断，不碰状态、不碰 DOM
//
// 抽出来是因为「哪些步骤按数据行重复」是这套自动化最核心、也最容易出错的一条
// 规则 —— 之前它混在 runPlan 那几百行里，既没法单独看，也没法测。它出错的
// 方式还特别安静：某一个接口被多调了几十遍，或者一个本该按行跑的步骤只跑了一次。
// ---------------------------------------------------------------------------
import { collectVarNames } from './api.js';

/**
 * 一个请求里所有可能写 {{变量}} 的文本。
 *
 * 抽在一处，是因为「哪些字段算用到了变量」曾经有两个实现（执行引擎一份、
 * 接口编辑器一份），字段列表还不一样：一个含 bodyForm 不含 pathParams，
 * 另一个反过来 —— 于是「这一步依不依赖数据」和「有没有变量漏配」各说各话。
 *
 * @param {Object} request
 * @param {{enabledOnly?: boolean}} [options] 只看启用的 params / headers。
 *   编辑器判断「漏配」时要按这个算（停用的行不算数），执行引擎不用。
 * @returns {string[]}
 */
export function requestVarTexts(request, { enabledOnly = false } = {}) {
  const r = request || {};
  const keep = (rows) => (rows || []).filter((x) => !enabledOnly || x.enabled);
  return [
    r.url,
    // 路径参数的值也能写 {{变量}}，而且它属于 URL 那一部分。
    // finalUrl 就是「先填路径参数、再做变量替换」，漏掉这一段的话，
    // 靠 {{列名}} 决定数据依赖的那一步会被误判成「不依赖数据」
    ...keep(r.pathParams).flatMap((p) => [p.key, p.value]),
    ...keep(r.params).flatMap((p) => [p.key, p.value]),
    ...keep(r.headers).flatMap((h) => [h.key, h.value]),
    r.body,
    ...keep(r.bodyForm).flatMap((f) => [f.key, f.value]),
    r.script,
    // 后置脚本里的 {{变量}} 也是这一步的引用 —— 漏了它，只用在后置脚本里的
    // 数据列会被判成「这步不依赖数据」
    r.afterScript,
  ].filter((v) => v !== undefined && v !== null);
}

/** 一个请求引用到的全部变量名（去重、保持出现顺序） */
export function requestVarNames(request, options) {
  return collectVarNames(requestVarTexts(request, options).join('\n'));
}

/**
 * 这一步依不依赖测试数据：请求里引用了任一数据列。
 *
 * 注意列名可以是非 ASCII（中文表头很常见），所以变量名的识别必须和替换用的
 * 那一份一致 —— 这里走 collectVarNames，它用的是 vartoken.js 里带 u 标志的
 * 正则，天然对得上。
 */
export function usesData(step, columns) {
  const cols = columns || [];
  if (!cols.length) return false;
  return requestVarNames(step?.request).some((v) => cols.includes(v));
}

/**
 * 这一步算不算通过。
 *
 * 两个判据，**缺一不可**：
 *
 *   1. HTTP 状态码 ≥ 400 —— 服务端自己说的「这个请求没成」；
 *   2. 有断言没过。
 *
 * 只认断言的话会出一个很安静的错：一个返回 500 的接口，只要没配断言（或者断言
 * 恰好只写了「状态码存在」这种），就会被标成通过。而重试逻辑**是知道它挂了的**
 * （≥ 400 会重发），于是同一轮里出现「重试了 3 次」和「这一步通过」并存，
 * 一个处处 500 的方案还能显示「全绿」。
 */
export function stepVerdict(result, assertions) {
  const status = Number(result?.status) || 0;
  if (status >= 400) return { ok: false, error: `HTTP ${status}` };
  if ((assertions || []).some((a) => !a.ok)) return { ok: false, error: '断言未通过' };
  return { ok: true, error: '' };
}

/*
 * 一个步骤跑几遍 —— 这套自动化最容易出错的一条规则，所以单独摆在这儿。
 *
 *   · 用到「逐行变化」的变量   → 每行跑一遍（几行数据就跑几遍）
 *   · 用到的全是固定值         → 整轮只跑一遍
 *
 * 「逐行变化」是**顺着变量来源往前追**出来的：
 *   · 数据表的列                                  → 逐行变
 *   · 某个「每行跑」的步骤产出的变量（提取 / 脚本）→ 逐行变，所以链条要一路追上去
 *   · 环境变量 / 方案变量 / 「只跑一遍」步骤的产出  → 固定
 *
 * 例：登录（不引用任何数据列）只跑一遍；取用户用 {{userId}}，每行跑；
 * 下单用「取用户」提取出来的 userId，它没直接引用数据列，但追得到上游，也是每行跑。
 *
 * 追不到的只有一种：脚本里动态拼出来的变量名（`env.set('t-' + i, v)`）——
 * 静态认不出，靠步骤上的手动指定兜底。
 *
 * 这里原来还有一个 splitSteps：按**位置**把步骤切成「开头跑一次 / 按数据行跑 /
 * 收尾跑一次」三段。那是位置说了算，看不见也猜不着 —— 现在改成按**依赖**判定，
 * 结论摆在步骤行上（×N / ×1），能核对也能改。
 */

/**
 * 脚本里写死的变量名。动态拼的扫不出来，见上面那段。
 *
 * 结尾那个 `\s*[,)]` 是必需的，不能省：少了它，`env.set('s' + 'ig', v)`
 * 会把第一个字面量 `s` 当成产出的变量名 —— 凭空多出一个假产出，而它要是正好
 * 撞上某个数据列的名字，这一步就会被判成「每行跑」。要求名字后面紧跟逗号或
 * 右括号，拼接那种自然就落下了。
 */
const SCRIPT_SET = /\b(?:env|variables|environment)\s*\.\s*set\s*\(\s*['"`]([^'"`]+)['"`]\s*[,)]/g;

/**
 * 这一步会产出哪些变量名：提取配置里的 key + 脚本里 `env.set('x', …)` 写死的那些。
 */
export function stepProduces(step) {
  const out = new Set();
  // 提取配置里变量名存在 `to`（见 assert.js 的 runExtracts）—— 不是 key
  (step?.request?.extracts || []).forEach((e) => {
    if (e?.to) out.add(e.to);
  });
  // 前置和后置脚本都算产出：一个在发之前算，一个在响应回来之后算，
  // 对下游步骤来说都是「这一步会给出这个变量」
  [step?.request?.script, step?.request?.afterScript].forEach((code) => {
    for (const m of String(code || '').matchAll(SCRIPT_SET)) out.add(m[1]);
  });
  return out;
}

/** 手动指定过的步骤（''/undefined = 自动判定） */
const pinned = (step) => step?.scope === 'each' || step?.scope === 'once';

/**
 * 「只重跑失败的」要跑哪些格子，以及每格是**本体**还是**陪跑**。
 *
 * 失败那格自己重跑没用：它要用的变量是这一轮现攒的，跑完就清了（见 runPlan 的
 * 双重清理）。所以得把它依赖的上游一起挑出来，上游还依赖上游的就继续往上追，
 * 一直追到没有依赖为止。
 *
 * 分两类标，是因为报告里要说得清「哪些是这次要修的、哪些只是来重新产出数据的」：
 * 陪跑那几步挂了不算新问题，但要是没跑起来，本体重跑也是白跑。
 *
 * @param {Object} run 上一次运行的结果
 * @param {Array} steps 这次要跑的步骤（顺序即执行顺序）
 * @param {string[]} columns 测试数据的列名
 * @returns {Map<string, 'target'|'dep'>} key 是 `行下标:步骤下标`，整轮一遍的步骤行下标记 -1
 */
export function rerunTargets(run, steps, columns) {
  const list = steps || [];
  const scopes = stepScopes(list, columns);
  const makes = list.map(stepProduces);
  const marks = new Map();

  /** 产出这个变量的步骤（取它前面最近的一个）—— 靠后的步骤还没跑，产不出值 */
  const producerOf = (name, s) => {
    for (let j = s - 1; j >= 0; j -= 1) if (makes[j].has(name)) return j;
    return -1;
  };

  const add = (r, s, kind) => {
    // 整轮一遍的步骤不属于任何数据行，一律记在 -1 上（和执行时一致）
    const row = scopes[s] === 'once' ? -1 : r;
    const key = `${row}:${s}`;
    const known = marks.get(key);
    // 「本体」不降级成「陪跑」；已经标过同样性质的不用再往下走一遍
    if (known === 'target' || known === kind) return;
    marks.set(key, kind);

    // 这一步要用的变量由谁产出，那个步骤也得跑 —— 否则它一开跑就是「未执行」
    requestVarNames(list[s]?.request).forEach((name) => {
      const j = producerOf(name, s);
      if (j >= 0) add(row, j, 'dep');
    });
  };

  // 失败的和缺数据没跑成的，都是「本体」
  (run?.shared || []).forEach((rec, s) => {
    if (rec && (rec.status === 'failed' || rec.status === 'missing')) add(-1, s, 'target');
  });
  (run?.rows || []).forEach((row, r) => {
    (row.steps || []).forEach((rec, s) => {
      if (rec && (rec.status === 'failed' || rec.status === 'missing')) add(r, s, 'target');
    });
  });

  return marks;
}

/**
 * 这一步有没有**直接**引用测试数据里的列 —— 只算 CSV / 手填的那些列。
 *
 * 和 stepScopes 是两件事，别混：
 *
 *   · stepScopes 要**顺着链条传递**（下游用上游取回来的值，就得跟着一起每行跑），
 *     那是执行的事 —— 不传递的话，下游拿到的是最后一行的值，跑出来一团乱。
 *   · 这个不传递。只用 `{{token}}`（上游取的）或环境变量的步骤，在这儿算「没用到
 *     测试数据」。步骤行上那句话说的是「我给它喂了几条数据」，不是「它会发几次
 *     请求」—— 后者去运行页看，那儿是实打实的次数。
 */
export function usesTestData(step, columns) {
  const cols = columns || [];
  if (!cols.length) return false;
  return requestVarNames(step?.request).some((name) => cols.includes(name));
}

/**
 * 每个步骤跑几遍：`'each'`（每行一遍）或 `'once'`（整轮一遍）。
 *
 * @param {Array} steps 这次要跑的步骤，顺序就是执行顺序
 * @param {string[]} columns 测试数据的列名
 * @returns {string[]} 与 steps 一一对应
 */
export function stepScopes(steps, columns) {
  const list = steps || [];
  const cols = new Set(columns || []);
  const names = list.map((s) => requestVarNames(s?.request));
  const makes = list.map(stepProduces);

  // 手动指定的先落定，其余按「有没有直接引用数据列」起判
  const scope = list.map((s, i) =>
    pinned(s) ? s.scope : names[i].some((v) => cols.has(v)) ? 'each' : 'once'
  );

  /*
   * 再顺着链条往下传：引用了「某个每行跑的步骤」产出的变量，那这一步也得每行跑。
   *
   * 要迭代到不动点，不能一趟了事：A 每行跑 → B 用 A 的产出（B 也每行）→ C 用 B 的
   * 产出……一趟只往后传一格，传到链条尾巴要几趟。步骤数就是上限。
   */
  for (let round = 0; round < list.length; round += 1) {
    let changed = false;
    list.forEach((s, i) => {
      if (pinned(s) || scope[i] === 'each') return;
      const hit = names[i].some((v) =>
        list.some((other, j) => j < i && scope[j] === 'each' && makes[j].has(v))
      );
      if (hit) {
        scope[i] = 'each';
        changed = true;
      }
    });
    if (!changed) break;
  }

  return scope;
}
