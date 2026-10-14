// ---------------------------------------------------------------------------
// 断言与变量提取（声明式，不跑脚本）
// ---------------------------------------------------------------------------

/** 按路径取值，支持 data.token、items[0].id 两种写法。 */
export function getByPath(source, path) {
  if (path === undefined || path === null || path === '') return undefined;

  const keys = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  let current = source;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// 路径的「拼」这一侧。工作台的 JSON 工具拿它给树上每个节点生成路径，
// 拼出来的东西必须能被上面那个 getByPath 认走 —— 两边贴着放，谁改了谁看得见。
// ---------------------------------------------------------------------------

/** 键里出现这三个字符就拼不出路径：getByPath 按 . 切、按 [n] 认下标 */
const BAD_KEY = /[.\[\]]/;

/**
 * 拼出 getByPath 认的路径。拼不出（键带点 / 括号）返回 null。
 *
 * @param {string} parent 上层路径，根是空串
 * @param {string} key 对象键名
 */
export function joinBodyPath(parent, key) {
  if (BAD_KEY.test(key)) return null;
  return parent === '' ? key : `${parent}.${key}`;
}

/** 数组下标那段：list → list[0]。下标永远拼得出来 */
export function joinIndexPath(parent, i) {
  return `${parent}[${i}]`;
}

/**
 * 把 response.body 解析成对象，失败返回 undefined。
 *
 * 按响应对象缓存解析结果：一条响应配 N 条断言 + M 条提取时，实际只需要
 * 解析一次 —— 大响应（上限 10MB）逐条 parse 是零点几秒一个的隐形税。
 * WeakMap 挂在响应对象上，响应被回收缓存跟着走。
 */
const bodyCache = new WeakMap();

export function parseBody(response) {
  if (!response) return undefined;
  if (bodyCache.has(response)) return bodyCache.get(response);
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = undefined;
  }
  bodyCache.set(response, parsed);
  return parsed;
}

const OPS = {
  eq: (a, b) => String(a) === String(b),
  neq: (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a ?? '').includes(String(b)),
  exists: (a) => a !== undefined && a !== null,
  lt: (a, b) => Number(a) < Number(b),
  gt: (a, b) => Number(a) > Number(b),
};

/** 值的类型名。比 typeof 多分辨三样：null、数组、整数。 */
export function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // string / number / boolean / object / undefined
}

/** 类型断言能写的名字，顺手收几个常见简写 */
const TYPE_ALIASES = {
  str: 'string', string: 'string',
  num: 'number', number: 'number', int: 'integer', integer: 'integer',
  bool: 'boolean', boolean: 'boolean',
  obj: 'object', object: 'object',
  arr: 'array', array: 'array',
  null: 'null',
};

/**
 * 类型断言。写 `number` 时整数也算过 —— 人想看的是「它是不是个数」，
 * 真在意整数会直接写 `integer`。
 */
function matchesType(value, expect) {
  const want = TYPE_ALIASES[String(expect ?? '').trim().toLowerCase()];
  if (!want) {
    return {
      ok: false,
      reason: `认不出类型「${expect}」。可写：string / number / integer / boolean / object / array / null`,
    };
  }
  const actual = typeName(value);
  if (want === 'number') return { ok: actual === 'number' || actual === 'integer' };
  return { ok: actual === want };
}

/** 数组元素数 / 字符串长度 / 对象字段数；数字、布尔这类没有长度概念 */
function lengthOf(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (typeof value === 'object') return Object.keys(value).length;
  return undefined;
}

/**
 * 长度断言。expect 可以写死一个数，也可以写比较（`>0`、`>=2`、`<10`）——
 * 「别是空的」几乎人人都会写，只给等号会逼着人去凑具体数字。
 */
function compareLength(actual, expect) {
  const len = lengthOf(actual);
  if (len === undefined) {
    return { ok: false, reason: `这个值没有长度（实际是 ${typeName(actual)}）` };
  }
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(String(expect ?? '').trim());
  if (!m) return { ok: false, reason: '长度要写数字，或者 >0 / >=2 这样的比较' };

  const want = Number(m[2]);
  const op = m[1] || '=';
  const pass =
    op === '=' ? len === want
      : op === '>' ? len > want
        : op === '<' ? len < want
          : op === '>=' ? len >= want
            : len <= want;
  return { ok: pass, reason: pass ? '' : `实际长度 ${len}` };
}

/**
 * 把用户写的正则变成 RegExp。两种写法都认：
 *
 *   ^tr-\d+        裸模式
 *   /^tr-\d+/i     带斜杠和标志（要忽略大小写、要多行时用这个）
 *
 * 写错时抛出去，由调用方翻成一句人话。
 */
function parseRegex(text) {
  const src = String(text ?? '').trim();
  const literal = /^\/([\s\S]*)\/([a-z]*)$/.exec(src);
  return literal ? new RegExp(literal[1], literal[2]) : new RegExp(src);
}

/** schema 断言的递归深度上限：写飞了的 schema 不该把界面转晕 */
const SCHEMA_DEPTH_LIMIT = 12;

/**
 * 轻量 JSON Schema 校验。**只支持常见的这几个关键字**：
 * type / enum / required / properties / items / minimum / maximum /
 * minLength / maxLength / pattern。
 *
 * 不做规范全集：这里要回答的是「结构对不对」，不是当校验器用。
 * 遇到不支持的键一律忽略（不是报错），免得写了个 `additionalProperties` 就整条挂掉。
 */
function validateSchema(schema, value, path, depth) {
  if (depth > SCHEMA_DEPTH_LIMIT) return { ok: true };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'schema 要写成 JSON 对象' };
  }

  if (schema.type !== undefined && !matchesType(value, schema.type).ok) {
    return {
      ok: false,
      reason: `${path} 的类型不是 ${schema.type}（实际 ${typeName(value)}）`,
    };
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === value)) {
    return { ok: false, reason: `${path} 不在 enum 列举的值里` };
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, reason: `${path} 小于 ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, reason: `${path} 大于 ${schema.maximum}` };
    }
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { ok: false, reason: `${path} 比 ${schema.minLength} 个字短` };
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { ok: false, reason: `${path} 比 ${schema.maxLength} 个字长` };
    }
    if (typeof schema.pattern === 'string') {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch (e) {
        return { ok: false, reason: 'schema 里的 pattern 正则写错了：' + (e.message || '') };
      }
      if (!re.test(value)) return { ok: false, reason: `${path} 不匹配 pattern` };
    }
  }
  if (Array.isArray(schema.required) && value && typeof value === 'object') {
    for (const key of schema.required) {
      if (!(key in value)) return { ok: false, reason: `${path} 缺字段 ${key}` };
    }
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (!(key in value)) continue;
      const result = validateSchema(sub, value[key], `${path}.${key}`, depth + 1);
      if (!result.ok) return result;
    }
  }
  if (schema.items && Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const sub = Array.isArray(schema.items) ? schema.items[i] : schema.items;
      if (!sub) continue;
      const result = validateSchema(sub, value[i], `${path}[${i}]`, depth + 1);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

/** schema 断言：expect 那段文本是一份 JSON Schema */
function runSchema(actual, expect) {
  const text = String(expect ?? '').trim();
  if (!text) return { ok: false, reason: 'schema 是空的' };
  if (actual === undefined) return { ok: false, reason: '这个路径取不到值，没法校验' };

  let schema;
  try {
    schema = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'schema 不是合法 JSON：' + (e.message || '') };
  }
  return validateSchema(schema, actual, '$', 0);
}

/**
 * 操作符的显示名。
 *
 * 界面的下拉框直接照这份生成（见 RequestEditor 的 ops）—— 以前那里另抄了一份
 * 一模一样的清单，加一个操作符要改两个文件，漏一个就是「下拉里选得到、
 * 结果里显示成英文 op」。
 */
export const OP_LABELS = {
  eq: '等于',
  neq: '不等于',
  contains: '包含',
  exists: '存在',
  lt: '小于',
  gt: '大于',
  matches: '正则匹配',
  type: '类型是',
  length: '长度',
  schema: '符合 schema',
};

const TARGET_LABELS = {
  status: '状态码',
  time: '响应耗时',
  size: '响应大小',
  header: '响应头',
  json: 'JSON',
};

function describeTarget(assertion) {
  const target = assertion.target || 'status';
  if (target === 'json') return `JSON ${assertion.path || '(未填路径)'}`;
  if (target === 'header') return `响应头 ${assertion.path || '(未填头名)'}`;
  return TARGET_LABELS[target] || target;
}

/**
 * 按名字取响应头。**大小写不敏感** —— HTTP 头本来就不区分大小写，
 * 让人为了写 `content-type` 还是 `Content-Type` 试两次是没必要的。
 */
export function headerValue(response, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return undefined;
  const found = (response.headers || []).find(
    (h) => String(h.key || '').toLowerCase() === key
  );
  return found ? found.value : undefined;
}

/** 断言要拿来比对的那个值 */
function actualOf(target, path, response) {
  if (target === 'status') return response.status;
  if (target === 'time') return response.time;
  if (target === 'size') return response.size;
  if (target === 'header') return headerValue(response, path);
  return getByPath(parseBody(response), path);
}

/** 跑一个操作符。这几个各有一套解析，所以单独走 */
function applyOp(op, actual, expect) {
  if (op === 'matches') {
    // 正则写错了要当场说清楚。让它抛出去的话，整条断言只会变成一句
    // 「未知操作符」之类的东西，找不到真正的原因
    try {
      return { ok: parseRegex(expect).test(String(actual ?? '')) };
    } catch (e) {
      return { ok: false, reason: '正则写错了：' + (e.message || '') };
    }
  }
  if (op === 'type') return matchesType(actual, expect);
  if (op === 'length') return compareLength(actual, expect);
  if (op === 'schema') return runSchema(actual, expect);

  const fn = OPS[op];
  if (!fn) return { ok: false, reason: '未知操作符' };
  return { ok: fn(actual, expect) };
}

/** 跑一遍断言，返回逐条结果。 */
export function runAssertions(assertions, response) {
  return (assertions || []).map((a, index) => {
    const target = a.target || 'status';
    const op = a.op || 'eq';
    // schema 那种 expect 可以是很长一段 JSON，整段塞进标签会把结果列表撑破
    const shown = String(a.expect ?? '');
    const suffix =
      op === 'exists' ? '' : ` ${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}`;
    const label = `${describeTarget({ ...a, target })} ${OP_LABELS[op] || op}${suffix}`;

    if (!response) {
      return { index, label, ok: false, actual: undefined, reason: '没有响应' };
    }

    const actual = actualOf(target, a.path, response);
    const result = applyOp(op, actual, a.expect);
    return { index, label, ok: result.ok, actual, expect: a.expect, reason: result.reason };
  });
}

/**
 * 提取的来源。
 *
 * 加这几个是因为最常见的那个坑：**登录的 token 往往不在 JSON 里**，
 * 而在响应头（`Authorization`）或者表单文本（`token=xxx&...`）里。
 * 只能从 JSON 取的话，「先登录、后面步骤用 token」这条链根本搭不起来。
 */
export const EXTRACT_SOURCES = [
  { value: 'body', label: 'JSON' },
  { value: 'header', label: '响应头' },
  { value: 'text', label: '正文正则' },
  { value: 'status', label: '状态码' },
];

/** 从一个来源里取值，取不到时给出人话的原因 */
function readFrom(from, path, response) {
  if (from === 'status') return { value: response.status };

  if (from === 'header') {
    const name = String(path || '').trim();
    if (!name) return { reason: '没填响应头名' };
    const value = headerValue(response, name);
    return value === undefined ? { reason: `响应里没有 ${name} 这个头` } : { value };
  }

  if (from === 'text') {
    // 这一档的「路径」其实是一段正则：从正文里抠出要的那一截。
    // 有捕获组就用第一组，没有就整个匹配
    const pattern = String(path || '').trim();
    if (!pattern) return { reason: '没填正则' };
    let m;
    try {
      // 和断言里的正则一样，也认 /pattern/flags 的写法
      m = String(response.body ?? '').match(parseRegex(pattern));
    } catch (e) {
      return { reason: '正则写错了：' + (e.message || '') };
    }
    if (!m) return { reason: '正文里没匹配到' };
    return { value: m.length > 1 ? m[1] : m[0] };
  }

  const value = getByPath(parseBody(response), path);
  if (value === undefined || value === null) return { reason: '路径取不到值' };
  return { value };
}

/**
 * 跑一遍提取，返回 [{ path, key, from, ok, value, reason }]。
 *
 * 老数据没有 `from` 字段 —— 那时候只有 JSON 一种来源，所以缺省就当 body，
 * 不用迁移。
 */
export function runExtracts(extracts, response) {
  return (extracts || []).map((x) => {
    const from = x.from || 'body';
    const key = x.to;
    const base = { path: x.path, key, from };

    if (!response) return { ...base, ok: false, value: undefined, reason: '没有响应' };
    if (!String(key || '').trim()) {
      return { ...base, ok: false, value: undefined, reason: '没填变量名' };
    }

    const { value, reason } = readFrom(from, x.path, response);
    return {
      ...base,
      ok: !reason && value !== undefined && value !== null,
      value,
      reason: reason || '',
    };
  });
}

/**
 * 把任意 JSON 展平成一串节点（每个节点带自己的路径），
 * 响应区做「搜索定位上一条 / 下一条」就是靠它算出命中路径的。
 *
 * @param {number} [limit] 最多走多少个节点。大响应（几万个键）里每次按键都全量遍历
 *   会把界面卡住，调用方给个上限；到了上限就返回，`out.length === limit` 说明被截了。
 */
export function flattenTree(data, path = '', label = '', out = [], limit = Infinity) {
  if (out.length >= limit) return out;
  out.push({ path, label, value: data });
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      if (out.length >= limit) break;
      flattenTree(value, path ? `${path}.${key}` : key, key, out, limit);
    }
  }
  return out;
}

/** 能否直接转成字符串来比对（对象本身不参与文本匹配）。 */
export const isPlainValue = (value) => value === null || typeof value !== 'object';

/** 统一格式化取值结果，用于界面展示。 */
export function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
