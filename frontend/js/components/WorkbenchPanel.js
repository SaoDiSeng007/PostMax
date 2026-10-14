import { defineComponent } from 'vue';
import { WORKBENCH_TOOLS } from '../workbench.js';

/**
 * 工作台的左栏：工具清单。
 *
 * 就干一件事 —— 列出有哪些工具、当前是哪个。工具本身的界面全在主区
 * （见 WorkbenchView）：「点一个看一个」，所以这一栏会一直很短。
 */
export default defineComponent({
  name: 'WorkbenchPanel',
  props: {
    /** 当前工具的 id。空串 = 还没选过，按清单第一个算 */
    active: { type: String, default: '' },
  },
  emits: ['pick'],
  setup(props, { emit }) {
    /**
     * 行是可聚焦的（键盘要能走一圈），Enter / 空格触发。
     * 只在元素自己被聚焦时响应：行里还嵌着别的东西，事件会冒泡上来。
     */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    const isActive = (id) => id === (props.active || WORKBENCH_TOOLS[0].id);

    return { tools: WORKBENCH_TOOLS, isActive, keyActivate, emit };
  },
  template: `
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <div class="rail-title">工作台</div>
      </div>

      <div class="sidebar-body">
        <div
          class="wt-item"
          v-for="t in tools"
          :key="t.id"
          :class="{ active: isActive(t.id) }"
          tabindex="0"
          role="button"
          :aria-current="isActive(t.id) ? 'true' : 'false'"
          :title="t.name + '：' + t.desc"
          @click="emit('pick', t.id)"
          @keydown="keyActivate($event, () => emit('pick', t.id))"
        >
          <span class="wt-name">{{ t.name }}</span>
          <span class="wt-desc">{{ t.desc }}</span>
        </div>
      </div>
    </div>
  `,
});
