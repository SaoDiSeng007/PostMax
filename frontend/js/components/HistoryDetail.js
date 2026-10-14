import { computed, defineComponent, ref } from 'vue';
import JsonNode from './JsonNode.js';
import { formatSize, truncateNotice } from '../format.js';
import { caretOnly } from '../caretOnly.js';
import { useCopyFlag } from '../useCopy.js';
import { splitUnresolved } from '../api.js';
import { parseJsonText } from '../jsonText.js';

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * 历史记录右侧：这一条到底发了什么、回来什么。
 *
 * 左侧列表是「发生过哪些调用」，这里才是内容。两者分工和接口页一致 ——
 * 左边选、右边看。
 *
 * 展示的是**实际发出的**请求（变量已经换成真值），因为「当时到底发了什么」
 * 正是回看历史要回答的问题。原始定义（含 {{变量}}）单独一行，只在两者不同时
 * 出现 —— 它解释了这个请求本来写的是什么。
 */
export default defineComponent({
  name: 'HistoryDetail',
  components: { JsonNode },
  props: {
    entry: { type: Object, default: null },
    /** 有没有项目能接住「载入到新请求」 */
    canReplay: { type: Boolean, default: false },
  },
  emits: ['replay'],
  setup(props) {
    const tab = ref('response');
    const { copied, copy } = useCopyFlag();
    /** 复制失败时给一句话，别静默 */
    const copyError = ref('');

    /** 实际发出的那份 */
    const sent = computed(() => props.entry?.detail?.request || null);
    /** 后端回来的那份 */
    const detail = computed(() => props.entry?.detail || null);
    /** 原始定义（含 {{变量}}），重放时用它 */
    const originUrl = computed(() => props.entry?.request?.url || '');

    const statusClass = computed(() => {
      const s = detail.value?.status ?? 0;
      if (s >= 200 && s < 300) return 'ok';
      if (s >= 400) return 'err';
      return 'warn';
    });

    const parsed = computed(() => parseJsonText(detail.value?.body));

    const fullTime = computed(() => {
      const at = props.entry?.at;
      if (!at) return '';
      const d = new Date(at);
      return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      );
    });

    const buildFullText = () => {
      const d = detail.value;
      if (!d) return '';
      const lines = [`${d.request.method} ${d.request.url}`, ''];
      lines.push('--- 请求头 ---');
      d.request.headers.forEach((h) => lines.push(`${h.key}: ${h.value}`));
      if (d.request.body) lines.push('', '--- 请求体 ---', d.request.body);
      lines.push('', `--- 响应 HTTP ${d.status} ${d.statusText} · ${d.time} ms ---`);
      d.headers.forEach((h) => lines.push(`${h.key}: ${h.value}`));
      lines.push('', '--- 响应体 ---', d.body);
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

    return {
      tab, copied, copyError, sent, detail, originUrl, statusClass, parsed,
      fullTime, formatSize, truncateNotice, copyAll, splitUnresolved, caretOnly,
    };
  },
  template: `
    <div class="hist-view">
      <div class="card" v-if="!entry">
        <div class="empty">
          <span class="empty-title">没有选中任何记录</span>
          <span class="empty-hint">在左边点一条，这里显示那次调用发出的请求和回来的响应</span>
        </div>
      </div>

      <div class="card" v-else-if="!detail || !sent">
        <div class="empty">
          <span class="empty-title">这条记录只存了摘要</span>
          <span class="empty-hint">
            它是旧版本记下的，只留了方法、地址、状态和耗时。<br />
            之后发送的记录都会带上完整的请求与响应。
          </span>
        </div>
      </div>

      <div class="card" v-else>
        <div class="status-line">
          <span class="method" :class="sent.method">{{ sent.method }}</span>
          <span class="badge" :class="statusClass">{{ detail.status }} {{ detail.statusText }}</span>
          <span class="metric">耗时 <b>{{ detail.time }} ms</b></span>
          <span class="metric">大小 <b>{{ formatSize(detail.size) }}</b></span>
          <div class="topbar-spacer"></div>
          <span class="hint">{{ fullTime }}</span>
          <button
            class="btn btn-sm"
            :disabled="!canReplay"
            :title="canReplay ? '按当时那份原始定义开一个新的未保存请求' : '当前没有打开项目，没地方放它'"
            @click="$emit('replay')"
          >载入到新请求</button>
          <span class="copy-fail" v-if="copyError">{{ copyError }}</span>
          <button class="btn btn-sm" @click="copyAll">{{ copied ? '已复制' : '复制完整记录' }}</button>
        </div>

        <div class="hist-req">
          <div class="sent-line">
            <span class="kv-url">
              <span
                v-for="(p, i) in splitUnresolved(sent.url)"
                :key="i"
                :class="{ 'var-miss': p.miss }"
              >{{ p.text }}</span>
            </span>
          </div>
          <!-- 只在确实不同时出现：原始定义长这样 {{baseUrl}}/users，
               它解释了这个请求本来是写给哪个环境的 -->
          <div class="hist-origin" v-if="originUrl && originUrl !== sent.url">
            原始：<span class="kv-url">{{ originUrl }}</span>
          </div>
        </div>

        <div class="tabs">
          <button class="tab" :class="{ active: tab === 'response' }" @click="tab = 'response'">
            响应<span class="tab-badge">{{ formatSize(detail.size) }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'headers' }" @click="tab = 'headers'">
            响应头<span class="tab-badge">{{ detail.headers.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'request' }" @click="tab = 'request'">
            请求
          </button>
        </div>

        <div class="pane">
          <template v-if="tab === 'response'">
            <div class="truncated-hint" v-if="detail.bodyClipped">
              响应体只留了开头一段（完整大小 {{ formatSize(detail.size) }}），避免历史文件越滚越大。
            </div>
            <div class="truncated-hint" v-else-if="truncateNotice(detail)">
              当时的情况：{{ truncateNotice(detail) }}
            </div>
            <div class="selectable" v-bind="caretOnly" v-if="parsed !== undefined">
              <JsonNode :data="parsed" />
            </div>
            <pre class="jt selectable" v-bind="caretOnly" v-else>{{ detail.body }}</pre>
          </template>

          <template v-else-if="tab === 'headers'">
            <div class="data-table">
              <div class="data-row" v-for="(h, i) in detail.headers" :key="i">
                <span class="data-key">{{ h.key }}</span>
                <span class="data-value">{{ h.value }}</span>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="sent-label" v-if="sent.headers.length">请求头</div>
            <div class="data-table" v-if="sent.headers.length">
              <div class="data-row" v-for="(h, i) in sent.headers" :key="i">
                <span class="data-key">{{ h.key }}</span>
                <span class="data-value">{{ h.value }}</span>
              </div>
            </div>
            <div class="sent-label" v-if="sent.body">请求体</div>
            <div class="code-box" v-if="sent.body">
              <pre class="jt selectable" v-bind="caretOnly">{{ sent.body }}</pre>
            </div>
            <p class="hint" v-if="!sent.headers.length && !sent.body">
              这次调用没有带请求头和请求体。
            </p>
          </template>
        </div>
      </div>
    </div>
  `,
});
