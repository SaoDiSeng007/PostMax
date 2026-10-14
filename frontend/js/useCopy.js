// ---------------------------------------------------------------------------
// 「复制 + 已复制闪一下」的模式，之前在 10 个组件里各写一遍（约 65 处）。
// 收在这里的只有这个交互模式 —— 两种形态对应两种 UI：
//   · useCopy：多行各自反馈，key 区分是哪一行在闪（时间戳 / UUID / JSON 路径）
//   · useCopyFlag：一个组件只有一处复制，boolean 够用（复制完整响应 / curl）
// 都在组件卸载时清掉定时器。
// ---------------------------------------------------------------------------

import { onUnmounted, ref } from 'vue';
import { copyText } from './clipboard.js';

/** 多行各自闪。copy(text, key) 成了返回 true，调用方好决定要不要补错误提示 */
export function useCopy(holdMs = 1500) {
  const copied = ref('');
  let timer = 0;
  async function copy(text, key = 'copied') {
    if (!(await copyText(text))) return false;
    copied.value = key;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = ''), holdMs);
    return true;
  }
  onUnmounted(() => clearTimeout(timer));
  return { copied, copy };
}

/** 单处闪。copy(text) 成了返回 true */
export function useCopyFlag(holdMs = 1500) {
  const copied = ref(false);
  let timer = 0;
  async function copy(text) {
    if (!(await copyText(text))) return false;
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), holdMs);
    return true;
  }
  onUnmounted(() => clearTimeout(timer));
  return { copied, copy };
}
