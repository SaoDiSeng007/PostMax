import { computed, defineComponent, ref } from 'vue';
import { diffLines, normalizeJson } from '../textdiff.js';

/**
 * 文本对比。
 *
 * 两边贴文本，逐行标出：只有左边有的画红、只有右边有的画绿。
 * 两边都是 JSON 时勾「归一后比」—— 键序、缩进不同不算差异，只比内容。
 *
 * 行数封顶在 textdiff.MAX_LINES：再大就不是这个工具该干的事了。
 */
export default defineComponent({
  name: 'WbDiff',
  setup() {
    const left = ref('');
    const right = ref('');
    const jsonMode = ref(false);
    const onlyDiff = ref(false);
    const tooBig = ref(false);
    /** diffLines 的 ops 结果；null = 还没跑过 */
    const ops = ref(null);

    function run() {
      let a = left.value;
      let b = right.value;
      // 归一：先把两边都摆成同样的键序和缩进，再进逐行比
      if (jsonMode.value) {
        a = normalizeJson(a) ?? left.value;
        b = normalizeJson(b) ?? right.value;
      }
      const out = diffLines(a, b);
      tooBig.value = !!out.tooBig;
      ops.value = out.tooBig ? null : out.ops;
    }

    const shown = computed(() => (ops.value && onlyDiff.value ? ops.value.filter((o) => o.type !== 'same') : ops.value));

    const stats = computed(() => {
      if (!ops.value) return null;
      let del = 0;
      let add = 0;
      let same = 0;
      for (const o of ops.value) {
        if (o.type === 'del') del++;
        else if (o.type === 'add') add++;
        else same++;
      }
      return { del, add, same };
    });

    const identical = computed(() => stats.value && !stats.value.del && !stats.value.add);

    const swap = () => {
      [left.value, right.value] = [right.value, left.value];
      run();
    };

    const clear = () => {
      left.value = '';
      right.value = '';
      ops.value = null;
      tooBig.value = false;
    };

    return { left, right, jsonMode, onlyDiff, tooBig, ops, shown, stats, identical, run, swap, clear };
  },
  template: `
    <div class="wb-tool">
      <div class="wb-grid2">
        <div class="wb-field">
          <span class="wb-label">左（旧）</span>
          <textarea class="wb-ta" v-model="left" spellcheck="false"></textarea>
        </div>
        <div class="wb-field">
          <span class="wb-label">右（新）</span>
          <textarea class="wb-ta" v-model="right" spellcheck="false"></textarea>
        </div>
      </div>

      <div class="wb-line">
        <button class="btn btn-primary btn-sm" type="button" @click="run" :disabled="!left && !right">对比</button>
        <label class="wb-check"><input type="checkbox" v-model="jsonMode" />按 JSON 归一后比（键序不算差异）</label>
        <label class="wb-check" v-if="ops"><input type="checkbox" v-model="onlyDiff" />只看差异</label>
        <span class="wb-grow"></span>
        <button class="btn btn-sm" type="button" @click="swap" :disabled="!left && !right" title="左右互换">⇄ 互换</button>
        <button class="btn btn-sm" type="button" @click="clear" :disabled="!left && !right">清空</button>
      </div>

      <p class="error-text" v-if="tooBig">文本太长（超过 3000 行），先删一删再比。</p>
      <p class="hint" v-else-if="!ops">两边各贴一段，点「对比」。比两次响应有什么不一样、改前改后差在哪，都用这儿。</p>

      <template v-else>
        <div class="wb-line">
          <span class="wb-chip" v-if="identical">两边一致</span>
          <template v-else>
            <span class="wb-chip">相同 {{ stats.same }} 行</span>
            <span class="wb-chip wb-chip-del" v-if="stats.del">只有左边 {{ stats.del }} 行</span>
            <span class="wb-chip wb-chip-add" v-if="stats.add">只有右边 {{ stats.add }} 行</span>
          </template>
        </div>

        <div class="wb-out wb-diff" v-if="shown.length">
          <div
            class="wb-diff-line"
            :class="{ del: o.type === 'del', add: o.type === 'add' }"
            v-for="(o, i) in shown"
            :key="i"
          >
            <span class="wb-diff-no">{{ o.aNo || '' }}</span>
            <span class="wb-diff-no">{{ o.bNo || '' }}</span>
            <span class="wb-diff-mark">{{ o.type === 'del' ? '−' : o.type === 'add' ? '+' : ' ' }}</span>
            <span>{{ o.text || ' ' }}</span>
          </div>
        </div>
      </template>
    </div>
  `,
});
