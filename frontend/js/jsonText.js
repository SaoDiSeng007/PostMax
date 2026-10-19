/**
 * 把一段文本当 JSON 解析，解析不出来就返回 undefined。
 *
 * 三处展示各写过一遍 try/catch：响应面板（:parsed）、历史详情（:parsed）、
 * 方案报告（:parsedResp）。顺带统一了判空 —— 方案报告那处是直接读
 * `response.body`，response 为 null 时靠 catch 兜住，看着能用，其实是侥幸。
 */

/** @returns 解析出来的值；不是 JSON 文本（或空）时 undefined */
export function parseJsonText(text) {
  if (typeof text !== 'string' || !text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
