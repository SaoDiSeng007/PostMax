// ---------------------------------------------------------------------------
// 「项目文件」（整份搬走一个项目用的那套 JSON）的读入侧
//
// 为什么单独一个模块：这里最值钱的东西，其实是**出错时那几句话**。JSON.parse 原样
// 抛出来的只有 "Unexpected token 'o', "openapi: 3"... is not valid JSON" —— 用户
// 照着这句完全不知道该干什么（实测：有人拿 OpenAPI 文档去点「导入项目」，就卡在
// 这一句上，还以为文件坏了）。剥成纯函数，测试才能把各种「喂错文件」的文本直接
// 喂进来，把提示钉住。
//
// 只判「这是不是一份能用的项目文件」，不碰任何状态 —— 落库那套在 store.js。
// ---------------------------------------------------------------------------

/** 项目文件的格式标记 / 版本：导入前先认它，别把随便一个 JSON 当项目读进来 */
export const PROJECT_FILE_KIND = 'posmax-project';
export const PROJECT_FILE_VERSION = 1;

/** 嗅前多少个字符够判断「这是不是接口文档」—— 它的第一个键就是标志 */
const SNIFF_LEN = 4000;

const OPENAPI_TIP =
  '这看起来是 OpenAPI 接口文档，不是 PostMax 项目文件 —— 请先进入一个项目，再点侧栏底部的「＋ 导入 OpenAPI」。';

const RUN_REPORT_TIP = '这看起来是「运行报告」，不是项目文件 —— 报告只能导出，没有导入。';

/**
 * 内容像 YAML 版的接口文档吗。
 *
 * `openapi:` / `swagger:` 只认行首：缩进过的那是别的键下面的字段，不算标志。
 */
function looksLikeOpenApiYaml(text) {
  return /^[ \t]*(openapi|swagger)[ \t]*:/m.test(text.slice(0, SNIFF_LEN));
}

/** 运行报告导出物的形状：有 rows，并且带着 plan / status 这类报告字段 */
function looksLikeRunReport(value) {
  return Array.isArray(value.rows) && (value.plan !== undefined || value.status !== undefined);
}

/**
 * 读一份项目文件的内容。
 *
 * @param {string} text 文件内容
 * @returns {Object} 认过的 payload；`payload.project` 是老格式（collections）也算过
 * @throws {Error} 消息是**给用户看的**，不是给控制台看的
 */
export function parseProjectFile(text) {
  // 记事本一类「另存为 UTF-8」会塞个 BOM，而 JSON 不认它 —— 去掉再解析，
  // 同样的事 csv.js 那边也做过
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  let payload;
  try {
    payload = JSON.parse(src);
  } catch (e) {
    // 内容像接口文档时先说这件事：对着一份 YAML 说「不是合法 JSON」等于没说
    throw new Error(
      looksLikeOpenApiYaml(src)
        ? OPENAPI_TIP
        : `这个文件不是合法 JSON，读不出来：${(e && e.message) || e}`
    );
  }

  // 合法 JSON 但不是项目文件：接口文档（JSON 版）和运行报告都落在这一档
  if (payload && typeof payload === 'object' && !payload.kind) {
    if (payload.openapi || payload.swagger) throw new Error(OPENAPI_TIP);
    if (looksLikeRunReport(payload)) throw new Error(RUN_REPORT_TIP);
  }

  if (!payload || payload.kind !== PROJECT_FILE_KIND || !payload.project) {
    throw new Error('这不是 PostMax 项目文件（缺 kind / project）');
  }

  const raw = payload.project;
  // 老的导出文件里是 collections，新的是 dirs + requests —— 两种都得认
  const hasTree = Array.isArray(raw.requests) || Array.isArray(raw.collections);
  if (!String(raw.name || '').trim() || !hasTree) {
    throw new Error('项目文件不完整：缺项目名或请求列表');
  }

  return payload;
}
