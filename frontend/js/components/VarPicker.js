import { computed, defineComponent, ref, watch } from 'vue';
import {
  buildGroupedCandidates,
  parseDatetimeOffset,
  resolveBuiltin,
} from '../varsuggest.js';

/**
 * 「插入数据」浮层。
 *
 * 贴在输入框下方（靠 CSS 的 absolute 定位），不是居中的模态框 ——
 * 插变量是高频小动作，每次走一遍「遮罩 → 选 → 关」太打断节奏，
 * 而且模态框会把整个界面推到背景里，反而看不见自己正往哪插。
 *
 * 它和 {{ 补全那个下拉共用 buildVarCandidates / applyVarPick 那一套，
 * 只是这里多一个搜索框、多了分组标题。
 */
export default defineComponent({
  name: 'VarPicker',
  props: {
    vars: { type: Object, default: () => ({}) },
  },
  emits: ['pick', 'close'],
  setup(props, { emit }) {
    const query = ref('');
    const activeIndex = ref(0);

    const groups = computed(() => buildGroupedCandidates(props.vars, query.value));

    /** 拍平成一条线：上下键只需要在一个列表里移动，不用管分组边界 */
    const flat = computed(() => groups.value.flatMap((g) => g.items));

    // 换了关键词就从第一个重新开始
    watch(query, () => {
      activeIndex.value = 0;
    });

    function pick(item) {
      if (item) emit('pick', item.name);
    }

    function onKeydown(event) {
      const total = flat.value.length;

      if (event.key === 'Escape') {
        emit('close');
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!total) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex.value = (activeIndex.value + step + total) % total;
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        pick(flat.value[activeIndex.value]);
      }
    }

    /** 某项在扁平列表里的位置，用来决定高亮哪一项 */
    const indexOf = (name) => flat.value.findIndex((it) => it.name === name);

    /*
     * ---------------- 时间偏移：敲偏移，插进去的是对应的时间 ----------------
     *
     * 输入框收的是**偏移本身**（-8h / +2h30m / -1d12h），不是「符号 + 数字 + 单位」
     * 三个控件 —— 那样拼不出 2h30m 这种叠写的偏移，可语法本来就支持。
     *
     * 也不摆一排写死的偏移供点选：能敲的东西没必要再列一遍，多一行就少一行列表。
     * 怎么写由占位提示和 README 说清楚就够了。
     *
     * 下面实时说清两件事：会插入哪个变量名、那个变量此刻算出来是什么时间。
     * 时间格式固定是 YYYY-MM-DD HH:mm:ss，和别处显示时间一个样式。
     */
    const offsetText = ref('');
    const offset = computed(() => parseDatetimeOffset(offsetText.value));

    /** 合法时给「{{名字}} = 算出来的时间」；不合法就把原因顶上来，不留一个说不清的结果 */
    const offsetPreview = computed(() =>
      offset.value.ok
        ? `{{${offset.value.name}}} = ${resolveBuiltin(offset.value.name) ?? ''}`
        : offset.value.error
    );

    const offsetTitle = computed(() => `插入 {{${offset.value.name}}}`);

    const pickOffset = () => {
      if (offset.value.ok) emit('pick', offset.value.name);
    };

    /** 偏移框自己拦下了 keydown（见模板），所以 Esc 得在这儿补一次 —— 不然搜索框能关、这里关不掉 */
    const closePanel = () => emit('close');

    return {
      query, activeIndex, groups, flat, pick, onKeydown, indexOf,
      offsetText, offset, offsetPreview, offsetTitle, pickOffset, closePanel,
    };
  },
  template: `
    <div class="var-picker" @keydown="onKeydown">
      <input
        v-focus
        class="var-picker-search"
        v-model="query"
        placeholder="搜索变量…"
        spellcheck="false"
      />
      <!--
        时间偏移：@keydown.stop 是必须的 —— 不拦住的话，在这个输入框里按方向键
        会去挪列表的高亮；回车本来该「插入」，也会被列表截胡。
        代价是外层的 Esc（关浮层）也一起被拦掉了，所以这里单独补一个 @keydown.esc。
      -->
      <div class="var-picker-offset" @keydown.stop @keydown.esc="closePanel" @keyup.enter="pickOffset">
        <div class="vpo-row">
          <span class="vpo-label">时间偏移</span>
          <input
            class="vpo-input"
            :class="{ 'vpo-bad': !offset.ok }"
            v-model="offsetText"
            placeholder="留空就是此刻；如 -8h、+2h30m、-1d12h"
            spellcheck="false"
          />
          <button
            class="vpo-insert"
            :disabled="!offset.ok"
            :title="offsetTitle"
            @mousedown.prevent="pickOffset"
          >插入</button>
        </div>
        <div class="vpo-preview" :class="{ 'vpo-bad': !offset.ok }">{{ offsetPreview }}</div>
      </div>
      <div class="var-picker-body">
        <template v-for="g in groups" :key="g.title">
          <div class="var-picker-title">{{ g.title }}</div>
          <div
            class="var-picker-item"
            v-for="it in g.items"
            :key="it.name"
            :class="{ active: indexOf(it.name) === activeIndex }"
            @mousedown.prevent="pick(it)"
            @mouseenter="activeIndex = indexOf(it.name)"
          >
            <span class="vp-name">{{ it.name }}</span>
            <span
              class="vp-value"
              :class="{ 'vp-empty': it.value === '' }"
              :title="it.desc || ''"
            >{{ it.value === '' ? '空值' : it.value }}</span>
          </div>
        </template>
        <div class="var-picker-empty" v-if="!groups.length">没有匹配的变量</div>
      </div>
    </div>
  `,
});
