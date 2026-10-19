/**
 * 「整批勾选」那点判断和操作。
 *
 * 全选 / 半选（indeterminate）/ 勾一批 / 取消一批 —— 这套逻辑原先在四处各写了
 * 一遍：接口树（目录行、「未分组」那一格、「全选」）、方案步骤、挑接口弹窗、
 * 导出时的勾选树。四处口径本该一致，实际改动时忘掉一处的风险就在那儿
 * （挑接口弹窗的「半选」就是漏掉过的那一处）。
 *
 * 这里只收**计算**：不碰组件、不碰 store，调用方把「这一批的 id」和「已经勾了
 * 哪些」丢进来就行。谁存哪个 ref、落不落盘，都不归它管。
 */

/** 这一批是不是都勾上了（空批不算「都勾上」—— 没东西可选时复选框该是空的） */
export const allPicked = (ids, picked) =>
  ids.length > 0 && ids.every((id) => picked.includes(id));

/**
 * 勾了一部分 —— 复选框那档半选。
 *
 * 一律是「这一批里勾上的是不是介于 0 和全部之间」，不比较数量：picked 里可能
 * 还有这一批之外的 id（别的目录、搜索之外勾的），比数量会莫名其妙变成未勾选。
 */
export const somePicked = (ids, picked) => {
  const n = ids.filter((id) => picked.includes(id)).length;
  return n > 0 && n < ids.length;
};

/** 整批勾上 / 移出勾选：只动这一批，别处勾好的一起带着走 */
export const applyPick = (picked, ids, checked) => {
  const rest = picked.filter((id) => !ids.includes(id));
  return checked ? [...rest, ...ids] : rest;
};

/** 单条勾 / 取消，返回新数组 */
export const toggleOne = (picked, id) =>
  picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
