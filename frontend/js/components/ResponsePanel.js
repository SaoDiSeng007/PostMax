import { computed, defineComponent, inject, onUnmounted, provide, reactive, ref, watch } from 'vue';
import JsonNode from './JsonNode.js';
import ConsolePanel from './ConsolePanel.js';
import { flattenTree, formatValue, isPlainValue } from '../assert.js';
import { splitUnresolved } from '../api.js';
import { formatSize, truncateNotice } from '../format.js';
import { caretOnly } from '../caretOnly.js';
import { useCopyFlag } from '../useCopy.js';
import { parseJsonText } from '../jsonText.js';

/** 下方：响应状态 + Body / Headers / 实际请求 / 断言结果 / 控制台。 */
export default defineComponent({
  name: 'ResponsePanel',
  components: { JsonNode, ConsolePanel },
  props: {
    response: { type: Object, default: null },
    sending: { type: Boolean, default: false },
    error: { type: String, default: '' },
    /** 上一次发送是被「停止」叫停的。和 error 分开：不是失败，没什么可查的 */
    cancelled: { type: Boolean, default: false },
    assertions: { type: Array, default: () => [] },
    /** 控制台那一页：会话里脚本的 console 输出（不是请求日志） */
    consoleEntries: { type: Array, default: () => [] },
    consoleDropped: { type: Number, default: 0 },
  },
  emits: ['clear-console'],
  setup(props) {
    const tab = ref('body');
    const { copied, copy } = useCopyFlag();
    /** 复制失败时给一句话 —— 静默 return 会让人分不清「没点上」还是「不支持」 */
    const copyError = ref('');
    const currentIndex = ref(0);

    // 给 JSON 树用的控制信号（搜索关键词 / 当前定位到哪一项）
    const jt = reactive({ keyword: '', currentPath: '' });
    provide('jt', jt);

    // 搜索框防抖 200ms：大响应（上限 10MB）每敲一个键就是「2 万节点扫两遍
    // + 全树强制展开重渲染」，逐键跑整条链路是自找卡顿。等手停了再搜，
    // 输入体验没差别，重活从 N 次变 1 次
    const searchInput = ref('');
    let searchTimer = 0;
    watch(searchInput, () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => (jt.keyword = searchInput.value), 200);
    });
    onUnmounted(() => clearTimeout(searchTimer));

    const parsed = computed(() => parseJsonText(props.response?.body));

    /**
     * 能不能搜索：搜索是**按 JSON 节点**定位的（见 matchPaths），响应不是 JSON
     * 就没有节点可跳 —— 这时把搜索框禁用掉，而不是假装搜了但恒显示 0 / 0。
     */
    const canSearch = computed(() => parsed.value !== undefined);

    /**
     * 搜索最多扫多少个节点。
     *
     * 响应体本身可以有 10MB（见后端 MAX_BODY_BYTES），几万个键的 JSON 不罕见。
     * 每敲一个字母就把整棵树走一遍、再建一份路径数组，输入框会明显卡手。
     * 到上限就停，并在界面上说明「只扫了一部分」—— 宁可少报几条，也不能假装扫全了。
     */
    const SEARCH_NODE_LIMIT = 20000;

    /** 这次搜索扫过的节点（带上限）。命中列表与「是否被截」都从这一份出发 */
    const searchedNodes = computed(() => {
      if (!jt.keyword.trim() || parsed.value === undefined) return [];
      return flattenTree(parsed.value, '', '', [], SEARCH_NODE_LIMIT);
    });

    /** 响应大到只扫了一部分：界面上得说一句，别让人以为「就这几条」 */
    const searchCapped = computed(
      () => !!jt.keyword.trim() && searchedNodes.value.length >= SEARCH_NODE_LIMIT
    );

    /** 命中的节点路径列表 */
    const matchPaths = computed(() => {
      const kw = jt.keyword.trim().toLowerCase();
      if (!kw) return [];
      return searchedNodes.value
        .filter((node) => {
          const labelHit = node.label && node.label.toLowerCase().includes(kw);
          const valueHit =
            isPlainValue(node.value) &&
            String(node.value ?? '').toLowerCase().includes(kw);
          return labelHit || valueHit;
        })
        .map((node) => node.path);
    });

    // 关键词变了就从头开始
    watch(matchPaths, () => {
      currentIndex.value = 0;
    });

    // 把「当前定位」同步给树
    watch(
      [() => jt.keyword, currentIndex],
      () => {
        jt.currentPath = matchPaths.value[currentIndex.value] || '';
      },
      { immediate: true }
    );

    function nextMatch() {
      if (!matchPaths.value.length) return;
      currentIndex.value = (currentIndex.value + 1) % matchPaths.value.length;
    }

    function prevMatch() {
      if (!matchPaths.value.length) return;
      currentIndex.value =
        (currentIndex.value - 1 + matchPaths.value.length) % matchPaths.value.length;
    }

    const statusClass = computed(() => {
      const s = props.response?.status ?? 0;
      if (s >= 200 && s < 300) return 'ok';
      if (s >= 400) return 'err';
      return 'warn';
    });

    const passCount = computed(() => props.assertions.filter((a) => a.ok).length);

    const assertClass = computed(() =>
      passCount.value === props.assertions.length ? 'ok' : 'err'
    );

    /** 把整条响应（状态 + 头 + 体）拼成纯文本，用于一键复制。 */
    const buildFullText = () => {
      const r = props.response;
      if (!r) return '';
      const lines = [`HTTP ${r.status} ${r.statusText}`, `耗时: ${r.time} ms`, `大小: ${r.size} B`, ''];
      lines.push('--- 响应头 ---');
      r.headers.forEach((h) => lines.push(`${h.key}: ${h.value}`));
      lines.push('', '--- 响应体 ---', r.body);
      return lines.join('\n');
    };

    const copyAll = async () => {
      if (await copy(buildFullText())) {
        copyError.value = '';
        return;
      }
      copyError.value = '自动复制失败，请手动选择内容';
      setTimeout(() => (copyError.value = ''), 2500);
    };

    /** 大响应那句话；空串 = 不用提示 */
    const truncateNote = computed(() => truncateNotice(props.response));

    return {
      tab, copied, copyError, canSearch, parsed, statusClass, passCount, assertClass,
      formatSize, copyAll, formatValue, splitUnresolved, truncateNote,
      jt, matchPaths, searchCapped, searchNodeLimit: SEARCH_NODE_LIMIT,
      currentIndex, nextMatch, prevMatch, caretOnly,
    };
  },
  template: `
    <div class="card card-response">
      <!-- 三种空态统一成「一句话 + 一句指引」，和全站其他地方一个形状 -->
      <div v-if="sending" class="empty">
        <div class="spinner"></div>
        <span class="empty-title">请求发送中…</span>
      </div>

      <!-- 叫停不是失败：标题不写「发送失败」，也不上红 -->
      <div v-else-if="cancelled" class="empty">
        <span class="empty-title">已取消这次发送</span>
        <span class="empty-hint">请求可能已经发到上游了，这里只是不再等它的响应</span>
      </div>

      <div v-else-if="error" class="empty empty-bad">
        <span class="empty-title">发送失败</span>
        <span class="empty-hint">{{ error }}</span>
      </div>

      <div v-else-if="!response" class="empty">
        <span class="empty-title">还没有响应</span>
        <span class="empty-hint">填好 URL 后点「发送」，结果会显示在这里</span>
      </div>

      <template v-else>
        <div class="status-line">
          <span class="badge" :class="statusClass">{{ response.status }} {{ response.statusText }}</span>
          <span class="metric">耗时 <b>{{ response.time }} ms</b></span>
          <span class="metric">大小 <b>{{ formatSize(response.size) }}</b></span>
          <span class="badge" v-if="assertions.length" :class="assertClass">
            断言 {{ passCount }}/{{ assertions.length }}
          </span>
          <div class="topbar-spacer"></div>
          <span class="copy-fail" v-if="copyError">{{ copyError }}</span>
          <button class="btn btn-sm" @click="copyAll">{{ copied ? '已复制' : '复制完整响应' }}</button>
        </div>

        <div class="truncated-hint" v-if="truncateNote">{{ truncateNote }}</div>

        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'body' }" @click="tab = 'body'">Body</button>
          <button class="tab" :class="{ active: tab === 'headers' }" @click="tab = 'headers'">
            Headers<span class="tab-badge">{{ response.headers.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'request' }" @click="tab = 'request'">
            实际请求
          </button>
          <button class="tab" :class="{ active: tab === 'assert' }" @click="tab = 'assert'">
            断言<span class="tab-badge" v-if="assertions.length">{{ assertions.length }}</span>
          </button>
          <!-- 控制台放最后：脚本的输出和「请求结果」是一件事的两面 -->
          <button class="tab" :class="{ active: tab === 'console' }" @click="tab = 'console'">
            控制台<span class="tab-badge" v-if="consoleEntries.length">{{ consoleEntries.length }}</span>
          </button>

          <div class="tabs-end" v-if="tab === 'body'">
            <input
              class="search search-sm"
              v-model="searchInput"
              :disabled="!canSearch"
              :title="canSearch ? '' : '响应不是 JSON，暂不支持搜索'"
              :placeholder="canSearch ? '在响应里搜索…' : '仅 JSON 支持搜索'"
            />
            <template v-if="canSearch && jt.keyword.trim()">
              <span class="hint">
                {{ matchPaths.length ? currentIndex + 1 : 0 }} / {{ matchPaths.length }}
              </span>
              <!-- 响应大到只扫了一部分：得说清楚，否则「0 / 0」会被当成「真的没有」 -->
              <span
                class="hint"
                v-if="searchCapped"
                :title="'响应太大，搜索只扫了前 ' + searchNodeLimit + ' 个节点，后面的没搜'"
              >结果可能不全</span>
              <button
                class="btn-ghost btn-sm"
                :disabled="!matchPaths.length"
                title="上一个匹配"
                @click="prevMatch"
              >↑</button>
              <button
                class="btn-ghost btn-sm"
                :disabled="!matchPaths.length"
                title="下一个匹配"
                @click="nextMatch"
              >↓</button>
            </template>
          </div>
        </div>

        <!-- 控制台那一页自己滚（列表跟着新日志走），外层就别再套一层滚动 -->
        <div class="pane" :class="{ 'pane-console': tab === 'console' }">
          <template v-if="tab === 'body'">
            <div class="selectable" v-bind="caretOnly" v-if="parsed !== undefined">
              <JsonNode :data="parsed" />
            </div>
            <pre class="jt selectable" v-bind="caretOnly" v-else>{{ response.body }}</pre>
          </template>

          <template v-else-if="tab === 'headers'">
            <div class="data-table">
              <div class="data-row" v-for="(h, i) in response.headers" :key="i">
                <span class="data-key">{{ h.key }}</span>
                <span class="data-value">{{ h.value }}</span>
              </div>
            </div>
          </template>

          <template v-else-if="tab === 'request'">
            <div class="sent-line">
              <span class="method" :class="response.request.method">{{ response.request.method }}</span>
              <span class="kv-url">
                <span
                  v-for="(p, i) in splitUnresolved(response.request.url)"
                  :key="i"
                  :class="{ 'var-miss': p.miss }"
                >{{ p.text }}</span>
              </span>
            </div>

            <div class="sent-label" v-if="response.request.headers.length">请求头</div>
            <div class="data-table" v-if="response.request.headers.length">
              <div class="data-row" v-for="(h, i) in response.request.headers" :key="i">
                <span class="data-key">{{ h.key }}</span>
                <span class="data-value"><span
                  v-for="(p, j) in splitUnresolved(h.value)"
                  :key="j"
                  :class="{ 'var-miss': p.miss }"
                >{{ p.text }}</span></span>
              </div>
            </div>

            <div class="sent-label" v-if="response.request.body">请求体</div>
            <div class="code-box" v-if="response.request.body"><pre class="jt selectable" v-bind="caretOnly"><span
              v-for="(p, i) in splitUnresolved(response.request.body)"
              :key="i"
              :class="{ 'var-miss': p.miss }"
            >{{ p.text }}</span></pre></div>
          </template>

          <template v-else-if="tab === 'console'">
            <ConsolePanel
              :entries="consoleEntries"
              :dropped="consoleDropped"
              @clear="$emit('clear-console')"
            />
          </template>

          <template v-else>
            <div v-if="!assertions.length" class="hint">这个请求没有配置断言。</div>
            <div class="assert-result" v-for="(a, i) in assertions" :key="i">
              <span class="badge" :class="a.ok ? 'ok' : 'err'">{{ a.ok ? '通过' : '失败' }}</span>
              <span class="assert-label">{{ a.label }}</span>
              <span class="assert-actual">实际：{{ formatValue(a.actual) }}</span>
            </div>
          </template>
        </div>
      </template>
    </div>
  `,
});
