import { defineComponent, ref } from 'vue';

/**
 * 一个小「?」。
 *
 * 说明文字默认收起来，鼠标悬停（或键盘聚焦）才展开。一大段功能说明常驻在
 * 页面上，九成时候用不到，却把真正要看的东西淹了 —— 该在哪儿写清楚、
 * 想看的人自己去点，而不是糊在每一屏上。
 *
 * 气泡用 fixed 定位到视口（而不是 absolute 挂在「?」旁边）：运行设置那栏
 * overflow:auto，absolute 气泡一超出栏就被裁掉、被左边界面盖住。fixed 跟着
 * 视口走，再也不会被任何祖先的 overflow 裁掉；定位时顺手避开右边缘出屏。
 */
export default defineComponent({
  name: 'InfoTip',
  props: {
    text: { type: String, default: '' },
  },
  setup() {
    const tipEl = ref(null);
    const pos = ref({ left: 0, top: 0, show: false });

    const place = () => {
      const el = tipEl.value;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const maxW = 280;
      let left = r.left;
      // 右边剩不下就往左挪，最少贴 8px；左边同理，避免气泡出屏被窗口裁
      if (left + maxW > window.innerWidth - 8) left = window.innerWidth - 8 - maxW;
      if (left < 8) left = 8;
      pos.value = { left, top: r.bottom + 6, show: true };
    };
    const hide = () => {
      pos.value = { ...pos.value, show: false };
    };

    return { tipEl, pos, place, hide };
  },
  template: `
    <span
      class="info-tip"
      ref="tipEl"
      tabindex="0"
      :aria-label="text"
      @mouseenter="place"
      @focus="place"
      @mouseleave="hide"
      @blur="hide"
    >?
      <span
        class="info-bubble"
        role="tooltip"
        v-show="pos.show"
        :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      >{{ text }}</span>
    </span>
  `,
});
