// ---------------------------------------------------------------------------
// {{变量}} 的**唯一定义**
//
// 这个正则原来在 api.js / store.js / VarHighlight.js / RequestEditor.js /
// varsuggest.js 里各抄了一份，十几处。规则一改就得挨个对齐，漏一处就出现
// 「这里认、那里不认」的怪现象 —— 之前连着几轮「变量误报」都是这么来的：
// 判定「什么是变量」的地方太多，而它们说的不是同一件事。
//
// 所以：**任何需要认出 {{变量}} 的地方，都从这里拿**，别再自己写一份。
//
// ---------------------------------------------------------------------------
// 一个 {{}} 里能写什么
//
//   {{名字}}              变量：环境变量 / 测试数据列 / 脚本产出 / 内置变量
//   {{'明文'}}            明文：不用先去环境里配一个变量，直接写死
//   {{源|sha256}}         套过滤器：把「源」算出来的值再 SHA-256 一下
//
// 「源」可以是上面两种里的任意一种，所以这几种都成立：
//
//   {{appSecret|sha256}}          把环境变量里的密钥哈希掉
//   {{'Vss_2024'|sha256}}         明文直接哈希，不用先在环境里配
//   {{$timestamp|sha256}}         内置变量也能套
//   {{'Vss_2024'|sha('sha256')}}  过滤器写成函数调用式也认（等价于上一行）
//
// 为什么过滤器要写在 {{}} 里面，而不是新开一套语法：{{}} 的识别、补全、替换、
// 漏配检查已经铺到十几处了，另起炉灶就要把这十几处全改一遍。塞进来只要改这一份。
//
// 为什么明文要带引号：不带引号就没法跟变量名区分 —— {{Vss_2024|sha256}} 到底是
// 「叫 Vss_2024 的变量」还是「明文 Vss_2024」，谁也说不清。引号把话说明白。
// 只认单引号：双引号在 JSON body 里就是字符串的引号，混在一起没法读也没法解析。
//
// ---------------------------------------------------------------------------
// 名字允许的字符
//
// 任意语言的字母（\p{L}，含中日韩）、数字、下划线、点、连字符、$、加号。
// 之前用的是 [\w.$-]，而 JS 里 \w 只匹配 ASCII 字母数字 —— 中文列名一律认不出来：
// CSV 表头写成「摄像头名称」时，{{摄像头名称}} 既不会被替换，也不被当成数据列，
// 引用它的步骤还会被误判成「不依赖数据」而只跑一次。
//
// `+` 是为了时间偏移那种写法：{{$datetime+8h}} 得整个认成一个变量
// （减号本来就在集合里，{{$datetime-8h}} 早就成立；只有加号需要放行）。
//
// \p{L} 这类写法**必须带 u 标志**，否则按字面量处理（等于永远匹配不上）。
// ---------------------------------------------------------------------------

/** 名字里允许的单个字符。`-` 放最后，免得被当成区间 */
const NAME = String.raw`[\p{L}\p{N}_.$+-]`;

/** 明文：单引号包起来，里面可以用 \' 和 \\ 转义 */
const LITERAL = String.raw`'(?:[^'\\]|\\.)*'`;

/** 源：变量名，或者明文 */
const SOURCE = String.raw`(?:${NAME}+|${LITERAL})`;

/**
 * 过滤器：`sha256`，也收 `sha('sha256')` 这种函数调用式。
 *
 * 引号同样只用单引号 —— 明文和过滤器参数一套规则，不搞两种。
 *
 * 这里只管**长得像不像**，认不认识是替换那一步的事（见 varsuggest.js 的 VAR_FILTERS）。
 * 分开是为了让「不认识的过滤器」和「写错的语法」表现不一样：前者原样留在报文里
 * （一眼看得出没生效），后者压根不构成一个占位符。
 */
const FILTER = String.raw`[A-Za-z]\w*(?:\(\s*'[^']*'\s*\))?`;

/** 一个 {{}} 里的完整表达式 */
const EXPR = String.raw`${SOURCE}(?:\s*\|\s*${FILTER})?`;

/** 匹配一个占位符，捕获组是里面的表达式 */
export const VAR_TOKEN_SRC = String.raw`\{\{\s*(${EXPR})\s*\}\}`;

/** 只关心「这里有个没解析出来的 {{}}」，不要表达式 */
export const VAR_UNRESOLVED_SRC = String.raw`\{\{\s*${EXPR}\s*\}\}`;

/** 校验一整段文本是不是一个合法的变量名（补全用，只看名字、不含过滤器） */
export const VAR_NAME_SRC = `^${NAME}*$`;

/** 全局版：replace / matchAll 用。**不要用它做单次 exec** —— 带 g 的正则 exec 会改 lastIndex */
export const VAR_TOKEN_G = new RegExp(VAR_TOKEN_SRC, 'gu');
export const VAR_UNRESOLVED_G = new RegExp(VAR_UNRESOLVED_SRC, 'gu');

/** 从字符串**开头**匹配一个占位符。给「拿到的那一小段本身就是一个占位符」的场景用 */
export const VAR_TOKEN_HEAD = new RegExp(`^${VAR_TOKEN_SRC}`, 'u');

/** 校验一个变量名是否合法 */
export const VAR_NAME_ONLY = new RegExp(VAR_NAME_SRC, 'u');

/** 校验一整段文本是不是一个完整的表达式（名字 / 明文 / 带过滤器） */
export const VAR_EXPR_ONLY = new RegExp(`^${EXPR}$`, 'u');

/** 把表达式拆成「源 + 过滤器」。分组和上面那套是同一份规则，不会再走偏 */
const EXPR_PARSE = new RegExp(String.raw`^(${SOURCE})(?:\s*\|\s*(${FILTER}))?$`, 'u');

/** 过滤器 `sha('sha256')` → `sha256`；本来就叫 `sha256` 的原样返回 */
function normalizeFilter(text) {
  if (!text) return '';
  const m = /^[A-Za-z]\w*\(\s*'([^']*)'\s*\)$/.exec(text);
  return m ? m[1] : text;
}

/**
 * 拆一个 `{{}}` 里的表达式。
 *
 * @param {string} expr 占位符里面的原文（不含 `{{` `}}`）
 * @returns {{name:string|null, literal:string|null, filter:string}|null}
 *   name    变量名；明文时是 null
 *   literal 明文内容（已去引号、解开转义）；变量时是 null
 *   filter  过滤器名（已归一化）；没写就是空串
 *   整个认不出来时返回 null —— 调用方据此保留原文，别硬猜
 */
export function parseVarExpr(expr) {
  const m = EXPR_PARSE.exec(String(expr ?? '').trim());
  if (!m) return null;

  const raw = m[1];
  const isLiteral = raw.startsWith("'");
  return {
    name: isLiteral ? null : raw,
    // 去引号 + 解转义：只有 \' 和 \\ 是有意义的，其余反斜杠原样留着
    literal: isLiteral ? raw.slice(1, -1).replace(/\\(['\\])/g, '$1') : null,
    filter: normalizeFilter(m[2]),
  };
}

/**
 * 表达式里引用的**变量名**；纯明文返回 null。
 *
 * 「哪些变量被用到了」的地方（漏配检查、数据依赖判断、高亮）都走这个，
 * 免得把 `'Vss_2024'|sha256` 整串当成一个变量名去找 —— 那必然找不到。
 */
export function varNameOf(expr) {
  const parsed = parseVarExpr(expr);
  return parsed && !parsed.literal ? parsed.name : null;
}
