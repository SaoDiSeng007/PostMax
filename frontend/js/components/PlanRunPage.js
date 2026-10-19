import { computed, defineComponent, onUnmounted, ref, watch } from 'vue';
import { downloadText } from '../download.js';
import { useCopyFlag } from '../useCopy.js';
import {
  allRunRows, buildFailureSummary, buildRunCsv, buildRunJson, reportFileName,
  runStats, stepFailureText, stepStatusText,
} from '../planExport.js';
import Caret from './Caret.js';
import { stepScopes } from '../planSteps.js';

/** 一次渲染多少行 —— 几千步的运行全画出来会让浏览器僵住（报告页也是这么做的） */
const ROW_BATCH = 100;

/** 毫秒，人读得顺眼的那种：不到 1 秒给 ms，超过给秒 */
function formatMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)} 秒`;
  const m = Math.floor(n / 60000);
  const s = Math.round((n % 60000) / 1000);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
}

/**
 * 运行页：方案跑起来之后翻开的那个全屏页。
 *
 * 为什么要有它：一轮可能几分钟、几十上千个请求，而界面上原来只有一颗「停止」。
 * 人看不出跑到哪儿了（报告页是「按行」的，得自己数），也够不着别的 —— 想先停下来
 * 改个数据都没有入口。这里把三件事放一屏：进度（环）、账目（通过/失败/耗时）、
 * 逐条明细；顶上一排按钮管运行本身（暂停 / 恢复 / 终止）。
 *
 * 它只是**看**：所有数字都从 run 现算（runStats），不自己攒状态 —— 一攒就会和
 * 报告页对不上，两处数字打架比没有数字更糟。
 */
export default defineComponent({
  name: 'PlanRunPage',
  components: { Caret },
  props: {
    planName: { type: String, default: '' },
    /** 方案本身。只为算「这一步该跑几遍」—— 没跑满之前不下结论 */
    plan: { type: Object, default: null },
    /** 这一次运行（可能还在跑）。空 = 这个方案还没跑过 */
    run: { type: Object, default: null },
    running: { type: Boolean, default: false },
    paused: { type: Boolean, default: false },
  },
  emits: ['pause', 'resume', 'stop', 'rerun', 'close'],
  setup(props) {
    /** 运行中要实时刷用时，一秒一次就够（报告页是 500ms，这里不差那点） */
    const now = ref(Date.now());
    const tick = setInterval(() => {
      if (props.running) now.value = Date.now();
    }, 500);
    onUnmounted(() => clearInterval(tick));

    const stats = computed(() => runStats(props.run, now.value));

    /** 顶上那个状态词。它是这一页的「结论」，所以每种情形都得有一句 */
    const stateText = computed(() => {
      if (!props.run) return '还没跑过';
      if (props.running) return props.paused ? '已暂停' : '运行中';
      if (props.run.status === 'stopped') return '已终止';
      if (props.run.status === 'failed') return '有失败';
      if (props.run.status === 'done') return '全部通过';
      return '已结束';
    });
    const stateClass = computed(() => {
      if (props.running) return props.paused ? 'is-paused' : 'is-running';
      if (props.run?.status === 'failed') return 'is-failed';
      if (props.run?.status === 'stopped') return 'is-stopped';
      if (props.run?.status === 'done') return 'is-ok';
      return 'is-idle';
    });

    const percentText = computed(() => `${Math.round(stats.value.percent * 100)}%`);

    /**
     * 环本身：绿（通过）/ 红（失败）/ 琥珀（已停止）三段，剩下的灰。
     *
     * 不用「一条进度弧」那种画法：那样只看得出「跑了多少」，看不出「跑完的里面
     * 多少是红的」—— 而后一个问题才是人打开这一页最想知道的。
     */
    const ringStyle = computed(() => {
      const total = stats.value.stepsTotal || 1;
      const ok = (stats.value.okSteps / total) * 100;
      const fail = ok + (stats.value.failedSteps / total) * 100;
      const stopped = fail + (stats.value.stoppedSteps / total) * 100;
      return {
        background:
          `conic-gradient(var(--green) 0% ${ok}%,` +
          ` var(--red) ${ok}% ${fail}%,` +
          ` var(--amber) ${fail}% ${stopped}%,` +
          ` var(--border) ${stopped}% 100%)`,
      };
    });

    const okPct = computed(() =>
      stats.value.stepsTotal ? `(${((stats.value.okSteps / stats.value.stepsTotal) * 100).toFixed(2)}%)` : '(0.00%)');
    const failPct = computed(() =>
      stats.value.stepsTotal ? `(${((stats.value.failedSteps / stats.value.stepsTotal) * 100).toFixed(2)}%)` : '(0.00%)');

    /**
     * 按接口分组：一步一行，底下挂着它在各数据行（或整轮那一次）上的结果。
     *
     * 之前是「一步 × 一行」平铺：跑 200 行 5 个步骤就是 1000 条，而人想知道的是
     * 「第 3 步怎么样了」—— 得在 1000 条里数。分组之后一眼看清每步跑了几遍、
     * 过了几遍；哪一步有问题再点开看是哪几行挂的。
     */
    /** 这一轮会跑几个数据行（和步骤行上那个 ×N、引擎里那个 N 是同一个数） */
    const rowCount = computed(() => {
      const rows = props.plan?.data?.rows || [];
      const limit = Math.floor(Number(props.plan?.dataLimit));
      return limit > 0 ? Math.min(limit, rows.length) : rows.length;
    });

    /** 每个步骤该跑几遍。判定走引擎那套 stepScopes —— 界面上的数不能自己另算一份 */
    const expectedSteps = computed(() => {
      const list = (props.plan?.steps || []).filter((s) => s.enabled);
      const scopes = stepScopes(list, props.plan?.data?.columns || []);
      return new Map(list.map((s, i) => [s.id, scopes[i] === 'each' ? rowCount.value : 1]));
    });

    const stepGroups = computed(() => {
      const groups = new Map();
      allRunRows(props.run).forEach((part) => {
        // 「整轮一遍」的那些不属于任何数据行，说成「第几行」会误导
        const where = part.once ? '整轮一遍' : `第 ${part.no} 行`;
        (part.steps || []).forEach((s) => {
          // 空位（整轮一遍的步骤在数据行里留的）与落盘读回来的 null 都跳过
          if (!s) return;
          const key = s.stepId || `${s.no}-${s.name}`;
          let g = groups.get(key);
          if (!g) {
            g = {
              key, no: s.no, name: s.name, method: s.method, once: !!part.once,
              // 老记录可能没有 stepId，认不出来就当它只跑一遍
              expected: expectedSteps.value.get(s.stepId) ?? 1,
              runs: [], ok: 0, failed: 0, missing: 0, stopped: 0, running: 0,
              failure: '',
            };
            groups.set(key, g);
          }
          g.runs.push({
            key: `${where}-${g.runs.length}`,
            where, status: s.status, http: s.httpStatus, time: s.time,
            attempts: s.attempts || 1,
            failure: s.status === 'ok' ? '' : stepFailureText(s),
          });
          if (s.status === 'ok') g.ok += 1;
          else if (s.status === 'failed') g.failed += 1;
          else if (s.status === 'missing') g.missing += 1;
          else if (s.status === 'stopped') g.stopped += 1;
          else g.running += 1;
          // 只留第一条原因：同一步挂 47 次，原因基本都是同一个
          if (!g.failure && s.status !== 'ok') g.failure = stepFailureText(s);
        });
      });
      return [...groups.values()];
    });

    /**
     * 这一步**还没跑满**：这会儿别给它下结论。
     *
     * 勾了 5 行数据，第 1 行挂了就立刻把整个接口标红、还写上失败原因，是不对的 ——
     * 后面 4 行就在眼下的几秒里（按接口推进，它们紧挨着同一批）。没跑满之前只报进度。
     *
     * 两种「还没满」：遍数没走到头，或者当前这一遍还在跑（等重试也算）。
     */
    const groupPending = (g) => props.running && (g.runs.length < g.expected || g.running > 0);

    /** 这一步有没有要处理的问题。跑着的时候不算 —— 见 groupPending */
    const groupBad = (g) => !groupPending(g) && (g.failed > 0 || g.missing > 0 || g.stopped > 0);

    /**
     * 只有「未执行」、没有真失败的那种。
     *
     * 左边那条竖杠用琥珀不用红：接口一个字节都没发出去，服务端根本没参与，
     * 标红会让人以为这个接口坏了，去查一个没问题的东西。
     */
    const groupOnlyMissing = (g) =>
      !groupPending(g) && !g.failed && !g.stopped && g.missing > 0;

    const filter = ref('all'); // all | bad
    const keyword = ref('');

    const counts = computed(() => ({
      all: stepGroups.value.length,
      bad: stepGroups.value.filter(groupBad).length,
    }));

    const visibleGroups = computed(() => {
      const kw = keyword.value.trim().toLowerCase();
      let list = stepGroups.value;
      if (filter.value === 'bad') list = list.filter(groupBad);
      if (kw) {
        list = list.filter((g) =>
          `${g.no} ${g.name} ${g.method} ${g.failure}`.toLowerCase().includes(kw));
      }
      return list;
    });

    /** 展开的是哪一步（''=都收着）。默认收着 —— 先看总账，有问题的再点开 */
    const openGroup = ref('');
    const toggleGroup = (key) => {
      openGroup.value = openGroup.value === key ? '' : key;
    };

    // 换筛选 / 换关键词都从头看起：停在老位置上不动，等于切了筛选也看不见东西
    const shownCount = ref(ROW_BATCH);
    watch([filter, keyword], () => { shownCount.value = ROW_BATCH; });
    const renderedGroups = computed(() => visibleGroups.value.slice(0, shownCount.value));
    const moreCount = computed(() => Math.max(0, visibleGroups.value.length - shownCount.value));
    const showMore = () => { shownCount.value += ROW_BATCH; };

    /** 「分享」：抽成一段纯文本，能直接贴进 issue / 聊天窗口 */
    const { copied, copy } = useCopyFlag();
    const share = async () => {
      if (!props.run) return;
      await copy(buildFailureSummary(props.run, props.planName, now.value));
    };

    const exportCsv = () => {
      if (!props.run) return;
      downloadText(reportFileName(props.planName, props.run.at, 'csv'), buildRunCsv(props.run));
    };
    const exportJson = () => {
      if (!props.run) return;
      downloadText(reportFileName(props.planName, props.run.at, 'json'), buildRunJson(props.run, props.planName));
    };

    return {
      stats, stateText, stateClass, percentText, ringStyle, okPct, failPct,
      stepGroups, filter, keyword, counts, visibleGroups, renderedGroups, moreCount, showMore,
      openGroup, toggleGroup, groupBad, groupPending, groupOnlyMissing,
      formatMs, copied, share, exportCsv, exportJson, stepStatusText,
    };
  },
  template: `
    <div class="runpage">
      <header class="runpage-top">
        <button class="btn-icon runpage-back" title="回到方案（运行不会中断）" @click="$emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div class="runpage-headtext">
          <div class="runpage-name">{{ planName }}</div>
          <div class="runpage-sub">
            运行进度
            <span class="runpage-dot">·</span>
            已完成 {{ stats.stepsDone }} / {{ stats.stepsTotal }} 步
          </div>
        </div>

        <span class="runpage-state" :class="stateClass">{{ stateText }}</span>

        <div class="runpage-actions">
          <button v-if="running && !paused" class="btn btn-sm" @click="$emit('pause')">暂停</button>
          <button v-if="running && paused" class="btn btn-sm btn-primary" @click="$emit('resume')">继续运行</button>
          <button v-if="running" class="btn btn-sm btn-danger" @click="$emit('stop')">终止</button>
          <button v-else-if="run" class="btn btn-sm btn-primary" @click="$emit('rerun')">再次运行</button>

          <template v-if="run">
            <span class="runpage-sep"></span>
            <button class="btn btn-sm" @click="share">{{ copied ? '已复制' : '分享报告' }}</button>
            <button class="btn btn-sm" @click="exportCsv">导出 CSV</button>
            <button class="btn btn-sm" @click="exportJson">导出 JSON</button>
          </template>
        </div>
      </header>

      <div class="empty" v-if="!run">
        <span class="empty-title">这个方案还没跑过</span>
        <span class="empty-hint">回到方案页点「运行」，进度会显示在这里</span>
      </div>

      <template v-else>
        <section class="runpage-hero">
          <div class="runpage-ring" :style="ringStyle">
            <div class="runpage-ring-inner">
              <span class="runpage-ring-state" :class="stateClass">{{ stateText }}</span>
              <span class="runpage-ring-pct">{{ percentText }}</span>
            </div>
          </div>

          <div class="runpage-legend">
            <div class="lg is-ok">
              <span class="lg-dot"></span>
              <span class="lg-label">通过</span>
              <span class="lg-num">{{ stats.okSteps }}</span>
              <span class="lg-pct">{{ okPct }}</span>
            </div>
            <div class="lg is-failed">
              <span class="lg-dot"></span>
              <span class="lg-label">失败</span>
              <span class="lg-num">{{ stats.failedSteps }}</span>
              <span class="lg-pct">{{ failPct }}</span>
            </div>
            <!-- 缺数据没发出去的。和失败分开列：接口没毛病，是上游没成 -->
            <div class="lg is-missing" v-if="stats.missingSteps">
              <span class="lg-dot"></span>
              <span class="lg-label">未执行</span>
              <span class="lg-num">{{ stats.missingSteps }}</span>
            </div>
            <div class="lg is-stopped" v-if="stats.stoppedSteps">
              <span class="lg-dot"></span>
              <span class="lg-label">已终止</span>
              <span class="lg-num">{{ stats.stoppedSteps }}</span>
            </div>
          </div>

          <div class="runpage-numbers">
            <div class="nb">
              <span class="nb-label">总耗时</span>
              <span class="nb-value">{{ formatMs(stats.elapsed) }}</span>
            </div>
            <div class="nb" v-if="stats.loopsTotal">
              <span class="nb-label">循环数</span>
              <span class="nb-value">
                执行 <b>{{ stats.loopsDone }}</b>
                <i>失败 <b :class="{ bad: stats.loopsFailed }">{{ stats.loopsFailed }}</b></i>
              </span>
            </div>
            <div class="nb">
              <span class="nb-label">接口请求耗时</span>
              <span class="nb-value">{{ formatMs(stats.requestTime) }}</span>
            </div>
            <div class="nb">
              <span class="nb-label">断言数</span>
              <span class="nb-value">
                执行 <b>{{ stats.assertionsRun }}</b>
                <i>失败 <b :class="{ bad: stats.assertionsFailed }">{{ stats.assertionsFailed }}</b></i>
              </span>
            </div>
            <div class="nb">
              <span class="nb-label">平均接口请求耗时</span>
              <span class="nb-value">{{ formatMs(stats.avgTime) }}</span>
            </div>
          </div>
        </section>

        <section class="runpage-list">
          <div class="runpage-tools">
            <div class="seg runpage-seg">
              <button type="button" :class="{ on: filter === 'all' }" @click="filter = 'all'">
                全部接口 ({{ counts.all }})
              </button>
              <button type="button" :class="{ on: filter === 'bad' }" @click="filter = 'bad'">
                有问题的 ({{ counts.bad }})
              </button>
            </div>
            <input class="search" v-model="keyword" placeholder="搜索接口 / 失败原因…" />
            <span class="runpage-tip">一步一行，点开看是哪些行</span>
          </div>

          <div class="runpage-rows">
            <div
              class="rg"
              v-for="g in renderedGroups"
              :key="g.key"
              :class="{
                'is-bad': groupBad(g),
                'only-missing': groupOnlyMissing(g),
                open: openGroup === g.key,
              }"
            >
              <div
                class="rg-head"
                role="button"
                tabindex="0"
                :aria-expanded="openGroup === g.key ? 'true' : 'false'"
                @click="toggleGroup(g.key)"
              >
                <Caret :open="openGroup === g.key" />
                <span class="rg-no">{{ g.no }}</span>
                <span class="method" :class="g.method">{{ g.method }}</span>
                <span class="rg-name" :title="g.failure || g.name">{{ g.name }}</span>
                <!-- 跑几遍：按行跑的写「N 遍」，整轮一遍的直接说清楚 -->
                <span class="rg-scope">{{ g.once ? '整轮一遍' : g.runs.length + ' 遍' }}</span>
                <span class="rg-stat">
                  <!--
                    还没跑满：只报进度，不报得失。
                    已经挂掉的那几遍照样说出来（红字看得见），但整行不给红条、也不写
                    失败原因 —— 那两样都是「这一步的结论」，而结论要等它跑完。
                  -->
                  <template v-if="groupPending(g)">
                    <b class="mute">跑着呢 {{ g.runs.length }} / {{ g.expected }} 遍</b>
                    <b class="err" v-if="g.failed">{{ g.failed }} 失败</b>
                  </template>
                  <template v-else>
                    <b class="ok">{{ g.ok }} 通过</b>
                    <b class="err" v-if="g.failed">{{ g.failed }} 失败</b>
                    <b class="warn" v-if="g.missing">{{ g.missing }} 未执行</b>
                    <b class="mute" v-if="g.stopped">{{ g.stopped }} 已停止</b>
                    <b class="mute" v-if="g.running">{{ g.running }} 进行中</b>
                  </template>
                </span>
                <span class="rg-fail" v-if="g.failure && !groupPending(g)">{{ g.failure }}</span>
              </div>

              <div class="rg-runs" v-if="openGroup === g.key">
                <div class="rr" v-for="r in g.runs" :key="r.key" :class="'is-' + r.status">
                  <span class="rr-badge" :class="'is-' + r.status">{{ stepStatusText(r.status) }}</span>
                  <span class="rr-where">{{ r.where }}</span>
                  <span class="rr-fail" v-if="r.failure">{{ r.failure }}</span>
                  <span class="rr-spacer"></span>
                  <span class="rr-retry" v-if="r.attempts > 1">重试 {{ r.attempts - 1 }}</span>
                  <span class="rr-http" :class="{ bad: r.status !== 'ok' && r.http >= 400 }">
                    {{ r.http || '—' }}
                  </span>
                  <span class="rr-time">{{ r.time ? r.time + ' ms' : '—' }}</span>
                </div>
              </div>
            </div>

            <div class="empty" v-if="!renderedGroups.length">
              <span class="empty-hint">
                {{ keyword || filter === 'bad' ? '没有匹配的接口' : '还没有跑出结果' }}
              </span>
            </div>

            <button class="btn btn-sm runpage-more" v-if="moreCount" @click="showMore">
              还有 {{ moreCount }} 个接口…
            </button>
          </div>
        </section>
      </template>
    </div>
  `,
});
