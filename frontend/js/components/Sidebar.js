import { computed, defineComponent, ref } from 'vue';
import Caret from './Caret.js';
import RowMenu from './RowMenu.js';
import {
  clearPickedRequests, pickRequests, pickedRequestIds, requestMatches, requestsUnderEach,
  selectableRequestIds, toggleRequestPick,
} from '../store.js';
import { allPicked, somePicked } from '../pickScope.js';

/** 树里每一层往里缩进多少像素。和「移动到目录」菜单同一套刻度。 */
const INDENT = 14;
/** 每一层最左边留出的空白（缩进从这一格开始算）。 */
const TREE_PAD = 10;

/**
 * 一行（目录 / 请求）的缩进、层级引导线，以及**吸顶时的落点**。
 *
 * 层级用三样东西一起说：
 *   · 缩进（每层 14px）—— 往里一层
 *   · 引导线（画在自己那层缩进块的中间）—— 同一层的东西连成一条。
 *     只有缩进的时候，深一层和父目录看着只是「往右偏了一点」，几层全靠数
 *   · 吸顶落点（每层让一个行高）—— 滚到深处时，从一级到当前这一级的标题
 *     依次停在顶上垒成一摞，路径一眼数得出来
 *
 * 一级目录不缩进、也没有线：它在这一列里是「分组标题」，不是「某个目录的
 * 子目录」。线画在上一级三角的正下方，看起来就是从父目录那儿垂下来的。
 *
 * 缩进和线都从行自己的 background 上给，不加额外元素：模板里插一层 i 标签，
 * 每行数量还不一样，拖拽落点和键盘走位都得跟着重新算。
 *
 * top 只对目录行有意义（.dir-row 是 sticky，请求行不是），请求行跟着带上
 * 不影响什么，用一个函数省得两处各算一遍。
 */
function rowStyle(depth) {
  const style = {
    paddingLeft: TREE_PAD + (depth - 1) * INDENT + 'px',
    /*
     * 吸顶落点交给 CSS 算（.dir-row 里 top: calc((var(--depth) - 1) * var(--row-h))）。
     * 行高只在 CSS 里定义一处 —— 以前这里也写死一个行高，加了 1px 下边线之后
     * 实际变成 31px，落点还按 30 让位，堆叠起来每层都压住上一层那条线，三层糊成一块。
     */
    '--depth': depth,
  };
  if (depth <= 1) return style;

  style.backgroundImage = 'linear-gradient(var(--border-strong), var(--border-strong))';
  style.backgroundSize = '1px 100%';
  style.backgroundRepeat = 'no-repeat';
  style.backgroundPosition = TREE_PAD + (depth - 2) * INDENT + 6 + 'px 0';
  return style;
}

/**
 * 一个请求行。
 *
 * 拆出来是因为它要在多处出现：目录里、子目录里、未分组里，以及没有目录时的
 * 扁平列表里。十几行模板抄好几遍，以后每次改都得记得改每一处。
 */
const ReqRow = defineComponent({
  name: 'ReqRow',
  components: { RowMenu },
  props: {
    request: { type: Object, required: true },
    activeId: { type: String, default: '' },
    dirty: { type: Boolean, default: false },
    picked: { type: Boolean, default: false },
    depth: { type: Number, default: 1 },
    /** 拖拽落点提示：'' / 'before' / 'after' */
    drop: { type: String, default: '' },
    menu: { type: Array, required: true },
  },
  emits: ['open', 'toggle-pick', 'rename', 'action', 'drag-start', 'drag-end'],
  setup(props, { emit }) {
    const editing = ref(false);
    const name = ref('');

    const startEdit = () => {
      name.value = props.request.name;
      editing.value = true;
    };

    const commit = () => {
      if (!editing.value) return;
      editing.value = false;
      const trimmed = name.value.trim();
      if (trimmed && trimmed !== props.request.name) emit('rename', trimmed);
    };

    // ⋯ 里的「重命名」由行内部消化，其余（复制 / 删除）往上抛
    const onAction = (id) => {
      if (id === 'rename') return startEdit();
      emit('action', id);
    };

    /** Enter / 空格打开这个请求。只在行自己被聚焦时响应 —— 行里还嵌着勾选框和 ⋯ 按钮 */
    const onKeydown = (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      emit('open');
    };

    return {
      editing, name, commit, onAction, onKeydown,
      rowStyle: () => rowStyle(props.depth),
    };
  },
  template: `
    <div
      class="req-item tree-row"
      :class="[
        { active: request.id === activeId, picked },
        drop === 'before' ? 'drop-before' : '',
        drop === 'after' ? 'drop-after' : '',
      ]"
      :style="rowStyle()"
      draggable="true"
      tabindex="0"
      role="button"
      :aria-label="request.method + ' ' + request.name"
      :title="request.method + ' ' + (request.url || '')"
      :aria-current="request.id === activeId ? 'true' : 'false'"
      @click="$emit('open')"
      @keydown="onKeydown"
      @dragstart="$emit('drag-start', $event)"
      @dragend="$emit('drag-end')"
    >
      <input
        v-if="editing"
        v-focus
        class="kv-input"
        v-model="name"
        @keyup.enter="commit"
        @blur="commit"
        @click.stop
      />
      <template v-else>
        <input
          type="checkbox"
          class="req-pick"
          :checked="picked"
          title="选中（批量移动）"
          @click.stop
          @change="$emit('toggle-pick')"
        />
        <span class="method" :class="request.method">{{ request.method }}</span>
        <span class="req-name">{{ request.name }}</span>
        <span v-if="dirty" class="dirty-dot" title="有未保存的改动"></span>
        <RowMenu :items="menu" title="这个请求的操作" @pick="onAction" />
      </template>
    </div>
  `,
});

/**
 * 左侧接口列：项目下是一棵目录树。
 *
 * 目录可以无限嵌套（目录里还能建目录），请求落在任意目录下或根上（根上的归到
 * 「未分组」那一栏）。树是**扁平摊开**渲染的（每行带深度），靠缩进体现层级 ——
 * 比递归组件好维护，拖拽落点也只要认「这一行」的位置就行。
 *
 * 拖拽是整棵树里通用的：请求 / 目录能拖到任意目录下，拖到行的上 1/3、下 1/3 是
 * 排序（插到它前 / 后），拖到目录行中间是「放进这个目录」。
 */
export default defineComponent({
  name: 'Sidebar',
  components: { Caret, RowMenu, ReqRow },
  props: {
    /** interfaceTree 那份：{ rows, ungrouped, count, hasDirs, ungroupedCollapsed } */
    tree: { type: Object, required: true },
    activeId: { type: String, default: '' },
    /** 还挂着未提交改动的请求 id。这些行要标个点，否则看不出来谁没保存 */
    dirtyIds: { type: Array, default: () => [] },
  },
  emits: [
    'select', 'create-request', 'rename-request',
    'remove-request', 'duplicate-request',
    'import-openapi', 'export',
    'create-dir', 'dir-action', 'toggle-dir', 'toggle-ungrouped', 'move-nodes',
    'remove-requests',
  ],
  setup(props, { emit }) {
    const keyword = ref('');
    const fileEl = ref(null);

    const pickFile = () => {
      // 先清空，否则连着选同一个文件不会触发 change
      if (fileEl.value) fileEl.value.value = '';
      fileEl.value?.click();
    };

    const onFilePicked = (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) emit('import-openapi', file);
    };

    const searching = computed(() => !!keyword.value.trim());

    // ------------------------------ 可见行 ------------------------------
    /**
     * 折叠靠「跳过被折叠目录的子孙」实现。树是前序铺开的：子行的 depth 一定
     * 比父目录大，所以记一下被折叠目录的深度，遇到 depth 不比它大的行就恢复。
     */
    const visibleRows = () => {
      const all = props.tree.rows || [];
      if (searching.value) return all;
      const out = [];
      let skipDeeperThan = -1;
      all.forEach((row) => {
        if (row.depth <= skipDeeperThan) skipDeeperThan = -1;
        if (skipDeeperThan >= 0) return;
        out.push(row);
        if (row.kind === 'dir' && row.collapsed) skipDeeperThan = row.depth;
      });
      return out;
    };

    /** 搜索：只留有命中的请求（接口名或 URL），以及包含命中的目录 */
    const searchRows = () => {
      const all = props.tree.rows || [];
      const hit = (r) => requestMatches(r, keyword.value);
      const dirParent = new Map(all.filter((r) => r.kind === 'dir').map((r) => [r.id, r.parentId]));
      const keep = new Set();
      all.forEach((row) => {
        if (row.kind !== 'req' || !hit(row.request)) return;
        let parentId = row.parentId;
        while (parentId && !keep.has(parentId)) {
          keep.add(parentId);
          parentId = dirParent.get(parentId) || '';
        }
      });
      return all.filter((row) => (row.kind === 'dir' ? keep.has(row.id) : hit(row.request)));
    };

    /** 当前要渲染的行（搜索时是筛过的，平时是按折叠收过的） */
    const rows = computed(() => (searching.value ? searchRows() : visibleRows()));

    /** 「未分组」那一栏的请求。搜索时同样只留命中的（接口名或 URL） */
    const ungrouped = computed(() => {
      const list = props.tree.ungrouped || [];
      if (!searching.value) return list;
      return list.filter((r) => requestMatches(r, keyword.value));
    });

    /** 目录该不该展开：搜索时一律展开 */
    const dirOpen = (row) => searching.value || !row.collapsed;

    const ungroupedOpen = computed(() => searching.value || !props.tree.ungroupedCollapsed);

    const isDirty = (id) => props.dirtyIds.includes(id);

    // ------------------------------ 勾选 / 批量操作 ------------------------------
    /*
     * 勾选是**项目级**的（只认请求 id）：目录树本就跨整个项目，批量移动 / 删除也该跨。
     *
     * 状态存在 store 里（state.pickedRequestIds）—— 用它的不止这一处：还有浮在主区
     * 顶上的那条批量操作条（PickBar.js）。这个组件只管树上的勾选框。
     * 也不用再手动对账：store 那份读出来就已经滤掉了不存在的 id。
     */
    const picked = computed(() => pickedRequestIds.value);
    const pickCount = computed(() => picked.value.length);

    /**
     * 顶上那格「全选」管的那一批：**搜索时是命中的，平时是项目里全部请求**。
     *
     * 折叠一律不算筛选 —— 它只是收起来不显示。以前这格只看屏幕上那几行，
     * 折叠着的目录就整批漏掉了：点完全选再删除，那些请求还留着，界面上却看不出。
     * 目录行那格（dirIds）一直是这个口径，这里原来跟它不一致。
     */
    const scopeIds = computed(() =>
      selectableRequestIds(
        props.tree.rows || [],
        props.tree.ungrouped || [],
        searching.value ? keyword.value : ''
      )
    );

    // 三态判定统一走 pickScope.js（口径只有一份，别处别再各写一遍）
    const allSelected = computed(() => allPicked(scopeIds.value, picked.value));
    const someSelected = computed(() => somePicked(scopeIds.value, picked.value));

    const isPicked = (requestId) => picked.value.includes(requestId);

    const togglePick = (requestId) => toggleRequestPick(requestId);

    /** 悬停那格「全选」时说清它要勾多少、勾哪些 —— 折叠不影响它，搜索才影响 */
    const selectTitle = computed(() =>
      searching.value
        ? `选中命中的 ${scopeIds.value.length} 个请求（折叠的目录里命中的也算）`
        : `选中项目里全部 ${scopeIds.value.length} 个请求（折叠的目录也算）`
    );

    /**
     * 全选 / 取消全选。**只管自己那批**（搜索时是命中的，平时是全部），
     * 和目录行那格一个规矩：不碰这一批之外的勾选。
     */
    const toggleAll = (checked) => pickRequests(scopeIds.value, checked);

    const clearPicks = () => clearPickedRequests();

    // ------------------------------ 按目录整批勾选 ------------------------------
    /**
     * 目录 → 它下面**所有后代请求**的 id（子目录里的也算）。
     *
     * 走的是完整那棵树（`tree.rows`），不是屏幕上那几行：折叠只是收起来不显示，
     * 不代表里面没有 —— 勾一个目录就该把折叠着的那部分也带上。
     * 搜索时只算命中的请求（搜索是明确的筛选意图）。
     *
     * 行是前序铺开的，所以从这一行往后走、遇到 depth 不再更大就是走出了这棵子树。
     * 整棵树一次算完，别每行都走一遍。
     */
    const dirRequests = computed(() =>
      requestsUnderEach(
        props.tree.rows || [],
        searching.value ? keyword.value.trim().toLowerCase() : ''
      )
    );

    const dirIds = (dirId) => dirRequests.value[dirId] || [];

    /** 空目录的勾选框是禁用的，文案得说清是「本来就空」还是「搜索没命中」 */
    const dirPickTitle = (dirId) => {
      if (dirIds(dirId).length) return '选中这个目录下的全部接口';
      return searching.value ? '这个目录下没有命中的接口' : '这个目录下还没有接口';
    };

    const dirAllChecked = (dirId) => allPicked(dirIds(dirId), picked.value);

    /** 半选：勾了一部分 —— 嵌套目录里只看得见「父目录勾没勾」的话会误判 */
    const dirSomeChecked = (dirId) => somePicked(dirIds(dirId), picked.value);

    /** 整目录勾 / 不勾：只动这一批 id，别把别处勾的带走 */
    const toggleDirPick = (dirId, checked) => pickRequests(dirIds(dirId), checked);

    /** 「未分组」那一栏同上 —— 它也是一格，装的都是顶层请求 */
    const looseIds = computed(() => ungrouped.value.map((r) => r.id));

    const looseAllChecked = () => allPicked(looseIds.value, picked.value);
    const looseSomeChecked = () => somePicked(looseIds.value, picked.value);

    const toggleLoosePick = (checked) => pickRequests(looseIds.value, checked);

    // ------------------------------ 拖拽 ------------------------------
    const DRAG_MIME = 'text/plain';
    /** 正在拖的：{ kind, id, ids?, fromPicks } */
    const drag = ref(null);
    /** 落点：{ key, mode, targetParentId, beforeId, afterId } */
    const dropHint = ref(null);

    const dragNode = (kind, id, event) => {
      const fromPicks = kind === 'req' && isPicked(id);
      drag.value = {
        kind,
        id,
        ids: fromPicks ? picked.value.slice() : null,
        fromPicks,
      };
      if (!event?.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不设数据就不启动拖拽
      event.dataTransfer.setData(DRAG_MIME, id);
    };

    const dragEnd = () => {
      drag.value = null;
      dropHint.value = null;
    };

    /** 事件委托：整片列表上算落点，省得每行都挂一套监听 */
    const onDragOver = (event) => {
      if (!drag.value) return;
      const row = event.target.closest && event.target.closest('[data-node-kind]');
      if (!row) {
        dropHint.value = null;
        return;
      }
      // 必须 preventDefault，否则浏览器不认这是「能放下的地方」，drop 不会触发
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

      const kind = row.getAttribute('data-node-kind');
      if (kind === 'root') {
        // 「未分组」那一行就是项目的顶层
        dropHint.value = { key: 'root', mode: 'into', targetParentId: '' };
        return;
      }

      const id = row.getAttribute('data-node-id');
      const parentId = row.getAttribute('data-parent') || '';
      const rect = row.getBoundingClientRect();
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;

      if (kind === 'dir') {
        if (ratio < 0.3) {
          dropHint.value = { key: 'before:' + id, mode: 'before', targetParentId: parentId, beforeId: id };
        } else if (ratio > 0.7) {
          dropHint.value = { key: 'after:' + id, mode: 'after', targetParentId: parentId, afterId: id };
        } else {
          // 中间那一大半 = 放进这个目录
          dropHint.value = { key: 'into:' + id, mode: 'into', targetParentId: id };
        }
      } else if (ratio < 0.5) {
        dropHint.value = { key: 'before:' + id, mode: 'before', targetParentId: parentId, beforeId: id };
      } else {
        dropHint.value = { key: 'after:' + id, mode: 'after', targetParentId: parentId, afterId: id };
      }
    };

    const onDragLeave = (event) => {
      // 在子元素之间移动也会触发 dragleave，不挡一下高亮会疯狂闪
      if (event.currentTarget.contains(event.relatedTarget)) return;
      dropHint.value = null;
    };

    const onDrop = (event) => {
      event.preventDefault();
      const hint = dropHint.value;
      const current = drag.value;
      dragEnd();
      if (!current || !hint) return;

      const nodes = current.ids
        ? current.ids.map((id) => ({ kind: 'req', id }))
        : [{ kind: current.kind, id: current.id }];

      emit('move-nodes', {
        nodes,
        targetParentId: hint.targetParentId,
        beforeId: hint.beforeId || '',
        afterId: hint.afterId || '',
      });
      if (current.fromPicks) clearPicks();
    };

    const hintIs = (key) => !!dropHint.value && dropHint.value.key === key;
    /** 请求行的落点样式：只有上下排序，没有「放进去」 */
    const reqDrop = (id) => {
      const hint = dropHint.value;
      if (!hint) return '';
      if (hint.key === 'before:' + id) return 'before';
      if (hint.key === 'after:' + id) return 'after';
      return '';
    };

    // ------------------------------ 菜单 ------------------------------
    const reqMenu = [
      { id: 'rename', label: '重命名' },
      { id: 'duplicate', label: '复制' },
      { id: 'remove', label: '删除', danger: true },
    ];

    const dirMenu = [
      { id: 'new-subdir', label: '新建子目录' },
      { id: 'new-request', label: '在此新建请求' },
      { id: 'rename', label: '重命名' },
      { id: 'remove', label: '删除', danger: true },
    ];

    /**
     * 搜索框后面那个「＋」的可选项：**只有**「新建目录」（建在项目顶层）。
     *
     * 新建请求不在这里 —— 树末尾、目录行尾各有一处（后者还是在「这个目录下」
     * 建），再给一条就是第三条重复的路。
     */
    const addMenu = [{ id: 'new-dir', label: '新建目录' }];

    const onAdd = (action) => {
      if (action === 'new-dir') emit('create-dir', { parentId: '' });
    };

    function onDirPick(dirId, action) {
      if (action === 'new-subdir') return emit('create-dir', { parentId: dirId });
      if (action === 'new-request') return emit('create-request', { dirId });
      return emit('dir-action', { dirId, action });
    }

    function onRequestPick(row, action) {
      if (action === 'duplicate') return emit('duplicate-request', row.id);
      if (action === 'remove') return emit('remove-request', row.id);
    }

    // ------------------------------ 键盘 ------------------------------
    /**
     * 行级键盘操作：Enter / 空格触发这一行的动作。
     *
     * 只在**行自己被聚焦**时响应（`target === currentTarget`）—— 行里还嵌着勾选框
     * 和 ⋯ 按钮，事件会冒泡上来；不设这道判断的话，在勾选框上按空格会顺带把请求打开。
     */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyword, rows, ungrouped, dirOpen, ungroupedOpen, isDirty, searching,
      keyActivate,
      emit,
      fileEl, pickFile, onFilePicked,
      reqMenu, dirMenu, addMenu, onRequestPick, onDirPick, onAdd,
      // 勾选 / 批量
      rowStyle,
      scopeIds, selectTitle, allSelected, someSelected, toggleAll, pickCount,
      isPicked, togglePick, clearPicks,
      // 按目录整批勾选
      dirIds, dirPickTitle, dirAllChecked, dirSomeChecked, toggleDirPick,
      looseAllChecked, looseSomeChecked, toggleLoosePick,
      // 拖拽
      drag, dragNode, dragEnd, onDragOver, onDragLeave, onDrop, hintIs, reqDrop,
    };
  },
  template: `
    <div class="sidebar-inner">
      <div class="sidebar-head with-action">
        <!--
          「全选」排在最左，正好压在树里那排复选框的正上方 —— 同一列，
          「它管的是这一整列」不用解释。搜索框夹在它和 ＋ 中间，
          左右留白差不多，整条看着才是平的。搜索没命中时（scopeIds 为空）
          它不出现：那时候没东西可全选。
        -->
        <label class="sel-all" v-if="scopeIds.length" :title="selectTitle">
          <input
            type="checkbox"
            :checked="allSelected"
            :indeterminate.prop="someSelected"
            @change="toggleAll($event.target.checked)"
          />
          全选
        </label>
        <input class="search" v-model="keyword" placeholder="搜索接口名或 URL…" />
        <!-- 只留「新建目录」；新建请求在树末尾、目录行尾各有一处 -->
        <RowMenu :items="addMenu" :width="140" title="添加" label="＋" @pick="onAdd" />
      </div>

      <!--
        勾选之后那条操作条**不在这儿** —— 它浮在主区顶上（PickBar.js）。
        钉在侧栏顶部的时候，它一出现就把整棵树往下推一截；而「把这些接口怎么办」
        的结果发生在右边，眼睛还得来回跑。
      -->
      <div
        class="sidebar-body tree-body"
        :class="{ dragging: !!drag }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- 目录树（扁平行，缩进体现层级） -->
        <template v-for="row in rows" :key="row.kind + ':' + row.id">
          <div
            v-if="row.kind === 'dir'"
            class="dir-row tree-row"
            :class="[
              row.depth <= 1 ? 'top' : 'sub',
              {
                'drop-on': hintIs('into:' + row.id),
                'drop-before': hintIs('before:' + row.id),
                'drop-after': hintIs('after:' + row.id),
              },
            ]"
            :style="rowStyle(row.depth)"
            data-node-kind="dir"
            :data-node-id="row.id"
            :data-parent="row.parentId"
            draggable="true"
            tabindex="0"
            role="button"
            :aria-expanded="dirOpen(row) ? 'true' : 'false'"
            @dragstart="dragNode('dir', row.id, $event)"
            @dragend="dragEnd"
            @click="emit('toggle-dir', row.id)"
            @keydown="keyActivate($event, () => emit('toggle-dir', row.id))"
            >
            <!-- 勾一下 = 这个目录下所有接口都勾上（含子目录里的、含折叠着的） -->
            <input
              type="checkbox"
              class="dir-pick"
              :checked="dirAllChecked(row.id)"
              :indeterminate.prop="dirSomeChecked(row.id)"
              :disabled="!dirIds(row.id).length"
              :title="dirPickTitle(row.id)"
              @click.stop
              @change="toggleDirPick(row.id, $event.target.checked)"
            />
            <Caret :open="dirOpen(row)" />
            <span class="dir-name">{{ row.name }}</span>
            <span class="dir-n">{{ row.count }}</span>
            <button
              class="dir-add"
              title="在此新建请求"
              @click.stop="emit('create-request', { dirId: row.id })"
            >＋</button>
            <RowMenu
              :items="dirMenu"
              title="目录的操作"
              @pick="(id) => onDirPick(row.id, id)"
            />
          </div>

          <ReqRow
            v-else
            :request="row.request"
            :active-id="activeId"
            :dirty="isDirty(row.id)"
            :picked="isPicked(row.id)"
            :depth="row.depth"
            :drop="reqDrop(row.id)"
            :menu="reqMenu"
            @open="emit('select', row.id)"
            @toggle-pick="togglePick(row.id)"
            @rename="(name) => emit('rename-request', { requestId: row.id, name })"
            @action="onRequestPick(row, $event)"
            @drag-start="dragNode('req', row.id, $event)"
            @drag-end="dragEnd"
          />
        </template>

        <!-- 「未分组」：不属于任何目录的请求。有目录了才单列一栏，本身也能折叠 -->
        <div
          class="dir-row flat top tree-row"
          v-if="tree.hasDirs"
          :class="{ 'drop-on': hintIs('root') }"
          data-node-kind="root"
          tabindex="0"
          role="button"
          :aria-expanded="ungroupedOpen ? 'true' : 'false'"
          @click="emit('toggle-ungrouped')"
          @keydown="keyActivate($event, () => emit('toggle-ungrouped'))"
        >
          <!-- 同上：「未分组」也是一格，装的都是顶层请求 -->
          <input
            type="checkbox"
            class="dir-pick"
            :checked="looseAllChecked()"
            :indeterminate.prop="looseSomeChecked()"
            :disabled="!ungrouped.length"
            :title="ungrouped.length ? '选中「未分组」里的全部接口' : '「未分组」里还没有接口'"
            @click.stop
            @change="toggleLoosePick($event.target.checked)"
          />
          <Caret :open="ungroupedOpen" />
          <span class="dir-name">未分组</span>
          <span class="dir-n">{{ ungrouped.length }}</span>
        </div>
        <template v-if="!tree.hasDirs || ungroupedOpen">
          <ReqRow
            v-for="r in ungrouped"
            :key="r.id"
            :request="r"
            :active-id="activeId"
            :dirty="isDirty(r.id)"
            :picked="isPicked(r.id)"
            :depth="tree.hasDirs ? 2 : 1"
            :drop="reqDrop(r.id)"
            :menu="reqMenu"
            @open="emit('select', r.id)"
            @toggle-pick="togglePick(r.id)"
            @rename="(name) => emit('rename-request', { requestId: r.id, name })"
            @action="onRequestPick(r, $event)"
            @drag-start="dragNode('req', r.id, $event)"
            @drag-end="dragEnd"
          />
        </template>

        <p v-if="!rows.length && !ungrouped.length" class="hint list-empty">
          {{ searching ? '没有匹配的请求。' : '还没有接口。用上面的 ＋ 新建目录，或者从 OpenAPI 文档导入。' }}
        </p>
      </div>

      <div class="sidebar-foot">
        <button class="btn btn-sm" title="从本地 OpenAPI 文档导入" @click="pickFile">
          ＋ 导入 OpenAPI
        </button>
        <button class="btn btn-sm" title="把项目导出成 OpenAPI 3.0 文档" @click="emit('export', '')">
          ⬇ 导出 OpenAPI
        </button>
        <input
          ref="fileEl"
          type="file"
          accept=".yaml,.yml,.json"
          style="display: none"
          @change="onFilePicked"
        />
      </div>
    </div>
  `,
});
