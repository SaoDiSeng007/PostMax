// ---------------------------------------------------------------------------
// 复制到剪贴板：优先用异步 API，失败时降级到 execCommand，
// 这样就不会再弹出原生 prompt 让人手动复制。
// ---------------------------------------------------------------------------

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

/** @returns {Promise<boolean>} 是否复制成功 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // 继续走降级
    }
  }
  return fallbackCopy(text);
}
