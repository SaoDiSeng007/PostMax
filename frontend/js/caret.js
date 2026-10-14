// ---------------------------------------------------------------------------
// 光标位置测量
//
// 浏览器没有「光标在第几像素」这种接口，唯一可靠的办法是镜像：
// 造一个和输入框同样式、同宽度的隐藏节点，把光标之前的文字塞进去，
// 末尾放一个零宽标记，量这个标记的位置就是光标位置。
//
// 量出来的是「内容坐标」（相对于内容左上角），用时记得减掉滚动偏移。
//
// 代价是每次都要读一遍计算样式并让浏览器重排一次隐藏节点。
// 只在输入、点击这类时刻调用，不要放进循环或者 mousemove 里。
// ---------------------------------------------------------------------------

/** 这些样式会影响文字排版，镜像节点必须逐个抄过来 */
const MIRRORED_STYLES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxSizing',
  'whiteSpace',
  'wordWrap',
  'overflowWrap',
];

/**
 * 量出光标在输入框内容里的位置。
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} el 输入框
 * @returns {{left:number, top:number, lineHeight:number}}
 *   left / top 是相对内容区左上角的坐标（未扣滚动）
 */
export function caretOffset(el) {
  if (!el) return { left: 0, top: 0, lineHeight: 16 };

  const style = window.getComputedStyle(el);
  const mirror = document.createElement('div');

  MIRRORED_STYLES.forEach((name) => {
    mirror.style[name] = style[name];
  });

  // 定位到屏幕外而不是 display:none —— 隐藏的元素量不出尺寸
  mirror.style.position = 'absolute';
  mirror.style.top = '-9999px';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';

  // 输入框分两种，镜像必须跟它一致，否则光标会算错行：
  //   <input>    单行、不折行、横向滚动  → 宽度交给内容，white-space: pre
  //   <textarea> 按宽度折行              → 宽度锁成一样，white-space: pre-wrap
  const single = el.tagName === 'INPUT';
  mirror.style.whiteSpace = single ? 'pre' : 'pre-wrap';
  mirror.style.wordWrap = single ? 'normal' : 'break-word';
  mirror.style.width = single ? 'auto' : `${el.clientWidth}px`;

  const caret = el.selectionStart ?? el.value.length;
  mirror.textContent = el.value.slice(0, caret);

  const marker = document.createElement('span');
  marker.textContent = '\u200b'; // 零宽空格：不占宽度，只用来定位
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  // 用两个矩形的差来算相对位置，不能用 offsetLeft / offsetTop ——
  // 那两个值是相对 offsetParent 的，而镜像被挪到了屏幕外，
  // 量出来会白白带上那 -9999px
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();

  const left = markerRect.left - mirrorRect.left;
  const top = markerRect.top - mirrorRect.top;
  const measured = markerRect.height;

  document.body.removeChild(mirror);

  const cssLineHeight = parseFloat(style.lineHeight);

  return {
    left,
    top,
    // 行高优先信 CSS 的 line-height：镜像节点量出来的高度在带内边距时会偏大，
    // 而按钮要靠它算垂直居中
    lineHeight: Number.isFinite(cssLineHeight) ? cssLineHeight : measured || 16,
  };
}

/**
 * 浮层自己的内边距 + 边框（样式表里 .var-suggest / .sc-suggest 都是 4px padding + 1px 边框）。
 *
 * 对齐第一行时要把它减掉：浮层的 top 指到的是边框外沿，而「和光标同一行」说的是
 * 第一项的文字 —— 不减掉这 5px，列表看着就比光标那一行矮一格。
 */
const PANEL_INSET = 5;

/**
 * 算出「贴着光标」的浮层该摆在哪儿 —— **视口坐标**版（配 position: fixed 用）。
 *
 * 为什么不像插入按钮那样按容器坐标摆：编辑器的祖先里有 .pane（overflow: auto）和
 * .card-editor（overflow: hidden），按容器摆的话，浮层往下排到编辑框外面就被裁掉了
 * —— 于是只能在「翻到光标上方」和「被裁」之间二选一。脱离文档流走视口坐标，
 * 浮层才真的能停在光标那一行往下铺。
 *
 * 横向：光标右边 8px 起；右边放不下收到视口右沿。
 * 纵向：单行输入框贴框底（它只有一行，按光标行算会压在框里面）；
 *       多行**第一项就摆在光标这一行**往下排 —— 眼睛不用离开正在写的那行去找列表。
 *       视口下面放不下（光标贴着窗口底）才翻到光标行上方，这是唯一让步。
 *
 * 已知取舍：浮层开了之后如果用滚轮滚外层 .pane，光标行会动而浮层不动（视口坐标不跟着
 * 容器滚）。敲字、点选、编辑器内部滚动都会重新量，只有滚外层这一种情况会短暂错位。
 *
 * @param {{left:number, top:number, lineHeight:number}} caret 光标位置（视口坐标）
 * @param {{top:number, bottom:number, height:number}} anchor 编辑器在视口里的位置
 * @param {{width:number, height:number}} viewport 视口尺寸
 * @param {{width:number, height:number}} panel 浮层尺寸（高度可以用估算值）
 * @returns {{left:number, top:number}} 视口坐标
 */
export function placeNearCaretFixed(caret, anchor, viewport, panel) {
  const left = Math.min(caret.left + 8, Math.max(0, viewport.width - panel.width));

  // 单行输入框（URL 栏、键值表格）贴框底
  if (anchor.height <= 60) return { left, top: anchor.bottom + 6 };

  const top = Math.max(0, caret.top - PANEL_INSET);
  if (top + panel.height <= viewport.height) return { left, top };

  return { left, top: Math.max(0, caret.top - panel.height) };
}

/**
 * 算出「贴着光标」的元素该摆在哪儿 —— **容器坐标**版（配 position: absolute 用）。
 *
 * 给「插入数据」按钮和那个钉在编辑器左上角的浮层用：它们本来就该跟着编辑器走、
 * 被编辑器这一片裁掉也无所谓，不需要脱离文档流。
 *
 * 横向：摆在光标**右边** —— 浮层左沿对齐光标。
 *       右边放不下就往左收，但不顶出容器。
 * 纵向分两种：
 *   单行 <input> —— 贴在框的下边缘。它只有一行，用「光标行」算会压在框里面
 *   多行 <textarea> —— **第一项就摆在光标这一行**，往下排
 *
 * 多行为什么要跟光标同一行起：浮层飘在光标上方时，眼睛得离开正在写的那行去找列表，
 * 一行一行对着看，越长的列表越费劲。跟光标同起，列表和光标是一根视线。
 *
 * 下面放不下（光标在容器底部）才翻到光标行上方 —— 宁可第一行不在同一行，
 * 也不能顶到容器外面被裁掉。
 *
 * @param {{left:number, top:number, lineHeight:number}} caret 光标位置（相对容器）
 * @param {{width:number, height:number}} host 容器尺寸
 * @param {{width:number, height:number}} panel 浮层尺寸（高度可以用估算值）
 * @returns {{left:number, top:number}} 相对容器的坐标
 */
export function placeNearCaret(caret, host, panel) {
  // 浮层左沿对齐光标 + 8px 缝，整块落在光标右边。
  // 右边放不下就退到容器右沿 —— 这时免不了压到光标，但总好过顶出容器。
  // 上限用 host.width - panel.width 兜住，保证任何情况下都不越右边界
  const left = Math.min(caret.left + 8, Math.max(0, host.width - panel.width));

  // 单行输入框 28px 上下，多行的 Body 有 240px
  const single = host.height <= 60;
  if (single) return { left, top: host.height + 6 };

  const top = Math.max(0, caret.top - PANEL_INSET);
  // 往下排得下就往下排，排不下翻到光标行上方
  if (top + panel.height <= host.height) return { left, top };

  return { left, top: Math.max(0, caret.top - panel.height) };
}

/**
 * 变量浮层的尺寸。
 *
 * 只用来判断「上方放不放得下」，不需要精确，但不能拍得太小 ——
 * 估小一半的话判断会过于乐观，浮层实际会一路顶到容器顶部盖住光标。
 * 两个浮层不会同时出现，所以取其中较大的那个（带搜索框的 VarPicker）就够：
 * CSS 里搜索框 32px + 列表上限 240px。
 */
export const VAR_PANEL_SIZE = { width: 320, height: 272 };

/**
 * 脚本补全浮层的尺寸。
 *
 * 比变量那个更宽（一行要放下名字 + 签名，如 HmacSHA256(msg, key)）、更矮
 * （一屏给 8 行左右够看，太长反而挡住要写的代码）。同样只用于判断往哪边摆。
 */
export const SCRIPT_PANEL_SIZE = { width: 380, height: 176 };

/** 插入按钮的边长。样式表里 .insert-btn 也是这个尺寸，改一处要记得另一处 */
const INSERT_BTN_SIZE = 20;

/**
 * 算出「插入数据」按钮该摆在哪儿 —— 贴在光标正右方。
 *
 * 横向：先空出约一个字符的宽度（gap）。贴着光标会让人不敢点，也容易误触。
 *       但不能无限往右 —— 光标停在行末时按钮会顶出输入框，所以要收边拉回来。
 *
 * 纵向分两种：
 *   多行 <textarea> —— 按光标所在行居中
 *   单行 <input>    —— 按框高居中。用「光标行」去算会偏上：
 *                      单行框里光标行的顶部就是 padding 顶，再减掉半个按钮高就冒出去了
 *
 * @param {{left:number, top:number, lineHeight:number}} caret 光标位置（相对容器）
 * @param {{width:number, height:number}} host 容器尺寸
 * @param {{multiline?:boolean, gap?:number}} [options]
 * @returns {{left:number, top:number}} 相对容器的坐标
 */
export function placeInsertBtn(caret, host, { multiline = false, gap = 10 } = {}) {
  // 收边时不能把「还没测量过」当成「宽度为 0」—— 那会把上限算成负数，
  // 按钮被直接拉到左上角去。首帧的 host.width 就是 0，这种情况不收边才对。
  // 正常收边时留 2px，免得按钮右边正好压在输入框的边框上；
  // 容器比按钮还窄时兜到 0，否则又会出现负数坐标
  const maxLeft = host.width > 0 ? Math.max(0, host.width - INSERT_BTN_SIZE - 2) : Infinity;
  const left = Math.min(caret.left + gap, maxLeft);

  const top = multiline
    ? Math.max(0, caret.top + (caret.lineHeight - INSERT_BTN_SIZE) / 2)
    : Math.max(0, (host.height - INSERT_BTN_SIZE) / 2);

  return { left, top };
}
