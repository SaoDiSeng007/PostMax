import { computed, defineComponent, ref, watch } from 'vue';

/**
 * 正则测试。
 *
 * 写 pattern、勾 flags，样本上标出命中、下面列出每个匹配和分组。
 * 断言里 matches 操作符写完正则，不确定它到底吃哪段 —— 来这儿试。
 *
 * 样本高亮只处理整段匹配；分组在下面的明细里看。g 没勾的时候只有第一处
 * 会亮（这是正则本身的语义，不是工具的毛病），所以说一句。
 */
export default defineComponent({
  name: 'WbRegex',
  setup() {
    const pattern = ref('');
    const sample = ref('');
    const flags = ref({ g: true, i: false, m: false, s: false, u: false });
    /** { error } | { error:'', matches:[{ text, index, groups, named }], segs: [{text, hit}] } */
    const result = ref({ error: '', matches: [], segs: [] });

    function run() {
      const p = pattern.value;
      if (!p) {
        result.value = { error: '', matches: [], segs: [] };
        return;
      }
      const f = Object.keys(flags.value)
        .filter((k) => flags.value[k])
        .join('');
      let re;
      try {
        re = new RegExp(p, f);
      } catch (e) {
        result.value = { error: (e && e.message) || String(e), matches: [], segs: [] };
        return;
      }
      result.value = { error: '', ...matchAll(re, sample.value, flags.value.g) };
    }

    /** 把样本切成「普通 / 命中」两色片段，并把每个匹配连同分组收出来 */
    function matchAll(re, text, global) {
      const segs = [];
      const matches = [];
      let last = 0;
      let guard = 0;
      const re2 = new RegExp(re.source, global ? re.flags : re.flags.replace('g', ''));
      let m;
      while ((m = re2.exec(text))) {
        matches.push({
          text: m[0],
          index: m.index,
          groups: m.slice(1).map((g) => (g === undefined ? null : g)),
          named: m.groups ? { ...m.groups } : null,
        });
        if (m.index > last) segs.push({ text: text.slice(last, m.index), hit: false });
        segs.push({ text: m[0], hit: true });
        last = m.index + m[0].length;
        // 空匹配会原地打转：往前挪一个字符
        if (m[0] === '') {
          if (!global) break;
          re2.lastIndex++;
          last++;
        }
        if (!global) break;
        if (++guard > 10000) break; // 兜底：样本异常大时别把页面卡死
      }
      if (last < text.length) segs.push({ text: text.slice(last), hit: false });
      return { matches, segs };
    }

    // pattern / 样本 / flags 任何一个变了都重算。边打边算不能逐键跑，
    // 缓 200ms —— 不然长样本一贴进来每敲一个字都全文 exec 一遍。
    let timer = 0;
    watch([pattern, sample, flags], () => {
      clearTimeout(timer);
      timer = setTimeout(run, 200);
    }, { deep: true });

    const matchCount = computed(() => result.value.matches.length);

    return { pattern, sample, flags, result, matchCount };
  },
  template: `
    <div class="wb-tool">
      <div class="wb-field">
        <span class="wb-label">正则</span>
        <div class="wb-line">
          <span class="wb-slash">/</span>
          <input class="wb-in wb-grow" v-model="pattern" placeholder="如 \\d{4}-\\d{2}" spellcheck="false" />
          <span class="wb-slash">/</span>
          <label class="wb-check" v-for="f in ['g','i','m','s','u']" :key="f">
            <input type="checkbox" v-model="flags[f]" />{{ f }}
          </label>
        </div>
        <span class="error-text" v-if="result.error">{{ result.error }}</span>
      </div>

      <div class="wb-field">
        <span class="wb-label">样本</span>
        <textarea
          class="wb-ta wb-ta-sm"
          v-model="sample"
          placeholder="把要测的响应片段贴进来"
          spellcheck="false"
        ></textarea>
      </div>

      <template v-if="pattern && sample && !result.error">
        <div class="wb-field">
          <span class="wb-label">
            命中
            <span class="wb-chip" v-if="matchCount">{{ matchCount }} 处</span>
            <span class="wb-label-hint" v-else>没有命中</span>
            <span class="wb-label-hint" v-if="matchCount === 1 && flags.g === false">没勾 g，只标第一处</span>
          </span>
          <div class="wb-out wb-hl"><template v-for="(s, i) in result.segs" :key="i"><mark class="jt-hit" v-if="s.hit">{{ s.text }}</mark><template v-else>{{ s.text }}</template></template></div>
        </div>

        <div class="wb-field" v-if="matchCount">
          <span class="wb-label">匹配明细</span>
          <div class="wb-out">
            <div class="wb-mrow" v-for="(m, i) in result.matches" :key="i">
              <span class="wb-mno">#{{ i + 1 }}</span>
              <span class="wb-kv-val">{{ JSON.stringify(m.text) }}</span>
              <span class="wb-gchips" v-if="m.groups.length || m.named">
                <span class="wb-gchip" v-for="(g, gi) in m.groups" :key="'g' + gi">\${{ gi + 1 }}={{ g === null ? '∅' : JSON.stringify(g) }}</span>
                <span class="wb-gchip" v-for="(g, k) in m.named" :key="'n' + k">{{ k }}={{ JSON.stringify(g) }}</span>
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>
  `,
});
