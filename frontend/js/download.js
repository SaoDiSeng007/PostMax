/**
 * 文件名清洗：去掉各系统文件名的禁忌字符，空格收成连字符，去首尾多余连字符。
 *
 * 空名返回空串 —— 兜底名字交给调用方定（导接口文档和导项目要的兜底不一样）。
 */
export function safeFileName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// 把一段文本存成文件
//
// 单独一个文件是因为它是浏览器能力（Blob + <a download>），不是业务逻辑 ——
// 导出报告只是第一个用到它的地方，以后导出方案、导出环境变量都走这儿。
// ---------------------------------------------------------------------------

/**
 * 让浏览器下载一份文本。
 *
 * @param {string} filename 文件名（含扩展名）
 * @param {string} text 内容，原样写入，不额外加 BOM
 * @param {string} mime
 */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // 有些浏览器要求节点在文档里才认这次点击
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // 立刻 revoke 会让部分浏览器来不及读，挪到下一轮事件循环
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
