import { computed, defineComponent, nextTick, ref, watch } from 'vue';
import JsonNode from './JsonNode.js';
import { copyText } from '../clipboard.js';

/**
 * 控制台：脚本里 console.* 的输出。
 *
 * 不是请求日志 —— 那是「历史记录」那一栏的活。这里收的就是「脚本想说的话」：
 * 分级（log / info / warn / error）、按时间排、每条带出处（哪个请求 / 方案第几步、
 * 前置还是后置）。
 *
 * 对象不糊成一行：日志值在沙箱里就保留了结构（见 script-worker 的 toLogValue），
 * 这里用折叠树摊开 —— 一个嵌套对象进去，能一层层点开看。
 *
 * 两种形态：
 *   · 默认：响应区的一个页签（和 Body / Headers 平级），工具行 + 日志列表
 *   · inline：报告里某一步就地看，只有那一段日志，没有工具行
 */

const PAD = (n) => String(n).padStart(2, '0');

const clock = (ms) => {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}:${PAD(d.getSeconds())}`;
};

/** 标量直接印；特殊类型给个人话写法；对象 / 数组走折叠树 */
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function scalarText(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return String(v);
}

function markerText(v) {
  const t = v.__t;
  if (t === 'undefined') return 'undefined';
  if (t === 'bigint') return `${v.value}n`;
  if (t === 'symbol') return v.value;
  if (t === 'function') return `ƒ ${v.value.replace(/\s+/g, ' ').slice(0, 60)}`;
  if (t === 'error') return `${v.name}: ${v.message}`;
  if (t === 'date') return v.value;
  if (t === 'regexp') return v.value;
  if (t === 'circular') return '[循环引用]';
  if (t === 'deep') return '[太深了]';
  if (t === 'more') return `…还有 ${v.count} 项`;
  return String(v.value ?? '');
}

/** 一行里的每个参数：标量印出来，对象/数组给个可展开 */
const argView = (arg) => {
  if (isScalar(arg)) return { scalar: true, text: scalarText(arg) };
  if (arg && typeof arg === 'object' && '__t' in arg) return { scalar: true, text: markerText(arg), muted: true };
  return { scalar: false, data: arg, preview: previewOf(arg) };
};

function previewOf(v) {
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (v && typeof v === 'object') return `{${Object.keys(v).slice(0, 4).join(', ')}${Object.keys(v).length > 4 ? ', …' : ''}}`;
  return String(v);
}

export default defineComponent({
  name: 'ConsolePanel',
  components: { JsonNode },
  props: {
    /** [{ id, at, source, phase, level, args }] */
    entries: { type: Array, default: () => [] },
    /** 因为上限被丢掉的条数 */
    dropped: { type: Number, default: 0 },
    /** 就地形态：报告里某一步的日志，不要工具行 */
    inline: { type: Boolean, default: false },
  },
  emits: ['clear'],
  setup(props) {
    const listEl = ref(null);
    /** 没被用户往上滚走，就跟着新日志走 */
    const stick = ref(true);
    const unread = ref(0);
    const copied = ref(false);
    let copyTimer = 0;

    const count = computed(() => props.entries.length);

    const view = (entry) => (entry.args || []).map(argView);

    const scrollToEnd = async () => {
      await nextTick();
      const el = listEl.value;
      if (el) el.scrollTop = el.scrollHeight;
      unread.value = 0;
    };

    const onScroll = () => {
      const el = listEl.value;
      if (!el) return;
      stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (stick.value) unread.value = 0;
    };

    // 新日志进来：贴着底就继续跟，用户翻上去了就只记一条数字，不硬拽回去
    watch(
      () => count.value,
      async (now, before) => {
        const grown = Math.max(0, now - (before ?? 0));
        if (!props.inline && stick.value) await scrollToEnd();
        else unread.value += grown;
      }
    );

    /** 复制全部：按显示的那套写法拼成纯文本（对象给 JSON） */
    const asText = () =>
      props.entries
        .map((e) => {
          const head = `${clock(e.at)} [${e.phase === 'post' ? '后置' : '前置'}] ${e.source} ${e.level.toUpperCase()}`;
          const body = (e.args || [])
            .map((a) => (isScalar(a) ? scalarText(a) : a && '__t' in a ? markerText(a) : JSON.stringify(a)))
            .join(' ');
          return `${head} ${body}`.trim();
        })
        .join('\n');

    const copyAll = async () => {
      if (!(await copyText(asText()))) return;
      copied.value = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied.value = false), 1500);
    };

    return {
      listEl, unread, count, view, onScroll, scrollToEnd,
      copyAll, copied, clock,
    };
  },
  template: `
    <!-- 就地形态：报告里某一步的日志 -->
    <div class="con-inline" v-if="inline">
      <div class="con-line" :class="'lv-' + e.level" v-for="e in entries" :key="e.id">
        <span class="con-phase">{{ e.phase === 'post' ? '后置' : '前置' }}</span>
        <span class="con-msg">
          <template v-for="(a, i) in view(e)" :key="i">
            <template v-if="a.scalar"><span :class="{ 'con-muted': a.muted }">{{ a.text }}</span>&nbsp;</template>
            <details class="con-obj" v-else>
              <summary>{{ a.preview }}</summary>
              <div class="code-box"><JsonNode :data="a.data" label="" /></div>
            </details>
          </template>
        </span>
      </div>
    </div>

    <div class="con-panel" v-else>
      <div class="con-tools">
        <span class="wb-chip">共 {{ count }} 条</span>
        <span class="wb-chip" v-if="dropped">已丢弃 {{ dropped }} 条</span>
        <button class="btn btn-sm" type="button" v-if="count" @click="copyAll">
          {{ copied ? '已复制' : '复制全部' }}
        </button>
        <button class="btn btn-sm" type="button" v-if="count" @click="$emit('clear')">清空</button>
        <button class="btn-ghost btn-sm" type="button" v-if="unread" @click="scrollToEnd">
          {{ unread }} 条新日志 ↓
        </button>
      </div>

      <div class="con-list" ref="listEl" @scroll="onScroll">
        <div class="con-line" :class="'lv-' + e.level" v-for="e in entries" :key="e.id">
          <span class="con-time">{{ clock(e.at) }}</span>
          <span class="con-src" :title="e.source">{{ e.source }}</span>
          <span class="con-phase">{{ e.phase === 'post' ? '后置' : '前置' }}</span>
          <span class="con-msg">
            <template v-for="(a, i) in view(e)" :key="i">
              <template v-if="a.scalar"><span :class="{ 'con-muted': a.muted }">{{ a.text }}</span>&nbsp;</template>
              <details class="con-obj" v-else>
                <summary>{{ a.preview }}</summary>
                <div class="code-box"><JsonNode :data="a.data" label="" /></div>
              </details>
            </template>
          </span>
        </div>
        <div class="hint" v-if="!count">脚本里用 console.log / warn / error 输出，就会出现在这里。</div>
      </div>
    </div>
  `,
});
