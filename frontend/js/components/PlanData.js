import { computed, defineComponent, onBeforeUnmount, ref, watch } from 'vue';
import InfoTip from './InfoTip.js';
import { askConfirm } from '../store.js';
import { parseTsv } from '../csv.js';

/**
 * 方案的测试数据。
 *
 * 是**一张能编辑的表**，不是「导入了一份 CSV」的只读回显。理由是实际用法：
 * 跑完发现某一行数据是坏的，要改一个值再跑一遍 —— 为此去改 CSV、重新导入，
 * 是最没必要的一步。手动建表和导入 CSV 之后，增删改都在这里做。
 *
 * 行结构就是二维数组，列名单独一份（`columns`），和 CSV 的形状一致 ——
 * 导入只是「填一次」，之后和手动建的没有区别。
 *
 * 点列名旁边的「复制」按钮、以及「只跑前 N 行」那个输入框由上层接 ——
 * 一个要往编辑器粘贴，一个要落回方案。
 */

/**
 * 列宽按方案缓在这儿。
 *
 * 必须是模块级的：上层是 v-if，切页签这个组件会整个重建 —— 缓在实例里等于
 * 没缓，拖好的宽度一切走就回到默认值。
 */
const widthCache = new Map();

export default defineComponent({
  name: 'PlanData',
  components: { InfoTip },
  props: {
    data: { type: Object, default: null },
    /** 这次只跑前多少行，0 = 全部 */
    limit: { type: Number, default: 0 },
    /** 哪个方案的测试数据。列宽按它缓存 —— 换方案该有各自的宽窄 */
    planId: { type: String, default: '' },
  },
  emits: ['import', 'clear', 'create', 'limit'],
  setup(props, { emit }) {
    const fileEl = ref(null);

    const pick = () => {
      // 先清空，否则连着选同一个文件不会再触发 change
      if (fileEl.value) fileEl.value.value = '';
      fileEl.value?.click();
    };

    const onFile = (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) emit('import', file);
    };

    // ---------------- 列宽能拖 ----------------
    /**
     * 列宽是**看表的人**的偏好，不是这份数据的一部分。
     *
     * 所以不进 store：进去就会跟着方案写进 data 文件，拖一下宽窄也变成一次
     * 「有未保存的改动」。缓在模块里（见文件顶部），本次会话有效。
     */
    const ROWNO_WIDTH = 62;
    const ADD_WIDTH = 40;
    const DEFAULT_COL_WIDTH = 130;
    /** 再窄就把列名挤没了。删除键是浮出来的、不占位置，所以这个下限只跟列名有关 */
    const MIN_COL_WIDTH = 76;
    const MAX_COL_WIDTH = 560;
    /** 手柄宽度。放在这儿而不是 CSS 里：left 得按它算，两处写就得两处改 */
    const GRIP_WIDTH = 7;
    /**
     * 表头那一格的固定开销：格子左右内边距 10 + 10，再加上列名输入框自己的左右
     * 内边距 6 + 6。删除键是绝对定位浮出来的，不占这儿的开销。
     * 少算最后那 12px，自适应出来的宽度就会把列名啃掉两个字。
     */
    const HEAD_CHROME_WIDTH = 34;
    /** 单元格左右内边距，量内容宽度时要加回来 */
    const CELL_PADDING = 20;

    const widths = ref([]);
    const cacheKey = () => props.planId || '__unnamed__';

    /** 列数变了（换方案、导入 CSV、加列、删列）就按缓存重新对齐宽度 */
    const loadWidths = () => {
      const n = props.data ? props.data.columns.length : 0;
      const saved = widthCache.get(cacheKey()) || [];
      widths.value = Array.from({ length: n }, (_, j) => saved[j] || DEFAULT_COL_WIDTH);
    };

    watch(
      () => [cacheKey(), props.data ? props.data.columns.length : 0],
      loadWidths,
      { immediate: true }
    );

    const tableWidth = computed(
      () => ROWNO_WIDTH + ADD_WIDTH + widths.value.reduce((sum, w) => sum + w, 0)
    );

    /** 手柄骑在列的分界线上：从行号列右边算起，减掉半个手柄 */
    const gripLeft = (j) =>
      ROWNO_WIDTH + widths.value.slice(0, j + 1).reduce((sum, w) => sum + w, 0) - GRIP_WIDTH / 2;

    /**
     * 拖动中只记「按下时的位置和宽度」，移动多少加多少。
     * 不用组件的 mousemove：指针一快就滑出手柄，拖到一半断掉。
     */
    let drag = null;

    const onDragMove = (event) => {
      if (!drag) return;
      const next = drag.from + (event.clientX - drag.x);
      widths.value[drag.j] = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(next)));
    };

    const stopDrag = () => {
      if (!drag) return;
      drag = null;
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', stopDrag);
      window.removeEventListener('blur', stopDrag);
      document.body.classList.remove('col-resizing');
      widthCache.set(cacheKey(), widths.value.slice());
    };

    const startResize = (j, event) => {
      event.preventDefault();
      drag = { j, x: event.clientX, from: widths.value[j] || DEFAULT_COL_WIDTH };
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', stopDrag);
      // 拖到一半切走窗口、或者在窗口外松手，mouseup 是收不到的 —— 那条监听会一直
      // 挂着，回来动一下鼠标列宽就跟着跑
      window.addEventListener('blur', stopDrag);
      document.body.classList.add('col-resizing');
    };

    /**
     * 双击手柄：按这一列的内容算一个刚好放得下的宽度。
     *
     * 量文字用 canvas 的 measureText，不往 DOM 里塞隐藏节点再量 —— 那种做法每列
     * 都要触发一次重排。字体直接取单元格上的，别处改了字号这里跟着对。
     */
    let measureCtx = null;
    const textWidth = (text, font) => {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = font;
      return measureCtx.measureText(text == null ? '' : String(text)).width;
    };

    const fitColumn = (j) => {
      if (!props.data) return;
      // 字体从真实的格子上取。没有数据行（手动新建的空表）时退回列名那个输入框 ——
      // 那时候要量的也只有列名，用它的字号正好
      const sample =
        document.querySelector('.grid-table .grid-cell') ||
        document.querySelector('.grid-table .grid-col-input');
      if (!sample) return;
      const cs = getComputedStyle(sample);
      const font = `${cs.fontSize} ${cs.fontFamily}`;

      // 数据那一侧：一格一格量，取最宽的那个
      let byValue = 0;
      document.querySelectorAll('.grid-table tbody tr').forEach((tr) => {
        const cell = tr.children[j + 1] && tr.children[j + 1].querySelector('.grid-cell');
        if (cell) byValue = Math.max(byValue, textWidth(cell.value, font));
      });
      byValue += CELL_PADDING;

      // 表头那一侧：列名加上两颗按钮 —— 名字再短，这两颗也得放得下
      const byName = textWidth(props.data.columns[j], font) + HEAD_CHROME_WIDTH;

      widths.value[j] = Math.min(
        MAX_COL_WIDTH,
        Math.max(MIN_COL_WIDTH, Math.round(Math.max(byValue, byName)) + 8)
      );
      widthCache.set(cacheKey(), widths.value.slice());
    };

    onBeforeUnmount(stopDrag);

    // ---------------- 分页 ----------------
    /**
     * 分页只管**显示**：一页 20 行还是 100 行，跟这一轮跑多少行没有任何关系 ——
     * 那是上面「运行前 N 行」的事，别让两个数字看着像一回事，所以这里写「每页显示」。
     *
     * 页码和每页行数都是会话里的看法，不落盘：换方案、重新导入、清空数据都会回到第一页。
     */
    const PAGE_SIZES = [20, 50, 100, 0]; // 0 = 全部
    const page = ref(1);
    const pageSize = ref(PAGE_SIZES[0]);

    const rowTotal = computed(() => (props.data ? props.data.rows.length : 0));
    /** 实际的每页行数。「全部」时就是全部行数，兜个 1 免得后面除零 */
    const size = computed(
      () => (pageSize.value > 0 ? pageSize.value : Math.max(rowTotal.value, 1))
    );
    const pageCount = computed(() => Math.max(1, Math.ceil(rowTotal.value / size.value)));

    /**
     * 这一页要显示的行，连**全局行号**一起带出去。
     *
     * 行号必须是全局的（第二页从 21 开始）：单元格和删行按钮都按这个下标去改数据，
     * 只给页内下标的话，第二页改一格会改到第一页去。
     */
    const pageRows = computed(() => {
      if (!props.data) return [];
      const start = (page.value - 1) * size.value;
      return props.data.rows
        .slice(start, start + size.value)
        .map((row, k) => ({ row, index: start + k }));
    });

    // 删着删着当前页就没了（最后一页只剩两行，删光就空了），收回最后一页
    watch(pageCount, (n) => {
      if (page.value > n) page.value = n;
    });
    // 换方案、重新导入、清空 —— 数据换了对象，回到第一页
    watch(() => props.data, () => {
      page.value = 1;
    });

    const goPage = (n) => {
      page.value = Math.min(pageCount.value, Math.max(1, n));
    };

    /** 换每页多少行：回到第一页，否则会停在「第 5 页，但总共只剩 3 页」 */
    const setPageSize = (value) => {
      pageSize.value = Number(value) || 0;
      page.value = 1;
    };

    // ---------------- 就地编辑 ----------------
    // 直接改 props.data 里的数组：它就是 store 里那份草稿，Vue 追得到。
    // 和请求编辑器改 request 是同一个路数，不为了「纯粹」再绕一层事件。
    const columns = () => props.data.columns;
    const rows = () => props.data.rows;

    /**
     * 重名的列。
     *
     * 数据行是按列名摊成 `{ 列名: 值 }` 给接口用的（见 store 的 runOneRow），
     * 两列同名时只有后一个能取到 —— 少了一列数据，接口照样返回 200，报告也全绿。
     * 导入 CSV 时会自动改名，但手动改列名躲不过这回事，所以在这儿显式提醒。
     */
    const dupColumns = computed(() => {
      const seen = new Set();
      const dup = new Set();
      columns().forEach((name) => {
        if (seen.has(name)) dup.add(name);
        else seen.add(name);
      });
      return [...dup];
    });

    const renameColumn = (j, value) => {
      columns()[j] = value;
    };

    const addColumn = () => {
      columns().push(`列${columns().length + 1}`);
      // 已有的行要补一格，否则新列在它们那里是 undefined，渲染出来是空的但改不了
      rows().forEach((row) => row.push(''));
      widths.value.push(DEFAULT_COL_WIDTH);
      widthCache.set(cacheKey(), widths.value.slice());
    };

    const removeColumn = (j) => {
      // 删列会连带整列数据，先问一句（和全站其它删除一致）
      const name = columns()[j] || `第 ${j + 1} 列`;
      askConfirm('删除列', `确定删除列「${name}」吗？这一列的数据会一起删掉。`, () => {
        columns().splice(j, 1);
        rows().forEach((row) => row.splice(j, 1));
        // 宽度得跟着列一起删，不然删掉中间一列之后，右边全部宽度左移一位
        widths.value.splice(j, 1);
        const saved = widthCache.get(cacheKey());
        if (saved) saved.splice(j, 1);
      });
    };

    const setCell = (rowIndex, colIndex, value) => {
      rows()[rowIndex][colIndex] = value;
    };

    /**
     * 往表格里粘一片数据，落点从当前这一格开始往右往下铺。
     *
     * 以前只能一格一格敲 —— 而这份数据本来就是从 Excel 来的：导 CSV 是唯一的批量
     * 入口，想再补 20 行 × 5 列，得点 20 次「添加一行」再敲 100 次。
     *
     * 行列不够就地长：行追加在末尾（列数按表头对齐），列按「列N」加出来、已有行补空格。
     * **只补不删** —— 粘一小片不该把右边、下边已有的数据擦掉。
     */
    const pasteCells = (rowIndex, colIndex, text) => {
      const block = parseTsv(text);
      if (!block.length) return;

      const needCols = colIndex + Math.max(...block.map((line) => line.length));
      while (columns().length < needCols) {
        columns().push(`列${columns().length + 1}`);
        rows().forEach((row) => row.push(''));
        widths.value.push(DEFAULT_COL_WIDTH);
      }
      while (rows().length < rowIndex + block.length) rows().push(columns().map(() => ''));

      block.forEach((line, i) => {
        line.forEach((value, j) => {
          rows()[rowIndex + i][colIndex + j] = value;
        });
      });

      widthCache.set(cacheKey(), widths.value.slice());
      // 贴进来的这一片得看得见：翻到它所在的那一页
      page.value = Math.min(pageCount.value, Math.floor(rowIndex / size.value) + 1);
    };

    /**
     * 单元格上收到粘贴。
     *
     * 只有**多格**的内容才接管（带制表符或换行）：往输入框里粘一段普通文本是浏览器
     * 自己的事，拦下来反而把「改一个格子」这种最常干的活儿弄坏。
     */
    const onPaste = (rowIndex, colIndex, event) => {
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!/[\t\r\n]/.test(text)) return;
      event.preventDefault();
      pasteCells(rowIndex, colIndex, text);
    };

    const addRow = () => {
      rows().push(columns().map(() => ''));
      // 新行加在最后。停在第一页的话，点完看不出任何变化 —— 翻到最后一页让人看见它
      page.value = pageCount.value;
    };

    const removeRow = (rowIndex) => {
      askConfirm('删除行', `确定删除第 ${rowIndex + 1} 行吗？`, () => {
        rows().splice(rowIndex, 1);
      });
    };

    /**
     * 提示文案里的字面量 {{列名}}。
     *
     * 必须先在 JS 里拼好：直接写进模板插值的话，这个 `}}` 会被 Vue 当成插值的
     * 结束，生成的渲染函数是坏代码，运行时直接抛 SyntaxError。
     */
    const varHint = '{{列名}}';

    /**
     * 「?」里的说明。
     *
     * 不说「跑 N 遍」：这张表的行数就写在旁边（10 行 · 4 列），再报一遍是多余的，
     * 而且那个数会跟着「只跑前 N 行」变，说多了反而要对账。
     */
    const dataTip = `整个方案按行跑，接口里写 ${varHint} 取到的就是当前这一行的值。`;

    return {
      fileEl, pick, onFile, varHint, dataTip,
      renameColumn, addColumn, removeColumn, setCell, addRow, removeRow, onPaste,
      widths, tableWidth, startResize, gripLeft, fitColumn, ROWNO_WIDTH, ADD_WIDTH, GRIP_WIDTH,
      page, pageSize, PAGE_SIZES, rowTotal, pageCount, pageRows, goPage, setPageSize,
      dupColumns,
    };
  },
  template: `
    <div class="plan-data">
      <!--
        file 输入常驻在根节点下，不进 v-if / v-else。有数据时那颗「重新导入 CSV」
        就是靠它弹选择框的 —— 之前它跟着空态一起被 v-else 藏掉，有数据时点那颗
        按钮等于对着 null 调 click()，什么都不会发生。
      -->
      <input
        ref="fileEl"
        type="file"
        accept=".csv,text/csv"
        style="display: none"
        @change="onFile"
      />

      <template v-if="data">
        <div class="data-head">
          <span class="data-file">{{ data.name }}</span>
          <span class="data-meta">{{ data.rows.length }} 行 · {{ data.columns.length }} 列</span>
          <!-- 重名列必须说出来：{{列名}} 只能取到其中一个，取不到的那一列没有任何别的提示 -->
          <span
            class="hint data-dup"
            v-if="dupColumns.length"
            :title="'{{名字}} 只能取到其中一个 —— 另一个列取不到值，但请求照样会成功'"
          >列名重复：{{ dupColumns.join('、') }}</span>
          <InfoTip :text="dataTip" />

          <!--
            只跑前 N 行。200 行要跑几分钟，改了一处想先跑 10 行看看 ——
            为此去删掉 190 行数据再跑，是没人愿意干的事。
          -->
          <label class="data-limit" title="调试时先跑几行看看，不用把数据删掉">
            运行前
            <input
              class="kv-input"
              type="number"
              min="1"
              :max="data.rows.length"
              :value="limit || ''"
              :placeholder="data.rows.length"
              @change="$emit('limit', $event.target.value)"
            />
            行
          </label>

          <button
            class="btn btn-sm"
            title="重新选一个 CSV 文件导入，覆盖现在这份数据"
            @click="pick"
          >重新导入 CSV</button>
          <button class="icon-btn" title="清空测试数据" @click="$emit('clear')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div class="grid-wrap">
          <!-- 定位容器：宽度跟着列走，手柄那一层也铺在这个范围里 -->
          <div class="grid-scroll" :style="{ width: tableWidth + 'px', minWidth: '100%' }">
            <table class="grid-table">
              <!--
                列宽交给 colgroup：表格用 fixed 布局，拖的是这里的数字，不是单元格内容 ——
                否则内容一长就把拖好的宽度顶开。
                最后那列不给宽度：列加起来铺不满的时候，由它吃掉剩下的地方，
                表头灰底和行线才能一直拉到右边缘，而不是在最后一列断掉。
              -->
              <colgroup>
                <col :style="{ width: ROWNO_WIDTH + 'px' }" />
                <col v-for="(w, j) in widths" :key="j" :style="{ width: w + 'px' }" />
                <col :style="{ width: ADD_WIDTH + 'px' }" />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th class="grid-rowno"></th>
                  <th v-for="(c, j) in data.columns" :key="j" class="grid-col">
                    <div class="grid-col-head">
                      <input
                        class="grid-col-input"
                        :value="c"
                        title="改列名"
                        @input="renameColumn(j, $event.target.value)"
                      />
                      <button
                        class="grid-icon grid-col-del danger"
                        title="删掉这一列"
                        @click="removeColumn(j)"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 6h18" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </th>
                  <th class="grid-add">
                    <button class="grid-icon" title="加一列" @click="addColumn">＋</button>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in pageRows" :key="r.index">
                  <td class="grid-rowno">
                    <!-- 行号是全局的：翻到第二页从 21 开始，不是从头数 -->
                    <span class="grid-rowno-n">{{ r.index + 1 }}</span>
                    <!-- 和删列同一个图标、同一个大小 -->
                    <button
                      class="grid-icon grid-row-del danger"
                      title="删掉这一行"
                      @click="removeRow(r.index)"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </td>
                  <td v-for="(c, j) in data.columns" :key="j">
                    <input
                      class="grid-cell"
                      :value="r.row[j] ?? ''"
                      title="可以直接从 Excel 粘一片进来"
                      @input="setCell(r.index, j, $event.target.value)"
                      @paste="onPaste(r.index, j, $event)"
                    />
                  </td>
                  <td></td>
                  <td></td>
                </tr>
                <tr class="grid-add-row">
                  <td class="grid-rowno"></td>
                  <td :colspan="data.columns.length + 2">
                    <button class="btn btn-sm" @click="addRow">＋ 添加一行</button>
                  </td>
                </tr>
              </tbody>
            </table>

            <!--
              列宽手柄。铺在表格上面，每条压在列的分界线上、整列高都能抓 ——
              上一版只挂在表头那一格里，鼠标在下面的数据区想拖列宽，得先挪回表头，
              而且手柄往右探出去的那一半还被右边那格的吸顶表头盖住，实际只剩四个像素。

              不能每格都挂一个手柄（表一长就是几百个元素），也不能让这一层吃掉点击：
              整层 pointer-events:none，只有手柄自己收事件。
            -->
            <div class="grid-grips">
              <span
                v-for="(w, j) in widths"
                :key="j"
                class="grid-grip"
                :style="{ left: gripLeft(j) + 'px', width: GRIP_WIDTH + 'px' }"
                title="拖动改列宽；双击按内容自适应"
                @mousedown="startResize(j, $event)"
                @dblclick="fitColumn(j)"
              ></span>
            </div>
          </div>
        </div>

        <!--
          分页条。它管的是**显示**，不是「这一轮跑多少行」—— 所以写「每页显示」，
          和上面那个「运行前 N 行」分开说，免得两个数字看着像同一件事。

          只报「第几页 / 共几页」：行号就写在每一行的行号格里（翻到第二页是 21 起），
          再报一遍「第 41–60 行」是同一件事说两遍。
        -->
        <div class="grid-pager" v-if="rowTotal">
          <label class="grid-pager-size">
            每页显示
            <select class="kv-input" :value="pageSize" @change="setPageSize($event.target.value)">
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n ? n + ' 行' : '全部' }}</option>
            </select>
          </label>

          <!-- 只有一页时那两颗按钮都是灰的，纯占地方，不摆 -->
          <div class="grid-pager-nav" v-if="pageCount > 1">
            <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
            <span class="grid-pager-page">{{ page }} / {{ pageCount }}</span>
            <button class="btn btn-sm" :disabled="page >= pageCount" @click="goPage(page + 1)">下一页</button>
          </div>
        </div>
      </template>

      <div v-else class="empty">
        <span class="empty-title">还没有测试数据</span>
        <span class="empty-hint">
          每一行都会把整个方案跑一遍。第一行当列名，接口里用列名取值。<br />
          导入 CSV，或者直接手动建一张表 —— 建完一样能改。
        </span>
        <div class="data-new">
          <button class="btn btn-primary btn-sm" @click="pick">选择 CSV 文件</button>
          <button class="btn btn-sm" @click="$emit('create')">手动新建</button>
        </div>
      </div>
    </div>
  `,
});
