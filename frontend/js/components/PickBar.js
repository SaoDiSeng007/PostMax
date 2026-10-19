import { computed, defineComponent } from 'vue';
import RowMenu from './RowMenu.js';
import { clearPickedRequests, pickedRequestIds } from '../store.js';

/**
 * 勾选接口之后那条操作条：浮在**主区顶部**，盖住下面那点接口信息。
 *
 * 它以前钉在侧栏顶上（搜索栏下面），一出现就把整棵接口树往下推一截 ——
 * 手刚点完的那一行当场跑掉。而且「把这些接口怎么办」的结果发生在右边主区，
 * 眼睛还得来回跑。
 *
 * 现在归主区：勾选状态在 store（state.pickedRequestIds），侧栏树上的勾选框
 * 用的是同一份；这里只负责那条浮条。位置和尺寸见 style.css 的 .pick-float。
 */
export default defineComponent({
  name: 'PickBar',
  components: { RowMenu },
  props: {
    /** interfaceTree 那份：{ rows, ungrouped } —— 「移动到目录」的层级就是它 */
    tree: { type: Object, default: () => ({ rows: [], ungrouped: [] }) },
  },
  emits: ['move-nodes', 'remove-requests'],
  setup(props, { emit }) {
    const count = computed(() => pickedRequestIds.value.length);

    /** 有目录才谈得上「移动到目录」 */
    const canMove = computed(() => (props.tree.rows || []).some((row) => row.kind === 'dir'));

    /**
     * 选中的接口眼下都在哪个目录（勾选可以跨目录，所以是个集合）。
     *
     * 菜单里给这些目录标一个「当前」—— 否则「移动到目录」完全是盲挑：
     * 既看不出这几条现在在哪儿，也看不出「挪到这儿」等于没挪。
     */
    const pickedDirs = computed(() => {
      const dirs = new Set();
      const take = (r) => {
        if (r && pickedRequestIds.value.includes(r.id)) dirs.add(r.dirId || '');
      };
      (props.tree.ungrouped || []).forEach(take);
      (props.tree.rows || []).forEach((row) => {
        if (row.kind === 'req') take(row.request);
      });
      return dirs;
    });

    /**
     * 选中的请求能移到的目录，**按层级给**（children 逐层挂下去），外加顶层那一项。
     *
     * 平铺一张表、拿全角空格凑缩进是不行的：目录一多，子目录和它父目录差的那
     * 一个空格根本看不出来。菜单默认整棵折着（展开逻辑在 RowMenu 里），
     * 想看子目录得点那一层的三角，一次只看一层。
     */
    const moveMenu = computed(() => {
      const top = [];
      // byDepth[d-1] = 第 d 层的节点该落进哪个数组（深度从 1 起，和 tree.rows 一致）
      const byDepth = [top];
      (props.tree.rows || []).forEach((row) => {
        if (row.kind !== 'dir') return;
        const node = {
          id: row.id,
          label: row.name,
          // 这个目录里有多少接口：挑落点的时候，「3 个」和「30 个」是两种决定
          count: row.count,
          children: [],
          current: pickedDirs.value.has(row.id),
        };
        byDepth.length = row.depth; // 回到父层，把刚才更深的那几层丢掉
        byDepth[row.depth - 1].push(node);
        byDepth[row.depth] = node.children;
      });
      top.push({
        id: '',
        label: '未分组（顶层）',
        count: (props.tree.ungrouped || []).length,
        current: pickedDirs.value.has(''),
      });
      return top;
    });

    /** 批量挪到某个目录；`dirId` 为空 = 挪到顶层（「未分组」那一栏） */
    const move = (dirId) => {
      const ids = pickedRequestIds.value.slice();
      if (!ids.length) return;
      emit('move-nodes', {
        nodes: ids.map((id) => ({ kind: 'req', id })),
        targetParentId: dirId || '',
      });
      clearPickedRequests();
    };

    /**
     * 删除选中。**这里不清勾选** —— 确认框是异步的，在这儿清的话，
     * 点「取消」就等于把攒好的选择白丢了。清空在 store 的确认回调里做。
     */
    const remove = () => {
      const ids = pickedRequestIds.value.slice();
      if (!ids.length) return;
      emit('remove-requests', ids);
    };

    return { count, canMove, moveMenu, move, remove, clear: clearPickedRequests };
  },
  template: `
    <div class="pick-float" v-if="count">
      <span class="pick-n">已选 <b>{{ count }}</b></span>
      <RowMenu
        v-if="canMove"
        :items="moveMenu"
        :width="200"
        align="left"
        title="移动到目录"
        label="移动到目录"
        @pick="move"
      />
      <button class="btn pick-del" @click="remove">删除</button>
      <button class="btn-icon pick-x" title="取消选择" @click="clear">✕</button>
    </div>
  `,
});
