// ---------------------------------------------------------------------------
// 变量补全：在输入框里敲 {{ 时给出候选
//
// 这里只有纯逻辑（判断该不该弹、候选怎么排），不碰 DOM；
// 下拉长什么样、怎么插进输入框，交给用的地方处理。
// ---------------------------------------------------------------------------
import { VAR_NAME_ONLY } from './vartoken.js';
import { sha256Hex } from './sha256.js';

/**
 * 内置变量：不来自环境配置，发送时由 interpolate 现算。
 *
 * 名字以 $ 开头是为了和环境里自己起的变量区分开 —— 万一真有人想建一个
 * 叫 timestamp 的环境变量，也不会跟这里打架。
 */
export const BUILTIN_VARS = [
  { name: '$timestamp', desc: '时间戳 · 秒（10 位）' },
  { name: '$timestampMs', desc: '时间戳 · 毫秒（13 位）' },
  { name: '$datetime', desc: '当前时间 · YYYY-MM-DD HH:mm:ss（可带偏移：$datetime-8h / $datetime+2h30m）' },
];

/** 内置变量的求值函数。带偏移的 $datetime 走下面单独一套解析，不在这张表里 */
export const BUILTIN_RESOLVERS = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $timestampMs: () => String(Date.now()),
};

/**
 * 变量过滤器：`{{源|sha256}}` 里 `|` 后面那个。
 *
 * 现在只有 SHA-256 一个 —— 先把需求解决掉，别急着铺一套通用的管道机制。
 * 以后要加（md5 / sha512 / base64 …），在这儿补一行就行，**语法那侧不用动**：
 * vartoken.js 只管「长得像不像一个过滤器」，认不认识由这张表说了算。
 * 表里没有的名字，替换时原样保留占位符（和变量漏配一个表现），不会硬塞一个值进去。
 */
export const VAR_FILTERS = {
  sha256: sha256Hex,
};

/**
 * 时间偏移：`$datetime-8h`（减 8 小时）、`$datetime+2h30m`（加 2 小时 30 分）。
 *
 * 单位和数字都可叠着写，单位 m=分钟 h=小时 d=天；`$datetime` 自己就是此刻。
 * 偏移写在**名字**里而不是另开一套语法，是因为变量名那套（{{}} 的识别、
 * 补全、替换、漏配检查）已经铺到十几处了，多一种写法就要多改十几处。
 */
const DATETIME_VAR = /^\$datetime(?:([+-])((?:\d+[mhd])+))?$/;

const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

/**
 * 能接受的时间范围：年份必须正好 4 位，才撑得住 `YYYY-MM-DD HH:mm:ss` 这个格式。
 *
 * 这个下限不是拍脑袋来的：`formatDatetime` 用的是 `getFullYear()`，它只在
 * 1000–9999 之间才自然给出 4 位。越界之后拼出来的是 `29405-11-07 14:42:12`
 * 或者 `-25353-09-19 14:47:55` —— 看着像时间，其实格式已经塌了；再往大还会
 * 直接越过 `Date` 的表示范围，得到 `NaN-NaN-NaN NaN:NaN:NaN`。
 *
 * 偏移是用户手敲的，敲错一个数量级就会落到这儿，所以必须拦住。
 */
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

/** 把 `8h30m` 这种偏移段算成毫秒数（符号由调用方给） */
function offsetMs(sign, body) {
  const total = [...String(body).matchAll(/(\d+)([mhd])/g)].reduce(
    (sum, [, n, unit]) => sum + Number(n) * UNIT_MS[unit],
    0
  );
  return sign === '-' ? -total : total;
}

/**
 * 偏移 → 日期；算不出「格式撑得住」的时间就返回 null。
 *
 * 单独抽出来是因为有两个地方要问同一个问题：`resolveBuiltin` 想知道「该替换成什么」，
 * `parseDatetimeOffset` 想知道「这个偏移能不能收」。两边要是各判各的，迟早会出现
 * 「面板放行、替换时却算不出来」的缝。
 */
function datetimeFromOffset(sign, body) {
  const date = new Date(Date.now() + offsetMs(sign, body));
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  return year < MIN_YEAR || year > MAX_YEAR ? null : date;
}

/** 本地时间按 `YYYY-MM-DD HH:mm:ss` 摆出来（和界面上其它时间显示一个样式） */
export function formatDatetime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 算一个内置变量的值；不是内置变量返回 null（调用方据此判断「要不要走变量表」）。
 *
 * 每次调用现算 —— 时间戳、时间这类值缓存住就会和实际发出去的对不上。
 */
export function resolveBuiltin(name) {
  const key = String(name ?? '');
  const fixed = BUILTIN_RESOLVERS[key];
  if (fixed) return fixed();

  const m = DATETIME_VAR.exec(key);
  if (!m) return null;

  const date = datetimeFromOffset(m[1], m[2]);
  /*
   * 偏移大到算不出合法时间（手敲进来的，浮层那边拦不住所有人）：当作「取不到值」
   * 返回 null。调用方据此保留原占位符（见 api.js 的 resolveVar），URL 上直接看得见
   * 是哪个变量没落地 —— 总好过悄悄发一个 `t=NaN-NaN-NaN NaN:NaN:NaN` 出去。
   */
  return date ? formatDatetime(date) : null;
}

/**
 * 是不是内置变量（漏配检查要用：内置的不算「没配」）。
 *
 * 这里只看**名字长得对不对**，不看偏移算不算得出来 —— 越界的偏移在浮层那一步
 * 就被挡了，走到这儿的基本都是正常值。真有人手敲一个越界的进来，`resolveBuiltin`
 * 会给 null，占位符原样留在报文里，一眼就能看见。
 */
export function isBuiltinVar(name) {
  const key = String(name ?? '');
  return Object.prototype.hasOwnProperty.call(BUILTIN_RESOLVERS, key) || DATETIME_VAR.test(key);
}

/**
 * 偏移文本 → 变量名。
 *
 * 让人直接在框里敲偏移，而不是拨「符号 + 数字 + 单位」三个控件：语法本来就支持
 * 叠写（`+2h30m`），三个控件反而表达不出来 —— 想写「2 小时 30 分」得拆成两步，
 * 而两步之间根本存不下「既加小时又加分钟」这个状态。
 *
 * 接受的写法：`-8h`、`+2h30m`、`-1d12h`、`90m`；不带符号的 `8h` 当作 `+8h`；
 * 空字符串表示此刻（拼出来就是 `$datetime`）。
 *
 * 除了语法，还要过一遍「算出来是不是个正经时间」—— 见 datetimeFromOffset。
 * 光看语法的话，`999999999d` 是合法的，可它算出来是 `NaN-NaN-NaN NaN:NaN:NaN`。
 *
 * 不合法时**不硬拼一个名字**出来 —— 拼出来的东西会当成普通变量名，替换时找不到值，
 * 界面上表现为「变量标红 / 原样发出去」，排查起来完全看不出是这里写错了。
 *
 * @returns {{ok:boolean, name:string, error:string}}
 */
export function parseDatetimeOffset(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, name: '$datetime', error: '' };

  if (/[^0-9mhd+-]/.test(raw)) {
    return { ok: false, name: '', error: '只能用数字和 m / h / d 这三个单位' };
  }
  if (/[+-]/.test(raw.slice(1))) {
    return { ok: false, name: '', error: '正负号只能写在最前面' };
  }

  const m = /^([+-]?)((?:\d+[mhd])+)$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      name: '',
      error: '写法是「数字 + 单位」：m 分钟 / h 小时 / d 天，可以叠着写（如 2h30m）',
    };
  }

  const sign = m[1] || '+';
  if (!datetimeFromOffset(sign, m[2])) {
    return { ok: false, name: '', error: '偏移太大了，算出来超出 1000–9999 年，时间格式会撑不住' };
  }

  return { ok: true, name: `$datetime${sign}${m[2]}`, error: '' };
}

/** 变量名允许的字符。定义在 vartoken.js，和替换用的那一份是同一个 */
const NAME_CHARS = VAR_NAME_ONLY;

/**
 * 光标处是不是正在写一个 {{变量}}。
 *
 * @param {string} text 输入框的完整内容
 * @param {number} caret 光标位置
 * @returns {{active:boolean, query:string, start:number}}
 *   active 该不该弹候选
 *   query  已经敲进去的过滤词
 *   start  `{{` 里第一个 `{` 的位置 —— 选中候选项时要从这里开始替换
 */
export function detectVarTrigger(text, caret) {
  const before = String(text ?? '').slice(0, Math.max(0, caret ?? 0));

  // 从光标往前找最近的一个 {{
  const open = before.lastIndexOf('{{');
  if (open < 0) return { active: false, query: '', start: -1 };

  const segment = before.slice(open + 2);

  // 中间夹着 } 说明这个变量早就写完了，现在不是在写变量
  if (segment.includes('}')) return { active: false, query: '', start: -1 };

  // 允许的字符集之外的内容（空格、换行、引号…）说明已经不在变量里了。
  // 这条很关键：「{ "a": {{ }}」这种 JSON 里的花括号不会被误判
  if (!NAME_CHARS.test(segment)) return { active: false, query: '', start: -1 };

  return { active: true, query: segment, start: open };
}

/**
 * 把当前环境变量和内置变量合成候选列表。
 *
 * @param {Object} vars 当前生效的变量表（环境分组 + 用户认证信息已合并）
 * @param {string} query 过滤词，逐字符匹配
 */
export function buildVarCandidates(vars = {}, query = '') {
  const items = [];

  Object.keys(vars).forEach((name) => {
    items.push({ name, value: String(vars[name] ?? ''), builtin: false });
  });

  BUILTIN_VARS.forEach((item) => {
    items.push({
      name: item.name,
      value: resolveBuiltin(item.name) ?? '',
      desc: item.desc,
      builtin: true,
    });
  });

  const keyword = String(query || '').toLowerCase();
  const matched = keyword
    ? items.filter((item) => item.name.toLowerCase().includes(keyword))
    : items;

  // 环境变量排前面：内置的那两个大多数时候用不到，
  // 混在一起会让常用变量每次都要往下找
  return matched.sort((a, b) => Number(a.builtin) - Number(b.builtin));
}

/**
 * 按「自定义变量 / 系统变量」分好组的候选，给带搜索框的插入浮层用。
 *
 * 和 buildVarCandidates 的分工：那个给 {{ 补全用 —— 一个扁平列表，
 * 越简单越好；这个要分组，因为浮层里有搜索框，分组标题能帮人定位。
 */
export function buildGroupedCandidates(vars = {}, query = '') {
  const keyword = String(query || '').trim().toLowerCase();
  const hit = (name) => !keyword || name.toLowerCase().includes(keyword);

  // 自定义变量 = 配置里加的（环境分组的变量 + 当前账号的认证信息）
  const custom = Object.keys(vars)
    .filter(hit)
    .map((name) => ({ name, value: String(vars[name] ?? ''), builtin: false }));

  // 系统变量 = 前端内置的那几个，名字带 $ 前缀。
  // 时间偏移不往这儿塞预设：浮层顶部那个偏移输入框能直接敲任意偏移（包括 -8h 这种），
  // 同一个东西给两个入口，只会让人不知道该点哪个
  const system = BUILTIN_VARS.map((item) => item.name)
    .filter(hit)
    .map((name) => ({
      name,
      value: resolveBuiltin(name) ?? '',
      desc: BUILTIN_VARS.find((b) => b.name === name)?.desc || '',
      builtin: true,
    }));

  // 过滤后空掉的组直接不出现，免得留下一个光秃秃的标题
  return [
    { title: '自定义变量', items: custom },
    { title: '系统变量', items: system },
  ].filter((group) => group.items.length);
}

/**
 * 把选中的候选写回输入框内容。
 *
 * @param {string} text 原内容
 * @param {number} start `{{` 的位置
 * @param {number} caret 当前光标位置
 * @param {string} name 选中的变量名
 * @returns {{text:string, caret:number, inserted:string, start:number, end:number}}
 *   新内容和新的光标位置；`inserted` / `start` / `end` 是给「原生插入」用的——
 *   只把这一段交给输入框，撤销栈里才有这一步（见 useVarInsert.js 的 writeText）。
 */
export function applyVarPick(text, start, caret, name) {
  const source = String(text ?? '');
  const before = source.slice(0, start);
  const end = Math.max(start, caret ?? start);
  const after = source.slice(end);
  const inserted = `{{${name}}}`;

  return {
    text: before + inserted + after,
    caret: before.length + inserted.length,
    inserted,
    start: before.length,
    end,
  };
}
