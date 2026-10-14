// ---------------------------------------------------------------------------
// 输入框的「变量补全」+「插入数据浮层」
//
// 这两件事原先在 Body（RequestEditor）和键值表格（KeyValueTable）里各写了一遍，
// 一百多行几乎逐字相同 —— 改一边漏一边是迟早的事（浮层关闭行为就已经漏过一次），
// 所以收到这里来。差异只有三处，都做成参数：
//
//   getVars()     当前的变量表（环境变量 + 当前用户的认证信息，外面已经合并好）
//   getHost()     正被编辑的那个输入框。Body 固定是它自己；表格是当前编辑的那一行
//   commit(text)  把改好的内容写回去。Body 写进 request.body；表格写进对应那一行
//
// 浮层本身不在这里渲染 —— 组件拿 suggest / pickerOpen 自己决定挂在哪，
// 位置用 pickerStyle / insertBtnStyle 取。
// ---------------------------------------------------------------------------

import { computed, nextTick, reactive, ref } from 'vue';
import { applyVarPick, buildVarCandidates, detectVarTrigger } from './varsuggest.js';
import { VAR_PANEL_SIZE, caretOffset, placeInsertBtn, placeNearCaret, placeNearCaretFixed } from './caret.js';

/**
 * 默认策略：`{{变量}}`。
 *
 * 这一套（触发 → 候选 → 替换）做成可传入的，是因为脚本编辑器要的是另一种：
 * 那边认的是标识符和点（env. / CryptoJS.enc.），插进去的东西还带引号和光标落点。
 * 浮层怎么弹、光标怎么量、怎么撤销友好地插进去，两边完全一样 —— 差别就这三件事。
 */
const VAR_SUGGEST = {
  detect: (text, caret) => detectVarTrigger(text, caret),
  candidates: (vars, trigger) => buildVarCandidates(vars, trigger.query),
  // 点候选传的是名字，键盘选中传的是整条，两种都得认
  apply: (text, start, caret, picked) =>
    applyVarPick(text, start, caret, typeof picked === 'string' ? picked : picked.name),
};

/**
 * @param {Object} options
 * @param {() => Object} options.getVars 取当前变量表，返回空值表示这个输入框不启用补全
 * @param {() => (HTMLElement|null)} options.getHost 取当前输入框
 * @param {(text: string) => void} options.commit 把新内容写回数据源
 * @param {boolean} [options.multiline] 输入框是不是多行的（决定按钮纵向怎么对齐）
 * @param {boolean} [options.pinPanel] 「插入数据」浮层钉在输入框左上角，不跟光标走
 * @param {() => Object} [options.getSuggest] 取策略（触发 / 候选 / 替换）。默认 {{变量}}，
 *   脚本编辑器传另一份；用函数传是为了读得到当下的上下文（比如「现在是后置脚本吗」）
 * @param {{width:number, height:number}} [options.panelSize] 候选浮层尺寸，只用于判断往哪边摆
 */
export function useVarInsert({
  getVars,
  getHost,
  commit,
  multiline = false,
  pinPanel = false,
  getSuggest = () => VAR_SUGGEST,
  panelSize = VAR_PANEL_SIZE,
}) {
  // {{ 补全：跟着键盘走的下拉
  const suggest = reactive({ open: false, index: 0, start: -1, caret: 0, items: [] });

  // 「插入数据」浮层：点按钮才开
  const pickerOpen = ref(false);

  // 焦点在不在这一片。插入按钮和表格行的状态都看它
  const focused = ref(false);

  // 光标位置（相对输入框内容区，已扣掉滚动偏移）和容器尺寸。
  // scrollLeft / scrollTop 额外留给高亮层用 —— 它得跟着输入框一起滚。
  // pageLeft / pageTop 是同一根光标的**视口坐标**，给候选浮层用（见 placeNearCaretFixed）
  const caretPos = reactive({ left: 0, top: 0, lineHeight: 16, scrollLeft: 0, scrollTop: 0, pageLeft: 0, pageTop: 0 });
  const anchorSize = reactive({ width: 0, height: 0 });
  // 输入框在视口里的位置（编辑器一滚就变，所以每次量光标时一起量）
  const anchorBox = reactive({ top: 0, bottom: 0, height: 0 });

  /**
   * 重新量一次光标位置。
   *
   * 输入、点选、按方向键、**滚动**之后都要调 —— 少一个，浮层就会跟丢，
   * 贴在一条已经不存在的位置上，高亮层也会和文字错开。
   */
  function measure() {
    const el = getHost();
    if (!el) return;

    const offset = caretOffset(el);
    caretPos.left = offset.left - el.scrollLeft;
    caretPos.top = offset.top - el.scrollTop;
    caretPos.lineHeight = offset.lineHeight;
    caretPos.scrollLeft = el.scrollLeft;
    caretPos.scrollTop = el.scrollTop;

    // 视口坐标：输入框在窗口里的位置 + 光标在内容里的位置，再扣掉输入框自己的滚动
    const rect = el.getBoundingClientRect();
    caretPos.pageLeft = rect.left + caretPos.left;
    caretPos.pageTop = rect.top + caretPos.top;
    anchorBox.top = rect.top;
    anchorBox.bottom = rect.bottom;
    anchorBox.height = el.clientHeight;

    anchorSize.width = el.clientWidth;
    anchorSize.height = el.clientHeight;
  }

  /** 收起两个浮层，什么都不选。 */
  function close() {
    suggest.open = false;
    pickerOpen.value = false;
  }

  /** 把光标放回指定位置。不这样做的话，Vue 重渲染之后光标会跳回开头。 */
  function restoreCaret(el, caret) {
    nextTick(() => {
      el.focus();
      el.setSelectionRange(caret, caret);

      /*
       * 插完如果光标正好停在刚开的引号里（脚本里插了个 get('')），下一步必然是写变量名。
       * 这里直接把候选换成变量表，省掉一次按键 —— 光标落在别处就不动，免得插完还弹着
       * 没完没了。要不要重开由策略的 afterPick 说了算。
       */
      const strategy = getSuggest();
      if (strategy.afterPick && strategy.afterPick(el.value, caret)) refresh();
    });
  }

  /**
   * 把改动**写进输入框本身**，而不是算出新文本再整个塞回数据源。
   *
   * 差别在撤销：直接换 `:value` 只是换了个字符串，浏览器的撤销栈里根本没有这一步
   * —— 插完变量按 Ctrl+Z 撤不回来（人会觉得是自己手滑删了东西）。
   * 走 `execCommand('insertText')` 是**真的在编辑**：撤销栈里有它，Ctrl+Z 能撤；
   * 它同时照常触发 input 事件，v-model 照样同步，所以数据不会丢。
   *
   * insertText 虽然被标了 deprecated，但目前仍是**唯一**能让原生撤销生效的写入方式
   * （`setRangeText` 之类都只是改值）。真失效了就退回老办法：功能还在，只是撤销不了。
   */
  function writeText(el, result) {
    el.focus();
    // 先选中要被替换的那一段，insertText 就会用它当插入点
    el.setSelectionRange(result.start, result.end);

    let done = false;
    try {
      done = document.execCommand('insertText', false, result.inserted);
    } catch {
      done = false;
    }

    if (!done) {
      const value = el.value.slice(0, result.start) + result.inserted + el.value.slice(result.end);
      commit(value);
    }
    restoreCaret(el, result.caret);
  }

  /**
   * 按当前内容 + 光标位置重算候选。
   *
   * 输入时要算，「插完光标落在引号里」时也要算 —— 所以单独抽出来，
   * 不跟事件对象绑死。
   */
  function refresh(el) {
    if (!getVars()) return;

    // 敲字那条路径直接给出事件里的输入框（表格里每行一个框，别认错行）
    const host = el || getHost();
    if (!host) return;

    const trigger = getSuggest().detect(host.value, host.selectionStart);
    if (!trigger.active) {
      suggest.open = false;
      return;
    }

    suggest.items = getSuggest().candidates(getVars(), trigger);
    suggest.start = trigger.start;
    suggest.caret = host.selectionStart;
    suggest.index = 0;
    suggest.open = true;
  }

  /** 敲字时重新判断该不该弹候选。 */
  function onInput(event) {
    measure();
    refresh(event && event.target);
  }

  /** 选中候选项：把触发点到光标这一段换掉，光标落在策略指定的位置。 */
  function pick(picked) {
    const el = getHost();
    if (!el) return;

    const result = getSuggest().apply(el.value, suggest.start, suggest.caret, picked);
    suggest.open = false;
    writeText(el, result);
  }

  /** 点「插入数据」按钮：先把光标定住，再开浮层。 */
  function openPanel() {
    measure();
    suggest.open = false; // 两个浮层不同时开，免得叠在一起
    pickerOpen.value = true;
  }

  /** 从浮层里选了一个变量：插在光标处。 */
  function insert(name) {
    const el = getHost();
    if (!el) return;

    // 这里是「插入」不是「替换已有输入」：起点和终点都用当前光标
    const caret = el.selectionStart;
    const result = applyVarPick(el.value, caret, caret, name);
    pickerOpen.value = false;
    writeText(el, result);
  }

  /** 候选列表的键盘操作：上下选、回车插入、Esc 关掉。 */
  function onKeydown(event) {
    if (!suggest.open) return;

    if (event.key === 'Escape') {
      suggest.open = false;
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const total = suggest.items.length;
      if (!total) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      suggest.index = (suggest.index + step + total) % total;
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // 有候选时先用来选中，别顺手把请求发出去了
      if (!suggest.items.length) return;
      event.preventDefault();
      pick(suggest.items[suggest.index]);
    }
  }

  function onFocus() {
    focused.value = true;
    measure();
  }

  /**
   * 焦点离开这一片时收摊（focusout 冒泡，挂在容器上就够了）。
   *
   * 判断标准只有一条：**焦点还在不在这个容器里**。
   * 手从输入框伸向浮层的途中会经过好几个节点，只要还在这一片就不能关，
   * 否则刚伸过去它就没了。跑到容器外（点到空白处时 relatedTarget 为 null）才全关。
   *
   * 注意「点了输入框内部就收起浮层」不归这里管 —— 那种情况焦点压根没动，
   * focusout 根本不会触发，得靠输入框上的 @mousedown。
   *
   * @returns {boolean} 是否真的离开了。组件据此决定要不要收起自己的按钮 / 行状态
   */
  function onBlur(event) {
    const next = event.relatedTarget;
    if (next && event.currentTarget.contains(next)) return false;

    close();
    focused.value = false;
    return true;
  }

  /**
   * caret.js 里那两个定位函数算出来的是**纯数字**，交给 :style 之前必须补 px。
   *
   * CSSOM 只认 `0` 这一个无单位长度，`left: 110` 属于非法值会被整条丢掉，
   * 元素于是退回静态位置 —— 看起来就是「按钮跑到输入框外面去了」。
   * （`top: 0` 恰好合法，所以症状只在横向上发作。）
   */
  function toPx(pos) {
    return { left: `${pos.left}px`, top: `${pos.top}px` };
  }

  const insertBtnStyle = computed(() => toPx(placeInsertBtn(caretPos, anchorSize, { multiline })));

  /**
   * 候选下拉：一直跟着光标，敲到哪跟到哪。
   *
   * 走视口坐标（元素上是 position: fixed）—— 编辑器的祖先有 overflow 裁切，
   * 按容器摆的话「第一项和光标同一行」根本做不到，只能翻到光标上方。
   */
  const suggestStyle = computed(() =>
    toPx(
      placeNearCaretFixed(
        { left: caretPos.pageLeft, top: caretPos.pageTop, lineHeight: caretPos.lineHeight },
        anchorBox,
        { width: window.innerWidth, height: window.innerHeight },
        panelSize
      )
    )
  );

  /**
   * 「插入数据」浮层。
   *
   * pinPanel 那套（Body）把它钉在输入框左上角：Body 有 240px 高、内容又多，
   * 跟着光标跑反而晃眼，钉住更好找。表格那边输入框只有一行，跟着走才贴切。
   */
  const pickerStyle = computed(() =>
    pinPanel
      ? { left: '0px', top: '0px' }
      : toPx(placeNearCaret(caretPos, anchorSize, VAR_PANEL_SIZE))
  );

  return {
    suggest, pickerOpen, focused,
    caretPos, anchorSize,
    insertBtnStyle, suggestStyle, pickerStyle,
    measure, close, onInput, pick, openPanel, insert, onKeydown, onFocus, onBlur,
  };
}
