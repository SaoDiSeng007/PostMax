import { defineComponent, ref } from 'vue';
import Caret from './Caret.js';
import RowMenu from './RowMenu.js';

/**
 * 左栏里的一个方案行。
 *
 * 单独拆出来是因为它要在两处出现：目录里、以及「未分组」那一栏。
 * 一个行十几行模板，抄两遍就等于以后每次改都得记得改两处。
 */
const PlanRow = defineComponent({
  name: 'PlanRow',
  components: { RowMenu },
  props: {
    plan: { type: Object, required: true },
    activeId: { type: String, default: '' },
    menu: { type: Array, required: true },
  },
  emits: ['open', 'action', 'drag-start', 'drag-end'],
  setup(props, { emit }) {
    /** Enter / 空格打开这个方案。行里还嵌着 ⋯ 菜单，所以只在行自身聚焦时响应 */
    const keyActivate = (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      emit('open');
    };
    return { keyActivate };
  },
  template: `
    <div
      class="plan-item"
      :class="{ active: plan.id === activeId }"
      draggable="true"
      tabindex="0"
      role="button"
      :aria-current="plan.id === activeId ? 'true' : 'false'"
      @click="$emit('open')"
      @keydown="keyActivate"
      @dragstart="$emit('drag-start', $event)"
      @dragend="$emit('drag-end')"
    >
      <span class="req-name">{{ plan.name }}</span>
      <span class="plan-item-meta">{{ (plan.steps || []).length }} 步</span>
      <span class="step-dot on" v-if="plan.dirty" title="有未保存的改动"></span>
      <RowMenu
        :items="menu"
        title="这个方案的操作"
        @pick="$emit('action', $event)"
      />
    </div>
  `,
});

/**
 * 自动化：左栏是「目录 → 方案」两级。
 *
 * 一级（只有方案）在方案少的时候够用，一多就成一长条没法看 ——
 * 而「冒烟」「回归」这种分法本来就是现成的，不需要给人标签系统那么重的东西。
 *
 * 方案**拖进目录**是移动方式：目录头本身就是落点，比「⋯ → 移动到 → 选一个」
 * 少两级菜单。没分组的方案单列一栏，不自动塞进某个「默认目录」——
 * 那只会让那个目录变成大杂烩。
 */
export default defineComponent({
  name: 'AutomationPanel',
  components: { Caret, RowMenu, PlanRow },
  props: {
    /** { groups: [{ id, name, plans, collapsed }], ungrouped: [...] } */
    tree: { type: Object, default: () => ({ groups: [], ungrouped: [] }) },
    /** 当前打开的那个方案 id，用来高亮 */
    activePlanId: { type: String, default: '' },
  },
  emits: [
    'open-plan', 'create-plan', 'create-group',
    'plan-action', 'group-action', 'toggle-group', 'move-plan',
  ],
  setup(props, { emit }) {
    /** 方案行尾巴上那个 ⋯ 里的东西，和请求行一个形状 */
    const planMenu = [
      { id: 'rename', label: '重命名' },
      { id: 'duplicate', label: '复制' },
      { id: 'remove', label: '删除', danger: true },
    ];
    const groupMenu = [
      { id: 'rename', label: '重命名' },
      { id: 'remove', label: '删除目录', danger: true },
    ];

    /** 「未分组」那一栏的 id。和空 groupId 同一个值 —— 移出目录就是它 */
    const UNGROUPED = '';
    const DRAG_MIME = 'text/plain';

    /** 正在拖哪个方案，空 = 没在拖 */
    const dragPlanId = ref('');
    /** 现在指着哪个目录。**null 才是「没有」** —— 空串是「未分组」那一栏 */
    const dropGroupId = ref(null);

    const dragPlan = (planId, event) => {
      dragPlanId.value = planId;
      if (!event?.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不设数据就不启动拖拽
      event.dataTransfer.setData(DRAG_MIME, planId);
    };

    const overGroup = (groupId, event) => {
      if (!dragPlanId.value) return;
      // 必须 preventDefault，否则浏览器不认这是「能放下的地方」，drop 不会触发
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      dropGroupId.value = groupId;
    };

    const leaveGroup = (groupId, event) => {
      // dragleave 在子元素之间移动时也会触发，不挡一下高亮会疯狂闪
      if (event.currentTarget.contains(event.relatedTarget)) return;
      if (dropGroupId.value === groupId) dropGroupId.value = null;
    };

    const dropOn = (groupId, event) => {
      event.preventDefault();
      const planId = dragPlanId.value;
      dragEnd();
      if (planId) emit('move-plan', { planId, groupId });
    };

    const dragEnd = () => {
      dragPlanId.value = '';
      dropGroupId.value = null;
    };

    /** Enter / 空格折叠这个目录（方案目录头） */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyActivate,
      planMenu, groupMenu, UNGROUPED,
      dragPlan, overGroup, leaveGroup, dropOn, dragEnd, dropGroupId,
    };
  },
  template: `
    <div class="sidebar-inner">
      <div class="sidebar-head with-action">
        <div class="rail-title">测试方案</div>
        <button class="icon-btn" title="新建目录" @click="$emit('create-group')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" />
            <path d="M12 11v8" /><path d="M8 15h8" />
          </svg>
        </button>
      </div>

      <div class="sidebar-body">
        <template v-if="tree.groups.length || tree.ungrouped.length">
          <div
            class="plan-group"
            v-for="g in tree.groups"
            :key="g.id"
            :class="{ 'drop-on': dropGroupId === g.id }"
            @dragover="overGroup(g.id, $event)"
            @dragleave="leaveGroup(g.id, $event)"
            @drop="dropOn(g.id, $event)"
          >
            <div
              class="plan-group-head"
              tabindex="0"
              role="button"
              :aria-expanded="!g.collapsed ? 'true' : 'false'"
              @click="$emit('toggle-group', g.id)"
              @keydown="keyActivate($event, () => $emit('toggle-group', g.id))"
            >
              <Caret :open="!g.collapsed" />
              <span class="plan-group-name">{{ g.name }}</span>
              <span class="plan-group-n">{{ g.plans.length }}</span>
              <button
                class="plan-group-add"
                title="在这个目录下新建方案"
                @click.stop="$emit('create-plan', g.id)"
              >＋</button>
              <RowMenu
                :items="groupMenu"
                title="目录的操作"
                @pick="$emit('group-action', { groupId: g.id, action: $event })"
              />
            </div>

            <div class="plan-list" v-if="!g.collapsed">
              <PlanRow
                v-for="p in g.plans"
                :key="p.id"
                :plan="p"
                :active-id="activePlanId"
                :menu="planMenu"
                @open="$emit('open-plan', p.id)"
                @action="$emit('plan-action', { planId: p.id, action: $event })"
                @drag-start="dragPlan(p.id, $event)"
                @drag-end="dragEnd"
              />
              <p class="plan-group-empty" v-if="!g.plans.length">空的 —— 把方案拖进来</p>
            </div>
          </div>

          <!--
            「未分组」。有目录之后才出现 —— 一个目录都没有的时候，
            所有方案都在这一栏里，再顶一个「未分组」的标题纯属废话。
          -->
          <div
            class="plan-group"
            v-if="tree.groups.length"
            :class="{ 'drop-on': dropGroupId === UNGROUPED }"
            @dragover="overGroup(UNGROUPED, $event)"
            @dragleave="leaveGroup(UNGROUPED, $event)"
            @drop="dropOn(UNGROUPED, $event)"
          >
            <div class="plan-group-head flat">
              <span class="plan-group-name">未分组</span>
              <span class="plan-group-n">{{ tree.ungrouped.length }}</span>
            </div>
            <div class="plan-list">
              <PlanRow
                v-for="p in tree.ungrouped"
                :key="p.id"
                :plan="p"
                :active-id="activePlanId"
                :menu="planMenu"
                @open="$emit('open-plan', p.id)"
                @action="$emit('plan-action', { planId: p.id, action: $event })"
                @drag-start="dragPlan(p.id, $event)"
                @drag-end="dragEnd"
              />
              <p class="plan-group-empty" v-if="!tree.ungrouped.length">空的</p>
            </div>
          </div>

          <!-- 一个目录都没有：还是原来那副扁平列表 -->
          <div class="plan-list" v-if="!tree.groups.length">
            <PlanRow
              v-for="p in tree.ungrouped"
              :key="p.id"
              :plan="p"
              :active-id="activePlanId"
              :menu="planMenu"
              @open="$emit('open-plan', p.id)"
              @action="$emit('plan-action', { planId: p.id, action: $event })"
              @drag-start="dragPlan(p.id, $event)"
              @drag-end="dragEnd"
            />
          </div>
        </template>

        <p v-else class="hint plan-tip">
          还没有方案。新建一个，把接口树里的接口挑进来，排好顺序就能一遍跑完。
        </p>
      </div>

      <div class="sidebar-foot">
        <button class="btn btn-primary" style="width: 100%" @click="$emit('create-plan')">
          ＋ 新建方案
        </button>
      </div>
    </div>
  `,
});
