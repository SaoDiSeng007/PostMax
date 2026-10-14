// ---------------------------------------------------------------------------
// 接口与请求 → OpenAPI 3.0 / 3.1 文档
//
// 纯转换逻辑，和 openapi.js（导入方向）对称：不碰 Vue、不碰 DOM、
// 不依赖 js-yaml —— YAML 序列化由调用方注入，这样 Node 测试能直接跑。
//
// x-posmax-* 扩展字段是导出 / 导入两边共用的一份约定：
// 导出现在怎么写、以后导入（openapi.js）就怎么认，改字段形状要两边同步。
//
// 两个版本用同一套内容：这份转换用到的字段（servers、parameters[].example、
// MediaType.example）在 3.0 和 3.1 里语义一致，差异只在文档根的版本串 ——
// 不为 3.1 单写一条转换路径。
// ---------------------------------------------------------------------------

import { pathParamNames } from './api.js';
import { safeFileName } from './download.js';

const OPENAPI_VERSIONS = { '3.0': '3.0.3', '3.1': '3.1.0' };

/** 扩展格式代际，见设计文档 §2 */
const EXT_VERSION = 1;

/** 能落进 paths 的 HTTP 方法，和 openapi.js 导入侧一份清单 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** bodyType → 媒体类型（对应 api.js 里 BODY_TYPES 的 contentType） */
const MEDIA_BY_BODY = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  form: 'application/x-www-form-urlencoded',
};

/** 认不出的 bodyType 一律当 JSON —— 和 api.js 的 bodyTypeOf 同口径（老数据没这个字段） */
const mediaOf = (req) => MEDIA_BY_BODY[req.bodyType] || MEDIA_BY_BODY.json;

/**
 * 把请求的 URL 拆成「服务前缀 + 路径 + 查询串」。
 *
 * 前缀认三种：完整的 http(s) 地址、开头的 {{变量}}（`{{baseUrl}}`，
 * 或 `{{a}}/{{b}}` 这种变量拼变量）、以及没有前缀（URL 直接以 / 开头）。
 * 拆不出以 / 开头的路径就返回 null —— 比如没写协议的裸域名，
 * 硬塞进 paths 会得到一个非法的 key，不如整条跳过并说清楚原因。
 *
 * `{{baseUrl}}` 原样保留、不插值：占位符正是它在别的工具里该有的样子，
 * 回导 PostMax 时也能继续跟着环境走（设计文档 §2「占位符保留原样」）。
 */
export function splitUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let base = '';
  let rest = raw;

  let m = raw.match(/^https?:\/\/[^/?#\s]+/i);
  if (!m) m = raw.match(/^(?:\{\{[^{}]+\}\})(?:\s*\/\s*\{\{[^{}]+\}\})*/);
  if (m) {
    base = m[0];
    rest = raw.slice(m[0].length);
  }

  // fragment 先剥（字面 # 之后全是 fragment，哪怕它出现在查询串里），再分查询串
  rest = rest.replace(/#.*$/, '');

  let query = '';
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    query = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }

  if (!rest) rest = '/';
  if (!rest.startsWith('/')) return null;

  return { base, path: rest, query };
}

/** 查询串拆成参数行。只按第一个 = 分界（值里可以再有 =），同名的保留第一个。 */
export function parseQuery(qs) {
  const rows = [];
  for (const part of String(qs || '').split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (!key) continue;
    rows.push({ key, value: eq < 0 ? '' : part.slice(eq + 1) });
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.key) ? false : seen.add(r.key)));
}

/** 参数行 → OpenAPI parameter。value 空就不写 example，省得导入方填一堆空串。 */
function param(name, where, value, required) {
  const p = { name, in: where, required: !!required, schema: { type: 'string' } };
  if (value !== '' && value !== undefined && value !== null) p.example = String(value);
  return p;
}

/** 请求名 → operationId 候选。中文名会被清洗成空串，调用方要兜底。 */
export function slugId(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 断言导出：每项 4 个字段全部显式写出（设计文档 §3）。
 * 缺省值不省略 —— 导入方零推断，两份导出可以直接 diff。
 */
export function exportAssertions(list) {
  return (list || []).map((a) => ({
    target: a.target || 'status',
    path: a.path === undefined || a.path === null ? '' : String(a.path),
    op: a.op || 'eq',
    expect: a.expect === undefined || a.expect === null ? '' : a.expect,
  }));
}

/** 提取导出，设计文档 §4。from 必须显式写出（老数据缺省的在这里补上）。 */
export function exportExtracts(list) {
  return (list || []).map((x) => ({
    from: x.from || 'body',
    path: x.path === undefined || x.path === null ? '' : String(x.path),
    to: x.to === undefined || x.to === null ? '' : String(x.to),
  }));
}

/**
 * 变量行清洗：只留填了名字的。
 *
 * **停用的行也带出去**（写 `enabled: false`）—— 早先只导启用的，把文档当备份的人
 * 回导一次就会发现「先停着备用」的 key 全没了。请求那边的停用行有
 * `x-posmax-disabled` 兜着，环境变量这边没道理差一截。
 * 启用的行不写 `enabled`，文档保持干净。
 */
export function cleanVars(rows) {
  return (rows || [])
    .filter((v) => String(v?.key || '').trim())
    .map((v) => {
      const row = {
        key: String(v.key).trim(),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
      };
      if (v.enabled === false) row.enabled = false;
      return row;
    });
}

/**
 * 请求体 → requestBody。没内容返回 null。
 *
 * form 的真相是那张键值表（发送时才拼成 urlencoded），导出同样按表走；
 * json 能解析就给出结构化 example，解析不了（常常是占位符写法太野）
 * 按字符串给出并警告 —— 信息宁可丑，不可丢。
 */
function buildRequestBody(req, warnings, label) {
  const media = mediaOf(req);

  if (media === 'application/x-www-form-urlencoded') {
    const rows = (req.bodyForm || []).filter((r) => r.enabled && String(r.key || '').trim());
    if (!rows.length) return null;
    const example = {};
    rows.forEach((r) => {
      example[String(r.key).trim()] =
        r.value === undefined || r.value === null ? '' : String(r.value);
    });
    return { required: true, content: { [media]: { schema: { type: 'object' }, example } } };
  }

  const raw = String(req.body || '');
  if (!raw.trim()) return null;

  let example = raw;
  if (media === 'application/json') {
    try {
      example = JSON.parse(raw);
    } catch {
      warnings.push(`${label}：body 不是合法 JSON（多半是变量占位符的写法），已按字符串导出`);
    }
  }
  return { required: true, content: { [media]: { example } } };
}

/**
 * 一个请求 → 一段 operation。
 *
 * @returns {{path:string, method:string, operation:Object}|null}
 *   拆不出路径 / 方法不认识时返回 null（已记 warning）
 */
function buildOperation(collectionName, req, ctx) {
  const label = `${String(req.method || 'GET').toUpperCase()} ${req.name || '(未命名请求)'}`;

  const method = String(req.method || 'GET').toLowerCase();
  if (!METHODS.includes(method)) {
    ctx.warnings.push(`${label}：方法 ${method.toUpperCase()} 没有 OpenAPI 归宿，已跳过`);
    return null;
  }

  const parts = splitUrl(req.url);
  if (!parts) {
    ctx.warnings.push(`${label}：URL「${req.url || '(空)'}」拆不出接口路径，已跳过`);
    return null;
  }

  const parameters = [];

  // 路径参数：占位符留在 URL 上（那才是它该在的地方），这里只补声明和示例值
  const pathNames = pathParamNames(parts.path);
  const pathValues = new Map(
    (req.pathParams || []).map((r) => [String(r.key || '').trim(), r.value])
  );
  pathNames.forEach((name) => {
    parameters.push(param(name, 'path', pathValues.get(name), true));
  });

  parseQuery(parts.query).forEach((r) => parameters.push(param(r.key, 'query', r.value, false)));

  const headerKeys = new Set();
  (req.headers || []).forEach((h) => {
    if (!h.enabled || !String(h.key || '').trim()) return;
    const key = String(h.key).trim();
    if (headerKeys.has(key)) return; // 同名头取第一个
    headerKeys.add(key);
    parameters.push(param(key, 'header', h.value, false));
  });

  const operation = { tags: [collectionName], summary: String(req.name || ''), parameters };

  // operationId：中文请求名清洗后可能是空串，退回「方法-路径」，再退不回就不写（它本来可选）
  let id = slugId(req.name) || slugId(`${method}-${parts.path}`);
  if (id) {
    const base = id;
    let n = 2;
    while (ctx.operationIds.has(id)) id = `${base}-${n++}`;
    ctx.operationIds.add(id);
    operation.operationId = id;
  }

  const body = buildRequestBody(req, ctx.warnings, label);
  if (body) operation.requestBody = body;

  // ---- x-posmax 扩展区：空值不落字段 ----
  if ((req.assertions || []).length) {
    operation['x-posmax-assertions'] = exportAssertions(req.assertions);
  }
  if ((req.extracts || []).length) {
    operation['x-posmax-extracts'] = exportExtracts(req.extracts);
  }
  if (String(req.script || '').trim()) operation['x-posmax-script'] = String(req.script);
  if (String(req.afterScript || '').trim()) {
    operation['x-posmax-after-script'] = String(req.afterScript);
  }

  // 挂在哪个目录下（目录清单在文档根的 x-posmax-dirs）
  if (req.dirId) operation['x-posmax-dir'] = String(req.dirId);

  // 同级次序：目录与请求共用一套 sort，不带上回导就只能按数组下标排，
  // 目录与请求的穿插关系会乱
  if (typeof req.sort === 'number') operation['x-posmax-sort'] = req.sort;

  // 停用的行在 OpenAPI 里没有归宿（参数只有 required/optional，没有「停用」），
  // 不给它个地方就等于导出即丢。form 只在真是表单体时才算
  const disabled = [];
  const valueOf = (v) => (v === undefined || v === null ? '' : String(v));
  const collectDisabled = (where, rows) => {
    (rows || []).forEach((r) => {
      const key = String(r?.key || '').trim();
      if (!key || r.enabled) return;
      disabled.push({ in: where, key, value: valueOf(r.value) });
    });
  };
  collectDisabled('header', req.headers);
  collectDisabled('query', req.params);
  if (mediaOf(req) === 'application/x-www-form-urlencoded') {
    collectDisabled('form', req.bodyForm);
  }

  // 路径参数表里**没出现在 URL 里**的行（改过 URL 之后留下的，值还留着）：
  // OpenAPI 的 path 参数必须与 URL 模板严格对应，放不下 —— 和停用行一样兜进
  // 这里，回导原样补回表格，不再「改一次 URL 就悄悄丢几行」
  const pathSet = new Set(pathNames);
  (req.pathParams || []).forEach((r) => {
    const key = String(r?.key || '').trim();
    if (!key || pathSet.has(key)) return;
    disabled.push({ in: 'path', key, value: valueOf(r.value) });
  });

  if (disabled.length) operation['x-posmax-disabled'] = disabled;

  // 多前缀时，不属于 servers[0] 的请求记下自己的前缀，回导按它归位
  if (ctx.multiBase && parts.base && parts.base !== ctx.firstBase) {
    operation['x-posmax-server'] = parts.base;
  }

  return { path: parts.path, method, operation };
}

/**
 * 组装整份文档。
 *
 * @param {Object} options
 * @param {string} options.title 文档标题（一般取目录名 / 项目名）
 * @param {string} [options.version]
 * @param {string} [options.description]
 * @param {'3.0'|'3.1'} [options.specVersion] OpenAPI 版本，默认 3.0
 * @param {{name:string, dirs?:Array, requests:Array}[]} options.collections 要导出的几份（每份对应一个顶层目录）（请求已按范围筛好）
 * @param {Array|null} [options.environments] 传了才内嵌 x-posmax-environments（含明文值，警示由调用方负责）
 * @param {string} [options.activeEnvName] @param {string} [options.activeUserName]
 * @returns {{doc:Object, warnings:string[]}}
 */
export function buildDocument(options = {}) {
  const ctx = { warnings: [], operationIds: new Set() };

  const doc = {
    openapi: OPENAPI_VERSIONS[options.specVersion] || OPENAPI_VERSIONS['3.0'],
    'x-posmax-version': EXT_VERSION,
    info: {
      title: String(options.title || '').trim() || 'PostMax 导出',
      version: String(options.version || '1.0.0'),
    },
    paths: {},
  };
  if (String(options.description || '').trim()) {
    doc.info.description = String(options.description).trim();
  }

  // 服务前缀：先按首次出现顺序收齐。出现不止一个时，凡是不等于 servers[0]
  // 的 operation 都要记账（回导按它归位）；servers 是文档级默认，
  // 标准工具只会用第一个
  const allBases = [];
  (options.collections || []).forEach((c) =>
    (c.requests || []).forEach((r) => {
      const parts = splitUrl(r.url);
      if (parts && parts.base && !allBases.includes(parts.base)) allBases.push(parts.base);
    })
  );
  ctx.firstBase = allBases[0] || '';
  ctx.multiBase = allBases.length > 1;

  (options.collections || []).forEach((col) => {
    const colName = String(col.name || '未命名目录');
    (col.requests || []).forEach((req) => {
      const built = buildOperation(colName, req, ctx);
      if (!built) return;

      const item = doc.paths[built.path] || (doc.paths[built.path] = {});
      if (item[built.method]) {
        ctx.warnings.push(
          `${built.method.toUpperCase()} ${built.path}：路径与方法重复，排在后面的「${colName} / ${req.name}」已跳过`
        );
        return;
      }
      item[built.method] = built.operation;
    });
  });

  if (allBases.length) {
    doc.servers = allBases.map((url) => ({ url }));
    if (allBases.some((b) => b.includes('{{'))) {
      ctx.warnings.push(
        'servers 里有未解析的 {{变量}} 前缀（已按原样保留）：严格的 OpenAPI 校验工具可能报错，回导 PostMax 不受影响'
      );
    }
    if (allBases.length > 1) {
      ctx.warnings.push(
        `文档里有 ${allBases.length} 个服务前缀，标准工具只会默认用第一个；PostMax 已在相关请求上记 x-posmax-server 保真`
      );
    }
  }

  // 划分：多份导在一份文档里时，operation 的 tags 只能记名字，
  // 顺序和「到底有几份」得单独记 —— 否则回导时全会被并成一份
  if ((options.collections || []).length > 1) {
    doc['x-posmax-collections'] = options.collections.map((col) => ({
      name: String(col.name || ''),
    }));
  }

  // 目录树：项目内可嵌套的目录。请求挂在哪个目录由 operation 上的 x-posmax-dir 记，
  // 这里出「有哪些目录、谁是谁的子目录、属于哪一份」
  const dirs = [];
  (options.collections || []).forEach((col) => {
    (col.dirs || []).forEach((d) => {
      if (!d || !d.id) return;
      dirs.push({
        id: String(d.id),
        name: String(d.name || ''),
        parentId: String(d.parentId || ''),
        sort: typeof d.sort === 'number' ? d.sort : 0,
        collection: String(col.name || ''),
      });
    });
  });
  if (dirs.length) doc['x-posmax-dirs'] = dirs;

  if (Array.isArray(options.environments)) {
    doc['x-posmax-environments'] = options.environments.map((env) => ({
      name: String(env.name || ''),
      groups: (env.groups || []).map((g) => ({
        name: String(g.name || ''),
        vars: cleanVars(g.vars),
      })),
      users: (env.users || []).map((u) => ({ name: String(u.name || ''), vars: cleanVars(u.vars) })),
    }));
    if (String(options.activeEnvName || '').trim()) {
      doc['x-posmax-active-env'] = String(options.activeEnvName).trim();
    }
    if (String(options.activeUserName || '').trim()) {
      doc['x-posmax-active-user'] = String(options.activeUserName).trim();
    }
  }

  return { doc, warnings: ctx.warnings };
}

/** 导出文件名：清掉各系统文件名的禁忌字符，空格收成连字符。 */
export function exportFileName(title, ext) {
  return `${safeFileName(title) || 'postmax-export'}-openapi.${ext}`;
}
