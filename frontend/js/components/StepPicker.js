import { computed, defineComponent, onUnmounted, ref, watch } from 'vue';
import Caret from './Caret.js';
import { enterDialog, leaveDialog, trapTab } from '../dialogFocus.js';
import { allPicked, applyPick, somePicked } from '../pickScope.js';

/**
 * 「从接口树添加接口」弹层：按**顶层目录**分组，多选，每组能全选。
 *
 * 只负责挑。确认后把 id 抛给上层，由 store 复制成方案步骤 ——
 * 因为方案存的是副本，这里挑的只是「源」，不是活的绑定。
 *
 * 分到「顶层目录」这一层就够了：目录可以无限嵌套，但挑接口时人是按顶层认的，
 * 子目录里的接口跟着它的顶层走；根上的请求归到「未分组」。
 *
 * 键盘：打开即把焦点给搜索框（进来就是来挑接口的），Tab 在弹层里循环，
 * 关闭时焦点还给打开它的元素。见 ../dialogFocus.js。
 */
export default defineComponent({
  name: 'StepPicker',
  components: { Caret },
  props: {
    open: { type: Boolean, default: false },
    /** interfaceTree 那份：{ rows, ungrouped } */
    tree: { type: Object, default: () => ({ rows: [], ungrouped: [] }) },
  },
  emits: ['confirm', 'cancel', 'manual'],
  setup(props, { emit }) {
    const picked = ref([]);
    const keyword = ref('');
    const boxRef = ref(null);

    /**
     * 展开了哪些组（存组 id）。
     *
     * **默认全都折着**：目录一多、一组里几十个接口，全摊开的话得先滚半天才能
     * 找到要的那一组，而「挑接口」这个动作本来就是先认目录、再认接口。
     * 顺带也省得点开一个几百条的树。
     */
    const expanded = ref([]);

    const searching = computed(() => !!keyword.value.trim());

    /** 搜索时一律展开 —— 搜完还折着，等于什么都没搜出来 */
    const isOpen = (g) => searching.value || expanded.value.includes(g.id);

    const toggleOpen = (g) => {
      const i = expanded.value.indexOf(g.id);
      if (i >= 0) expanded.value.splice(i, 1);
      else expanded.value.push(g.id);
    };

    /** 这一组选了几个。折着的时候也要看得出来，不然勾完收起来就忘了 */
    const pickedIn = (g) => g.requests.filter((r) => picked.value.includes(r.id)).length;

    /** 组名那一行是「展开 / 收起」，键盘上 Enter / 空格同效 */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    // 和其它弹层一样支持 Esc 关闭 —— 全场只有它以前不响应，按 Esc 关不掉很别扭
    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.open) emit('cancel');
    };
    window.addEventListener('keydown', onKeydown);
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    // 每次打开都清空，免得上次挑的留到这一次
    watch(
      () => props.open,
      async (open) => {
        if (!open) {
          await leaveDialog();
          return;
        }
        picked.value = [];
        keyword.value = '';
        expanded.value = []; // 每次打开都从「全部折着」开始
        await enterDialog(() => boxRef.value, '.search');
      }
    );

    /** Tab 在弹层里循环，别让焦点跑到遮罩后面去 */
    const onDialogKeydown = (event) => trapTab(event, boxRef.value);

    /**
     * 按顶层目录分组。
     *
     * 树是前序铺开的，所以顺着走一遍就够：depth 1 的目录开一组，它后面的请求
     * 都归这一组（包括子目录里的 —— 挑的时候人是按顶层认的）。
     */
    const groups = computed(() => {
      const out = [];
      let current = null;
      (props.tree.rows || []).forEach((row) => {
        if (row.kind === 'dir') {
          if (row.depth === 1) {
            current = { id: row.id, name: row.name, requests: [] };
            out.push(current);
          }
          return;
        }
        if (current) current.requests.push(row.request);
      });
      const loose = props.tree.ungrouped || [];
      if (loose.length) out.push({ id: '', name: '未分组', requests: loose });
      return out;
    });

    const filtered = computed(() => {
      const kw = keyword.value.trim().toLowerCase();
      return groups.value
        .map((g) => ({
          ...g,
          // 过滤前先记一份：这个目录里**现有**多少接口（搜索时列表只剩命中的那几个，
          // 只报命中数会让人以为这个目录里就这么点东西）
          total: g.requests.length,
          requests: kw ? g.requests.filter((r) => r.name.toLowerCase().includes(kw)) : g.requests,
        }))
        .filter((g) => g.requests.length);
    });

    /**
     * 组右边那个数。
     *
     * 平时就是「这个目录里有多少接口」；挑过一部分换成「已选 n / 总数」——
     * 折起来也看得见自己动过手。搜索时列表只剩命中的，写成「命中 / 总数」，
     * 免得把「没搜到的」当成「没有的」。
     */
    const countText = (g) => {
      const n = pickedIn(g);
      if (n) return `已选 ${n} / ${g.total}`;
      return searching.value ? `${g.requests.length} / ${g.total}` : String(g.total);
    };

    const groupIds = (g) => g.requests.map((r) => r.id);

    // 三态判定和整组勾选统一走 pickScope.js（和接口树、方案步骤一个口径）
    const groupChecked = (g) => allPicked(groupIds(g), picked.value);
    const groupSomeChecked = (g) => somePicked(groupIds(g), picked.value);
    const toggleGroup = (g, checked) => {
      picked.value = applyPick(picked.value, groupIds(g), checked);
    };

    /**
     * 眼下**看得见**的那一批（搜索时就是命中的那些）。
     *
     * 「全选」只动这一批，和接口树顶上那颗一个口径：搜索是明确的筛选意图，
     * 点「全选」却把看不见的几十个也勾上，是没法核对的选择。
     */
    const visibleIds = computed(() => filtered.value.flatMap((g) => g.requests.map((r) => r.id)));

    const allChecked = computed(() => allPicked(visibleIds.value, picked.value));

    /** 只动看得见的这一批，别处挑好的一起带着走 */
    const toggleAll = () => {
      picked.value = applyPick(picked.value, visibleIds.value, !allChecked.value);
    };

    const submit = () => {
      if (picked.value.length) emit('confirm', [...picked.value]);
    };

    return {
      picked, keyword, boxRef, filtered, countText,
      groupChecked, groupSomeChecked, toggleGroup, allChecked, toggleAll,
      isOpen, toggleOpen, pickedIn, keyActivate, submit, onDialogKeydown,
    };
  },
  template: `
    <div class="mask" v-if="open" @click.self="$emit('cancel')">
      <div
        class="dialog dialog-picker"
        ref="boxRef"
        role="dialog"
        aria-modal="true"
        aria-label="添加接口"
        @keydown="onDialogKeydown"
      >
        <div class="dialog-title">
          添加接口
        </div>

        <div class="picker-tools">
          <input class="search" v-model="keyword" placeholder="搜索接口…" />
          <button class="btn btn-sm" @click="toggleAll">
            {{ allChecked ? '取消全选' : '全选' }}
          </button>
        </div>

        <div class="picker-body">
          <div class="picker-group" v-for="c in filtered" :key="c.id">
            <!--
              组头 = 「展开 / 收起」。复选框单独管「整组勾选」，所以它 stop 掉冒泡 ——
              点框是勾接口，点别处才是开合目录，两件事不抢。
            -->
            <div
              class="picker-group-head"
              tabindex="0"
              role="button"
              :aria-expanded="isOpen(c) ? 'true' : 'false'"
              @click="toggleOpen(c)"
              @keydown="keyActivate($event, () => toggleOpen(c))"
            >
              <input
                type="checkbox"
                :checked="groupChecked(c)"
                :indeterminate.prop="groupSomeChecked(c)"
                :title="'选中「' + c.name + '」里的全部接口'"
                @click.stop
                @change="toggleGroup(c, $event.target.checked)"
              />
              <Caret :open="isOpen(c)" />
              <span class="picker-group-name">{{ c.name }}</span>
              <span class="picker-group-count" :class="{ on: pickedIn(c) }">{{ countText(c) }}</span>
            </div>

            <div class="picker-items" v-if="isOpen(c)">
              <label class="picker-item" v-for="r in c.requests" :key="r.id">
                <input type="checkbox" :value="r.id" v-model="picked" />
                <span class="method" :class="r.method">{{ r.method }}</span>
                <span class="req-name">{{ r.name }}</span>
              </label>
            </div>
          </div>

          <div v-if="!filtered.length" class="hint" style="padding: 12px 4px">
            没有匹配的接口。
          </div>
        </div>

        <div class="dialog-actions">
          <!-- 接口树里还没有那个接口时，空着手起一个 —— 加完直接摊开，接着写 -->
          <button class="btn btn-sm" title="加一个空白步骤，自己填" @click="$emit('manual')">
            手动写入接口
          </button>
          <span class="picker-total">已选 {{ picked.length }} 个</span>
          <button class="btn btn-sm" @click="$emit('cancel')">取消</button>
          <button class="btn btn-primary btn-sm" :disabled="!picked.length" @click="submit">
            添加
          </button>
        </div>
      </div>
    </div>
  `,
});
