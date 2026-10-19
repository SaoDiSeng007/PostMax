import { defineComponent } from 'vue';

/**
 * 变量候选下拉。
 *
 * 相对「锚点容器」绝对定位，具体坐标由 placeNearCaret 跟着光标算出来：
 * 单行输入框贴在它下方，多行的 Body 则摆到光标上方（见 caret.js 里的说明）。
 *
 * 用 mousedown 而不是 click 来选中：click 要等鼠标抬起，那时输入框已经失焦，
 * 下拉被关掉了，根本选不中。
 */
export default defineComponent({
  name: 'VarSuggest',
  props: {
    items: { type: Array, required: true },
    activeIndex: { type: Number, default: 0 },
  },
  emits: ['pick', 'hover'],
  template: `
    <div class="var-suggest" v-if="items.length">
      <div
        class="var-suggest-item"
        v-for="(it, i) in items"
        :key="it.name"
        :class="{ active: i === activeIndex }"
        @mousedown.prevent="$emit('pick', it.name)"
        @mouseenter="$emit('hover', i)"
      >
        <span class="vs-name">{{ it.name }}</span>
        <span
          class="vs-value"
          :class="{ 'vs-empty': it.value === '' }"
          :title="it.desc || ''"
        >{{ it.value === '' ? '空值' : it.value }}</span>
      </div>
    </div>
    <div class="var-suggest no-match" v-else>没有匹配的变量</div>
  `,
});
