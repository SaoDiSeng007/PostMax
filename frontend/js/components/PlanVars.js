import { defineComponent } from 'vue';
import InfoTip from './InfoTip.js';
import KeyValueTable from './KeyValueTable.js';

/**
 * 方案自己的变量。
 *
 * 为什么要有这么一张表：方案能**选**环境、能从里面取值，但改不了它。
 * 跑一次测试顺手把手配的环境变量改掉，是最不该有的副作用 —— 尤其是并发跑
 * 多行的时候，几个行各自提取同一个名字，最后留下谁的值全看谁先回来。
 *
 * 所以方案要自己的东西，就放这儿：只有这个方案用得到，跑完也不影响别处。
 *
 * 表格直接复用 KeyValueTable —— 行结构和环境变量页一模一样
 * （{ enabled, key, value }），增删改都在那儿实现过了。
 */
export default defineComponent({
  name: 'PlanVars',
  components: { InfoTip, KeyValueTable },
  props: {
    vars: { type: Array, default: () => [] },
  },
  emits: ['change'],
  setup() {
    /**
     * 收进「?」里的说明：这张表和别处什么关系（同名谁优先），以及跑方案
     * 不改动环境变量。两句都是「读一次就够」的话，常驻页面上只会把表挤下去。
     */
    const tip =
      '这个方案自己的一套变量，只有它用得到。同名时越靠后的越优先：\n' +
      '环境 / 账号 → 这里 → 本步提取 → 测试数据行。\n' +
      '运行不会改动环境 / 账号里的变量；本步提取的值只在这一行内往后传，跑完就没了。';
    return { tip };
  },
  template: `
    <div>
      <div class="vars-head">
        <span class="vars-title">方案自己的变量</span>
        <InfoTip :text="tip" />
      </div>

      <KeyValueTable
        :model-value="vars"
        key-placeholder="变量名，如 baseUrl"
        value-placeholder="值"
        @update:model-value="$emit('change', $event)"
      />
    </div>
  `,
});
