import { defineComponent } from 'vue';

/**
 * 脚本补全的候选下拉。
 *
 * 和 VarSuggest（变量那个）是姊妹件，区别只在「一行里显示什么」：那边显示
 * 「名字 + 当前值」，这边显示「名字 + 签名」，变量名的候选走同一套组件也行 ——
 * detail 字段装什么就显示什么，所以这里不用为变量名单开一个分支。
 *
 * 定位、键盘上下选、插入方式都由 useVarInsert 管（两端共用），这里只管画。
 * 用 mousedown 而不是 click：click 要等鼠标抬起，那会儿输入框已经失焦、下拉没了。
 */
export default defineComponent({
  name: 'ScriptSuggest',
  props: {
    items: { type: Array, required: true },
    activeIndex: { type: Number, default: 0 },
  },
  emits: ['pick', 'hover'],
  template: `
    <div class="sc-suggest" v-if="items.length">
      <div
        class="sc-item"
        v-for="(it, i) in items"
        :key="it.label + '-' + i"
        :class="{ active: i === activeIndex, 'sc-var': it.kind === 'var' }"
        @mousedown.prevent="$emit('pick', it)"
        @mouseenter="$emit('hover', i)"
      >
        <span class="sc-name">{{ it.label }}</span>
        <span class="sc-detail" :title="it.doc || it.detail">{{ it.detail }}</span>
      </div>
    </div>
  `,
});
