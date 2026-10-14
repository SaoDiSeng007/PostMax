// ---------------------------------------------------------------------------
// 分隔条调尺寸的**纯逻辑**：边界，以及「按一次方向键挪到哪」。
//
// 单独一个文件是为了能测：真正应用尺寸的 ui.js 要碰 state，而 state 在 store.js 里，
// store 依赖 vue（浏览器里走 importmap 指到 vendor），node 的测试进程加载不了它。
// 把算术留在这儿，鼠标拖拽与键盘调整共用同一份边界。
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** 键盘一次挪多少像素 */
export const RESIZE_STEP = 16;

/**
 * 某条分隔条能调到的范围。
 *
 * @param {'sidebar'|'response'} kind
 * @param {{clientWidth:number, clientHeight:number}} host 分隔条的父元素 ——
 *   就是要调整的那块区域，用它算边界比用 window 更准
 */
export function resizeBounds(kind, host) {
  if (kind === 'response') {
    // 下限 0：编辑区可以被完全收起，响应区一直拖到底、占满整块区域
    return { min: 0, max: Math.max(0, host.clientHeight - 130) };
  }
  return { min: 220, max: Math.max(300, host.clientWidth - 384) };
}

/**
 * 按一次方向键之后的尺寸。侧栏用 ←/→，响应区用 ↑/↓；其它键返回 null。
 *
 * @returns {number|null} null 表示这次按键不归它管（调用方不要 preventDefault）
 */
export function nextSize(kind, current, key, host) {
  const backKey = kind === 'sidebar' ? 'ArrowLeft' : 'ArrowUp';
  const forwardKey = kind === 'sidebar' ? 'ArrowRight' : 'ArrowDown';
  if (key !== backKey && key !== forwardKey) return null;

  const delta = key === forwardKey ? RESIZE_STEP : -RESIZE_STEP;
  const { min, max } = resizeBounds(kind, host);
  return clamp(current + delta, min, max);
}

export { clamp };
