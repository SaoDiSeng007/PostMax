import { computed, defineComponent, onMounted, ref } from 'vue';
import { joinBodyPath, joinIndexPath } from '../assert.js';
import { useCopy, useCopyFlag } from '../useCopy.js';

// 路径怎么拼在 assert.js（和 getByPath 贴着放）：data.token、items[0].id。
// 键里带点 / 方括号的拼不出来，标成「取不了」。

const previewScalar = (v) => {
  const t = typeof v === 'string' ? JSON.stringify(v) : String(v);
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
};

const previewOf = (v) => {
  if (typeof v === 'string') {
    const t = v.length > 60 ? v.slice(0, 60) + '…' : v;
    return JSON.stringify(t);
  }
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? `[…] ${v.length} 项` : `{…} ${Object.keys(v).length} 个键`;
  return String(v);
};

const kindOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v;

/** 悬停提示：能复制的说明怎么复制，不能复制的说清为什么 */
export const COPY_HINT = '鼠标左键单击复制路径';
export function pathRowTitle(path, noPath) {
  if (path === '') return '根节点没有路径，点下面任意一行复制';
  return noPath ? '这个键带点或括号，按路径取不了' : COPY_HINT;
}

/** 根节点没有路径、键带点或括号拼不出路径，都算复制不了 */
export function canCopyPath(path, noPath) {
  return path !== '' && !noPath;
}

/**
 * 整行任意位置单击都复制路径（原来只有最右边那个按钮能点，行宽一点就得瞄着点）。
 * 唯一的例外是**容器行**的箭头 —— 它管展开收起。
 * 叶子行那一小条空白不是例外（点了也该复制），所以拿 e.target 判断，
 * 而不是给箭头挂个 @click.stop（那样会连叶子行也变成死区）。
 */
export function rowClickTarget(ev, isContainer) {
  const onCaret = !ev || !ev.target || typeof ev.target.closest !== 'function'
    ? null
    : ev.target.closest('.wb-caret');
  return onCaret && isContainer ? 'toggle' : 'copy';
}

/**
 * 树上的一层。容器可以展开收起；每行悬停浮出路径，**整行任意位置**单击复制走
 * （悬停的 title 上说明白是「鼠标左键单击复制路径」）。
 * 复制成功闪绿色 —— 不换文字，免得行高抖一下。
 */
const PathNode = {
  name: 'PathNode',
  props: {
    label: { type: String, default: '' },
    path: { type: String, default: '' },
    noPath: { type: Boolean, default: false },
    value: { required: true },
    depth: { type: Number, default: 0 },
    /** 顶层记着刚复制过哪条路径，闪绿用 */
    copiedPath: { type: String, default: '' },
  },
  emits: ['copy-path'],
  setup(props, { emit }) {
    const isContainer = computed(() => ['object', 'array'].includes(kindOf(props.value)));
    const open = ref(props.depth < 2);
    const kind = computed(() => kindOf(props.value));

    const toggle = () => {
      if (isContainer.value) open.value = !open.value;
    };

    const entries = computed(() => {
      if (!isContainer.value || !open.value) return [];
      const v = props.value;
      if (Array.isArray(v)) return v.map((val, i) => ({ key: String(i), val, idx: i }));
      return Object.keys(v).map((k) => ({ key: k, val: v[k], idx: -1 }));
    });

    const childPathOf = (e) => {
      if (e.idx >= 0) return { path: joinIndexPath(props.path, e.idx), noPath: false };
      const p = joinBodyPath(props.path, e.key);
      return { path: p ?? e.key, noPath: p === null };
    };

    const canCopy = computed(() => canCopyPath(props.path, props.noPath));
    const rowTitle = computed(() => pathRowTitle(props.path, props.noPath));
    // 根节点 path 是空串，初值也是空串，不带上 canCopy 会让根行一上来就「已复制」
    const justCopied = computed(() => canCopy.value && props.copiedPath === props.path);

    const copyPath = () => {
      if (!canCopy.value) return;
      emit('copy-path', props.path);
    };

    const onRowClick = (ev) => {
      if (rowClickTarget(ev, isContainer.value) === 'toggle') {
        toggle();
        return;
      }
      copyPath();
    };

    return {
      // 只回模板真用到的：toggle / copyPath 都被 onRowClick 收编了
      isContainer, open, kind, entries, childPathOf,
      onRowClick, rowTitle, justCopied, previewOf,
    };
  },
  template: `
    <div class="wb-pnode">
      <div
        class="wb-pline wb-pcopy"
        :class="{ copied: justCopied }"
        :title="rowTitle"
        @click="onRowClick"
      >
        <span class="wb-caret" :class="{ open }">{{ isContainer ? '▸' : '' }}</span>
        <span class="jt-key" v-if="label">{{ label }}</span><span class="jt-colon" v-if="label">:</span>
        <template v-if="isContainer">
          <span class="jt-count">{{ kind === 'array' ? value.length + ' 项' : Object.keys(value).length + ' 个键' }}</span>
        </template>
        <template v-else>
          <span :class="'jt-' + (kind === 'array' ? 'key' : kind)">{{ previewOf(value) }}</span>
        </template>
        <span class="wb-phint">{{ justCopied ? '已复制' : noPath ? '取不了' : path }}</span>
      </div>

      <div class="wb-pchildren" v-if="isContainer && open">
        <PathNode
          v-for="e in entries"
          :key="e.key"
          :label="e.key"
          :value="e.val"
          :depth="depth + 1"
          :copied-path="copiedPath"
          v-bind="childPathOf(e)"
          @copy-path="$emit('copy-path', $event)"
        />
      </div>
    </div>
  `,
};

/**
 * JSON 取路径。
 *
 * 一个框，两种看法：原文（可编辑、可粘贴）/ 格式化（结构树，**整行任意位置**
 * 单击复制取值路径 —— 写断言、提取路径不用手数层级）。
 */
export default defineComponent({
  name: 'WbJson',
  components: { PathNode },
  setup() {
    const raw = ref('');
    const view = ref('raw');
    /** { ok, value?, error? } */
    const parsed = ref({ ok: false, value: undefined, error: '' });
    let timer = 0;

    function reparse() {
      const text = raw.value;
      if (!text.trim()) {
        parsed.value = { ok: false, value: undefined, error: '' };
        return;
      }
      try {
        parsed.value = { ok: true, value: JSON.parse(text), error: '' };
      } catch (e) {
        parsed.value = { ok: false, value: undefined, error: (e && e.message) || String(e) };
      }
    }

    // 边打边解析会闪红字，缓 300ms
    const onInput = () => {
      clearTimeout(timer);
      timer = setTimeout(reparse, 300);
    };

    const { copied: copiedPath, copy: copyPathRaw } = useCopy();
    async function copyPath(p) {
      await copyPathRaw(p, p);
    }

    const clear = () => {
      raw.value = '';
      view.value = 'raw';
      reparse();
    };

    const { copied: copiedBar, copy: copyBarRaw } = useCopyFlag();
    async function copy() {
      await copyBarRaw(raw.value);
    }

    // 进来就有东西：一份像接口响应的示例，切到「格式化」立刻有得看。
    // 用户一贴自己的内容就盖掉了，不碍事。
    onMounted(() => {
      if (!raw.value) {
        raw.value = JSON.stringify(
          {
            code: 0,
            data: { userId: 1001, token: 'eyJhbGciOiJIUzI1NiJ9...', roles: ['admin', 'editor'], expiresAt: 1790854332000 },
            msg: 'ok',
          },
          null,
          2
        );
        reparse();
      }
    });

    return { raw, view, parsed, onInput, copy, copyPath, copiedPath, copiedBar, clear };
  },
  template: `
    <div class="wb-tool">
      <div class="wb-line">
        <div class="seg">
          <button type="button" :class="{ on: view === 'raw' }" @click="view = 'raw'">原文</button>
          <button type="button" :class="{ on: view === 'pretty' }" @click="view = 'pretty'">格式化</button>
        </div>
        <button class="btn btn-sm" type="button" @click="copy" :disabled="!raw">{{ copiedBar ? '已复制' : '复制' }}</button>
        <button class="btn btn-sm" type="button" @click="clear" :disabled="!raw">清空</button>
      </div>

      <textarea
        v-if="view === 'raw'"
        class="wb-ta wb-json-ta"
        v-model="raw"
        @input="onInput"
        placeholder="贴一段 JSON"
        spellcheck="false"
      ></textarea>

      <div v-else class="wb-out wb-json-tree">
        <PathNode v-if="parsed.ok && parsed.value !== null && typeof parsed.value === 'object'"
          :value="parsed.value" path="" :copied-path="copiedPath" @copy-path="copyPath" />
        <span class="error-text" v-else-if="parsed.error">解析失败：{{ parsed.error }}</span>
        <p class="hint" v-else-if="parsed.ok">顶层是标量，没有结构可点。</p>
        <p class="hint" v-else>贴一段合法 JSON 再切过来。</p>
      </div>

      <span class="error-text" v-if="view === 'raw' && parsed.error">解析失败：{{ parsed.error }}</span>
    </div>
  `,
});
