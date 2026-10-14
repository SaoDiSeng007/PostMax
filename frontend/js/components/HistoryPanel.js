import { computed, defineComponent, ref } from 'vue';
import { runCounts } from '../planExport.js';

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * 左侧历史列：按天分组，点一条在右侧看它的内容。
 *
 * 这里只负责「发生过哪些调用」—— 详情挪到右侧去了。以前选中项的摘要塞在列表
 * 顶上，等于把内容放进了导航栏，而且列表只剩半屏。
 */
export default defineComponent({
  name: 'HistoryPanel',
  props: {
    history: { type: Array, required: true },
    /** 所有方案的历次运行（store 的 allPlanRuns），按时间倒序 */
    runs: { type: Array, default: () => [] },
    /**
     * 现在看哪一栏：'req' 接口请求 / 'run' 自动化运行。
     *
     * 受控的（状态在 store 里）—— 右侧主区要跟着它换，留在组件自己手里的话，
     * 切到接口请求那栏时右边还挂着上一栏那份运行报告。
     */
    tab: { type: String, default: 'req' },
    activeId: { type: String, default: '' },
    /** 选中的是哪一次运行，用来高亮那一条 */
    activeRunAt: { type: Number, default: 0 },
  },
  emits: ['open', 'clear', 'clear-runs', 'open-run', 'set-tab'],
  setup(props, { emit }) {
    const dayKey = (timestamp) => {
      const d = new Date(timestamp);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };

    const dayLabel = (timestamp) => {
      const today = dayKey(Date.now());
      const diff = Math.round((today - dayKey(timestamp)) / 86400000);
      if (diff === 0) return '今天';
      if (diff === 1) return '昨天';
      if (diff === 2) return '前天';
      const d = new Date(timestamp);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };

    /** 列表里只到秒，够用且不挤 */
    const clock = (timestamp) => {
      const d = new Date(timestamp);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    /** 有响应存着才画状态点：旧记录没有状态，不画比画个假的强 */
    const hasDetail = (h) => !!h.detail;

    const groups = computed(() => {
      const map = new Map();
      props.history.forEach((entry) => {
        const label = dayLabel(entry.at);
        if (!map.has(label)) map.set(label, []);
        map.get(label).push(entry);
      });
      return Array.from(map, ([label, items]) => ({ label, items }));
    });

    /** Enter / 空格打开这条历史（和列表里其它行一个路数） */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    /**
     * 一次先画多少条。
     *
     * 历史最多 200 条，全画出来不至于卡，但每次切到历史页都要重建一遍这些节点。
     * 先画前一批，要看更早的点「显示更早的」再补 —— 反正真正会点开看的，
     * 绝大多数就是最近这几条。
     */
    const PAGE = 60;
    const shownCount = ref(PAGE);

    /** 按天分组的基础上再切一刀：只到「已经显示的那些条」为止 */
    const visibleGroups = computed(() => {
      const out = [];
      let budget = shownCount.value;
      for (const group of groups.value) {
        if (budget <= 0) break;
        const items = group.items.slice(0, budget);
        budget -= items.length;
        out.push({ label: group.label, items });
      }
      return out;
    });

    const hiddenCount = computed(() => Math.max(0, props.history.length - shownCount.value));
    const showMore = () => {
      shownCount.value += PAGE;
    };

    /** 运行记录右边那一小格：这一批跑成什么样了 */
    const runTail = (r) => {
      const c = runCounts(r.run);
      if (c.failed) return `${c.failed} 失败`;
      if (c.missing) return `${c.missing} 未执行`;
      // 跑到一半被叫停 / 中途停下：还有几段没轮到，别写成「全过」
      if (c.pending) return `${c.pending} 未运行`;
      return '全过';
    };
    const runBadge = (r) => {
      const c = runCounts(r.run);
      if (c.failed) return 'err';
      // 未执行是「缺数据没发出去」，不是失败 —— 颜色分开
      if (c.missing) return 'warn';
      if (c.pending) return 'mute';
      return '';
    };

    /** 运行记录也按天分组，和上面接口历史一个路数 */
    const runGroups = computed(() => {
      const map = new Map();
      props.runs.forEach((r) => {
        const label = dayLabel(r.at);
        if (!map.has(label)) map.set(label, []);
        map.get(label).push(r);
      });
      return Array.from(map, ([label, items]) => ({ label, items }));
    });

    return {
      visibleGroups, hiddenCount, showMore, clock, hasDetail, keyActivate, emit,
      runTail, runBadge, runGroups,
    };
  },
  template: `
    <div class="sidebar-inner">
      <div class="sidebar-head hist-head">
        <div class="rail-title" style="flex: 1">历史记录</div>
        <!-- 两栏各清各的：清空只动当前这一栏，不顺手把另一栏也抹了 -->
        <button
          class="btn btn-sm"
          v-if="tab === 'req' && history.length"
          @click="emit('clear')"
        >清空</button>
        <button
          class="btn btn-sm"
          v-else-if="tab === 'run' && runs.length"
          @click="emit('clear-runs')"
        >清空</button>
      </div>

      <!--
        两栏分开：接口请求是我手动调的，自动化运行是方案自己跑的一整批。
        混一张表的话，跑一次方案发几十上百个请求，手调那几条立刻被顶没 ——
        回头想找自己试过的那次都翻不到。
      -->
      <div class="seg hist-seg">
        <button type="button" :class="{ on: tab === 'req' }" @click="emit('set-tab', 'req')">
          接口请求 ({{ history.length }})
        </button>
        <button type="button" :class="{ on: tab === 'run' }" @click="emit('set-tab', 'run')">
          自动化运行 ({{ runs.length }})
        </button>
      </div>

      <div class="sidebar-body">
        <template v-if="tab === 'req'">
          <p v-if="!history.length" class="hint list-empty">
            还没有发送记录。发一个请求，这里会记下当时发出和返回的内容。
          </p>

          <div class="hist-group" v-for="g in visibleGroups" :key="g.label">
            <div class="hist-day">{{ g.label }}</div>
            <div
              class="hist-item"
              v-for="h in g.items"
              :key="h.id"
              :class="{ active: h.id === activeId }"
              :title="h.url"
              tabindex="0"
              role="button"
              @keydown="keyActivate($event, () => emit('open', h))"
              @click="emit('open', h)"
            >
              <span class="method" :class="h.method">{{ h.method }}</span>
              <span class="req-name">{{ h.name }}</span>
              <span class="badge" :class="h.status >= 400 ? 'err' : ''" v-if="hasDetail(h)">
                {{ h.status }}
              </span>
              <span class="hist-clock">{{ clock(h.at) }}</span>
            </div>
          </div>

          <!-- 一次先画一批：200 条全铺出来，切进历史页要先等它建完节点 -->
          <button class="list-more btn btn-sm" v-if="hiddenCount" @click="showMore">
            显示更早的 {{ hiddenCount }} 条
          </button>
        </template>

        <template v-else>
          <p v-if="!runs.length" class="hint list-empty">
            还没有跑过方案。在自动化页点「运行」，每跑完一次这里就多一条。
          </p>

          <div class="hist-group" v-for="g in runGroups" :key="g.label">
            <div class="hist-day">{{ g.label }}</div>
            <div
              class="hist-item"
              v-for="r in g.items"
              :key="r.key"
              :class="{ active: r.at === activeRunAt }"
              :title="r.planName + ' · 点开看这一次的报告'"
              tabindex="0"
              role="button"
              @keydown="keyActivate($event, () => emit('open-run', r))"
              @click="emit('open-run', r)"
            >
              <span class="req-name">{{ r.planName }}</span>
              <span class="badge" :class="runBadge(r)">{{ runTail(r) }}</span>
              <span class="hist-clock">{{ clock(r.at) }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>
  `,
});
