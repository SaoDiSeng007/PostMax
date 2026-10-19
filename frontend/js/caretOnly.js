// ---------------------------------------------------------------------------
// 展示区「可定位光标但不可编辑」：拦掉一切会改动内容的操作 —— 输入、输入法
// 组字、粘贴、剪切、拖放。这些都是可取消事件，拦掉之后光标、拖选、复制
// 仍然完全正常。
//
// 之前在响应面板 / 历史详情 / 方案报告逐字重复了三份。
// ---------------------------------------------------------------------------

export const caretOnly = {
  contenteditable: 'true',
  spellcheck: 'false',
  onBeforeinput: (e) => e.preventDefault(),
  onCompositionstart: (e) => e.preventDefault(),
  onPaste: (e) => e.preventDefault(),
  onCut: (e) => e.preventDefault(),
  onDragstart: (e) => e.preventDefault(),
  onDrop: (e) => e.preventDefault(),
  onDragover: (e) => e.preventDefault(),
};
