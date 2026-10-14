// ---------------------------------------------------------------------------
// 「看一份响应」的折叠树 —— 接口页、历史详情、方案报告三处共用。
// 从 ResponsePanel 挪成独立组件：它不该既是组件又是别人的工具库。
//
// 搜索定位靠 `jt` 注入（关键词 / 当前命中路径）。不 provide 也能用，
// 那样就是纯粹的一棵树，不高亮、不定位。
// ---------------------------------------------------------------------------

import { computed, defineComponent, inject, nextTick, ref, watch } from 'vue';
import Caret from './Caret.js';

/**
 * 把文本按关键词切成片段，只给命中的那几段加高亮。
 * 搜 "id" 时 user_id 只亮 "id" 两个字符，而不是整块变色。
 */
function splitHighlight(text, keyword) {
  const src = text === null || text === undefined ? '' : String(text);
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return [{ text: src, hit: false }];

  const haystack = src.toLowerCase();
  const parts = [];
  let cursor = 0;

  while (cursor < src.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at < 0) {
      parts.push({ text: src.slice(cursor), hit: false });
      break;
    }
    if (at > cursor) parts.push({ text: src.slice(cursor, at), hit: false });
    parts.push({ text: src.slice(at, at + needle.length), hit: true });
    cursor = at + needle.length;
  }

  return parts.length ? parts : [{ text: src, hit: false }];
}

/**
 * JSON 树一次先画多少个字段 / 元素。剩下的点「还有 N 项」再补。
 *
 * 200 是权衡：一屏最多也就看几十行，先画 200 行足够滚动浏览，又不会让一个大数组
 * 一上来就生成上万 DOM 节点。
 */
const CHILD_BATCH = 200;

export default defineComponent({
  name: 'JsonNode',
  components: { Caret },
  props: {
    data: { default: null },
    label: { type: String, default: '' },
    path: { type: String, default: '' },
    depth: { type: Number, default: 0 },
  },
  setup(props) {
    const open = ref(props.depth < 2);
    const rootEl = ref(null);
    const jt = inject('jt', null);

    const keyword = computed(() => (jt ? String(jt.keyword || '').trim().toLowerCase() : ''));

    const kind = computed(() => {
      const v = props.data;
      if (v === null || v === undefined) return 'null';
      if (Array.isArray(v)) return 'array';
      if (typeof v === 'object') return 'object';
      if (typeof v === 'string') return 'string';
      if (typeof v === 'number') return 'number';
      if (typeof v === 'boolean') return 'boolean';
      return 'null';
    });

    const isBranch = computed(() => kind.value === 'array' || kind.value === 'object');

    const entries = computed(() =>
      isBranch.value ? Object.entries(props.data).map(([k, v]) => ({ k, v })) : []
    );

    const display = computed(() => {
      if (kind.value === 'string') return JSON.stringify(props.data);
      if (kind.value === 'null') return 'null';
      return String(props.data);
    });

    const brace = computed(() => (kind.value === 'array' ? ['[', ']'] : ['{', '}']));

    // 只高亮命中的那几个字符，而不是整个 key / value
    const labelParts = computed(() => splitHighlight(props.label, keyword.value));
    const valueParts = computed(() => splitHighlight(display.value, keyword.value));

    const isCurrent = computed(() => !!jt && jt.currentPath === props.path);

    /**
     * 一次先画多少个字段 / 元素。
     *
     * 一个几万键的对象（或几万元素的数组）全画出来，浏览器要僵住好几秒 —— 而这个
     * 工具恰恰是用来「看大响应」的。先画前一批，剩下的点「还有 N 项」再补。
     * 折叠着的分支不渲染子节点，所以这个上限只影响真正铺开的那一层。
     */
    const shown = ref(CHILD_BATCH);
    const visibleEntries = computed(() => entries.value.slice(0, shown.value));
    const hiddenCount = computed(() => Math.max(0, entries.value.length - visibleEntries.value.length));
    const showMore = () => {
      shown.value += CHILD_BATCH;
    };

    // 换了一份数据（同一路径下重新渲染）就回到第一批，别把上一份的「展开量」带过来
    watch(
      () => props.data,
      () => {
        if (shown.value > CHILD_BATCH) shown.value = CHILD_BATCH;
      }
    );

    // 搜索时把整棵树铺开，否则匹配项可能藏在折叠的分支里
    watch(keyword, (kw) => {
      if (kw) open.value = true;
    });

    /**
     * 命中的子项排在第一批之外时，把它那一批也补出来。
     *
     * 不补的话，「跳到第 812 项」会滚到一个**根本没渲染**的节点上 —— 看着像定位失灵。
     * 补到批边界为止（不是 index + 1），免得一个命中就把五千个子项全铺开。
     */
    watch(
      () => (jt ? jt.currentPath : ''),
      (target) => {
        if (!target || !isBranch.value) return;
        const prefix = props.path ? `${props.path}.` : '';
        if (!target.startsWith(prefix)) return;
        // 命中在更深一层：那是子节点自己的事，这里不管
        const rest = target.slice(prefix.length);
        if (!rest || rest.includes('.')) return;

        const index = entries.value.findIndex((e) => String(e.k) === rest);
        if (index >= shown.value) {
          shown.value = Math.ceil((index + 1) / CHILD_BATCH) * CHILD_BATCH;
        }
      }
    );

    // 当前匹配项滚动到可视区
    watch(isCurrent, async (current) => {
      if (!current) return;
      await nextTick();
      if (rootEl.value) rootEl.value.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });

    return {
      open, rootEl, kind, isBranch, entries, visibleEntries, hiddenCount, showMore,
      display, brace, labelParts, valueParts, isCurrent,
    };
  },
  template: `
    <div ref="rootEl">
      <div class="jt-line" :class="{ 'jt-line-current': isCurrent }">
        <!--
          折叠开关用 button 而不是 span：键盘要能聚焦、要能按回车展开。
          叶子节点没有可折叠的东西，用 disabled 让它退出 Tab 顺序（顺带被读屏忽略）。
        -->
        <button
          class="jt-toggle"
          :class="{ leaf: !isBranch }"
          :disabled="!isBranch"
          :aria-expanded="isBranch ? (open ? 'true' : 'false') : undefined"
          :aria-label="isBranch ? (open ? '收起' : '展开') : undefined"
          @click="isBranch && (open = !open)"
        ><Caret v-if="isBranch" :open="open" /></button>
        <span>
          <span class="jt-key" v-if="label !== ''"><span
            v-for="(p, i) in labelParts"
            :key="i"
            :class="{ 'jt-hit': p.hit && !isCurrent, 'jt-current': p.hit && isCurrent }"
          >{{ p.text }}</span></span><span class="jt-colon" v-if="label !== ''">: </span>
          <template v-if="isBranch">
            <span class="jt-colon">{{ open ? brace[0] : brace[0] + brace[1] }}</span>
            <span class="jt-count" v-if="!open"> {{ entries.length }} 项</span>
          </template>
          <span v-else :class="'jt-' + kind"><span
            v-for="(p, i) in valueParts"
            :key="i"
            :class="{ 'jt-hit': p.hit && !isCurrent, 'jt-current': p.hit && isCurrent }"
          >{{ p.text }}</span></span>
        </span>
      </div>
      <div class="jt-children" v-if="isBranch && open">
        <JsonNode
          v-for="e in visibleEntries"
          :key="e.k"
          :data="e.v"
          :label="e.k"
          :path="path ? path + '.' + e.k : e.k"
          :depth="depth + 1"
        />
        <!-- 大数组 / 大对象分批渲染：剩下的点一下再补，别一上来就生成上万个节点 -->
        <button class="jt-more" v-if="hiddenCount" @click="showMore">
          还有 {{ hiddenCount }} 项…
        </button>
      </div>
    </div>
  `,
});
