import { computed, defineComponent, ref, watch } from 'vue';
import Caret from './Caret.js';
import InfoTip from './InfoTip.js';
import {
  MAX_CONCURRENCY, MAX_RETRY, planConcurrency, planDataLimit,
  openEnvPage, planInterval, planRetry, planTimeoutMs, state, togglePlanSection,
} from '../store.js';
import { allPicked, applyPick, somePicked, toggleOne } from '../pickScope.js';
import { usesTestData } from '../planSteps.js';
import { outcomePending, outcomeTextOf, stepOutcomes } from '../planExport.js';
import RequestEditor from './RequestEditor.js';
import PlanData from './PlanData.js';
import PlanVars from './PlanVars.js';
import PlanRunResult from './PlanRunResult.js';

/**
 * 右侧的方案视图。
 *
 * 方案的本质是**一条有序的流程**，所以主区就是这条流程本身：步骤竖排、
 * 一行一个，点哪一行就地展开成接口编辑器。
 *
 * 以前步骤挤在左栏那棵树里，一列只有名字，262px 宽；右侧三页里也没有一页
 * 在表达"这条线长什么样"。想看清一个方案跑什么，得在上下一串名字里逐个点开。
 * 现在左栏退回成方案列表（它就是导航），步骤回到主区，一行一步。
 *
 * 每行右边挂着**上一次的执行结果**：跑到哪、哪挂了，不用切到报告页去找。
 */
export default defineComponent({
  name: 'PlanView',
  components: { Caret, InfoTip, RequestEditor, PlanData, PlanVars, PlanRunResult },
  props: {
    plan: { type: Object, required: true },
    /** 现在展开的是哪一步（空 = 都收起） */
    step: { type: Object, default: null },
    view: { type: String, default: 'steps' },
    dirty: { type: Boolean, default: false },
    environments: { type: Array, default: () => [] },
    users: { type: Array, default: () => [] },
    stepVars: { type: Object, default: () => ({}) },
    urlVars: { type: Object, default: () => ({}) },
    run: { type: Object, default: null },
    /** 本次会话跑出来的那份结果。步骤行上的「上次结果」只认它，见 outcomes */
    sessionRun: { type: Object, default: null },
    running: { type: Boolean, default: false },
    /** 这个方案历次运行，新的在前 */
    planRunHistory: { type: Array, default: () => [] },
    /** 现在看的是其中第几次 */
    runIndex: { type: Number, default: 0 },
    changed: { type: Function, default: () => () => false },
    missing: { type: Function, default: () => () => false },
    editorHeight: { type: Number, default: 300 },
  },
  emits: [
    'open-picker', 'set-view', 'change-env', 'change-user', 'change-on-error',
    'change-run-options',
    'save', 'sync-all', 'run', 'stop', 'open-run', 'rerun-failed',
    'import-data', 'clear-data', 'change-vars', 'pick-run',
    'create-data', 'set-data-limit',
    'select-step', 'toggle-step', 'remove-step', 'remove-steps', 'move-step', 'sync-step',
  ],
  setup(props, { emit }) {
    const views = [
      { id: 'steps', label: '步骤' },
      { id: 'data', label: '测试数据' },
      // 「变量」挨着测试数据：两者都是「这个方案自己的数据」
      { id: 'vars', label: '变量' },
      { id: 'report', label: '报告' },
    ];

    const enabledCount = computed(
      () => props.plan.steps.filter((s) => s.enabled && !props.missing(s)).length
    );

    /**
     * 可运行的步骤数。运行按钮看它而不是只看「有没有步骤」——
     * 每一步要么没勾选、要么来源请求已被删除时，不给跑。
     */
    const runnableCount = computed(
      () => props.plan.steps.filter((s) => s.enabled && !props.missing(s)).length
    );

    const dataLimit = computed(() => planDataLimit(props.plan));

    // ---------------- 运行设置：并发 / 间隔 / 超时 / 重试 / 失败 ----------------
    // 读的就是方案本身（props.plan 是草稿）：改一下会让标签页变「未保存」，
    // 点保存才落盘。这几项本来就是方案的一部分，不是「这次跑」的临时选择。
    const concurrency = computed(() => planConcurrency(props.plan));
    const intervalMs = computed(() => planInterval(props.plan));
    const retry = computed(() => planRetry(props.plan));
    const timeoutMs = computed(() => planTimeoutMs(props.plan));
    // 方案没有 onError 字段（旧方案）时不落到 undefined，兜底成「继续跑完」
    const effectiveOnError = computed(() => props.plan.onError ?? 'continue');

    /** 超时按**秒**填。让人往里敲 30000 是不合理的 */
    const timeoutSec = computed(() =>
      timeoutMs.value ? Math.round(timeoutMs.value / 1000) : ''
    );

    /** 方案没设超时时，用全局那个。显示出来比空着强 —— 空着看不出在等多久 */
    const globalTimeoutSec = computed(() =>
      Math.round((Number(state.settings?.timeout) || 30000) / 1000)
    );

    /**
     * 运行设置里那几行的说明，收进「?」。
     *
     * 都是「读一次就够」的话。常驻在面板里，306px 宽的地方就成了一篇文章，
     * 真正要改的那几个输入框反而被淹了。
     */
    const tipConcurrency =
      '同时跑几个数据行，上限 6 —— 浏览器限制。';

    const tipInterval =
      '上一步收到响应（或超时）之后，再等这么久才发下一步。0 = 不等待；1 秒填 1000。';

    const tipTimeout = computed(
      () => `留空表示使用全局设置（全局设置：${globalTimeoutSec.value}秒）`
    );

    /*
     * 重试这条得说全两件事：填的数是什么、哪些失败才重发。
     * 只写「重试次数」的话，看的人不知道 2 是「再发 2 次」还是「一共 2 次」，
     * 也不可能猜到 4xx 和断言不过也会重发。
     */
    const tipRetry =
      '填 2 = 一共发 3 次（第 1 次 + 再重试 2 次）。\n' +
      '连不上、超时、状态码 ≥ 400、断言不过，都会重发。';

    const tipOnError =
      '某个接口重试用完仍然失败时怎么办。\n' +
      '「停下」整轮就此打住，后面的接口也不跑；\n' +
      '「继续跑完」照跑完剩下的接口，最后整轮标失败。';

    /*
     * 执行顺序这一段：讲清「按步骤推进」是什么意思。
     *
     * 用 \n 拼（不是模板里写 &#10;）：InfoTip 是文本插值，HTML 实体不会被解析成换行。
     */
    const tipSteps =
      '按步骤推进：一个接口把它所有数据行跑完，才轮到下一个接口。\n' +
      '\n' +
      '· 每个接口跑几遍 = 数据行数（行上写着「5 行」；没有测试数据就跑 1 遍）；\n' +
      '· 一次请求失败会原地重试（次数在右边「运行设置」里），重试用完还失败也继续往下走；\n' +
      '· 「并发数」说的是同一个接口的多个数据行能不能同时发 —— 设成 1 就是一条接一条。';

    /**
     * 「运行」点不动时，鼠标停上去的一句话。
     *
     * 只说**下一步点哪儿**，不再解释「为什么点不动」——「没有可运行的步骤，
     * 要么没勾选、要么来源被删了」这种话是把眼前这份列表再念一遍：
     * 勾没勾、来源在不在，人自己看得见，摆在屏幕上是噪音。
     *
     * 之所以还留着一句 title：按钮灰着又完全不给话，就成了「点了没反应」，
     * 而它恰恰是页面上最显眼的那个按钮。
     */
    const runBlockReason = computed(() => {
      if (props.running) return '';
      if (runnableCount.value) return '';
      return '先勾选要跑的步骤';
    });

    /**
     * 正在跑的是**另一个**方案。
     *
     * 一次只跑一个（runPlan 开头就挡住了），所以这时候点「运行」不会有任何反应 ——
     * 与其让它看着能点、点了没动静，不如灰掉并把原因写在 title 上。
     */
    const busyElsewhere = computed(() => state.planRunning && !props.running);

    // ---------------- 步骤段的展开 / 收起 ----------------
    /** 这一段收起来了没有。纯看的状态，和左栏目录一个路数 */
    const isSectionCollapsed = (kind) => state.collapsedPlanSections.includes(kind);
    const toggleSection = (kind) => togglePlanSection(kind);

    // ---------------- 批量选择 ----------------
    /**
     * 选中的步骤 id。
     *
     * 行首那颗勾选框就是它 —— 没有「批量模式」这一层。以前要先点「批量」进去、
     * 再点「全选」，一件事拆成两次点击：想删几步还得先声明「我要开始批量了」。
     * 现在勾选框一直在、上面那颗「全选」也一直在。
     *
     * 里面可能残留已经不存在的 id（删完、或者换了方案）—— 不做清理，
     * 显示和删除都走 `picked` 那个「还在的才算数」的视图。
     */
    const selected = ref([]);

    const allStepIds = computed(() => (props.plan.steps || []).map((s) => s.id));
    const stepTotal = computed(() => allStepIds.value.length);

    /**
     * 测试数据列名。编辑步骤时把它们当「编辑时未知值」——
     * 引用 {{列名}} 不该被当成「变量没配」而报警（值取决于跑到哪一行）。
     */
    const dataColumns = computed(() => props.plan.data?.columns || []);

    /**
     * 编辑某一步时，哪些变量名算「编辑时本来就取不到值、但不算漏配」：
     *
     *   - 测试数据列：值取决于跑到哪一行，编辑时无从得知；
     *   - 排在它前面那几步「提取变量」产出的名字：要等那几步跑完才有值。
     *
     * 不把后者算进来，步骤 2 引用步骤 1 提取的 {{gotGuid}} 就会被误报成
     * 「这些变量没取到值」。取前 N 步即可 —— 不依赖数据的步整轮先跑，
     * 它们的提取也在前面（见 store.js runPlan 的前缀划分）。
     */
    /**
     * 每一步会跑几遍：等于**数据行数**（没有测试数据时跑 1 遍）。
     *
     * 执行是「按步骤推进」的：一个接口把它所有数据行跑完，才轮到下一个接口。
     * 所以行上直接写「5 行」就够 —— 一眼知道这一步会发 5 次请求。
     *
     * （这里以前标的是「先跑 1 次 / 最后跑 1 次」那套引擎术语 —— 那是按数据行推进
     * 时的补丁，见 store.js runPlan 里的说明。现在用不着了。）
     */
    const runRowCount = computed(() => {
      const rows = props.plan.data?.rows || [];
      const limit = Math.floor(Number(props.plan.dataLimit));
      return limit > 0 ? Math.min(limit, rows.length) : rows.length;
    });

    /**
     * 这一步用了几条测试数据。
     *
     * 只看**直接引用**（CSV / 手填的那些列），不顺着上游传：只用 `{{token}}` 这种
     * 上游接口取回来的值的步骤，这里算「没用到测试数据」。
     *
     * 它当然还是跟着每一行跑 —— 那是执行上的事，不然下游拿不到行内的值。但那一行
     * 说的是「我给它喂了几条数据」，不是「它会发几次请求」。后者去运行页看，那儿
     * 是实打实的次数。
     */
    const stepUseCount = (s) => (usesTestData(s, dataColumns.value) ? runRowCount.value : 0);

    /**
     * 这一步「喂了几条测试数据」。没用到就直接说「未用数据」。
     *
     * 不写「测试数据 0 条」：那读起来像「这一步不会跑」，而它只是没直接引用数据列 ——
     * 用到了上游取回来的值的话，照样跟着每一行跑。至于真会发几次请求，去运行页看，
     * 那儿是按次数实打实报的。
     */
    const rowCountText = (s) => {
      const n = stepUseCount(s);
      return n ? `测试数据 ${n} 条` : '未用数据';
    };

    const rowCountTitle = (s) => {
      if (!s.enabled) return '这一步停用了，不参与运行';
      const n = stepUseCount(s);
      if (!n) {
        return '没引用测试数据里的列。它要是用到了上游接口取回来的值，照样跟着每一行跑';
      }
      return `引用了测试数据里的列，${n} 行各跑一遍`;
    };

    const placeholderVarsFor = (step) => {
      const steps = props.plan.steps || [];
      const idx = steps.indexOf(step);
      const names = new Set(dataColumns.value);
      steps.slice(0, idx < 0 ? 0 : idx).forEach((s) => {
        (s.request?.extracts || []).forEach((e) => {
          if (e.to) names.add(e.to);
        });
      });
      return [...names];
    };
    const picked = computed(() => selected.value.filter((id) => allStepIds.value.includes(id)));
    const pickedCount = computed(() => picked.value.length);
    // 三态判定统一走 pickScope.js（口径只有一份；也顺带把「比数量」的写法换掉了 ——
    // 那样在「选中集里混着别处的 id」时会判错）
    const allSelected = computed(() => allPicked(allStepIds.value, picked.value));
    const someSelected = computed(() => somePicked(allStepIds.value, picked.value));

    const isPicked = (id) => selected.value.includes(id);

    const togglePick = (id) => {
      selected.value = toggleOne(selected.value, id);
    };

    /** 全选 / 全不选（只动这一批，别处勾的不带走） */
    const selectAll = () => {
      selected.value = applyPick(selected.value, allStepIds.value, !allSelected.value);
    };

    const clearPick = () => {
      selected.value = [];
    };

    /**
     * 删掉选中的。
     *
     * 不在这里清空选中 —— 确认框是异步的，先清掉的话点「取消」就等于把攒好的
     * 选择白丢了。删完 `picked` 会自己变空（那些 id 已经不存在了）。
     */
    const removePicked = () => {
      if (!pickedCount.value) return;
      emit('remove-steps', picked.value.slice());
    };

    // 切走页签、或者换了方案，选择就清掉 —— 免得切回来是一屏勾选
    watch([() => props.view, () => props.plan.id], clearPick);

    const isOpen = (id) => props.step?.id === id;
    const toggleOpen = (id) => emit('select-step', isOpen(id) ? '' : id);

    /** 一行里那点摘要：这一步配了什么 */
    const summarize = (step) => {
      const req = step.request || {};
      const parts = [];
      const assertions = (req.assertions || []).length;
      if (assertions) parts.push(`断言 ${assertions} 条`);
      const extracts = (req.extracts || []).map((e) => e.to).filter(Boolean);
      if (extracts.length) parts.push(`提取 ${extracts.join('、')}`);
      if (req.script) parts.push('有前置脚本');
      return parts.join(' · ');
    };

    /**
     * 上一次运行里，每一步的结果。
     *
     * 按 stepId 汇总所有数据行：全部通过写「N 次全过」，真挂了写「x/N 通过」，
     * **还在跑**的写「x/N 进行中」（不算失败、也不标红）—— 三态的口径在
     * planExport.js 的 stepOutcomes / outcomeTextOf 里，那边能单测。
     *
     * 挂在哪一步、为什么，看这一行就够了，不用翻报告页。
     *
     * 只认**本次会话**跑出来的那份（sessionRun），不用落盘的那份：刷新页面等于
     * 开始新的操作，上一轮的失败数不该还挂在每个接口上。翻旧结果去报告页的
     * 「历次运行」。
     */
    const outcomes = computed(() => stepOutcomes(props.sessionRun));

    const outcomeText = (id) => outcomeTextOf(outcomes.value.get(id), props.running);

    /**
     * 这一步的结果该不该标红。
     *
     * 和那句文案同一个口径：没跑满的时候写的是「进行中」，那就不能配红字 ——
     * 红字配「0/5 进行中」看着像已经废了。
     */
    const outcomeBad = (id) => {
      const o = outcomes.value.get(id);
      return !!o && !outcomePending(o, props.running) && !!o.bad;
    };

    const outcomeTitle = (id) => outcomes.value.get(id)?.error || '';

    /**
     * 拖拽排序。
     *
     * 拖动过程中**只记落点、不真移动**。老写法是每经过一行就移动一次，而
     * dragover 触发得极密 —— 列表跟着手指乱跳，还看不出会插到哪。现在给落点
     * 画一条线，松手（drop）才真动。
     */
    const dragging = ref(null);
    /** 现在指着哪一行。null-ish（index < 0）= 没有落点 */
    const dropAt = ref({ index: -1 });

    const dragStart = (index, event) => {
      dragging.value = { index };
      dropAt.value = { index: -1 };
      if (!event?.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不设数据就不启动拖拽
      event.dataTransfer.setData('text/plain', String(index));
    };

    const dragOver = (index, event) => {
      // 必须 preventDefault，否则浏览器不认这是「能放下的地方」，drop 不会触发
      event.preventDefault();
      const from = dragging.value;
      if (!from || from.index === index) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      dropAt.value = { index };
    };

    const dropOn = (index, event) => {
      event.preventDefault();
      const from = dragging.value;
      if (from && from.index !== index) {
        emit('move-step', { from: from.index, to: index });
      }
      dragEnd();
    };

    const dragEnd = () => {
      dragging.value = null;
      dropAt.value = { index: -1 };
    };

    /**
     * 这一行该不该显示拖拽相关的样式。
     *
     * 线画哪一边有讲究：往下拖时，插进去的位置在目标**之后**（splice 出来再
     * 按目标下标插进去），往上拖则在**之前**。反了的话松手会发现东西落在
     * 线的另一边。
     */
    const stepDragClass = (index) => {
      const from = dragging.value;
      if (!from) return '';
      if (from.index === index) return 'dragging';
      if (dropAt.value.index !== index) return '';
      return from.index > index ? 'drop-up' : 'drop-down';
    };

    // 运行设置里的环境 / 账号是会话级临时覆盖：选了就用覆盖值，没选就回落到方案默认
    const effectiveEnvId = computed(() => state.planEnvOverride || props.plan.envId);
    const effectiveUserId = computed(() => state.planUserOverride || props.plan.userId);

    /**
     * 行级键盘操作：Enter / 空格触发这一行的动作。
     *
     * 只在元素自己被聚焦时响应 —— 行里还嵌着勾选框和那几个操作按钮，事件会冒泡上来。
     */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    /**
     * 点「添加接口」：先把步骤区摊开，再去挑接口。
     *
     * 按钮挂在标题行上，折叠的时候它也够得着 —— 但挑完回来，新加的那一步落在
     * 收起来的段落里，等于白加（看不见）。顺手摊开，省掉「加了却找不到」。
     */
    function startAdd() {
      if (isSectionCollapsed('steps')) toggleSection('steps');
      emit('open-picker');
    }

    return {
      keyActivate, startAdd,
      views, enabledCount, runnableCount, dataLimit, outcomes, dataColumns, placeholderVarsFor,
      runRowCount, rowCountText, rowCountTitle,
      effectiveEnvId, effectiveUserId,
      effectiveOnError,
      maxConcurrency: MAX_CONCURRENCY,
      maxRetry: MAX_RETRY,
      concurrency, intervalMs, retry, timeoutSec, globalTimeoutSec,
      runBlockReason, busyElsewhere,
      openEnvPage,
      tipConcurrency, tipInterval, tipTimeout, tipRetry, tipOnError, tipSteps,
      isSectionCollapsed, toggleSection,
      isOpen, toggleOpen, summarize, outcomeText, outcomeBad, outcomeTitle,
      dragStart, dragOver, dropOn, dragEnd, stepDragClass,
      stepTotal, pickedCount, allSelected, someSelected, isPicked,
      togglePick, selectAll, removePicked, clearPick,
    };
  },
  template: `
    <div class="plan-view">
      <div class="plan-main">
      <div class="tabs">
        <button
          class="tab"
          v-for="v in views"
          :key="v.id"
          :class="{ active: view === v.id }"
          @click="$emit('set-view', v.id)"
        >{{ v.label }}</button>
      </div>

      <!--
        步骤：一条有序的流程，一行一步。

        不分「前置 / 主流程 / 后置」三段 —— 一个步骤跑几遍由它用到的变量决定：用到逐行
        变化的（数据列、或某个每行跑的步骤的产出）就每行一遍，全是固定值的（登录、探活、
        清理）整轮一遍。那是执行上的事，运行页上看得到。

        每一行标的是「用了几条测试数据」，只看**直接引用**的那些列（CSV / 手填的）。
        只用上游取回来的值（{{token}}）的步骤算「未使用」—— 它照样跟着每一行跑，但
        「我给它喂了几条数据」和「它会发几次请求」是两件事。
      -->
      <div class="pane" v-if="view === 'steps'">
        <section class="flow-sec flow-sec-steps">
          <div
            class="flow-sec-head"
            tabindex="0"
            role="button"
            :aria-expanded="!isSectionCollapsed('steps') ? 'true' : 'false'"
            @click="toggleSection('steps')"
            @keydown="keyActivate($event, () => toggleSection('steps'))"
          >
            <Caret :open="!isSectionCollapsed('steps')" />
            <span class="flow-sec-title">步骤</span>
            <span class="flow-sec-n" v-if="isSectionCollapsed('steps') && plan.steps.length">
              {{ plan.steps.length }}
            </span>
            <InfoTip :text="tipSteps" @click.stop />
            <!--
              「全选」挂在标题行右端：它管的是整个列表，和标题在一块儿才讲得通；
              单独占一行时，没选中东西的话那一行左边一个框、右边空着，纯属占地方。
            -->
            <label class="sel-all" v-if="stepTotal" @click.stop>
              <!--
                三种状态都要有：全勾上 / 一个没勾 / 勾了一部分（那道横线）。
                indeterminate 是 DOM 属性而不是 HTML 属性，得用 .prop 才设得上。
              -->
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate.prop="someSelected"
                @change="selectAll"
              />
              全选
            </label>
            <!--
              「添加接口」挂在标题行右端：「全选」往里靠、它最外侧（主要动作放最右，
              和右上角的「运行」在同一条视觉动线上：加 → 跑）。
              文字照写全，不做成一个光秃秃的小＋ —— 那才是真的把它藏起来。
            -->
            <button
              class="add-step"
              title="从接口树里挑一个接口，加到流程末尾"
              @click.stop="startAdd"
            >
              <span class="add-step-plus">＋</span>添加接口
            </button>
          </div>

          <div class="flow" v-if="plan.steps.length && !isSectionCollapsed('steps')">
            <div
              class="flow-step"
              v-for="(s, i) in plan.steps"
              :key="s.id"
              :class="[
                {
                  open: isOpen(s.id), off: !s.enabled, gone: missing(s), failed: outcomes.get(s.id)?.bad,
                  picked: isPicked(s.id),
                },
                stepDragClass(i),
              ]"
            >
              <div
                class="flow-line"
                tabindex="0"
                role="button"
                :aria-expanded="isOpen(s.id) ? 'true' : 'false'"
                @click="toggleOpen(s.id)"
                @keydown="keyActivate($event, () => toggleOpen(s.id))"
                draggable="true"
                @dragstart="dragStart(i, $event)"
                @dragover="dragOver(i, $event)"
                @drop="dropOn(i, $event)"
                @dragend="dragEnd"
              >
                <input
                  type="checkbox"
                  :checked="isPicked(s.id)"
                  title="选中（批量删除用）"
                  @click.stop
                  @change="togglePick(s.id)"
                />
                <span class="flow-no">{{ i + 1 }}</span>
                <span class="method" :class="s.request.method">{{ s.request.method }}</span>
                <span class="flow-name">{{ s.request.name }}</span>
                <!--
                  这一步用了几条测试数据 —— 只看**直接引用**（CSV / 手填的那些列）。
                  只用上游接口取回来的值（{{token}}）的步骤算「未使用」，它照样跟着
                  每一行跑，那是执行上的事；这里说的是「喂了几条数据给它」。
                -->
                <span class="flow-mark once" :title="rowCountTitle(s)">{{ rowCountText(s) }}</span>
                <span class="flow-mark" v-if="changed(s)" title="这一步和项目里的不一样">改过</span>
                <span class="flow-mark gone" v-if="missing(s)" title="项目里的来源请求已被删除">源头没了</span>
                <span class="flow-sum">{{ summarize(s) }}</span>
                <span
                  class="flow-last"
                  v-if="outcomeText(s.id)"
                  :class="{ bad: outcomeBad(s.id) }"
                  :title="outcomeTitle(s.id)"
                >{{ outcomeText(s.id) }}</span>
                <!--
                  停用：这一步不参与运行。停用后按钮常驻 —— 看不出来怎么恢复
                  才是最烦的。
                -->
                <button
                  class="flow-act"
                  :class="{ shown: !s.enabled }"
                  :title="s.enabled ? '这一步不参与运行' : '让这一步重新参与运行'"
                  @click.stop="$emit('toggle-step', s.id)"
                >{{ s.enabled ? '停用' : '启用' }}</button>
                <button
                  class="flow-act"
                  v-if="!missing(s)"
                  title="同步关联的接口信息"
                  @click.stop="$emit('sync-step', s.id)"
                >同步</button>
                <button class="flow-act danger" title="删掉这一步" @click.stop="$emit('remove-step', s.id)">✕</button>
                <Caret :open="isOpen(s.id)" />
              </div>

              <div class="flow-body" v-if="isOpen(s.id)">
                <RequestEditor
                  :request="s.request"
                  :vars="stepVars"
                  :url-vars="urlVars"
                  :placeholder-vars="placeholderVarsFor(s)"
                  :hide-actions="true"
                  :style="{ height: editorHeight + 'px' }"
                />
              </div>
            </div>
          </div>

          <p class="hint flow-empty" v-else-if="!plan.steps.length">还没有步骤 —— 点「添加接口」从接口树里挑。</p>

          <!--
            批量操作条：勾起来才出现，位置在**列表下面、不在上面**。
            放上面的话，勾第一个框就会把整段内容连刚点的那颗框一起往下推，
            取消时再跳回来（细节和取舍见 style.css 的 .sel-bar）。
          -->
          <div class="sel-bar" v-if="pickedCount">
            <span class="sel-count">已选 {{ pickedCount }} 步</span>
            <button class="btn btn-sm btn-danger sel-del" @click="removePicked">删除选中</button>
            <button class="btn btn-sm sel-clear" @click="clearPick">取消</button>
          </div>
        </section>
      </div>

      <PlanData
        v-else-if="view === 'data'"
        :data="plan.data"
        :limit="dataLimit"
        :plan-id="plan.id"
        @import="$emit('import-data', $event)"
        @clear="$emit('clear-data')"
        @create="$emit('create-data')"
        @limit="$emit('set-data-limit', $event)"
      />

      <div class="pane" v-else-if="view === 'vars'">
        <PlanVars :vars="plan.vars" @change="$emit('change-vars', $event)" />
      </div>

      <PlanRunResult
        v-else
        :run="run"
        :running="running"
        :plan-name="plan.name"
        :history="planRunHistory"
        :run-index="runIndex"
        @rerun-failed="$emit('rerun-failed')"
        @stop="$emit('stop')"
        @pick-run="$emit('pick-run', $event)"
      />
      </div>

      <!--
        右侧这一栏：环境、账号、运行设置。
        以前它们挤在顶部工具条里（运行设置还收在齿轮弹层里），工具条一半的宽度
        都在放配置，方案名反而被挤到角落。挪出来之后：左边纯看流程，右边纯配。
      -->
      <aside class="plan-aside">
        <!-- 保存 / 运行放这一栏最上面：这一栏就是「跑这个方案要用的东西」，配完就点 -->
        <section class="aside-sec">
          <div class="aside-actions">
            <button
              class="btn btn-sm"
              :class="{ 'btn-primary': dirty }"
              :disabled="!dirty"
              @click="$emit('save')"
            >保存</button>

            <!--
              跑起来之后，这里并排两颗：「进度」和「停止」。
              同一个地方、同一颗按钮 —— 在哪儿点的运行，就在哪儿停，不用满界面去找。
              「停止」用危险色：一颗看错就点下去的按钮最要命。而「进度」放它左边 ——
              人先想知道跑到哪儿了（那一屏里也有暂停和终止），再决定停不停。
            -->
            <button
              v-if="running || run"
              class="btn btn-sm"
              :title="running
                ? '打开运行页：看进度、暂停、终止'
                : '看这次运行的详情：进度、逐条结果、导出'"
              @click="$emit('open-run')"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              进度
            </button>

            <button
              v-if="running"
              class="btn btn-danger btn-sm plan-run"
              title="停下来：在途的请求会中断，后面的不再发"
              @click="$emit('stop')"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              停止
            </button>

            <button
              v-else
              class="btn btn-primary btn-sm plan-run"
              :disabled="!runnableCount || busyElsewhere"
              :title="busyElsewhere
                ? '另一个方案正在运行 —— 等它跑完，或者切过去停掉'
                : (runBlockReason || '按当前设置运行')"
              @click="$emit('run')"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              运行
            </button>
          </div>

          <div class="plan-dirty" v-if="dirty"><span class="dot"></span>未保存</div>
        </section>

        <section class="aside-sec">
          <button class="btn btn-sm" style="width: 100%" @click="openEnvPage">管理环境变量</button>
        </section>

        <section class="aside-sec">
          <div class="aside-title">环境与账号</div>

          <label class="aside-row">
            <span class="aside-name">环境</span>
            <select class="kv-input" :value="effectiveEnvId" @change="$emit('change-env', $event.target.value)">
              <option v-for="e in environments" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>

          <label class="aside-row">
            <span class="aside-name">账号</span>
            <select class="kv-input" :value="effectiveUserId" @change="$emit('change-user', $event.target.value)">
              <!-- 方案选的那个环境里没有账号时，空下拉框看着像坏了，给一句说明 -->
              <option v-if="!users.length" value="">没有账号</option>
              <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </label>
        </section>

        <section class="aside-sec">
          <!--
            这几项存在方案里：改了会把标签页标成「未保存」，点保存才落盘。
            标题上写一句，免得有人以为和「环境 / 账号」一样只是本次有效。
          -->
          <div class="aside-title" title="这几项存在方案里，点上面的「保存」才会落盘">运行设置</div>

          <div class="run-set-row">
            <label>并发数</label>
            <InfoTip :text="tipConcurrency" />
            <input
              class="kv-input"
              type="number"
              min="1"
              :max="maxConcurrency"
              :value="concurrency"
              @change="$emit('change-run-options', { concurrency: $event.target.value })"
            />
            <span class="run-set-unit">个</span>
          </div>

          <div class="run-set-row">
            <label>发起间隔</label>
            <InfoTip :text="tipInterval" />
            <input
              class="kv-input"
              type="number"
              min="0"
              step="100"
              :value="intervalMs"
              @change="$emit('change-run-options', { intervalMs: $event.target.value })"
            />
            <span class="run-set-unit">ms</span>
          </div>

          <div class="run-set-row">
            <label>请求超时</label>
            <InfoTip :text="tipTimeout" />
            <input
              class="kv-input"
              type="number"
              min="0"
              step="5"
              :value="timeoutSec"
              :placeholder="globalTimeoutSec"
              @change="$emit('change-run-options', {
                timeoutMs: $event.target.value === '' ? '' : Number($event.target.value) * 1000
              })"
            />
            <span class="run-set-unit">秒</span>
          </div>

          <div class="run-set-row">
            <label>失败重试</label>
            <InfoTip :text="tipRetry" />
            <input
              class="kv-input"
              type="number"
              min="0"
              :max="maxRetry"
              :value="retry"
              @change="$emit('change-run-options', { retry: $event.target.value })"
            />
            <span class="run-set-unit">次</span>
          </div>

          <div class="run-set-row">
            <label>失败</label>
            <InfoTip :text="tipOnError" />
            <select
              class="kv-input"
              :value="effectiveOnError"
              @change="$emit('change-on-error', $event.target.value)"
            >
              <option value="stop">停下</option>
              <option value="continue">继续跑完</option>
            </select>
          </div>
        </section>

        <section class="aside-sec">
          <button
            class="btn btn-sm"
            style="width: 100%"
            title="同步关联的接口信息"
            @click="$emit('sync-all')"
          >全部同步</button>
        </section>
      </aside>
    </div>
  `,
});
