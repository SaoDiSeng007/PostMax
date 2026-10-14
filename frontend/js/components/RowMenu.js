import { computed, defineComponent, nextTick, ref, watch } from 'vue';
import Caret from './Caret.js';

/**
 * 列表行尾巴上的「⋯」菜单。
 *
 * 项目里的请求、自动化里的方案都用它，条目各传各的。
 *
 * 为什么用 position: fixed 而不是跟着按钮相对定位：这两处列表都装在
 * overflow:auto 的容器里（.sidebar-body），绝对定位的浮层会被容器的滚动裁掉 ——
 * 靠下的行点开就看不见菜单。fixed 的包含块是视口，不受那个 overflow 影响，
 * 换来的代价是坐标得自己算。
 *
 * 键盘：打开就把焦点交给第一项，↑↓ 换项、Enter 触发、Esc 收起 ——
 * 不给键盘走法的话，这个菜单就是「只有鼠标能开」的。
 * 收起时把焦点还给触发按钮：菜单项随关闭就从 DOM 上没了，不管的话焦点掉到 body，
 * 后面弹层（比如删除确认）关掉时就不知道该还给谁。
 */
export default defineComponent({
  name: 'RowMenu',
  components: { Caret },
  props: {
    /**
     * [{ id, label, danger, sep, children, count, current }]。
     *
     * `sep: true` 的条目渲染成一条分隔线；带 `children` 的条目左边多一个三角，
     * 点它展开 / 收起自己的子级（「移动到目录」那棵树就是这么来的）。
     * `count` 给了就在名字后面显示（右对齐的小字），`current` 给了挂一颗「当前」。
     */
    items: { type: Array, required: true },
    title: { type: String, default: '更多' },
    /**
     * 给了就把它当按钮文案（一颗普通文字按钮）；不给还是行尾那个 ⋯ 图标。
     * 批量操作条上需要一颗看得懂的「移动到目录」，光一个 ⋯ 猜不出来是干嘛的。
     */
    label: { type: String, default: '' },
    /** 菜单**最小**宽度。文案更长时菜单自己撑开，这里只保证不至于窄成一条 */
    width: { type: Number, default: 132 },
    /**
     * 菜单往哪边展开。
     *
     *   'right'（默认）右对齐到按钮、往左展 —— 列表行尾那颗「⋯」在右边，这样才不出屏；
     *   'left'         从按钮左边往右展 —— 按钮本身就在面板最左边时用（见 place）。
     */
    align: { type: String, default: 'right' },
  },
  emits: ['pick'],
  setup(props, { emit }) {
    const open = ref(false);
    const pos = ref({ top: 0, left: 0 });
    /** 菜单项的 DOM，键盘上下走位时要拿来聚焦 */
    const itemEls = ref([]);
    const triggerEl = ref(null);

    /** 行高的估算值（实际 28px 左右）。只用来预判菜单要占多高，估大不估小 */
    const ITEM_H = 30;

    /** 触发按钮的位置。展开 / 收起会换行数，菜单的位置和高度得按它重算 */
    const anchor = ref(null);

    /**
     * 哪些带子级的条目被展开了（存 item.id）。
     *
     * **每次打开都清空**：菜单是「临时挑一个落点」，记住上次展开到哪一层没有意义，
     * 反而让人以为目录本来就是这个样子。
     */
    const expanded = ref([]);

    /**
     * 真正渲染出来的行：折着的条目不把子级带出来。
     *
     * 展开一层只会多看到一层 —— 新露出来的那些带下级的条目自己还是折着的，
     * 和侧栏接口树一个规矩（见 store.js 的 expandedDirs）。
     */
    const rows = computed(() => {
      const out = [];
      const walk = (list, depth) => {
        (list || []).forEach((it) => {
          if (it.sep) {
            out.push({ ...it, depth });
            return;
          }
          const kids = it.children || [];
          const open = expanded.value.includes(it.id) && kids.length > 0;
          out.push({ ...it, depth, hasKids: kids.length > 0, open });
          if (open) walk(kids, depth + 1);
        });
      };
      walk(props.items, 0);
      return out;
    });

    /** 展开 / 收起一个条目：只动它自己，它的子孙该折着还折着 */
    function toggleExpand(id) {
      const i = expanded.value.indexOf(id);
      if (i >= 0) expanded.value.splice(i, 1);
      else expanded.value.push(id);
    }

    /** 收起来，并把焦点还给触发按钮 */
    function close() {
      open.value = false;
      const el = triggerEl.value;
      if (el && typeof el.focus === 'function') el.focus();
    }

    /**
     * 算菜单的位置和高度上限：右对齐到按钮，高度封在按钮那一侧剩下的空间里，
     * 装不下的条目交给滚动条。
     *
     * 这一步必须按「实际剩余空间」算，不能只按条数估。以前是拿条数估一个 top 就完事：
     * 目录一多，top 会被算成负数 —— 菜单上半截跑到屏幕外面，又没有滚动条，
     * 后面的目录压根没机会看到。
     *
     * 优先挂在按钮下方；下方明显不够、而上面更宽敞时才翻到按钮上方。
     */
    function place() {
      const a = anchor.value;
      if (!a) return;

      const GAP = 4; // 菜单和按钮之间留的缝
      const EDGE = 12; // 离视口上下边缘至少这么远
      const MIN_H = 120; // 两侧都挤时至少给这么高，再少就只剩两三行，没法挑了

      // 行数 × 行高 + 上下 padding。宁可估大一点：放得下就别急着出滚动条
      const want = rows.value.length * ITEM_H + 8;
      const below = window.innerHeight - EDGE - (a.bottom + GAP);
      const above = a.top - GAP - EDGE;
      const flip = below < Math.min(want, 240) && above > below;

      /*
       * 横向：默认**右对齐**到按钮 —— 列表行尾那颗「⋯」就在右边，菜单往左展开
       * 才不会顶出屏幕。
       *
       * 「按钮本身就在面板最左边」时得反过来（批量操作条上那颗就在主区最左边）：
       * 右对齐会让菜单整块跑到按钮左边的侧栏上，把刚看的那棵树糊住。这种是纯视觉
       * 问题，算不出来（右对齐并不越屏），所以由调用方直接说：align="left"。
       */
      const leftAligned = a.left;
      const fitsRight = leftAligned + props.width <= window.innerWidth - 8;
      const left =
        props.align === 'left'
          ? fitsRight
            ? leftAligned
            : Math.max(8, window.innerWidth - 8 - props.width)
          : Math.max(8, a.right - props.width);

      const maxH = Math.min(want, Math.max(flip ? above : below, MIN_H));
      pos.value = {
        top: flip ? Math.max(EDGE, a.top - GAP - maxH) : a.bottom + GAP,
        left,
        maxH,
      };
    }

    function toggle(event) {
      if (open.value) {
        close();
        return;
      }
      // 每次打开都从「全部折着」开始，再算菜单大小 —— 折着的时候行最少
      expanded.value = [];
      const box = event.currentTarget.getBoundingClientRect();
      // left 也要存：align="left" 那种（按钮在面板最左边）要从按钮左边往右展开
      anchor.value = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      place();
      open.value = true;
    }

    function pick(id) {
      close();
      emit('pick', id);
    }

    const setItemEl = (el, index) => {
      if (el) itemEls.value[index] = el;
    };

    watch(open, async (isOpen) => {
      if (!isOpen) return;
      itemEls.value = [];
      await nextTick();
      itemEls.value[0]?.focus();
    });

    /*
     * 展开 / 收起会换掉可见行，元素表得重建 —— 留着已经卸载的那些，
     * 键盘会「走到」一个不在页面上的按钮上，按了没反应。
     * 重建后把焦点放回同一序号那一行：展开就是在当前行下面插入子级，
     * 序号不变，看着像焦点没动过。
     */
    watch(rows, async () => {
      const keep = itemEls.value.indexOf(document.activeElement);
      itemEls.value = [];
      await nextTick();
      // 行数变了，高度上限和位置也跟着变（展开后不该顶出屏幕）
      if (open.value) place();
      if (keep >= 0) itemEls.value[keep]?.focus();
    });

    /** 菜单内的键盘走法：↑↓ 换行，→ 展开 / ← 收起，Enter 由按钮本身触发，Esc 收起 */
    function onMenuKeydown(event) {
      if (event.key === 'Escape') {
        // 别让 Esc 继续冒泡到弹层那边把整个弹窗也关了
        event.stopPropagation();
        close();
        return;
      }

      // 三角是个 span（不进 Tab 顺序），键盘上就用 ←→ 来展开 / 收起
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const row = rows.value[itemEls.value.indexOf(document.activeElement)];
        if (!row || !row.hasKids) return;
        event.preventDefault();
        if (event.key === 'ArrowRight' && !row.open) toggleExpand(row.id);
        if (event.key === 'ArrowLeft' && row.open) toggleExpand(row.id);
        return;
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

      const n = rows.value.length;
      if (!n) return;
      event.preventDefault();

      const step = event.key === 'ArrowDown' ? 1 : -1;
      const current = itemEls.value.indexOf(document.activeElement);
      // 焦点还不在任何一项上时：↓ 从头开始，↑ 从末尾开始
      const base = current < 0 ? (step > 0 ? -1 : 0) : current;
      itemEls.value[(base + step + n) % n]?.focus();
    }

    return {
      open, pos, toggle, pick, close, triggerEl, setItemEl, onMenuKeydown,
      rows, expanded, toggleExpand,
      menuW: computed(() => props.width),
    };
  },
  template: `
    <button
      class="row-menu-btn"
      ref="triggerEl"
      :class="label ? ['btn', 'btn-sm', { on: open }] : ['icon-btn', { on: open }]"
      :title="title"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      @click.stop="toggle"
    >
      <span v-if="label">{{ label }}</span>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="12" r="2" />
      </svg>
    </button>

    <!--
      菜单挂到 body 上（Teleport），不留在触发它的那一行里。
      原因：position: sticky 的祖先**一定会**创建堆叠上下文（写不写 z-index 都一样），
      菜单留在这行内部，它的 z-index 41 就只在这行里有效；出了这行，比的是
      「这一行」和「后面那些行」的顺序，于是被后面的行盖住 —— 点 ⋯ 弹出的菜单
      看着被削掉一截。这和下面用 fixed 定位是同一个道理：不能受列表容器的钳制。
    -->
    <Teleport to="body" v-if="open">
      <!-- 点别处就收起来。铺满整屏的透明层，比挂 document 监听干净 -->
      <div class="menu-mask" @click.stop="close"></div>
      <!--
        样式里必须写 right: auto —— .menu 自带 right: 0，而 fixed 定位下
        left 和 right 同时给上、又不给宽度，元素会被拉满一整行。
        宽度只给 min-width（和算坐标用的是同一个值）：文案长的菜单自己撑开，
        不会被写死的宽度截成省略号。
      -->
      <div
        class="menu"
        role="menu"
        :style="{
          position: 'fixed',
          top: pos.top + 'px',
          left: pos.left + 'px',
          right: 'auto',
          minWidth: menuW + 'px',
          maxWidth: 'calc(100vw - 16px)',
          maxHeight: pos.maxH + 'px',
        }"
        @keydown="onMenuKeydown"
      >
        <template v-for="(it, i) in rows" :key="it.id || 'sep-' + i">
          <div class="menu-sep" v-if="it.sep"></div>
          <!--
            带层级的一行 = [每层一根引导线][三角][文案][当前标记]。
            整行都是「移到这里」的点选区域，三角单独 stop 掉 ——
            底色铺在行上（不是文案按钮上），缩进那一段才不会看着像没亮。
          -->
          <div
            v-else
            class="menu-row"
            :class="{ danger: it.danger }"
            @click.stop="pick(it.id)"
          >
            <i class="menu-guide" v-for="g in it.depth" :key="g"></i>
            <!--
              三角不能借 Caret 的 btn 属性：那会挂上全站的 .btn 类
              （height:32px + padding:0 14px），行一下被撑到 32 高、三角占掉 32 宽，
              名字跟着右移一截，和没有三角的那些行对不齐。这里自己包一个按钮。
            -->
            <button
              v-if="it.hasKids"
              type="button"
              class="menu-caret"
              :title="it.open ? '收起子目录' : '展开子目录'"
              :aria-expanded="it.open ? 'true' : 'false'"
              @click.stop="toggleExpand(it.id)"
            >
              <Caret :open="it.open" />
            </button>
            <span v-else class="menu-caret-gap"></span>
            <button
              class="menu-item"
              :ref="(el) => setItemEl(el, i)"
              role="menuitem"
              :title="it.label"
              @click.stop="pick(it.id)"
            >{{ it.label }}</button>
            <!--
              条目后面跟一个数量（可选字段 it.count，别的菜单没给就不显示）：
              挑落点的时候，「3 个」和「30 个」是两种决定。
            -->
            <span class="menu-n" v-if="it.count">{{ it.count }}</span>
            <span class="menu-tag" v-if="it.current">当前</span>
          </div>
        </template>
      </div>
    </Teleport>
  `,
});
