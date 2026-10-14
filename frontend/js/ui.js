// ---------------------------------------------------------------------------
// 视图行为：拖拽调整尺寸、全局快捷键
//
// 这些逻辑要碰 window / document，所以和 store.js 分开；数据本身在 store.js。
// ---------------------------------------------------------------------------
import { watch } from 'vue';
import { sendRequest, state } from './store.js';
import { clamp, nextSize, resizeBounds } from './resize.js';

/**
 * 主题：把 `state.settings.theme` 落到 `<html data-theme>` 上，CSS 那边按它覆盖变量。
 *
 * 只认 `dark`，别的值（老存档里没有这一项、手改坏的字符串）一律按浅色处理 ——
 * 一个错值会让整套变量落空，界面直接变成没上色的样子。
 */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

// 进页面先应用一次（此时是默认值），存档读回来之后再跟着设置走
watch(() => state.settings.theme, applyTheme, { immediate: true });

/**
 * 键盘调整尺寸：分隔条聚焦后按方向键（侧栏 ←→，响应区 ↑↓）。
 *
 * 为什么要有：鼠标拖拽对键盘用户等于不存在 —— 左右栏挤了、编辑区被拖成一条缝时，
 * 键盘用户没有任何办法把它调回来。算术在 resize.js（那边不依赖 store，能单测）。
 */
export function resizeByKey(kind, event) {
  const host = event.currentTarget.parentElement;
  if (!host) return;

  const current = kind === 'sidebar' ? state.sidebarWidth : state.editorHeight;
  const next = nextSize(kind, current, event.key, host);
  if (next === null) return;

  event.preventDefault();
  if (kind === 'sidebar') state.sidebarWidth = next;
  else state.editorHeight = next;
}

function startDrag(kind, event) {
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;
  const startEditor = state.editorHeight;
  const startSidebar = state.sidebarWidth;
  const host = event.currentTarget.parentElement;

  const onMove = (e) => {
    const { min, max } = resizeBounds(kind, host);
    if (kind === 'response') {
      state.editorHeight = clamp(startEditor + (e.clientY - startY), min, max);
    } else {
      state.sidebarWidth = clamp(startSidebar + (e.clientX - startX), min, max);
    }
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  document.body.style.cursor = kind === 'response' ? 'row-resize' : 'col-resize';
  document.body.style.userSelect = 'none';
}

export const beginResizeResponse = (e) => startDrag('response', e);
export const beginResizeSidebar = (e) => startDrag('sidebar', e);

/** 拖到多远才算「在拖」而不是「点了一下」——标签条上这两件事只差几个像素 */
const PAN_SLOP = 4;

/**
 * 横向拖拽滑动：按住一排装不下的东西（标签条）往左右拖，它跟着走。
 *
 * 滚的是 `currentTarget` 自己，所以挂在哪个元素上就滚哪个。
 *
 * 两道坎：
 *   - 位移超过 4px 才算拖。不然点标签页会被当成拖拽，切不过去；
 *   - 真拖过之后，松手时浏览器还会补一个 click，落在标签上会顺手把它切走 ——
 *     那一个 click 得吃掉。只吃掉紧跟着的那次：松手在窗口外就没有 click，
 *     留到下一次点击才吞会变成「点一下没反应」。
 */
export function beginPanScroll(event) {
  if (event.button !== 0) return;
  const el = event.currentTarget;
  if (el.scrollWidth <= el.clientWidth) return;

  const startX = event.clientX;
  const startLeft = el.scrollLeft;
  let dragging = false;

  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onMove = (e) => {
    const dx = e.clientX - startX;
    if (!dragging) {
      if (Math.abs(dx) < PAN_SLOP) return;
      dragging = true;
      document.body.classList.add('panning');
      window.getSelection()?.removeAllRanges();
    }
    el.scrollLeft = startLeft - dx;
  };

  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('panning');
    if (!dragging) return;
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// 窗口缩小后，已设定的编辑区高度可能超出可用空间，这里收敛一次
window.addEventListener('resize', () => {
  state.editorHeight = clamp(state.editorHeight, 0, Math.max(0, window.innerHeight - 280));
});

// 全局快捷键：Ctrl / Cmd + Enter 直接发送当前请求
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (state.view === 'workspace') sendRequest();
  }
});
