import { nextTick } from 'vue';

// ---------------------------------------------------------------------------
// 弹层的键盘焦点
//
// 弹层（.mask）挂在页面最后，而触发它的按钮在页面中间。不管焦点就有两种坏法：
//
//   1. 打开时不搬焦点 —— 焦点还在触发它的那一行上，Tab 会先把身后整页走一遍，
//      表现就是「弹层里的按钮 Tab 不到」（用户报的就是这个）；
//   2. 关闭时不还焦点、也不拦 Tab —— 键盘用户丢了位置，焦点还会溜到遮罩后面去。
//
// 所以三件事：打开时搬进弹层、Tab 在弹层里循环、关闭时还给打开它的那个元素。
// 四个弹层（确认框 / 步骤选择 / 导入预览 / 导出）共用这一份，别各写一套。
// ---------------------------------------------------------------------------

/** 同一时刻只可能有一个弹层开着，所以「弹层之外最后焦点在哪」记一个全局的就够 */
let lastOutside = null;
let installed = false;

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (!el || el === document.body || !el.isConnected) return;
      // 弹层与菜单里的元素随手就没了，记它们等于没记
      if (el.closest && el.closest('.mask, .menu')) return;
      lastOutside = el;
    },
    true
  );
}

function focusables(box) {
  if (!box) return [];
  return Array.from(
    box.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => !el.disabled && el.offsetParent !== null);
}

/**
 * 打开弹层：把焦点搬进去。
 *
 * @param {Function} getBox 取弹层根元素（**传函数**：watcher 跑在渲染之前，
 *   这时候 `boxRef.value` 还是 null，等 nextTick 之后再取才有值）
 * @param {string} [preferred] 优先聚焦的选择器；命中不了就退到第一个可聚焦元素
 */
export async function enterDialog(getBox, preferred) {
  install();

  // 此刻还在页面上的那个元素，就是「打开它的东西」——先记下来，关的时候还给它
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !active.closest?.('.mask, .menu')) {
    lastOutside = active;
  }

  await nextTick();
  const box = typeof getBox === 'function' ? getBox() : getBox;
  const target = (preferred && box?.querySelector(preferred)) || focusables(box)[0];
  target?.focus?.();
  // 输入框顺手全选：里面多半是上一轮的名字，直接改比先删干净顺手
  if (target && typeof target.select === 'function') target.select();
}

/** 关闭弹层：焦点还给打开它的那个元素（它可能已经被删了 —— 比如刚删掉的那一行） */
export async function leaveDialog() {
  const back = lastOutside;
  lastOutside = null;
  await nextTick();
  if (back && back.isConnected) back.focus();
}

/** Tab / Shift+Tab 只在弹层里循环，首尾两端手动回绕 */
export function trapTab(event, box) {
  if (event.key !== 'Tab') return;
  const items = focusables(box);
  if (!items.length) return;

  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const inside = !!box && box.contains(active);

  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}
