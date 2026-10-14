// ---------------------------------------------------------------------------
// 后端接口层（唯一需要和后端打交道的地方）
//
// 后端是同源的 Flask 服务（见 backend/），所以直接 fetch 相对路径就行，
// 不存在跨域问题 —— 这也是当初决定「前端页面由后端一起发出去」的原因。
//
// 返回值和后端 proxy.py 一一对应，其中 request 是「本次真正发出去的请求」：
// requests 会自动补上 User-Agent、Accept、Content-Length 等，
// 界面上的「实际请求」标签页显示的就是这份最终结果，而不是用户填的那几行。
// ---------------------------------------------------------------------------

import { VAR_FILTERS, resolveBuiltin } from './varsuggest.js';
import { VAR_TOKEN_G, VAR_TOKEN_SRC, VAR_UNRESOLVED_G, parseVarExpr, varNameOf } from './vartoken.js';

/** 请求的默认超时（毫秒）。在左下角「设置」里改。 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Body 支持的格式。
 *
 * contentType 用来在用户没手写 Content-Type 时自动补一个。
 * 不含 multipart（表单带文件）和 binary —— 那两个要文件选择控件，
 * 而后端现在是「body 原样透传」，处理不了，得单独做一轮。
 */
export const BODY_TYPES = [
  { id: 'json', label: 'JSON', contentType: 'application/json' },
  { id: 'text', label: 'Text', contentType: 'text/plain' },
  { id: 'xml', label: 'XML', contentType: 'application/xml' },
  { id: 'form', label: 'Form', contentType: 'application/x-www-form-urlencoded' },
];

/** 按 id 取格式；认不出来的一律当 JSON —— 老数据里没有 bodyType 字段。 */
export function bodyTypeOf(id) {
  return BODY_TYPES.find((t) => t.id === id) || BODY_TYPES[0];
}

/** 把表单那几行拼成 x-www-form-urlencoded。变量先替换，再做 URL 编码。 */
export function buildFormBody(rows, vars = {}) {
  return (rows || [])
    .filter((row) => row.enabled && String(row.key || '').trim())
    .map((row) => {
      const key = interpolate(row.key, vars).trim();
      const value = interpolate(row.value, vars);
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
}

/**
 * 把参数表格的几行拼成 query 串。
 *
 * 值空也带上等号（`?limit=`）—— 这是 query 串的标准写法。
 * 写成光秃秃的 `?limit` 是另一回事：那在不少服务端眼里是「无值开关」，
 * 和「有这个参数、值还空着」不同。
 *
 * 和 buildFormBody 不同，这里**不做 URL 编码**：值里可以写 {{变量}}，编码得等替换
 * 之后才能做；而且 URL 栏是给人看和改的，编过码就没法读了。
 *
 * 编辑器和 OpenAPI 导入共用这一个函数 —— URL 是发送时唯一的真相，
 * 两处拼法必须一模一样，否则导入出来的请求，URL 和参数表格会对不上。
 */
export function buildQuery(rows) {
  return (rows || [])
    .filter((row) => row.enabled && String(row.key || '').trim())
    .map((row) => {
      const key = String(row.key).trim();
      const value = row.value === undefined || row.value === null ? '' : row.value;
      return `${key}=${value}`;
    })
    .join('&');
}

/**
 * 发送一个请求。
 * @param {{method:string, url:string, headers:Array, body:string}} request 请求
 * @param {Object} vars 当前环境的变量表，用于把 {{var}} 替换成真实值
 * @param {{timeout?:number, followRedirects?:boolean, skipTlsVerify?:boolean}} settings 全局设置
 * @param {AbortSignal} [signal] 用来中途叫停。方案跑一半点「停止」走的就是它 ——
 *   没有它的话，一个卡在超时上的请求要拖满 30 秒，界面看着像停止没生效
 */
export async function send(request, vars, settings = {}, signal) {
  const timeout = Number(settings.timeout);
  const type = bodyTypeOf(request.bodyType);

  // 表单类型的「body」是那张键值表，不是一段文本；
  // JSON 走 interpolateJson（字符串值会自动补引号），其余按纯文本替换。
  // JSON 还多一步：先去掉 `//` 注释 —— 注释只存在于编辑器里，
  // 带注释的 body 发出去服务端只会回 400。
  const body =
    type.id === 'form'
      ? buildFormBody(request.bodyForm, vars)
      : type.id === 'json'
        ? interpolateJson(stripJsonComments(request.body), vars)
        : interpolate(request.body, vars);

  const headers = activeHeaders(request, vars);
  // 按 body 类型自动补 Content-Type，但只在用户没手写时补 —— 不覆盖手填的值。
  // 没有 body 内容时不补：GET 请求上挂个 Content-Type 很怪
  if (body && !headers.some((h) => h.key.toLowerCase() === 'content-type')) {
    headers.push({ key: 'Content-Type', value: type.contentType });
  }

  const payload = {
    method: request.method,
    url: finalUrl(request, vars),
    headers,
    body,
    timeout: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    // 这些是全局设置（左下角「设置」里改）。没配过就取最保守的默认值：
    // 校验证书、跟随重定向。
    verifyTls: settings.skipTlsVerify !== true,
    followRedirects: settings.followRedirects !== false,
  };

  let res;
  try {
    res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    // 主动叫停不是「失败」：它是我们自己发的信号，原样抛出去让调用方区分。
    // 不加这一条的话，点「停止」会收到一句「连不上本地后端」—— 完全指错方向。
    if (e && e.name === 'AbortError') throw e;

    // 其余的 fetch 失败只有一个原因：根本没连上后端。
    // 最常见的是后端没启动，或者直接双击 html 打开了页面（file:// 下发不出请求）。
    throw new Error(
      '连不上本地后端。请确认后端已启动（python run.py），' +
        '并通过它给出的地址访问页面，不要直接双击 index.html。'
    );
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    throw new Error(`后端返回了无法解析的内容（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

/**
 * 把 {{var}} 替换成环境变量里的值；找不到的变量原样保留，方便一眼看出漏配。
 *
 * 这里只做一件事：**变量值末尾的斜杠，如果后面紧跟的也是斜杠，就把它去掉**。
 *
 * 因为 baseUrl 往往是从浏览器地址栏直接复制的（地址栏显示时会带结尾斜杠），
 * 配上 URL 里手写的 "/users"，就会拼成 "//users"。
 *
 * 注意范围 —— 动的只有「变量值」这一侧：
 *   {{baseUrl}}/users   baseUrl=https://a.com/  →  https://a.com/users
 *   {{baseUrl}}/users   baseUrl=https://a.com   →  https://a.com/users
 *   {{baseUrl}}//users  baseUrl=https://a.com   →  https://a.com//users   ← 手写的双斜杠原样保留
 * 预览行、实际发送、导出 curl 走的都是这个函数，三处必然一致。
 */
export function interpolate(text, vars = {}) {
  const source = String(text ?? '');
  return source.replace(VAR_TOKEN_G, (match, key, offset) => {
    const value = resolveVar(key, vars, source, offset, match.length);
    return value === null ? match : value;
  });
}

/*
 * ---------------------------------------------------------------------------
 * 路径参数
 *
 * URL 里两种占位符，写法只差一层括号：
 *
 *   {{变量}}      变量，值来自环境 / 账号 / 脚本 / 测试数据
 *   {路径参数}    路径参数，值填在请求自己的 pathParams 表里
 *
 * 为什么要分两种：OpenAPI 文档里的 path 参数本来就写成 `/users/{id}`，导入之后
 * 原样留在 URL 上。它们不是"环境变量"——同一个接口换个环境还是同一个 id，
 * 而 {{变量}} 恰恰是随环境变的。所以单独一张表。
 * ---------------------------------------------------------------------------
 */

/**
 * 两个分支写在同一个正则里，**双花括号那个必须在前**。
 *
 * 这样 {{baseUrl}} 会在第一个分支被整段吃掉，不会在第二个花括号处被当成
 * 路径参数 {baseUrl}。用一个正则同时认两种，也保证「扫出哪些路径参数」
 * 和「替换掉哪些」永远是同一份判断。
 */
const URL_TOKEN = new RegExp(`(?:${VAR_TOKEN_SRC})|\\{([A-Za-z_$][\\w$.-]*)\\}`, 'gu');

/** URL 里用到了哪些路径参数。去重，保持出现顺序。 */
export function pathParamNames(url) {
  const names = [];
  for (const m of String(url || '').matchAll(URL_TOKEN)) {
    if (m[2] && !names.includes(m[2])) names.push(m[2]);
  }
  return names;
}

/**
 * 把 URL 里的 {路径参数} 换成表里填的值。
 *
 * 没填的**原样留着**，不替换成空字符串。空字符串会发到一个路径少了半截的地址上，
 * 那种错比 404 还难查；留着的话，URL 上是看得见的 {id}，界面上也把它标红。
 */
export function fillPathParams(url, rows) {
  const table = new Map(
    (rows || []).map((r) => [String(r.key || '').trim(), String(r.value ?? '')])
  );
  return String(url || '').replace(URL_TOKEN, (match, varName, pathName) => {
    if (varName) return match;
    const value = table.get(pathName);
    return value === undefined || value === '' ? match : value;
  });
}

/**
 * 一个请求最终发出去的 URL。
 *
 * **先填路径参数、再做变量替换**，顺序不能反：路径参数的值本身可以写 {{变量}}
 * （比如 id 从环境里取），反过来的话它就没机会被解析了。
 *
 * 发送、URL 预览、导出 curl、方案步骤，四处都走这一个函数。以前是四处各写一遍
 * interpolate(request.url)，加一条规则就得记着改四遍。
 */
export function finalUrl(request, vars = {}) {
  return interpolate(fillPathParams(request.url, request.pathParams), vars);
}

/**
 * 取一个占位符该被替换成什么；取不到返回 null（调用方保留原占位符）。
 *
 * 分两步：**先拿到「源」的值，再套过滤器**。
 *
 *   源    变量名（环境 / 数据列 / 脚本产出 / 内置）、或者单引号包起来的明文
 *   过滤器 `|sha256` 之类，把源的值再加工一道
 *
 * 哪一步取不到就整体返回 null，让占位符原样留着 —— 界面上表现为「变量标红 /
 * 原样发出去」，一眼看得出是哪个没生效。绝不硬塞一个空串或者半截结果。
 *
 * @param {string} expr 占位符里的表达式，如 `appSecret|sha256`、`'Vss_2024'|sha256`
 * @param {Object} vars 变量表
 * @param {string} source 完整原文（判断该不该去斜杠，要看占位符后面那个字符）
 * @param {number} offset 占位符在原文里的起点
 * @param {number} matchLength 占位符本身的长度
 */
function resolveVar(expr, vars, source, offset, matchLength) {
  const parsed = parseVarExpr(expr);
  if (!parsed) return null;

  let value;

  if (parsed.literal !== null) {
    // 明文：写死在报文里，不依赖任何配置，永远取得到
    value = parsed.literal;
  } else {
    value = baseValue(parsed.name, vars, source, offset, matchLength);
    if (value === null) return null;
  }

  if (!parsed.filter) return value;

  const filter = VAR_FILTERS[parsed.filter];
  // 不认识的过滤器：当作取不到，占位符原样留着，别悄悄发一段没哈希的明文出去
  return filter ? filter(value) : null;
}

/** 单个变量名的取值：内置变量现算，其余查变量表 */
function baseValue(name, vars, source, offset, matchLength) {  // 内置变量（$timestamp / $datetime-8h 之类）：现算，不走环境配置
  const builtin = resolveBuiltin(name);
  if (builtin !== null) return builtin;

  const value = vars[name];
  const usable =
    Object.prototype.hasOwnProperty.call(vars, name) &&
    value !== '' &&
    value !== undefined &&
    value !== null;
  if (!usable) return null;

  let out = String(value);
  // 只看变量占位符后面紧跟着的那个字符（基于原字符串，不受替换影响）
  if (out.endsWith('/') && source[offset + matchLength] === '/') {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * 这个占位符此刻能不能算出值 —— 只回答「能 / 不能」，不返回值本身。
 *
 * 高亮层用它决定标绿还是标红。刻意**复用 resolveVar**：判据只有一份，
 * 就不可能走偏成「看着是绿的，发出去却是个原样保留的占位符」——
 * 那种不一致比不标色还难查。
 *
 * source / offset 那两个参数只服务于「变量值结尾的斜杠要不要去掉」，这里传空
 * 就行：`source[-1]` 是 undefined，不等于 '/'，那段逻辑自然不触发。
 */
export function canResolveVar(expr, vars = {}) {
  return resolveVar(expr, vars, '', -1, 0) !== null;
}

/**
 * 去掉 JSON body 里的 `//` 注释（到行尾为止）。发送和格式校验都先过一遍这里。
 *
 * 逐字符扫描，而不是拿 `/\/\/.*$/` 之类的正则整段替换：`"url": "http://a.com"`
 * 里的双斜杠是字符串内容，正则替换会把后面半截一起吃掉，直接把请求改坏。
 * 只有引号（含 \" 转义）之外的双斜杠才算注释。
 *
 * 注释内容删掉，但换行保留：体量不变，报错时给的行列位置才和编辑器里对得上。
 */
export function stripJsonComments(text) {
  const source = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      if (i < source.length) out += '\n';
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * JSON body 专用的变量替换。
 *
 * 和 interpolate 只差一点：占位符**两侧没有引号**、而变量值又不是合法 JSON 字面量时，
 * 自动补上引号并转义。
 *
 *   "pass": {{pass}}     pass=abc      →  "pass": "abc"
 *   "pass": {{pass}}     pass=123      →  "pass": 123
 *   "pass": {{pass}}     pass=[1,2]    →  "pass": [1,2]
 *   "pass": "{{pass}}"   pass=abc      →  "pass": "abc"     ← 两侧已有引号，原样放入
 *
 * 为什么要替用户补：{{x}} 是纯文本替换。写 `"pass": {{pass}}` 的时候，
 * 变量是数字就合法、是字符串就不合法 —— 用户没法同时满足，因为变量值本身不带引号。
 * 比起让每个人去记「字符串必须写成 "{{pass}}"」，不如这里按值的实际形态判断。
 */
export function interpolateJson(text, vars = {}) {
  const source = String(text ?? '');
  return source.replace(VAR_TOKEN_G, (match, key, offset) => {
    const value = resolveVar(key, vars, source, offset, match.length);
    if (value === null) return match;

    // 两侧已经被引号包住：类型由用户自己决定，原样放进去
    const before = source.slice(0, offset);
    const after = source.slice(offset + match.length);
    if (/"\s*$/.test(before) && /^\s*"/.test(after)) return value;

    // 值本身就是合法 JSON 字面量（数字、布尔、null、数组、对象、带引号的字符串）：直接用
    try {
      JSON.parse(value);
      return value;
    } catch {
      // 落到这里说明是普通字符串 —— JSON 里必须带引号，顺手转义
      return JSON.stringify(value);
    }
  });
}

/** 只保留启用且填了 key 的 header，并做变量替换。 */
export function activeHeaders(request, vars = {}) {
  return (request.headers || [])
    .filter((h) => h.enabled && String(h.key || '').trim())
    .map((h) => ({ key: interpolate(h.key, vars), value: interpolate(h.value, vars) }));
}

/** 找出文本里引用到的所有变量名（去重，保持出现顺序）。纯明文不算引用。 */
export function collectVarNames(text) {
  const names = new Set();
  // 用 matchAll：它按规范复制一份正则，不动共享正则的 lastIndex
  for (const m of String(text ?? '').matchAll(VAR_TOKEN_G)) {
    /*
     * 捕获组给的是**整个表达式**（可能是 `'明文'|sha256`）。这里要的是里面的变量名：
     * 拿整串去找变量必然找不到，后果是漏配检查把一步好好的请求拦下来，
     * 数据依赖判断也会把 {{列名|sha256}} 这种当成「不依赖数据」而只跑一次。
     */
    const name = varNameOf(m[1]);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * 把字符串按「没解析出来的 {{变量}}」切段，便于界面上把它们标红。
 * 传入的应该是已经 interpolate 过的文本 —— 剩下的 {{xxx}} 就是没配上的。
 * @returns {{text:string, miss:boolean}[]}
 */
export function splitUnresolved(text) {
  const str = String(text ?? '');
  // 本地一份：带 g 的正则 exec 会改 lastIndex，共享实例在循环里用容易互相干扰
  const re = new RegExp(VAR_UNRESOLVED_G.source, 'gu');
  const parts = [];
  let last = 0;
  let m;

  while ((m = re.exec(str)) !== null) {
    if (m.index > last) parts.push({ text: str.slice(last, m.index), miss: false });
    parts.push({ text: m[0], miss: true });
    last = m.index + m[0].length;
  }
  if (last < str.length) parts.push({ text: str.slice(last), miss: false });
  return parts;
}
