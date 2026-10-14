// ---------------------------------------------------------------------------
// OpenAPI 文档 → 接口与请求
//
// 纯转换逻辑：不碰 Vue、不碰 DOM，可以单独跑测试。
//
// 容错态度是「能导多少导多少」—— 解析不了的部分跳过、记进 warnings，
// 而不是碰到一个不认识的写法就整体失败。真实文档的写法千差万别，
// 严格模式的结果只会是反复导入失败，而且看不出是哪一行的问题。
// ---------------------------------------------------------------------------

import { buildQuery } from './api.js';

/** 展开 schema 的递归上限。循环引用主要靠 resolveRef 的 seen 拦，这是第二道保险 */
const MAX_DEPTH = 12;

/** 没给 example / default / enum 时，按类型填的占位值 */
function placeholderFor(type) {
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return '';
}

/** 媒体类型 → Body 格式（对应 api.js 里 BODY_TYPES 的 id） */
const BODY_TYPE_BY_MEDIA = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/x-www-form-urlencoded': 'form',
  'text/plain': 'text',
};

function bodyTypeOfMedia(media) {
  const m = String(media || '').toLowerCase().split(';')[0].trim();
  if (BODY_TYPE_BY_MEDIA[m]) return BODY_TYPE_BY_MEDIA[m];
  if (m.endsWith('+json')) return 'json';
  if (m.endsWith('+xml')) return 'xml';
  if (m.startsWith('text/')) return 'text';
  return '';
}

/** 能映射到界面上的参数位置。cookie 没有对应的去处，会被跳过 */
const PARAM_LOCATIONS = new Set(['query', 'header', 'path']);

/** paths 下面除了方法，还可能有 parameters / summary / x-* 这些东西 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/* ---------------------------------------------------------------------------
 * x-posmax-* 扩展字段（导出侧写在 openapiExport.js，两边共用一份约定）
 *
 * 规则先行、实现照抄：能导多少导多少 —— 类型不对的键忽略并记 warning，
 * 数组项缺字段按导出侧的缺省值补，绝不因为一个陌生写法整单失败。
 * ------------------------------------------------------------------------- */

/** 当前认识的 operation 级扩展键 */
const KNOWN_OP_EXT = new Set([
  'x-posmax-assertions',
  'x-posmax-extracts',
  'x-posmax-script',
  'x-posmax-after-script',
  'x-posmax-server',
  'x-posmax-dir',
  'x-posmax-sort',
  'x-posmax-disabled',
]);

/** 文档根级认识的扩展键；其余 `x-posmax-*` 记 warning（不然新版本导出的东西会被无声吞掉） */
const KNOWN_ROOT_EXT = new Set([
  'x-posmax-version',
  'x-posmax-collections',
  'x-posmax-dirs',
  'x-posmax-environments',
  'x-posmax-active-env',
  'x-posmax-active-user',
]);

/** 认识的扩展格式代际；文档标得更高时照常导入已知部分 + 提示 */
const SUPPORTED_EXT_VERSION = 1;

const ASSERT_TARGETS = new Set(['status', 'time', 'size', 'header', 'json']);
const ASSERT_OPS = new Set([
  'eq', 'neq', 'contains', 'exists', 'lt', 'gt', 'matches',
  // 后加的三种：不认识就会被「按等于处理」，导回来就失真了
  'type', 'length', 'schema',
]);
const EXTRACT_FROMS = new Set(['body', 'header', 'text', 'status']);

const asText = (v) => (v === undefined || v === null ? '' : String(v));

/** 断言读回：四项字段、显式缺省（target=status、op=eq），见 §3 */
function readAssertions(list, label, warnings) {
  return list.map((raw, i) => {
    const a = raw && typeof raw === 'object' ? raw : {};
    let target = asText(a.target) || 'status';
    let op = asText(a.op) || 'eq';
    if (!ASSERT_TARGETS.has(target)) {
      warnings.push(`${label}：第 ${i + 1} 条断言的目标「${target}」不认识，按状态码处理`);
      target = 'status';
    }
    if (!ASSERT_OPS.has(op)) {
      warnings.push(`${label}：第 ${i + 1} 条断言的操作符「${op}」不认识，按等于处理`);
      op = 'eq';
    }
    return { target, path: asText(a.path), op, expect: a.expect === undefined ? '' : a.expect };
  });
}

/** 提取读回：from 缺省当 body（§4） */
function readExtracts(list, label, warnings) {
  return list.map((raw, i) => {
    const x = raw && typeof raw === 'object' ? raw : {};
    let from = asText(x.from) || 'body';
    if (!EXTRACT_FROMS.has(from)) {
      warnings.push(`${label}：第 ${i + 1} 条提取的来源「${from}」不认识，按 JSON 取值`);
      from = 'body';
    }
    return { from, path: asText(x.path), to: asText(x.to) };
  });
}

/**
 * 读一个 operation 的扩展区。缺哪个键就返回空数组 / 空串（§6 第 1 条）。
 *
 * @returns {{assertions:Array, extracts:Array, script:string, server:string,
 *            dir:string, sort:(number|null), disabled:Array}}
 */
function readExtensions(op, label, warnings) {
  Object.keys(op).forEach((key) => {
    if (key.startsWith('x-posmax-') && !KNOWN_OP_EXT.has(key)) {
      warnings.push(`${label}：未知扩展 ${key}（可能来自更新版本的 PostMax），已忽略`);
    }
  });

  const out = {
    assertions: [], extracts: [], script: '', afterScript: '', server: '', dir: '',
    sort: null, disabled: [],
  };

  const rawA = op['x-posmax-assertions'];
  if (Array.isArray(rawA)) out.assertions = readAssertions(rawA, label, warnings);
  else if (rawA !== undefined) warnings.push(`${label}：x-posmax-assertions 不是数组，已忽略`);

  const rawX = op['x-posmax-extracts'];
  if (Array.isArray(rawX)) out.extracts = readExtracts(rawX, label, warnings);
  else if (rawX !== undefined) warnings.push(`${label}：x-posmax-extracts 不是数组，已忽略`);

  const rawS = op['x-posmax-script'];
  if (typeof rawS === 'string') out.script = rawS;
  else if (rawS !== undefined) warnings.push(`${label}：x-posmax-script 不是字符串，已忽略`);

  const rawAS = op['x-posmax-after-script'];
  if (typeof rawAS === 'string') out.afterScript = rawAS;
  else if (rawAS !== undefined) warnings.push(`${label}：x-posmax-after-script 不是字符串，已忽略`);

  const rawB = op['x-posmax-server'];
  if (typeof rawB === 'string' && rawB.trim()) out.server = rawB.trim().replace(/\/+$/, '');
  else if (rawB !== undefined) warnings.push(`${label}：x-posmax-server 不是字符串，已忽略`);

  // 所属目录：还是导出侧的 id，落库时由 store 换成新 id（目录清单在 x-posmax-dirs）
  const rawD = op['x-posmax-dir'];
  if (typeof rawD === 'string') out.dir = rawD.trim();
  else if (rawD !== undefined) warnings.push(`${label}：x-posmax-dir 不是字符串，已忽略`);

  // 同级次序：目录与请求共用一套 sort，缺了就只能按数组下标排，穿插关系会乱
  const rawOrder = op['x-posmax-sort'];
  if (typeof rawOrder === 'number' && Number.isFinite(rawOrder)) out.sort = rawOrder;
  else if (rawOrder !== undefined) warnings.push(`${label}：x-posmax-sort 不是数字，已忽略`);

  // 没地方归位的行：停用的（header / query / form）和「URL 里已经没有这个占位符」
  // 的路径参数行 —— OpenAPI 里都没有归宿，导出时单独兜着带回来
  const rawDis = op['x-posmax-disabled'];
  if (Array.isArray(rawDis)) {
    rawDis.forEach((d) => {
      if (!d || typeof d !== 'object') return;
      const where = asText(d.in).toLowerCase();
      const key = asText(d.key).trim();
      if (!key || !['header', 'query', 'form', 'path'].includes(where)) {
        warnings.push(`${label}：x-posmax-disabled 有一项认不出（in=${where || '空'}），已跳过`);
        return;
      }
      out.disabled.push({ in: where, key, value: asText(d.value) });
    });
  } else if (rawDis !== undefined) {
    warnings.push(`${label}：x-posmax-disabled 不是数组，已忽略`);
  }

  return out;
}

/**
 * 解析文件内容并做基本校验。
 *
 * YAML 是 JSON 的超集，所以这一条路同时能吃 .yaml 和 .json，不用分开处理。
 *
 * js-yaml 用动态导入：这个模块因此能被 Node 测试直接 import
 * （toBundles 只吃已解析的对象，测试不需要 YAML 解析器）。
 */
export async function parseDocument(text) {
  const { load: parseYaml } = await import('js-yaml');
  let doc;
  try {
    doc = parseYaml(String(text ?? ''));
  } catch (e) {
    throw new Error(`解析失败：${(e && e.message) || String(e)}`);
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('文件内容不是一个对象，看起来不是 OpenAPI 文档。');
  }
  // openapi / swagger 字段是它区别于普通 YAML 的标志
  if (!doc.openapi && !doc.swagger) {
    throw new Error('缺少 openapi / swagger 版本字段，看起来不是 OpenAPI 文档。');
  }
  // Swagger 2.0 的结构（host/basePath、in: body 参数）和 OpenAPI 3 不一样，
  // 这套转换只认 3.x —— 硬导会缺 host、丢请求体，而且一声不吭，不如直接拦住
  if (!doc.openapi) {
    throw new Error(`这是 Swagger ${doc.swagger} 文档，目前只支持 OpenAPI 3.x，请先转换后再导入。`);
  }
  if (!doc.paths || typeof doc.paths !== 'object') {
    throw new Error('文档里没有 paths，没有可导入的接口。');
  }
  return doc;
}

/**
 * 把 $ref 换成它指向的实际内容。
 *
 * `seen` 记录这一路上展开过的引用 —— 这是防循环的关键：
 * A 引用 B、B 又引用 A 的话，第二次遇到 A 就立刻返回 null 截断。
 * 少了这道防线，展开函数会无限递归下去，把标签页直接卡死，还查不出原因。
 */
function resolveRef(doc, node, seen, depth) {
  if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return node;
  if (typeof node.$ref !== 'string') return node;

  const ref = node.$ref;
  if (seen.has(ref)) return null; // 绕回来了
  if (!ref.startsWith('#/')) return null; // 指向别的文件或网址，本机解析不了

  const target = ref
    .slice(2)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((cur, key) => (cur == null ? cur : cur[key]), doc);

  if (target == null) return null;

  const next = new Set(seen);
  next.add(ref);
  return resolveRef(doc, target, next, depth + 1);
}

/**
 * 合并 allOf，并处理 oneOf / anyOf。
 *
 * allOf 是最常见的复用写法（把公共字段抽到 components 里再拼起来），
 * 不合并的话导入出来的 body 会缺掉一半字段。
 */
function flattenSchema(doc, schema, seen, depth) {
  const node = resolveRef(doc, schema, seen, depth);
  if (!node || typeof node !== 'object') return null;
  if (depth > MAX_DEPTH) return null;

  const parts = [];

  if (Array.isArray(node.allOf)) {
    node.allOf.forEach((sub) => {
      const flat = flattenSchema(doc, sub, seen, depth + 1);
      if (flat) parts.push(flat);
    });
  }

  // oneOf / anyOf 只取第一个：选哪个都是猜，排在最前面的至少是作者优先考虑的
  const pick = Array.isArray(node.oneOf)
    ? node.oneOf[0]
    : Array.isArray(node.anyOf)
      ? node.anyOf[0]
      : null;
  if (pick) {
    const flat = flattenSchema(doc, pick, seen, depth + 1);
    if (flat) parts.push(flat);
  }

  if (!parts.length) return node;

  // 自身除组合关键字之外的字段也要算进来
  const own = { ...node };
  delete own.allOf;
  delete own.oneOf;
  delete own.anyOf;
  parts.unshift(own);

  const merged = { ...parts[0] };
  merged.properties = {};
  parts.forEach((p) => {
    Object.assign(merged.properties, p.properties || {});
  });
  if (!Object.keys(merged.properties).length) delete merged.properties;
  return merged;
}

/**
 * 按 schema 生成一个「能直接发出去」的骨架值。
 *
 * 优先用文档作者留下的真实线索（example / default / enum），都没有才按类型填占位。
 * 生成**全部字段**而不是只生成 required：「文档里写了哪些字段」正是导入时想看的
 * 信息，漏掉反而要回去翻文档。不用的字段自己删掉就行。
 */
function sampleFromSchema(doc, schema, seen, depth) {
  if (depth > MAX_DEPTH) return null;
  if (!schema || typeof schema !== 'object') return null;

  /*
   * seen 必须沿着属性递归一路带下去 —— 这是拦住循环引用的关键。
   *
   * A 有个字段是 B、B 又有个字段是 A 时，只有把「已经展开过 A」这件事
   * 传到展开 B 的过程里，绕回来时才认得出来。每层都拿一份新的 Set 拦不住：
   * 那样虽然靠 MAX_DEPTH 也不会死循环，但会生成一棵深得没法看的嵌套树。
   *
   * 范围要注意：只在「属性递归」这一条线上维护。交给 flattenSchema 的必须是
   * 一份干净的 Set —— allOf / oneOf 里那些引用是另一条展开路径，
   * 拿带着当前 ref 的 seen 进去，会把正常引用也误判成循环、直接截成 null。
   */
  const nextSeen = new Set(seen);
  if (typeof schema.$ref === 'string') {
    if (seen.has(schema.$ref)) return null; // 绕回来了，截断
    nextSeen.add(schema.$ref);
  }

  const node = flattenSchema(doc, schema, new Set(), depth);
  if (!node || typeof node !== 'object') return null;

  if (node.example !== undefined) return node.example;
  if (node.default !== undefined) return node.default;
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];

  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  if (type === 'array') {
    const item = sampleFromSchema(doc, node.items, nextSeen, depth + 1);
    return item === null ? [] : [item];
  }

  if (type === 'object' || (!type && node.properties)) {
    const out = {};
    Object.keys(node.properties || {}).forEach((key) => {
      out[key] = sampleFromSchema(doc, node.properties[key], nextSeen, depth + 1);
    });
    // additionalProperties 当成一个 key 的示例，比整块丢掉好
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      out.key = sampleFromSchema(doc, node.additionalProperties, nextSeen, depth + 1);
    }
    return out;
  }

  return placeholderFor(type);
}

/** 从参数自己的 example / schema 里取一个能填进表格的值；取不到就留空 */
function sampleFromParam(doc, param) {
  if (param.example !== undefined) return String(param.example);

  const schema = param.schema;
  if (schema && schema.example !== undefined) return String(schema.example);
  if (schema && schema.default !== undefined) return String(schema.default);
  if (schema && Array.isArray(schema.enum) && schema.enum.length) {
    return String(schema.enum[0]);
  }
  return '';
}

/**
 * 从 requestBody 里挑一个能用的媒体类型，并生成内容。
 *
 * 优先 JSON —— 这是接口文档里绝对的主流，生成出来的骨架也最可读。
 */
/**
 * 按媒体类型处理手写的示例值。
 *
 * form 类型不能只把示例塞成一段 JSON 文本当 raw —— 发送时读的是 form 键值表，
 * 那样的话界面表格是空的、发出去的 body 也是空的。得把示例对象拆成键值行，
 * 和下面按 schema 推骨架时的 form 分支一个样。
 */
function bodyFromExample(type, example) {
  if (type === 'form') {
    const pairs = example && typeof example === 'object' ? Object.entries(example) : [];
    return {
      type,
      raw: '',
      form: pairs.map(([key, value]) => ({
        enabled: true,
        key,
        value: value === null || value === undefined ? '' : String(value),
      })),
    };
  }
  // 示例本来就是字符串（XML / 纯文本，或导出侧降级保存的非法 JSON）：原样放回去。
  // 再 stringify 一遍会裹上一层引号和转义，往返一次 body 就花了
  const raw = typeof example === 'string' ? example : JSON.stringify(example, null, 2);
  return { type, raw };
}

function buildBody(doc, requestBody, warnings, label) {
  const content = requestBody && requestBody.content;
  if (!content || typeof content !== 'object') return null;

  const medias = Object.keys(content);
  if (!medias.length) return null;

  // 已经因为 multipart 提示过了，下面就别再补一条「媒体类型都不认识」——
  // 同一件事说两遍只会让人以为出了两个问题
  const sawMultipart = medias.some((m) => m.toLowerCase().includes('multipart/form-data'));
  if (sawMultipart) {
    warnings.push(`${label}：requestBody 是 multipart/form-data，暂不支持，已跳过请求体`);
  }

  // 挑的顺序：JSON → 表单 → 不认识的 → 剩下随便
  const ordered = [
    ...medias.filter((m) => bodyTypeOfMedia(m) === 'json'),
    ...medias.filter((m) => bodyTypeOfMedia(m) === 'form'),
    ...medias.filter((m) => !bodyTypeOfMedia(m)),
    ...medias,
  ];

  for (const media of ordered) {
    const type = bodyTypeOfMedia(media);
    if (!type) continue;

    const spec = content[media] || {};

    // 作者手写的示例优先级最高：这是唯一「作者明说请求长这样」的线索
    if (spec.example !== undefined) {
      return bodyFromExample(type, spec.example);
    }
    if (spec.examples && typeof spec.examples === 'object') {
      const first = Object.values(spec.examples)[0];
      const value = first && first.value !== undefined ? first.value : undefined;
      if (value !== undefined) return bodyFromExample(type, value);
    }
    if (spec.schema && spec.schema.example !== undefined) {
      return bodyFromExample(type, spec.schema.example);
    }

    // 到这里只能按 schema 推骨架了
    const sample = sampleFromSchema(doc, spec.schema, new Set(), 0);

    if (type === 'form') {
      const pairs = sample && typeof sample === 'object' ? Object.entries(sample) : [];
      return {
        type,
        raw: '',
        form: pairs.map(([key, value]) => ({
          enabled: true,
          key,
          value: value === null || value === undefined ? '' : String(value),
        })),
      };
    }

    if (type === 'json') {
      return { type, raw: JSON.stringify(sample, null, 2) };
    }

    return { type, raw: '' };
  }

  if (!sawMultipart) {
    warnings.push(`${label}：requestBody 的媒体类型都不认识，已跳过请求体`);
  }
  return null;
}

/** 请求名：summary → operationId → METHOD /path */
function requestName(op, method, path) {
  const summary = typeof op.summary === 'string' ? op.summary.trim() : '';
  if (summary) return summary;

  const opId = typeof op.operationId === 'string' ? op.operationId.trim() : '';
  if (opId) return opId;

  return `${method.toUpperCase()} ${path}`;
}

/** 文档内嵌的环境（x-posmax-environments）→ 结构化列表。 */
function readEnvironments(raw, warnings) {
  if (!Array.isArray(raw)) return [];
  const varsOf = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .filter((v) => v && typeof v === 'object' && String(v.key || '').trim())
      .map((v) => ({
        key: String(v.key).trim(),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
        // 导出侧只给停用的行写 enabled: false；别的工具手写的文档没这字段，按启用算
        enabled: v.enabled !== false,
      }));

  const out = [];
  raw.forEach((env) => {
    if (!env || typeof env !== 'object') return;
    const name = String(env.name || '').trim();
    if (!name) {
      warnings.push('x-posmax-environments：有一条环境没有名字，已跳过');
      return;
    }
    out.push({
      name,
      groups: (Array.isArray(env.groups) ? env.groups : []).map((g) => ({
        name: String(g?.name || '').trim(),
        vars: varsOf(g?.vars),
      })),
      users: (Array.isArray(env.users) ? env.users : []).map((u) => ({
        name: String(u?.name || '').trim(),
        vars: varsOf(u?.vars),
      })),
    });
  });
  return out;
}

/** 文档里的目录（x-posmax-dirs）→ 结构化列表（id 仍是导出侧那个，落库时再换新 id）。 */
function readDirs(raw, warnings) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((d) => {
    if (!d || typeof d !== 'object') return;
    const id = String(d.id || '').trim();
    if (!id) {
      warnings.push('x-posmax-dirs：有一条目录没有 id，已跳过');
      return;
    }
    out.push({
      id,
      name: String(d.name || '').trim(),
      parentId: String(d.parentId || '').trim(),
      sort: typeof d.sort === 'number' ? d.sort : 0,
      /** 属于哪一份（多接口导出时才有；缺省归到文档默认那个） */
      collection: String(d.collection || '').trim(),
    });
  });

  // 父级必须真的存在，而且不能绕成环 —— 环会让侧栏的递归铺开转不出来。
  // 认不出的一律放到根上（并说一声），不静默降级
  const ids = new Set(out.map((d) => d.id));
  out.forEach((d) => {
    if (!d.parentId) return;
    const seen = new Set([d.id]);
    let cursor = d.parentId;
    let broken = false;
    while (cursor) {
      if (seen.has(cursor) || !ids.has(cursor)) {
        broken = true;
        break;
      }
      seen.add(cursor);
      cursor = out.find((x) => x.id === cursor)?.parentId || '';
    }
    if (broken) {
      warnings.push(
        `x-posmax-dirs：目录「${d.name || d.id}」的父级 ${d.parentId} 对不上或绕成了环，已放到根上`
      );
      d.parentId = '';
    }
  });

  return out;
}

/**
 * 文档 → 一捆或多捆导入内容（含请求、目录、内嵌环境）。
 *
 * 「一捆」= 文档里的一份（文件格式里叫「集合」），落库时对应项目下的一个**顶层目录**
 * （见 store.js 的 confirmImport）。单份文档（没有 `x-posmax-collections`）就是
 * 原来那样：全部归到 info.title 那一捆。多份文档按 operation 的 `tags[0]` +
 * 文档根那份清单还原，顺序照文档来。
 *
 * 返回的请求**不带 id** —— id 由 store.js 统一生成，这里不掺和；
 * 请求上的 `dirId` 也还是导出侧的目录 id，同样由 store.js 换成新 id。
 *
 * @param {Object} doc 已解析的文档
 * @param {string} fallbackName 取不到 info.title 时用的名字（一般是文件名）
 * @returns {{bundles:{name:string, dirs:Array, requests:Array}[],
 *            requests:Array, environments:Array,
 *            activeEnvName:string, activeUserName:string, warnings:string[]}}
 */
export function toBundles(doc, fallbackName = '导入的接口') {
  const warnings = [];

  const extVersion = Number(doc['x-posmax-version'] || 0);
  if (extVersion > SUPPORTED_EXT_VERSION) {
    warnings.push(
      `文档的扩展格式是第 ${extVersion} 代，这里只认到第 ${SUPPORTED_EXT_VERSION} 代：未知部分已忽略，其余照常导入`
    );
  }

  // 根级未知扩展也要说一声：以前只查 operation 级，新版本在根上加的东西会被无声吞掉
  Object.keys(doc).forEach((key) => {
    if (key.startsWith('x-posmax-') && !KNOWN_ROOT_EXT.has(key)) {
      warnings.push(`文档根级有未知扩展 ${key}（可能来自更新版本的 PostMax），已忽略`);
    }
  });

  // 内嵌的目录与环境：能认就还原，认不出的条目跳过并记 warning
  const dirs = readDirs(doc['x-posmax-dirs'], warnings);
  const environments = readEnvironments(doc['x-posmax-environments'], warnings);
  const activeEnvName = String(doc['x-posmax-active-env'] || '').trim();
  const activeUserName = String(doc['x-posmax-active-user'] || '').trim();

  const title = (doc.info && String(doc.info.title || '').trim()) || '';
  const name = title || fallbackName;

  // 文档记着的划分（多接口导出才有）。没记的话全都归到 info.title 那一捆，
  // 和以前一样
  const colNames = Array.isArray(doc['x-posmax-collections'])
    ? doc['x-posmax-collections'].map((c) => String((c && c.name) ?? c ?? '').trim()).filter(Boolean)
    : [];

  // servers 有多个时只取第一个：一次请求只能打一个地址，
  // 多出来的没法体现在单个请求上，硬塞反而让人困惑
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const server0 =
    servers.length && servers[0] && typeof servers[0].url === 'string' ? servers[0] : null;
  let prefix = server0 ? server0.url.trim().replace(/\/+$/, '') : '';
  // server 里的 {变量}（如 https://{region}.api.com）用它的 default 填上，
  // 否则会原样留在 URL 里、被当成路径参数，发到一个不存在的主机上
  if (prefix && server0.variables && typeof server0.variables === 'object') {
    prefix = prefix.replace(/\{([^}]+)\}/g, (match, varName) => {
      const def = server0.variables[varName] && server0.variables[varName].default;
      return def !== undefined ? String(def) : match;
    });
  }
  if (servers.length > 1) {
    warnings.push(`文档里有 ${servers.length} 个 servers，只用了第一个（${prefix || '空'}）`);
  }

  const requests = [];
  // 文档根上的 parameters 对所有接口生效，先存着，下面和方法自己的合并
  const rootParams = Array.isArray(doc.paths.parameters) ? doc.paths.parameters : [];

  /**
   * 这个 operation 属于哪一捆：导出时写在 tags[0]。
   * 只有它确实出现在文档记的清单里才认，否则归到默认那一捆 —— 别人的文档
   * 也爱用 tags，不能因为有个 tag 就凭空多出一捆。
   */
  const bundleOf = (op) => {
    const tag = Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0].trim() : '';
    return tag && colNames.includes(tag) ? tag : name;
  };

  Object.keys(doc.paths).forEach((path) => {
    if (path === 'parameters' || path.startsWith('x-')) return;
    const pathItem = doc.paths[path];
    if (!pathItem || typeof pathItem !== 'object') return;

    METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') return;

      const label = `${method.toUpperCase()} ${path}`;

      // 扩展区（断言 / 提取 / 脚本 / 服务前缀），和导出侧 openapiExport.js 对称
      const ext = readExtensions(op, label, warnings);
      // x-posmax-server 记的是这个请求导出时的真实前缀，比 servers[0] 更可信
      const base = ext.server || prefix;

      // 参数三层合并：文档根 → 路径级 → 方法级，后者覆盖前者
      const merged = new Map();
      [rootParams, pathItem.parameters, op.parameters].forEach((list) => {
        (Array.isArray(list) ? list : []).forEach((raw) => {
          const p = resolveRef(doc, raw, new Set(), 0);
          if (!p || typeof p !== 'object' || !p.name) return;
          merged.set(`${p.in}:${p.name}`, p);
        });
      });

      const params = [];
      const headers = [];
      /**
       * path 参数仍然留在 URL 的 {占位符} 里（那才是它该在的地方），
       * 这里只是把文档给的示例值攒起来一起带过去 —— 导入完就能直接发，
       * 不用对着 URL 一个个手填。界面上的那几行也是读这张表。
       */
      const pathParams = [];
      merged.forEach((p) => {
        const where = String(p.in || '').toLowerCase();
        if (!PARAM_LOCATIONS.has(where)) {
          if (where === 'cookie') {
            warnings.push(`${label}：cookie 参数「${p.name}」在这里没有对应的位置，已跳过`);
          }
          return;
        }

        const row = { enabled: true, key: String(p.name), value: sampleFromParam(doc, p) };
        if (where === 'path') pathParams.push({ key: row.key, value: row.value });
        else if (where === 'query') params.push(row);
        else headers.push(row);
      });

      const body = buildBody(doc, op.requestBody, warnings, label);

      // query 参数**必须同时拼进 URL**，不能只放进参数表格：
      // 发送、导出 curl 都只认 request.url，表格只是它的镜像。
      // 只放在表格里的话，这些参数根本出不去。
      const query = buildQuery(params);

      // 停用的行补回去。**必须在拼完 query 之后**补，否则停用的查询参数会被写进 URL。
      // 它们排在同级末尾（不保真原位置，但行不丢），enabled 置 false
      let bodyForm = body && body.form ? body.form : [];
      let bodyType = body ? body.type : 'json';
      if (ext.disabled.length) {
        ext.disabled.forEach((d) => {
          const row = { enabled: false, key: d.key, value: d.value };
          // 路径参数表本来就没有 enabled 这个概念（它是照着 URL 扫出来的），
          // 原样补回即可
          if (d.in === 'path') pathParams.push({ key: d.key, value: d.value });
          else if (d.in === 'query') params.push(row);
          else if (d.in === 'header') headers.push(row);
          else bodyForm = bodyForm.concat(row);
        });
        // 整张表单都是停用行时 buildBody 会返回 null，这时也得按表单形状放它们
        if (!body && bodyForm.length) bodyType = 'form';
      }

      requests.push({
        name: requestName(op, method, path),
        method: method.toUpperCase(),
        url: base + path + (query ? `?${query}` : ''),
        params,
        pathParams,
        headers,
        body: body ? body.raw || '' : '',
        bodyType,
        bodyForm,
        script: ext.script,
        afterScript: ext.afterScript,
        assertions: ext.assertions,
        extracts: ext.extracts,
        // 还是导出侧的目录 id，store 落库时会换成新 id；空串 = 文档里的「项目根」
        dirId: ext.dir,
        // 导出侧的同级次序（数字）；没有就由 store 按数组下标兜底
        sort: ext.sort,
        // 临时字段：按它分捆，分完就删（见下面的分捆）
        _bundle: bundleOf(op),
      });
    });
  });

  if (!requests.length) {
    throw new Error('paths 里没有找到任何可导入的接口。');
  }

  // 分捆：顺序以文档记的为准（它没记的按请求里出现的先后补），
  // 目录按 x-posmax-dirs 上的 collection 字段归位（那字段是文件格式的一部分）
  const order = [];
  const bucket = new Map();
  const ensure = (bundleName) => {
    if (!bucket.has(bundleName)) {
      bucket.set(bundleName, { name: bundleName, dirs: [], requests: [] });
      order.push(bundleName);
    }
    return bucket.get(bundleName);
  };
  // 文档记的几捆先按它的顺序建；单份文档这里为空，靠下面第一次 ensure 落成
  // info.title 那一捆。**别无条件建默认捆** —— 多份文档会凭空多出一个空的
  colNames.forEach(ensure);
  requests.forEach((r) => {
    ensure(r._bundle || name).requests.push(r);
  });
  dirs.forEach((d) => {
    ensure(d.collection || name).dirs.push(d);
  });
  // 这两个只是分捆用的临时字段，落库的请求 / 目录不需要它们
  requests.forEach((r) => {
    delete r._bundle;
  });
  dirs.forEach((d) => {
    delete d.collection;
  });

  const bundles = order.map((bundleName) => bucket.get(bundleName)).filter(Boolean);

  return { bundles, requests, environments, activeEnvName, activeUserName, warnings };
}
