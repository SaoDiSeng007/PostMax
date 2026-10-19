// ---------------------------------------------------------------------------
// 展示用的两个纯函数，从 ResponsePanel 挪出来 —— 历史详情、方案报告也在用，
// 工具函数不该住在某个组件里让人跨组件 import。
// ---------------------------------------------------------------------------

/** 字节数转成人看的写法。 */
export const formatSize = (bytes) => {
  if (bytes === undefined || bytes === null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
};

/**
 * 大响应那句提示。三种「提前停下」的原因分开说：
 *
 *   readCapped    太大：为了算「完整大小」读到上限就打住了，后面的没再读
 *   readTimedOut  读满后端的总时长上限还没下完（网慢，或服务端在一滴一滴地喂数据）
 *   truncated     只是界面只显示开头一段，大小是准的
 *
 * 前两条的判断顺序和后端 _read_body 的循环一致（先看大小、再看时长）——
 * 实际运行时两者只会命中一个，顺序一致是为了手写的响应也不会两边说法不同。
 *
 * 同一个后端字段在接口页 / 历史详情 / 方案报告三处共用这份文案，不会走偏。
 * 阈值也来自后端（bodyLimit / readLimit / readDeadline），前端不写死数字。
 */
export function truncateNotice(r) {
  if (!r) return '';
  const kept = formatSize(r.bodyLimit);
  if (r.readCapped) {
    return `响应太大，只统计到 ${formatSize(r.readLimit)}：界面显示开头 ${kept}，后面的没再读。`;
  }
  if (r.readTimedOut) {
    return `读了 ${r.readDeadline || '一'} 秒还没下完，已中止：界面只显示开头 ${kept}（收到的部分 ${formatSize(r.size)}）。`;
  }
  if (r.truncated) {
    return `响应体太大，这里只显示了开头的一部分（完整大小 ${formatSize(r.size)}）。`;
  }
  return '';
}
