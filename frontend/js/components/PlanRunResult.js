import { computed, defineComponent, onUnmounted, ref, watch } from 'vue';
import Caret from './Caret.js';
import JsonNode from './JsonNode.js';
import { formatSize, truncateNotice } from '../format.js';
import { caretOnly } from '../caretOnly.js';
import { useCopy } from '../useCopy.js';
import { downloadText } from '../download.js';
import {
  buildRunJson, buildRunCsv, buildFailureSummary, reportFileName, stepCurl,
  runCounts, formatShortTime, runStats, stepGroups, stepScriptLogs,
} from '../planExport.js';
import ConsolePanel from './ConsolePanel.js';
import { parseJsonText } from '../jsonText.js';

/**
 * 方案的测试报告。
 *
 * 外层是「一次运行」（有测试数据时一行数据算一次），里层是这次运行里的每一步。
 * 这个两层结构和执行本身是同一件事，所以看起来才不会错位。
 *
 * 并发跑的时候完成顺序是乱的，但报告按行号排 —— 执行时已经把每行的位置占好了，
 * 结果回填到对应的格子里（见 store 的 runPlan）。
 *
 * 200 行跑几分钟，所以头部得有进度和用时；每步的响应也留在这里，
 * 不然跑完想回头看第 137 行返回了什么，没地方看。
 */
export default defineComponent({
  name: 'PlanRunResult',
  components: { Caret, JsonNode, ConsolePanel },
  props: {
    run: { type: Object, default: null },
    running: { type: Boolean, default: false },
    /**
     * 只读。历史页看别的方案跑出来的那一份时用 —— 报告能看能导出，但「只重跑失败的」
     * 不给：那是当前打开的那个方案的事，在历史页按它等于对另一个方案动手。
     */
    readonly: { type: Boolean, default: false },
    /** 导出时要用名字起文件名 */
    planName: { type: String, default: '' },
    /** 这个方案历次运行，新的在前。只有一次时不显示切换器 */
    history: { type: Array, default: () => [] },
    /** 现在看的是其中第几次 */
    runIndex: { type: Number, default: 0 },
  },
  emits: ['rerun-failed', 'stop', 'pick-run'],
  setup(props) {
    const openId = ref('');
    /** 展开的是哪一步的响应，形如 `行号:步骤id`（步骤 id 在多行之间会重复） */
    const respKey = ref('');

    /** 只看失败。跑 200 行挂 20 行，在 200 行里手点 20 次展开太蠢了 */
    const onlyFailed = ref(false);
    /** 导出菜单开没开 */
    const menu = ref('');
    /** 刚复制过的那个按钮（''= 没有），用来把文字换成「已复制」 */
    const { copied: copiedKey, copy } = useCopy();

    /** 跑的时候要让「用时」动起来，否则屏幕上是个死数字 */
    const now = ref(Date.now());
    const tick = setInterval(() => {
      if (props.running) now.value = Date.now();
    }, 500);
    onUnmounted(() => clearInterval(tick));

    /** 失败的那次自动展开 —— 出问题的地方应当自己跳出来 */
    const isOpen = (g) =>
      openId.value === g.key ||
      (openId.value === '' && autoExpand.value && groupBad(g));

    /**
     * 再点一次就收起来。
     *
     * 判断用 isOpen 而不是 `openId === row.no`：自动展开的那些行 openId 还是空的，
     * 按老写法点第一下会把它重新「打开」（其实本来就没关），看着像没反应。
     */
    const toggle = (g) => {
      openId.value = isOpen(g) ? '__none__' : g.key;
    };

    // key 要带上**落点**：同一个步骤在每一行各有一条记录
    const bindKey = (g, where) => `${g.key}:${where}`;
    const isRespOpen = (g, where) => respKey.value === bindKey(g, where);
    const toggleResp = (g, where) => {
      const key = bindKey(g, where);
      respKey.value = respKey.value === key ? '' : key;
    };

    /*
     * 补齐老记录缺的字段。
     *
     * 这份数据是从 data.json 里读回来的，可能是好几个版本之前跑的那次 ——
     * usedVars / extracted / assertions 都是后来才加上的。模板里一句
     * `s.usedVars.length` 碰上 undefined 就抛 TypeError，整页渲染直接空白。
     * 这里是只读展示，补成空数组比崩掉强。
     *
     * 注意不能写成 `{ usedVars: [], ...s }`：s 上如果**有**这个键、值是
     * undefined，展开会把默认值盖回去。必须先展开再兜底。
     */
    const safeStep = (s) => ({
      ...s,
      usedVars: s.usedVars || [],
      extracted: s.extracted || [],
      assertions: s.assertions || [],
    });

    // ---------------- 进度 ----------------
    /*
     * 一段（一行数据 / 整轮跑一遍的那些步骤）。steps 都要过 safeStep —— 老记录同样
     * 可能缺字段。
     *
     * 先滤掉**空位**：整轮一遍的步骤不占数据行的格子，数组下标是按方案里步骤的位置
     * 留出来的，所以行里一定会出现空位。`v-for` 遍历稀疏数组会拿到 undefined
     * （`forEach` 不会），不滤的话整个报告页渲染就崩了。落盘再读回来时空位是 null，
     * 这个 filter 一并处理。
     */
    /*
     * 报告按**步骤**排：一步一条，顺序就是执行顺序。
     *
     * 早先是按数据行分组 —— 同一个步骤会散在 5 个地方（第 1 行的第 3 步、第 2 行的
     * 第 3 步…），想看清「哪一步总挂」得来回翻。按步骤排，一眼就是那条流程本身；
     * 哪一步出了事，点开看它是在哪几行出的。
     *
     * 每条记录都过 safeStep：它是从 data.json 读回来的，可能是好几个版本之前跑的。
     */
    const groups = computed(() =>
      stepGroups(props.run).map((g) => ({
        ...g,
        runs: g.runs.map((r) => ({ where: r.where, step: safeStep(r.step) })),
      }))
    );

    /** 这一步有没有要处理的问题 */
    const groupBad = (g) => g.failed > 0 || g.missing > 0 || g.stopped > 0;

    const visibleGroups = computed(() =>
      onlyFailed.value ? groups.value.filter(groupBad) : groups.value
    );

    /** 头部的账按**次数**算（每个步骤的每一遍算一次），不是按步骤数 —— 那才是实打实的量 */
    const stats = computed(() => runStats(props.run, now.value));
    const pendingSteps = computed(() =>
      Math.max(0, stats.value.stepsTotal - stats.value.stepsDone)
    );
    /** 「要看的问题」= 失败 + 未执行 */
    const badCount = computed(() => stats.value.failedSteps + stats.value.missingSteps);

    /** 有失败、或有没跑成的，才谈得上「重跑那些」。只读的时候不给这颗按钮 */
    const canRerun = computed(
      () => !props.readonly && !props.running && !!props.run && badCount.value > 0
    );

    /**
     * 出问题的那几步自动摊开。
     *
     * 挂得少的时候摊开最好用 —— 一进来就直接看到出问题的地方。挂得多就不能摊：
     * 一堆详情同时铺开会卡，而且那等于把「只看失败」这个筛选本想解决的问题又还回去一半。
     */
    const autoExpand = computed(() => {
      const bad = groups.value.filter(groupBad);
      return bad.length > 0 && bad.length <= 5;
    });

    const percent = computed(() => Math.round(stats.value.percent * 100));

    /** 用时。跑着就用当前时间算，跑完就冻在 finishedAt 上 */
    const elapsedText = computed(() => {
      const run = props.run;
      if (!run?.at) return '';
      const end = run.finishedAt || now.value;
      const secs = Math.max(0, Math.round((end - run.at) / 1000));
      if (secs < 60) return `${secs} 秒`;
      const m = Math.floor(secs / 60);
      const rest = secs % 60;
      return rest ? `${m} 分 ${rest} 秒` : `${m} 分`;
    });

    /** 一步的状态角标。「已停止」要和「失败」分开 —— 那是我们喊停的，不是接口挂了 */
    const stepBadge = (step) => {
      if (step.status === 'ok') return { cls: 'ok', text: '✓' };
      if (step.status === 'running') return { cls: 'mute', text: '…' };
      if (step.status === 'stopped') return { cls: 'mute', text: '已停止' };
      // 「未执行」标红会误导：这一步的接口一个字节都没发出去，服务端根本没参与
      if (step.status === 'missing') return { cls: 'warn', text: '未执行' };
      if (step.status === 'pending') return { cls: 'mute', text: '未运行' };
      return { cls: 'err', text: '✗' };
    };

    const parsedResp = (step) => parseJsonText(step.response?.body);

    const respStatusClass = (step) => {
      const s = step.response?.status ?? 0;
      if (s >= 200 && s < 300) return 'ok';
      if (s >= 400) return 'err';
      return 'warn';
    };

    /**
     * 把变量名拼成 `{{名}}` 这样的展示文案。
     *
     * **必须在 JS 里拼好再交给模板**。Vue 的插值按 `{{ … }}` 非贪婪匹配，
     * 表达式自己带上 `}}`（哪怕写在字符串字面量里）会被当成插值的结束，
     * 生成一段没闭合的代码 —— 运行时抛 SyntaxError，而且不指向任何文件。
     */
    const braces = (names) => names.map((n) => '{{' + n + '}}').join(' ');

    /**
     * 「这个变量是从哪儿取的」。取不到的时候尤其需要 ——
     * 光看到「取不到」，不知道该去查 JSON、响应头还是正文
     */
    const sourceLabel = (item) => {
      const from = item.from || 'body';
      if (from === 'header') return `响应头 ${item.path || '(没填头名)'}`;
      if (from === 'text') return `正文正则 ${item.path || '(没填正则)'}`;
      if (from === 'status') return '状态码';
      return `JSON ${item.path || '(没填路径)'}`;
    };

    // ---------------- 筛选 ----------------
    /*
     * 「只看失败」把「未执行」也算进来：那些步同样是**这轮没成**、同样要处理，只是
     * 原因不在接口身上（缺数据，压根没发）。漏掉的话筛完看着全绿，其实还有一片没跑。
     *
     * 不再分批画：一条 = 一个步骤，方案里有几步就几条（几十条撑死），
     * 不像按数据行那样能动辄上千。
     */
    /** 有步骤可看 ≠ 有步骤。筛出来是空的时候要换一套说法，不能显示「还没有跑过」 */
    const hasVisibleGroups = computed(() => visibleGroups.value.length > 0);

    /**
     * 叫停时还有几行在飞。
     *
     * 不解释这一句，「失败 1 · 通过 3」看着像没停住 —— 其实是那 3 行已经发出去了，
     * 等它们回来报告才不会缺数据。
     */
    /**
     * 引擎自己出错中断了。
     *
     * 必须显眼：这不是接口挂了，是工具出问题了。只说「失败」的话，人会去查一个
     * 根本不存在的接口问题，而真正该看的就是这句话。
     */
    const engineErrorText = computed(() => {
      const msg = props.run?.engineError;
      return msg ? `运行被中断（工具出错，不是接口挂了）：${msg}` : '';
    });

    const haltedText = computed(() => {
      const n = props.run?.inFlightWhenHalted;
      if (!n) return '';
      return (
        `叫停时已经有 ${n} 行正在跑，它们的在途请求已经中断，不再等超时。` +
        '注意：请求已经发到服务端了，那边可能已经处理过。'
      );
    });

    // ---------------- 导出 / 复现 ----------------
    const copyFailures = async () => {
      if (!props.run) return;
      await copy(buildFailureSummary(props.run, props.planName), 'summary');
    };

    /** 导出菜单里点了哪一项。菜单自己先收起来，别挡着后面的反馈 */
    const pick = (what) => {
      menu.value = '';
      if (!props.run) return;
      if (what === 'json') {
        downloadText(
          reportFileName(props.planName, props.run.at, 'json'),
          buildRunJson(props.run, props.planName),
          'application/json;charset=utf-8'
        );
        return;
      }
      if (what === 'csv') {
        downloadText(
          reportFileName(props.planName, props.run.at, 'csv'),
          buildRunCsv(props.run),
          'text/csv;charset=utf-8'
        );
        return;
      }
      copyFailures();
    };

    /** 有「实际发出的请求」才能复现。只跑了半步、或根本没发出去的那种没有 */
    const canCurl = (step) => !!step.response?.request;

    const copyCurl = async (g, where, step) => {
      const text = stepCurl(step);
      if (!text) return;
      await copy(text, 'curl:' + bindKey(g, where));
    };

    // 「按步骤汇总」那张表没了：报告本身就是按步骤排的，再挂一张表是把同一件事说两遍

    /** 历次运行切换器里那一行的文案 */
    const runLabel = (run, index) => {
      const c = runCounts(run);
      // 「未执行」和「未运行」是两回事，别混着写（见 planExport 里那套状态的说明）
      const tail = c.failed
        ? `失败 ${c.failed}`
        : c.missing
          ? `未执行 ${c.missing}`
          : c.pending
            ? `未运行 ${c.pending}`
            : '全通过';
      return `${index === 0 ? '最新 · ' : ''}${formatShortTime(run.at)} · ${c.total} 段 · ${tail}`;
    };

    /**
     * 这一步为什么没有响应可以看。
     *
     * 落盘那份已经不带 response 了（见 store 的 slimRun），所以「响应没留着」
     * 和「这次压根没拿到响应」是两件事，不能共用一句话。
     */
    const noResponseText = (step) => {
      if (step.status === 'stopped') return '被叫停，没拿到响应';
      // 缺数据是**故意不发**的：说清缺什么，人才知道该去补哪一步
      if (step.status === 'missing') return step.error || '缺数据，没发出去';
      if (step.status === 'running') return '还在跑';
      if (step.status === 'pending') return '还没轮到';
      // 其余情况（发了请求、但响应体没跟着存下来）：什么都不说。
      // 这一行已经有状态码、错误和断言了，够读；再补一句「响应没留着」等于
      // 把工具的短处写在页面上，而用户对此什么也做不了。
      return '';
    };

    /**
     * 断言那一颗。过了写「通过」；没过要带上实际值 —— 光说「失败」等于没说：
     * 「评论数 大于 0 失败」看不出实际是 0 还是 null，还得自己点开响应去数。
     */
    const assertText = (a) => {
      if (a.ok) return '通过';
      const v = a.actual;
      const shown =
        v === null || v === undefined ? ''
          : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return shown === '' ? '失败' : `失败（实际 ${shown}）`;
    };

    /**
     * 这一步有没有响应可看。
     *
     * 从文件里载入的那份只留了摘要和请求（请求是为了「复制成 curl」），没有响应体。
     * 那就别给「看响应」这个入口 —— 点开一个空框，比没有入口更糟。
     */
    const hasResp = (s) => !!s?.response && s.response.body !== undefined;

    /** 一步的总账角标：全过 ✓、有挂 ✗、缺数据没发出去单独一档 */
    const groupBadge = (g) => {
      if (g.failed > 0) return { cls: 'err', text: '✗' };
      if (g.missing > 0) return { cls: 'warn', text: '未执行' };
      if (g.stopped > 0) return { cls: 'mute', text: '已停止' };
      if (g.running > 0) return { cls: 'mute', text: '跑着呢' };
      return { cls: 'ok', text: '✓' };
    };

    /**
     * 行级键盘操作：Enter / 空格触发这一行的动作。
     *
     * 只在元素自己被聚焦时响应 —— 行里还嵌着按钮，事件会冒泡上来。
     */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyActivate,
      isOpen, toggle, isRespOpen, toggleResp, bindKey,
      stats, pendingSteps, badCount, canRerun, percent, elapsedText,
      groups, visibleGroups, hasVisibleGroups, groupBad, groupBadge, autoExpand,
      stepBadge,
      parsedResp, respStatusClass, braces, sourceLabel, caretOnly, formatSize, truncateNotice,
      onlyFailed,
      haltedText, engineErrorText, assertText, hasResp,
      menu, pick, copiedKey, canCurl, copyCurl,
      runLabel, noResponseText, stepScriptLogs,
    };
  },
  template: `
    <div class="run-card">
      <div class="run-head">
        <span class="run-title">测试报告</span>

        <!--
          历次运行。只有一次时不出现 —— 「跑过几次」是回归测试才关心的事，
          只跑过一次的人在工具条上多一个下拉框纯属噪音。
        -->
        <select
          class="kv-input run-pick"
          v-if="history.length > 1"
          :value="runIndex"
          :disabled="running"
          title="看这个方案之前几次跑出来的结果"
          @change="$emit('pick-run', Number($event.target.value))"
        >
          <option v-for="(h, i) in history" :key="h.at" :value="i">{{ runLabel(h, i) }}</option>
        </select>

        <template v-if="run">
          <!--
            筛选。数字写在按钮上，一眼看出「有多少要处理」；
            不自动切到「只看失败」—— 自动切会让人以为一共只跑了这几行。
          -->
          <div class="run-filter" v-if="totalCount">
            <button class="run-tab" :class="{ on: !onlyFailed }" @click="onlyFailed = false">
              全部 <span class="run-tab-n">{{ totalCount }}</span>
            </button>
            <button
              class="run-tab"
              :class="{ on: onlyFailed }"
              :disabled="!badCount"
              @click="onlyFailed = true"
            >
              只看失败 <span class="run-tab-n">{{ badCount }}</span>
            </button>
            <!--
              原来这儿还有一颗「按步骤汇总」：那时候主体是按数据行排的，得再挂张表
              才看得出「哪一步总挂」。现在主体就是按步骤排的，那张表是把同一件事
              说两遍，去掉了。
            -->
          </div>

          <span class="run-progress" :class="run.status">
            已完成 {{ stats.stepsDone }} / {{ stats.stepsTotal }} 次请求
            · 通过 {{ stats.okSteps }}
            · 失败 {{ stats.failedSteps }}
            <span v-if="stats.missingSteps">· 未执行 {{ stats.missingSteps }}</span>
            <span v-if="pendingSteps">· 未运行 {{ pendingSteps }}</span>
            · 用时 {{ elapsedText }}
          </span>

          <div class="run-bar" :title="percent + '%'">
            <div class="run-bar-fill" :class="run.status" :style="{ width: percent + '%' }"></div>
          </div>
        </template>

        <div class="run-actions">
          <div class="menu-anchor" v-if="run && (run.rows.length || run.setup)">
            <button
              class="btn btn-sm"
              :class="{ on: menu === 'export' }"
              title="把这次运行导出去"
              @click.stop="menu = menu === 'export' ? '' : 'export'"
            >导出</button>

            <div class="menu-mask" v-if="menu === 'export'" @click="menu = ''"></div>
            <div class="menu" v-if="menu === 'export'">
              <button class="menu-item" @click="pick('json')">导出为 JSON</button>
              <button class="menu-item" @click="pick('csv')">导出为 CSV（Excel 可打开）</button>
              <button class="menu-item" @click="pick('fail')">
                {{ copiedKey === 'summary' ? '失败摘要已复制' : '复制失败摘要' }}
              </button>
            </div>
          </div>

          <button v-if="canRerun" class="btn btn-sm" @click="$emit('rerun-failed')">
            只重跑失败的
          </button>
          <button v-if="running" class="btn btn-sm" @click="$emit('stop')">停止</button>
        </div>
      </div>

      <!-- 工具自己出错中断：和「接口挂了」是两回事，得说清楚 -->
      <p class="run-note bad" v-if="engineErrorText">{{ engineErrorText }}</p>

      <!-- 叫停时在途的那几行：不说明白，报告上的数字会看着像没停住 -->
      <p class="run-note" v-if="haltedText">{{ haltedText }}</p>

      <div class="run-body" v-if="hasVisibleGroups">
        <!--
          一步一条，顺序就是**执行顺序**。原来按数据行分组，同一个步骤会散在 5 个
          地方（第 1 行的第 3 步、第 2 行的第 3 步…），想看清「哪一步总挂」得来回翻。
        -->
        <div
          class="run-row"
          v-for="g in visibleGroups"
          :key="g.key"
          :class="{ 'is-bad': groupBad(g), open: isOpen(g) }"
        >
          <div
            class="run-line"
            tabindex="0"
            role="button"
            :aria-expanded="isOpen(g) ? 'true' : 'false'"
            @click="toggle(g)"
            @keydown="keyActivate($event, () => toggle(g))"
          >
            <Caret :open="isOpen(g)" />
            <span class="run-no">{{ g.no }}</span>
            <span class="method" :class="g.method">{{ g.method }}</span>
            <span class="run-label">{{ g.name }}</span>
            <!-- 跑了几遍 = 它在数据行上跑过几次 -->
            <span class="run-count">
              跑 {{ g.runs.length }} 遍 · {{ g.ok }} / {{ g.runs.length }} 通过
            </span>
            <span class="badge" :class="groupBadge(g).cls">{{ groupBadge(g).text }}</span>
          </div>

          <div class="run-steps" v-if="isOpen(g)">
            <div
              class="run-step"
              v-for="({ where, step: s }) in g.runs"
              :key="where"
              :class="s.status"
            >
              <div class="run-line">
                <!-- 这一遍落在哪儿（第 2 行 / 整轮）—— 同一个步骤每行各有一条记录 -->
                <span class="run-where">{{ where }}</span>
                <span class="run-status" v-if="s.httpStatus">{{ s.httpStatus }}</span>
                <span class="run-time" v-if="s.time">{{ s.time }}ms</span>
                <!-- 重试过就写出来：这一步是不是「本来会挂、靠重试救回来的」，
                     只有这儿看得出来，否则那些偶发失败就永远藏在水面下 -->
                <span
                  class="run-retry"
                  v-if="s.attempts > 1"
                  :title="'这一遍一共发了 ' + s.attempts + ' 次'"
                >重试 {{ s.attempts - 1 }} 次</span>
                <span class="badge" :class="stepBadge(s).cls">{{ stepBadge(s).text }}</span>
              </div>

              <div class="run-detail">
                <div class="run-detail-line" v-if="s.error"><b>错误</b> {{ s.error }}</div>
                <div class="run-detail-line">
                  <b>URL</b> <span class="run-url">{{ s.url }}</span>
                </div>
                <div class="run-detail-line" v-if="s.extracted.length">
                  <b>提取</b>
                  <span
                    v-for="e in s.extracted"
                    :key="e.key"
                    class="run-chip"
                    :class="{ bad: !e.ok }"
                    :title="sourceLabel(e)"
                  >{{ e.key }} = {{ e.ok ? e.value : (e.reason || '取不到') }}</span>
                </div>
                <div class="run-detail-line" v-if="s.assertions.length">
                  <b>断言</b>
                  <span
                    v-for="(a, i) in s.assertions"
                    :key="i"
                    class="run-chip"
                    :class="{ bad: !a.ok }"
                  >{{ a.label }} {{ assertText(a) }}</span>
                </div>

                <!--
                  这一步的脚本日志，就地看 —— 不用跳去控制台翻。
                  只在会话里跑过的那份有（logs 不落盘），历史记录里这段不出现。
                -->
                <div class="run-script-logs" v-if="stepScriptLogs(s).length">
                  <ConsolePanel inline :entries="stepScriptLogs(s)" />
                </div>

                <div class="run-detail-line">
                  <button
                    class="btn-ghost btn-sm"
                    v-if="hasResp(s)"
                    @click.stop="toggleResp(g, where)"
                  >{{ isRespOpen(g, where) ? '收起响应' : '看响应' }}</button>
                  <span class="hint" v-else>{{ noResponseText(s) }}</span>

                  <!--
                    失败的那一步，拿去自己敲一遍最直接。
                    生成用的是**实际发出的**请求（变量已替换），所以换个环境也复现得出来。
                  -->
                  <button
                    class="btn-ghost btn-sm"
                    v-if="canCurl(s)"
                    title="复制成 curl，拿去终端里自己跑一遍"
                    @click.stop="copyCurl(g, where, s)"
                  >{{ copiedKey === 'curl:' + bindKey(g, where) ? '已复制' : '复制 curl' }}</button>
                </div>

                <div class="run-resp" v-if="isRespOpen(g, where) && hasResp(s)">
                  <div class="status-line">
                    <span class="badge" :class="respStatusClass(s)">
                      {{ s.response.status }} {{ s.response.statusText }}
                    </span>
                    <span class="metric">耗时 <b>{{ s.response.time }} ms</b></span>
                    <span class="metric">大小 <b>{{ formatSize(s.response.size) }}</b></span>
                  </div>
                  <div class="truncated-hint" v-if="truncateNotice(s.response)">
                    {{ truncateNotice(s.response) }}
                  </div>
                  <div class="selectable" v-bind="caretOnly" v-if="parsedResp(s) !== undefined">
                    <JsonNode :data="parsedResp(s)" />
                  </div>
                  <pre class="jt selectable" v-bind="caretOnly" v-else>{{ s.response.body }}</pre>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>

      <!-- 刚开始跑、第一行还没生成时也得有反馈，否则是一片空白 -->
      <div class="empty" v-else-if="running">
        <div class="spinner"></div>
        <span class="empty-title">正在跑…</span>
      </div>

      <!-- 有结果、只是被筛空了。别说成「还没有跑过」，那是另一回事 -->
      <div class="empty" v-else-if="run && (run.rows.length || run.setup)">
        <span class="empty-title">没有失败的行</span>
        <span class="empty-hint">这次运行全部通过了。</span>
      </div>

      <div class="empty" v-else>
        <span class="empty-title">还没有跑过</span>
        <span class="empty-hint">
          点上面的「运行」。每一步的请求、断言，以及提取出来的变量都会记在这里。
        </span>
      </div>
    </div>
  `,
});
