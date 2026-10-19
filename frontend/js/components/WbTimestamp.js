import { computed, defineComponent, nextTick, onUnmounted, ref, watch } from 'vue';
import { useCopy } from '../useCopy.js';

// ---------------------------------------------------------------------------
// 时间戳 ↔ 日期。时间只有两种：北京时间（UTC+8）和 UTC，没有「本地时间」。
// 两个入口指同一个时刻：选时间（第一行）或贴时间戳（第二行），改哪个另一个
// 都跟着变；四行结果实时跟着时刻走，没选就是当前，每秒更新。
//
// 第一行那个选择面板是自己画的，不是 <input type="datetime-local">：
// 原生控件的时分秒列在 shadow DOM 里，加不了「时 / 分 / 秒」表头，而六列并排
// 一眼看清哪列是哪列，正是这个工具要的（找个 token 过期时刻、改个秒都直接点）。
// ---------------------------------------------------------------------------

export const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时间和 UTC 的格式化器。六列显示的是**北京时间**那一份，和四行结果同一口径 */
function makeFormat(tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return {
    text(ms) {
      const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    },
    parts(ms) {
      const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
      return {
        year: +p.year, month: +p.month, day: +p.day,
        hour: +p.hour, minute: +p.minute, second: +p.second,
      };
    },
  };
}
const bj = makeFormat('Asia/Shanghai');
const utc = makeFormat('UTC');

const formatBJ = (ms) => bj.text(ms);
const formatUTC = (ms) => utc.text(ms);

/** 纯数字 = 时间戳：10 位按秒、13 位按毫秒；其余（含空）一律 null */
export function parseTsInput(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{1,14}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1e12 ? n : n * 1000;
}

/** 选择面板存的字符串（YYYY-MM-DDTHH:mm:ss，北京时间口径）→ 毫秒 */
export function parsePicker(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  // Date 会把 13 月 99 日「进位」成合法日期，先挡掉
  if (+Mo < 1 || +Mo > 12 || +D < 1 || +D > 31 || +H > 23 || +Mi > 59 || +S > 59) return null;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S) - BEIJING_OFFSET_MS;
}

/** 毫秒 → 北京时间那一份年月日时分秒（六列显示的就是它） */
export function partsFromMs(ms) {
  return bj.parts(ms);
}

/** 年月日时分秒 → 毫秒（按北京时间解释，和 parsePicker 是一对） */
export function msFromParts(p) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - BEIJING_OFFSET_MS;
}

/** 选择面板的字符串形式 */
export function valueFromParts(p) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 某年某月有几天（month 从 1 数）。闰年靠 UTC 那一侧的进位算，不用自己判 */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 改一列。
 *
 * 日要单独看：1 月 31 号把月份改成 2 月，原来那个 31 号在 2 月不存在 —— 往回收成
 * 28/29（闰年），而不是让 Date 把它进位成 3 月 3 日（那会悄悄跳到另一个月）。
 */
export function setPart(parts, field, value) {
  const next = { ...parts, [field]: value };
  const last = daysInMonth(next.year, next.month);
  if (next.day > last) next.day = last;
  return next;
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 六列：年 / 月 / 日 / 时 / 分 / 秒。
 *
 * 年份围绕当前选中的那一年取前后 25 年 —— 给一段够用的范围，换到别的年份时列表
 * 跟着挪（贴时间戳进来是 2035 年也能选到附近），比写死 1970–2035 更耐放。
 */
export function pickerColumns(parts) {
  const col = (field, head, values, current, label = pad2) => ({
    field,
    head,
    values: values.map((v) => ({ value: v, label: label(v), on: v === current })),
  });

  return [
    col('year', '年', range(parts.year - 25, parts.year + 25), parts.year, String),
    col('month', '月', range(1, 12), parts.month),
    col('day', '日', range(1, daysInMonth(parts.year, parts.month)), parts.day),
    col('hour', '时', range(0, 23), parts.hour),
    col('minute', '分', range(0, 59), parts.minute),
    col('second', '秒', range(0, 59), parts.second),
  ];
}

/** 四行结果：北京时间 / UTC / 毫秒 / 秒，样式一致，整行点击复制。 */
export default defineComponent({
  name: 'WbTimestamp',
  setup() {
    /** 选择面板选中的时刻（'YYYY-MM-DDTHH:mm:ss'，北京时间），空 = 没选 */
    const picked = ref('');
    /** 时间戳输入（第二行） */
    const tsInput = ref('');
    const pickerOpen = ref(false);
    const triggerEl = ref(null);
    const panelEl = ref(null);
    /** 面板相对触发器的位置（右边 / 左边 + 纵向微调），开的时候算一次 */
    const panelStyle = ref({});
    /** 六列的滚动容器，开面板时把选中的那一项滚到中间 */
    const colBodies = {};
    const { copied, copy: copyValue } = useCopy();

    const nowMs = ref(Date.now());
    const clock = setInterval(() => (nowMs.value = Date.now()), 1000);
    onUnmounted(() => clearInterval(clock));

    /** 显示的时刻：时间戳输入优先，其次选择面板，都没有 = 现在 */
    const showing = computed(() => {
      const ts = parseTsInput(tsInput.value);
      if (ts !== null) return ts;
      const pv = parsePicker(picked.value);
      if (pv !== null) return pv;
      return nowMs.value;
    });

    /** 六列当前指着的时刻：选了就是选的，没选就跟显示的时刻走（点哪列都从这个时刻改起） */
    const parts = computed(() => partsFromMs(parsePicker(picked.value) ?? showing.value));
    const columns = computed(() => pickerColumns(parts.value));

    const triggerLabel = computed(() =>
      picked.value ? formatBJ(parsePicker(picked.value)) : '选择年月日时分秒'
    );

    /** 贴时间戳 → 选择面板跟着摆到那个时刻（北京时间） */
    function onTsInput() {
      const ms = parseTsInput(tsInput.value);
      picked.value = ms === null ? '' : valueFromParts(partsFromMs(ms));
    }

    /** 点某一列的某一项：立刻生效（不用等「确定」），另一行也跟着填 */
    function pick(field, value) {
      const next = setPart(parts.value, field, value);
      picked.value = valueFromParts(next);
      tsInput.value = String(msFromParts(next));
    }

    /** 把选中的那一项滚到列的中间 —— 60 项的秒列否则总停在 00 */
    async function revealSelected() {
      await nextTick();
      columns.value.forEach((c) => {
        const body = colBodies[c.field];
        const on = body && body.querySelector('.ts-opt.on');
        if (on) body.scrollTop = Math.max(0, on.offsetTop - body.clientHeight / 2 + on.offsetHeight / 2);
      });
    }

    /** 最近的、会裁切子元素的祖先（面板不能越出它，否则会被切掉） */
    function clipBox(el) {
      let p = el.parentElement;
      while (p && p !== document.body) {
        if (getComputedStyle(p).overflow !== 'visible') return p.getBoundingClientRect();
        p = p.parentElement;
      }
      return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    }

    /**
     * 结果行里最宽的那段数字，右边缘到哪儿。
     *
     * 面板要挨着触发器，但绝不能压在时间戳上 —— 谁也不会想让浮层盖住自己正盯着看的那几位。
     * 用 Range 量文字本身（不是量那个撑满整行的盒子：值是 flex: 1，盒子右边缘一直在最右边，
     * 按它算就变成「永远没地方」）。
     */
    function valuesRight(root) {
      let right = 0;
      root.querySelectorAll('.wb-kv-val').forEach((el) => {
        if (!el.firstChild) return;
        const range = document.createRange();
        range.selectNodeContents(el);
        right = Math.max(right, range.getBoundingClientRect().right);
      });
      return right;
    }

    /**
     * 面板落在**第一行的右端**：紧挨着这一行（触发器 + 现在），纵向与它齐平。
     *
     * 三条约束，都是前几版踩出来的：
     *   1. 不占流内位置（最早放在触发器下面）—— 一开面板就把时间戳框和四行结果顶下去，
     *      关掉又弹回来，眼睛刚记住的地方来回动；
     *   2. 不压结果行 —— 面板的用法就是「点一列、看那四行怎么变」，可这边的数字正是要看的；
     *   3. 也不许甩到容器最右边 —— 那样离触发器两百多像素，看着跟谁都不是一伙的。
     *
     * 所以落点 = max(第一行内容右边, 最宽的那个值右边) + 8px：贴着这一行，又刚好不压数字。
     * 容器实在放不下就收进去；窄到连面板都放不下时顶到容器左沿，宁可压住触发器也不被裁。
     */
    async function placePanel() {
      if (!pickerOpen.value) return;
      await nextTick();

      const anchor = triggerEl.value;
      const panel = panelEl.value;
      if (!anchor || !panel) return;

      const box = clipBox(anchor);
      const a = anchor.getBoundingClientRect();
      const gap = 8;

      const row = anchor.closest('.wb-line');
      const rowRight = row
        ? Math.max(a.right, ...[...row.children].map((c) => c.getBoundingClientRect().right))
        : a.right;
      const tool = anchor.closest('.wb-tool');
      const wanted = Math.max(rowRight, tool ? valuesRight(tool) : 0) + gap;

      const minLeft = box.left + gap;
      const maxLeft = box.right - gap - panel.offsetWidth;
      const left = Math.min(Math.max(wanted, minLeft), Math.max(minLeft, maxLeft));
      const top = Math.max(
        box.top - a.top,
        Math.min(0, box.bottom - gap - panel.offsetHeight - a.top)
      );

      // 交给 :style 的是「相对触发器的偏移」：它照样在文档流里，坐标得自己算
      panelStyle.value = { left: `${Math.round(left - a.left)}px`, top: `${Math.round(top)}px` };
    }

    function open() {
      pickerOpen.value = true;
      placePanel();
      revealSelected();
    }

    function close() {
      pickerOpen.value = false;
    }

    const toggle = () => (pickerOpen.value ? close() : open());

    /*
     * 点面板和触发器**之外**的空白 = 同样效果（就是「确定」）。
     *
     * 用 mousedown 而不是 click：click 要等鼠标抬起，那时焦点可能已经跑到别处去了。
     * 触发器自己不算「外面」—— 否则点一下先被这里关掉，紧接着 click 又把它打开。
     */
    function onDocMousedown(e) {
      if (panelEl.value && panelEl.value.contains(e.target)) return;
      if (triggerEl.value && triggerEl.value.contains(e.target)) return;
      close();
    }

    watch(pickerOpen, (isOpen) => {
      if (isOpen) {
        document.addEventListener('mousedown', onDocMousedown);
        // 拖着侧栏分隔条挪宽度时，面板要跟着重算位置（不然会跑到容器外面被切掉）
        window.addEventListener('resize', placePanel);
      } else {
        document.removeEventListener('mousedown', onDocMousedown);
        window.removeEventListener('resize', placePanel);
      }
    });
    onUnmounted(() => {
      document.removeEventListener('mousedown', onDocMousedown);
      window.removeEventListener('resize', placePanel);
    });

    const tsBad = computed(() => tsInput.value.trim() !== '' && parseTsInput(tsInput.value) === null);

    const rows = computed(() => {
      const v = showing.value;
      return [
        { key: 'bj', label: '北京时间', value: formatBJ(v) },
        { key: 'utc', label: 'UTC', value: formatUTC(v) },
        { key: 'ms', label: '毫秒', value: String(v) },
        { key: 's', label: '秒', value: String(Math.floor(v / 1000)) },
      ];
    });

    const backToNow = () => {
      picked.value = '';
      tsInput.value = '';
      close();
    };

    return {
      picked, tsInput, tsBad, rows, copied, copyValue, backToNow, onTsInput,
      pickerOpen, triggerEl, panelEl, panelStyle, colBodies, columns, triggerLabel,
      toggle, close, pick,
    };
  },
  template: `
    <div class="wb-tool">
      <div class="wb-line">
        <!-- 锚点：面板相对它绝对定位，浮在右边，占不到下一行的地方 -->
        <div class="ts-anchor">
          <button
            class="wb-in ts-trigger"
            type="button"
            ref="triggerEl"
            :class="{ open: pickerOpen }"
            @click="toggle"
          >
            <span :class="{ 'ts-placeholder': !picked }">{{ triggerLabel }}</span>
            <span class="ts-caret">▾</span>
          </button>

          <!-- 六列并排：表头写清哪列是年月日、哪列是时分秒 -->
          <div class="ts-picker" ref="panelEl" v-if="pickerOpen" :style="panelStyle">
            <div class="ts-cols">
              <div class="ts-col" v-for="c in columns" :key="c.field">
                <div class="ts-col-head">{{ c.head }}</div>
                <div class="ts-col-body" :ref="(el) => (colBodies[c.field] = el)">
                  <button
                    class="ts-opt"
                    type="button"
                    v-for="o in c.values"
                    :key="o.value"
                    :class="{ on: o.on }"
                    @click="pick(c.field, o.value)"
                  >{{ o.label }}</button>
                </div>
              </div>
            </div>
            <div class="ts-actions">
              <button class="btn btn-primary btn-sm" type="button" @click="close">确定</button>
            </div>
          </div>
        </div>

        <button class="btn btn-sm" type="button" @click="backToNow">现在</button>
      </div>

      <div class="wb-line">
        <input class="wb-in wb-picker" v-model="tsInput" @input="onTsInput" placeholder="时间戳（秒 / 毫秒）" spellcheck="false" />
        <span class="error-text" v-if="tsBad">时间戳是纯数字</span>
      </div>

      <div
        class="wb-kv wb-kv-copy"
        v-for="r in rows"
        :key="r.key"
        :class="{ copied: copied === r.key }"
        title="点击复制"
        @click="copyValue(r.value, r.key)"
      >
        <span class="wb-kv-label">{{ r.label }}</span>
        <span class="wb-kv-val">{{ r.value }}</span>
        <span class="wb-kv-hint">{{ copied === r.key ? '已复制' : '复制' }}</span>
      </div>
    </div>
  `,
});
