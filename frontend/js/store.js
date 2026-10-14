// ---------------------------------------------------------------------------
// 全局状态与数据操作
//
// 这里只有「数据」和「改数据的方法」，不碰 DOM、不碰视图。
// 页面骨架和模板在 main.js，拖拽 / 快捷键这类视图行为在 ui.js。
//
// 数据整份落在后端的 JSON 文件里（见文件末尾「与后端同步」一节）：
// 改动被防抖收集后写回 /api/state，刷新和换浏览器都还在。
// ---------------------------------------------------------------------------
import { computed, reactive, ref, toRaw, watch } from 'vue';
import { dump as dumpYaml } from 'js-yaml';
import { finalUrl, send } from './api.js';
import { runPostScript, runPreScript } from './script.js';
import { applyPick, toggleOne } from './pickScope.js';
import { formatValue, runAssertions, runExtracts } from './assert.js';
import { parseDocument, toBundles } from './openapi.js';
import { buildDocument, exportFileName } from './openapiExport.js';
import { downloadText, safeFileName } from './download.js';
import { parseCsv } from './csv.js';
import { PROJECT_FILE_KIND, PROJECT_FILE_VERSION, parseProjectFile } from './projectFile.js';
import { requestVarNames, rerunTargets, stepScopes, stepVerdict } from './planSteps.js';
import { isBuiltinVar } from './varsuggest.js';

/** 生成一个短 id。环境分组那边也要用，所以导出。 */
export const uid = () => Math.random().toString(36).slice(2, 9);
const header = (key, value, enabled = true) => ({ enabled, key, value });

/** 深拷贝。请求是纯数据，没有函数也没有循环引用，JSON 来回一趟就够。 */
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * 存档格式版本，必须和 backend/storage.py 的 SCHEMA_VERSION 一致。
 *
 * 用处是认出「这份存档比本程序新」：新版本写过之后又回退到旧版本跑，旧代码读不懂
 * 新字段，随手一保存就把它们抹了 —— 所以那种情况下直接停用自动保存，只看不写。
 */
export const SCHEMA_VERSION = 1;

/**
 * 「正在进行中的一件事」的中途开关。
 *
 * 跑方案能不能停、发送能不能中止、落盘在不在途 —— 这些不是数据，是运行态。
 * 原先各是一个 let 变量，散在三千多行里，读一个流程得来回跳着找；收进一个对象，
 * 至少能一眼看全「同时可能有几件事在跑」。
 *
 * 不进 state：它们不该被任何界面直接读，也不参与响应式。
 */
const runtime = {
  /** 方案运行：叫停标记 + 用来断掉在途请求的中止器（见 stopPlan） */
  planStop: false,
  planAbort: null,
  /**
   * 方案运行：暂停标记 + 让引擎就地等着的那个 promise。
   *
   * 和 planStop 是两件事，别混：「停止」是断掉在途请求、这一轮就此结束；
   * 「暂停」什么都不中断（在途的请求照常回来），只是不再往下发 —— 引擎在几个
   * 检查点上 await 这里，人想接着跑就把 promise 兑现（见 pausePlan / resumePlan）。
   *
   * 引擎全在 runPlan 一个函数里、跑起来不能重入，所以「恢复」只能是把它叫醒，
   * 不能靠重新调一次 runPlan。
   */
  planPaused: false,
  pauseGate: null,
  /** 单个请求发送的中止器（见 stopSend） */
  sendAbort: null,
  /** 落盘：在途的那次、它在途期间又攒下的改动、以及防抖定时器 */
  saving: null,
  saveAgain: false,
  saveTimer: null,
};

export const state = reactive({
  // 'projects' 项目列表页 / 'environments' 环境变量页 / 'workspace' 工作区
  view: 'projects',
  activeProjectId: '',

  nav: 'api',
  showNav: true,
  /**
   * 工作台里当前打开哪个工具（见 frontend/js/workbench.js 的清单）。
   * 空串 = 还没选过，落到清单第一个。会话状态，不落盘 —— 和 nav 一个道理。
   */
  workbenchTool: '',

  // 可拖拽尺寸（编辑区初始高度按窗口收敛，避免小窗口下溢出）
  // 左栏显示的是接口树 / 历史 / 方案列表，262 挤了点，按 1.5 倍放宽
  sidebarWidth: 393,
  editorHeight: Math.max(160, Math.min(360, window.innerHeight - 320)),

  /**
   * 勾选的请求 id。**项目级**：接口树本来就跨整个项目，批量移动 / 删除也该跨。
   *
   * 放在这里而不是侧栏组件里，是因为用它的有两处：侧栏树上的勾选框，
   * 以及浮在主区顶上的那条批量操作条（见 PickBar.js）。会话状态，不落盘 ——
   * 刷新之后留着一屏勾选没有意义。
   */
  pickedRequestIds: [],

  // 不内置任何示例数据：装上就是白纸一张，第一次进来直接建自己的项目。
  // 早期版本在这里塞了两个示例项目和三个环境，正式使用时反而得先手动删干净。
  projects: [],

  environments: [],

  activeEnvId: '',
  activeUserId: '',
  activeRequestId: '',

  /**
   * 打开的标签页。每项：
   *   { id, requestId, isNew, draft, baseline,
   *     response, error, assertionResults, scriptRun }
   *
   * `draft` 才是编辑器实际操作的那个对象；项目里那份是**已保存的真身**，
   * 只有点保存才会被写入。
   *
   * 为什么非要分成两份：自动保存盯的是整份快照，而它写的是 state。
   * 如果编辑直接落在项目里，改一个环境变量就会顺带把当前请求的未保存改动
   * 一起写进文件 —— 保存按钮看着在工作，实际白设。
   *
   * 不进 PERSISTED_KEYS：刷新后回到「没开任何标签页」，与「没保存就是没保存」一致。
   */
  tabs: [],
  activeTabId: '',

  /**
   * 自动化：打开的方案标签页、正在编哪一步、右侧切到哪一页、上次运行结果。
   *
   * 都是会话状态，刻意不持久化 —— 方案本身存在 project.plans 里，已经有归宿了。
   * 每个方案标签页各带一份草稿，编辑落在草稿上，点保存才写回 plans。
   */
  planTabs: [],
  activePlanTabId: '',
  activeStepId: '',
  /**
   * 运行设置里临时选的环境 / 账号：**会话级、不持久化**。
   * 改了它不进方案草稿、不触发「未保存」、不写盘；刷新或切方案就清零，
   * 回到方案自己的默认（plan.envId / plan.userId）。让它和并发数那些
   * 真正要落盘的设置分开：环境账号只管「这次跑用哪个」，不该被存下来。
   */
  planEnvOverride: '',
  planUserOverride: '',
  /**
   * 运行页（跑起来之后那个全屏进度页）开着没。
   *
   * 一开跑就打开 —— 一轮要跑几分钟，人得看得见跑到哪儿了、能不能停；关掉它
   * 只是回到方案编辑页，运行照旧在跑（再点工具栏那颗按钮还能打开）。
   */
  planRunPage: false,
  /**
   * 这一轮在跑、但被暂停了。给界面读的一份 —— 真身在 runtime.planPaused，
   * 引擎只认那一份，这里跟着它走，免得两处各说各话。
   */
  planPaused: false,
  /** 右侧切到哪一页：步骤 / 测试数据 / 报告 */
  stepView: 'steps',
  /** 左栏收起了哪些目录。会话状态，不落盘 —— 和侧栏宽度一个道理 */
  collapsedPlanGroups: [],
  /**
   * 接口树里**点开过**哪些目录（按目录 id）。同样是会话状态。
   *
   * 记「展开的」而不是「收起的」：目录默认是折着的，这样一来新建的目录、
   * 刚导入的项目天然就是折叠状态，不用在别处补一轮初始化；
   * 展开父目录时子目录也不会跟着一起铺开 —— 一次只展开一层。
   */
  expandedDirs: [],
  /** 「未分组」那一栏展开没。默认和目录一样是折起来的，只剩一棵树，一个布尔就够 */
  expandedUngrouped: false,
  /** 步骤页三段（前置 / 步骤 / 后置）收起了哪几段。同样是会话状态 */
  collapsedPlanSections: [],
  planRun: null,
  /** 正在跑。要在这儿声明，运行时才挂上去的字段不算响应式状态 */
  planRunning: false,
  /**
   * 正在跑的是哪个方案。
   *
   * 「正在跑」必须是**按方案**的：报告页的「停止」按钮、步骤行上的实时结果，
   * 都只能挂在真正在跑的那个方案上。不然在看方案 B 的时候，B 的报告上会冒出
   * 一个停止按钮，点下去停掉的却是 A 的运行。
   */
  planRunningId: '',

  /**
   * 每个方案最近一次跑完的结果，精简版，按方案 id 存。
   *
   * 跑完刷新不该全白跑 —— 200 行跑三分钟，回来连"哪一行挂了"都看不到太亏了。
   * 只存摘要不存响应体，理由见 slimRun。
   */
  planRuns: {},
  /**
   * 本次会话里跑过的完整结果（带响应体），切标签页回来还能点开看。
   * 刻意不落盘：有了它，落盘那份才敢只留摘要。
   */
  planRunCache: {},

  /** 「从接口树添加接口」弹层。勾选状态在组件自己手里，这里只管开没开 */
  stepPickerOpen: false,

  // 全局请求设置：对所有请求生效，改完自动保存
  settings: {
    timeout: 30000,
    followRedirects: true,
    skipTlsVerify: false,
    /** 'light' | 'dark'。落在 <html data-theme> 上，见 ui.js 的 applyTheme */
    theme: 'light',
  },

  history: [],
  activeHistoryId: '',
  /**
   * 历史页现在看哪一栏：'req' 接口请求 / 'run' 自动化运行。
   *
   * 放在 store 里而不是组件自己手里 —— **右侧主区要跟着它换**。留在组件里的话，
   * 切到「接口请求」栏时右边还挂着上一栏那份运行报告，点接口记录也换不过来。
   */
  historyTab: 'req',
  /**
   * 「自动化运行」那一栏选中的是哪一次（方案 id + 运行时刻）。
   * 和 activeHistoryId 各管一摊：一个选接口调用，一个选方案运行。
   */
  activeHistoryRunPlanId: '',
  activeHistoryRunAt: 0,

  response: null,
  sending: false,
  error: '',
  /** 上一次发送是**我们点「停止」叫停的**。和 error 分开：一个是我们自己的动作，一个是真出事了 */
  cancelled: false,
  assertionResults: [],
  scriptRun: null,

  // 页内确认弹层（替代原生 confirm / alert / prompt）
  confirm: {
    open: false,
    title: '',
    message: '',
    confirmText: '确认删除',
    /** 第三个按钮。目前只有「关标签页时的未保存提示」会用到 */
    thirdText: '',
    /**
     * 不渲染「取消」按钮。
     *
     * 只给「关标签页时发现未保存改动」这类弹层用：取消本来就够得着 —— 点弹层外面
     * 或按 Esc 都是取消，按钮区再摆一个「取消」，三个按钮里就有一个是多余的。
     *
     * 去掉之后默认焦点不能在「不保存」上（回车就丢改动），ConfirmDialog 会把它
     * 挪到「保存并关闭」；所以这个开关别用在「回车就会丢数据」的场合。
     */
    hideCancel: false,
    alertOnly: false,
    withInput: false,
    inputPlaceholder: '',
    inputValue: '',
    /** 弹层里放一个下拉选择（目前只有「保存到哪个目录」会用） */
    withSelect: false,
    /** [{ value, label }] */
    selectOptions: [],
    selectValue: '',
    action: null,
    thirdAction: null,
  },
});

// ------------------------------- 派生状态 -------------------------------

export const activeProject = computed(
  () => state.projects.find((p) => p.id === state.activeProjectId) || null
);

/**
 * 接口树的作用域 = 当前项目。
 *
 * 结构和拿掉「集合」之前一样，只是从「每个集合一份」变成「每个项目一份」：
 *   项目 dirs[]      目录，靠 parentId 成树，可无限嵌套
 *   项目 requests[]  请求，扁平存放，靠 dirId 挂在目录下，空串 = 根（「未分组」）
 * 同级次序一律看 sort。
 *
 * 下面那组函数都收一个 scope（就是 activeProject）—— 整棵树的读写只有这一套。
 */
const projectDirs = computed(() => activeProject.value?.dirs || []);

export const allRequests = computed(() => activeProject.value?.requests || []);

// ------------------------------- 批量勾选 -------------------------------

/**
 * 眼下有效的勾选（读的那一份）。
 *
 * 顺手对一次账：单个删除、批量删除、导入替换、换项目之后，原始数组里会留下
 * 已经不存在的 id —— 不过滤的话「已选 N」虚高，删除确认框里的数字也是错的。
 * 放在读取这一侧，写入那边就不用到处补清理。
 */
export const pickedRequestIds = computed(() => {
  const alive = new Set(allRequests.value.map((r) => r.id));
  return state.pickedRequestIds.filter((id) => alive.has(id));
});

/** 整批勾上 / 移出勾选（「全选」、整目录勾选、未分组那一格走它） */
export function pickRequests(ids, checked) {
  state.pickedRequestIds = applyPick(state.pickedRequestIds, ids, checked);
}

/** 单条勾 / 取消 */
export function toggleRequestPick(id) {
  state.pickedRequestIds = toggleOne(state.pickedRequestIds, id);
}

/** 清空勾选：批量操作做完、拖完、点「取消」 */
export function clearPickedRequests() {
  state.pickedRequestIds = [];
}

/** 某个父节点下的子节点（目录 + 请求混在一起），已按 sort 排好序。 */
function siblingEntries(scope, parentId) {
  const parent = parentId || '';
  const entries = [];
  (scope.dirs || []).forEach((d) => {
    if ((d.parentId || '') === parent) entries.push({ kind: 'dir', node: d });
  });
  (scope.requests || []).forEach((r) => {
    if ((r.dirId || '') === parent) entries.push({ kind: 'req', node: r });
  });
  entries.sort((a, b) => {
    const diff = (a.node.sort || 0) - (b.node.sort || 0);
    // sort 相同（比如老存档）时按 id 兜底，保证顺序稳定
    return diff !== 0 ? diff : String(a.node.id).localeCompare(String(b.node.id));
  });
  return entries;
}

/** 一个目录连同它所有层级的子孙目录 id。 */
function subtreeDirIds(scope, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    (scope.dirs || []).forEach((d) => {
      if (d.parentId && ids.has(d.parentId) && !ids.has(d.id)) {
        ids.add(d.id);
        changed = true;
      }
    });
  }
  return ids;
}

function countRequestsUnder(scope, dirId) {
  const ids = subtreeDirIds(scope, dirId);
  return (scope.requests || []).filter((r) => ids.has(r.dirId)).length;
}

/**
 * 按数组顺序给同级节点重新编号，并把新位置同步进开着的标签页。
 *
 * 同步这一步不能省：保存标签页是**整份 draft 写回**，而 draft 里带着开标签那一刻
 * 的旧 sort。不同步的话，别人重排之后你在这个请求上点保存，位置就被写回旧值
 * （还会和新同级撞 sort）。
 */
function applyOrder(entries) {
  entries.forEach((entry, index) => {
    entry.node.sort = index;
    if (entry.kind === 'req') syncTabPos(entry.node);
  });
}

/** 把某个父节点下的子节点按当前顺序重编号（0,1,2…）。移动 / 删除后收拾现场用。 */
function renumber(scope, parentId) {
  applyOrder(siblingEntries(scope, parentId));
}

/** 下一个可用的 sort：排在同级最后。 */
function nextSort(scope, parentId) {
  return siblingEntries(scope, parentId).reduce((max, e) => Math.max(max, e.node.sort || 0), -1) + 1;
}

/**
 * 左栏那棵树，摊平成一行行、带 depth。
 *
 * **不管折叠**：全部铺平，每个目录行带着 `collapsed` 标记，折叠由侧栏渲染时
 * 跳过子孙实现 —— 这样搜索时能直接复用这份完整数据，强制展开。
 *
 * 项目根上的**请求**不进这里，它们归到「未分组」那一栏（可单独折叠）；
 * 项目根上的目录才是树的主干。目录里的请求和子目录则混在一起铺开。
 */
export const interfaceTree = computed(() => {
  const scope = activeProject.value;
  if (!scope) {
    return { rows: [], ungrouped: [], count: 0, hasDirs: false, ungroupedCollapsed: false };
  }

  const rows = [];
  const pushDirRow = (node, depth, index, parentId) => {
    rows.push({
      kind: 'dir',
      id: node.id,
      name: node.name,
      depth,
      parentId,
      index,
      collapsed: !state.expandedDirs.includes(node.id),
      count: countRequestsUnder(scope, node.id),
    });
  };

  const walk = (parentId, depth) => {
    siblingEntries(scope, parentId).forEach((entry, index) => {
      if (entry.kind === 'dir') {
        pushDirRow(entry.node, depth, index, parentId || '');
        walk(entry.node.id, depth + 1);
      } else {
        rows.push({
          kind: 'req',
          id: entry.node.id,
          request: entry.node,
          depth,
          parentId: parentId || '',
          index,
        });
      }
    });
  };

  // 根：只从目录铺起；根上的请求单独进「未分组」
  siblingEntries(scope, '').forEach((entry, index) => {
    if (entry.kind === 'dir') {
      pushDirRow(entry.node, 1, index, '');
      walk(entry.node.id, 2);
    }
  });

  const ungrouped = (scope.requests || [])
    .filter((r) => !r.dirId)
    .slice()
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));

  return {
    rows,
    ungrouped,
    count: (scope.requests || []).length,
    hasDirs: rows.length > 0,
    ungroupedCollapsed: !state.expandedUngrouped,
  };
});

/**
 * 搜索命中：**接口名或 URL**（不分大小写，片段对上就算）；关键词是空的 = 全命中。
 *
 * URL 也要算：接口名是人随手起的、长短不一，真正记得住的往往是路径
 * （`/vqd/tasks/stop` 这种），只能按名字搜等于搜不到自己知道的那个接口。
 *
 * 抽成一份是因为「谁算命中」有四个地方要问：侧栏那棵树、「未分组」那一栏、
 * 目录整批勾选、顶上那格「全选」—— 各写各的，迟早就出现「看着命中了，
 * 全选却没勾上」这种对不上的错。
 */
export function requestMatches(request, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return true;
  const name = String((request && request.name) || '').toLowerCase();
  if (name.includes(kw)) return true;
  return String((request && request.url) || '').toLowerCase().includes(kw);
}

/**
 * 每个目录下**所有后代请求**的 id（子目录里的也算）。
 *
 * 行是前序铺开的，所以从这一行往后走、遇到 `depth` 不再更大就是走出了这棵子树。
 * **不看 `collapsed`**：折叠只是收起来不显示，不代表里面没有 —— 勾一个目录
 * 就该把折叠着的那部分也带上（侧栏那个「整批勾选」就是这么用的）。
 * 给了 `keyword` 就只算命中的请求（接口名或 URL 命中，见 requestMatches）——
 * 搜索是明确的筛选意图。
 *
 * 抽出来是因为它是纯逻辑、要能单测：嵌套三层 + 折叠 + 搜索这种组合，
 * 在界面上点一遍试不出来。
 *
 * @param {Array} rows interfaceTree.rows
 * @param {string} [keyword]
 * @returns {Object<string, string[]>} 目录 id → 请求 id 数组
 */
export function requestsUnderEach(rows, keyword = '') {
  const list = rows || [];
  const map = {};
  list.forEach((row, start) => {
    if (row.kind !== 'dir') return;
    const ids = [];
    for (let i = start + 1; i < list.length; i += 1) {
      const next = list[i];
      if (next.depth <= row.depth) break;
      if (next.kind !== 'req') continue;
      if (!requestMatches(next.request, keyword)) continue;
      ids.push(next.id);
    }
    map[row.id] = ids;
  });
  return map;
}

/**
 * 「全选」的范围：项目里能勾的请求 id。给了 keyword 就只算命中的。
 *
 * **不看折叠**，和 requestsUnderEach 一个口径：折叠只是收起来不显示，不代表里面
 * 没有。以前「全选」只勾屏幕上看得见的那几行，于是折叠着的目录整批漏掉 ——
 * 界面上看着全选完了，一删除却留下一堆，而且没有任何提示。
 * 搜索才是有意为之的筛选（只勾命中的，判据同 requestMatches：接口名或 URL）。
 *
 * 同一个函数也是「现存请求」的权威名单：侧栏拿它给勾选集合对账，
 * 删掉请求、换项目之后不留影子勾选（批量条上的「已选 N」虚高就是这么来的）。
 *
 * @param {Array} rows interfaceTree.rows（完整那棵树，不是渲染用的那几行）
 * @param {Array} ungrouped interfaceTree.ungrouped
 * @param {string} [keyword]
 * @returns {string[]} 请求 id，按树里的顺序
 */
export function selectableRequestIds(rows, ungrouped, keyword = '') {
  const hit = (r) => requestMatches(r, keyword);
  const ids = [];
  (rows || []).forEach((row) => {
    if (row.kind === 'req' && hit(row.request)) ids.push(row.id);
  });
  (ungrouped || []).forEach((r) => {
    if (hit(r)) ids.push(r.id);
  });
  return ids;
}

export const activeTab = computed(
  () => state.tabs.find((t) => t.id === state.activeTabId) || null
);

/**
 * 正在编辑的请求 —— 返回的是标签页里的 draft，**不是**项目里那份。
 *
 * 编辑器的所有改动都落在 draft 上，项目里的真身要等点保存才更新。
 * 没打开标签页的请求自然也是 null（未保存的新请求同样在这里，
 * 因为它还没进项目）。
 */
export const activeRequest = computed(() => activeTab.value?.draft || null);

/**
 * 标签页里有没有未提交的改动。
 *
 * 新开的标签页拿空白请求当基准，所以「建完一个字没动」不算脏 ——
 * 这时关掉它本就不该弹提示，也确实没什么可丢的。
 */
export const tabIsDirty = (tab) =>
  !!tab && JSON.stringify(tab.draft) !== JSON.stringify(tab.baseline);

/**
 * 保存按钮能不能点。
 *
 * 新标签页一个字没改也允许保存 —— 否则建完就没法落库，
 * 只能靠先随便敲一下再撤销这种歪门邪道。
 */
export const tabCanSave = (tab) => !!tab && (tab.isNew || tabIsDirty(tab));

/** 侧栏用来标脏点：哪些请求还挂着未提交的改动。 */
export const dirtyRequestIds = computed(() =>
  state.tabs.filter(tabIsDirty).map((t) => t.requestId)
);

export const activeEnv = computed(
  () => state.environments.find((e) => e.id === state.activeEnvId) || null
);

/** 当前环境里选中的用户（认证信息挂在用户上）。 */
export const activeUser = computed(() => {
  const env = activeEnv.value;
  if (!env || !env.users) return null;
  return env.users.find((u) => u.id === state.activeUserId) || env.users[0] || null;
});

/**
 * 环境配置里的变量 —— **不含**当前用户的认证信息。
 *
 * URL 栏用它：地址里该引用的永远是 baseUrl、版本号这类环境级配置；
 * token 之类的认证信息属于请求头，混进 URL 的候选里只会干扰。
 */
export const envVars = computed(() => {
  const out = {};
  const env = activeEnv.value;
  if (!env) return out;

  (env.groups || []).forEach((group) => {
    (group.vars || []).forEach((v) => {
      if (v.enabled && v.key.trim()) out[v.key.trim()] = v.value;
    });
  });

  return out;
});

/**
 * 当前生效的变量表：环境级分组 + 当前用户的认证信息。
 * 用户级的同名变量会覆盖环境级。
 */
export const vars = computed(() => {
  const out = { ...envVars.value };

  const user = activeUser.value;
  if (user) {
    user.vars.forEach((v) => {
      if (v.enabled && v.key.trim()) out[v.key.trim()] = v.value;
    });
  }

  return out;
});

export const requestCount = computed(() => allRequests.value.length);

// ------------------------------- 视图切换 -------------------------------

export function openProject(id) {
  state.activeProjectId = id;
  state.view = 'workspace';
  state.nav = 'api';
  // 标签页属于项目，换项目就全关掉。未提交的改动跟着一起丢 ——
  // 切项目本来就是「离开这一摊」，每关一个弹一次反而更烦人
  resetTabs();
  resetPlanTabs();
  /*
   * 进来**不自动打开任何请求**。
   *
   * 以前这里会顺手把 `allRequests[0]` 打开，看着像「帮你省一步」，实际是替人做了决定：
   * 刷新页面再进项目，标签条里就凭空多出一个请求（多半还是「未分组」里排第一那个），
   * 得先关掉才能干自己的事。主区现在有空态（main.js 的 empty 那块）指路，
   * 侧栏点一下就打开，不存在「进来不知道干什么」的问题。
   */
}

export function backToProjects() {
  state.view = 'projects';
  state.response = null;
  state.error = '';
}

export function openEnvPage() {
  state.view = 'environments';
}

export function closeEnvPage() {
  state.view = state.activeProjectId ? 'workspace' : 'projects';
}

export function setNav(nav) {
  state.nav = nav;
}

/** 工作台里换一个工具。只记「看哪个」，工具自己不落任何数据 */
export function selectWorkbenchTool(id) {
  state.workbenchTool = id;
}

// ------------------------------- 设置页 -------------------------------

export function openSettings() {
  state.view = 'settings';
}

export function closeSettings() {
  state.view = state.activeProjectId ? 'workspace' : 'projects';
}

export function toggleNav() {
  state.showNav = !state.showNav;
}

// ------------------------------- 页内确认弹层 -------------------------------

/**
 * 统一装配弹层内容。
 *
 * 每个字段都给默认值：state.confirm 是整体替换的，少写一个字段就会变成
 * undefined 传到组件里，那些 v-if 判断跟着一起失效。
 */
function setConfirm(patch) {
  state.confirm = {
    open: true, title: '', message: '', confirmText: '确认删除',
    thirdText: '', hideCancel: false, alertOnly: false, withInput: false,
    inputPlaceholder: '', inputValue: '',
    withSelect: false, selectOptions: [], selectValue: '',
    action: null, thirdAction: null,
    ...patch,
  };
}

export function askConfirm(title, message, action, confirmText = '确认删除') {
  setConfirm({ title, message, action, confirmText });
}

export function askAlert(title, message) {
  setConfirm({ title, message, confirmText: '知道了', alertOnly: true });
}

/**
 * 让用户先输入一个名字，确定后再执行 action(name)。
 *
 * 确认按钮默认写「创建」—— 这是这个弹层最常见的用途（新建项目 / 目录 / 方案…）。
 * 而在**已有的东西**上编辑（改名、复制一份）按钮统一写「保存」：那不是在创建新的
 * 什么，就是把手填的这个名字存下来，写「创建」会让人以为又要点出一份。
 */
export function askInput(
  title, message, placeholder, defaultValue, action, confirmText = '创建'
) {
  setConfirm({
    title, message, action, confirmText, withInput: true,
    inputPlaceholder: placeholder, inputValue: defaultValue || '',
  });
}

export function closeConfirm() {
  state.confirm = { ...state.confirm, open: false, action: null, thirdAction: null };
}

export function confirmYes(value) {
  const { action, withInput, withSelect } = state.confirm;
  closeConfirm();
  // 输入框和下拉选择都把「选了什么」交给 action；别的弹层不需要参数
  if (typeof action === 'function') action(withInput || withSelect ? value : undefined);
}

/** 第三个按钮（只在「有未保存的改动」那类弹层里出现）。 */
export function confirmThird() {
  const { thirdAction } = state.confirm;
  closeConfirm();
  if (typeof thirdAction === 'function') thirdAction();
}

// ------------------------------- 标签页 -------------------------------

/** 在项目里找出这个请求和它的下标（项目只有一份请求数组了，不用再翻）。 */
function locate(requestId) {
  const requests = allRequests.value;
  const index = requests.findIndex((r) => r.id === requestId);
  if (index < 0) return null;
  return { index, request: requests[index] };
}

/** 离开当前标签页之前，把响应这几样快照下来 —— 它们不持久化，跟着标签页走。 */
function captureActive() {
  const tab = activeTab.value;
  if (!tab) return;
  tab.response = state.response;
  tab.error = state.error;
  tab.assertionResults = state.assertionResults;
  tab.scriptRun = state.scriptRun;
}

function restoreActive(tab) {
  state.response = tab ? tab.response : null;
  state.error = tab ? tab.error : '';
  state.assertionResults = tab ? tab.assertionResults : [];
  state.scriptRun = tab ? tab.scriptRun : null;
}

export function activateTab(id) {
  if (state.activeTabId === id) return;
  captureActive();
  state.activeTabId = id;
  const tab = activeTab.value;
  state.activeRequestId = tab ? tab.requestId : '';
  restoreActive(tab);
}

/** 一个空白请求。字段顺序固定 —— 脏值比较是整个对象转字符串，顺序得稳。 */
function blankRequest(dirId = '') {
  return {
    id: 'req-' + uid(),
    name: '新建请求',
    method: 'GET',
    /** 挂在哪个目录下（空串 = 根，也就是「未分组」那一栏）。同级次序由 sort 决定 */
    dirId: dirId || '',
    // 默认不带结尾斜杠：粘贴具体路径时基本都是 / 开头的，
    // 这里留斜杠就会拼成 {{baseUrl}}//users 这种
    url: '{{baseUrl}}',
    params: [],
    /**
     * URL 里的 {路径参数} 填什么。行是 { key, value }，key 跟着 URL 走 ——
     * 界面上那几行是从 URL 扫出来的，不是让用户手加的，所以这里可能比 URL 里
     * 现有的多（改错了 URL 再改回去，填过的值还在）。多出来的不影响发送。
     */
    pathParams: [],
    // 不预置 Content-Type：发送时会按 body 格式自动补一个。
    // 固定写死反而会在切成 XML / 表单之后对不上
    headers: [],
    body: '',
    bodyType: 'json',
    bodyForm: [],
    script: '',
    /** 后置脚本：响应回来之后跑，多一个 response 形参（见 script.js） */
    afterScript: '',
    assertions: [],
    extracts: [],
  };
}

function pushTab(request, isNew, chooseDir = false) {
  const draft = clone(request);
  const tab = {
    id: 'tab-' + uid(),
    requestId: draft.id,
    isNew,
    /**
     * 保存时要先问「存到哪个目录」。
     *
     * 只有凭空新建的（标签条那颗 ＋ 新建的请求）才是 true —— 它还没定落点。
     * 从某个目录的 ＋ 建的，落点就是那个目录，不用再问。
     */
    chooseDir: !!chooseDir && isNew,
    draft,
    baseline: clone(draft),
    response: null, error: '', assertionResults: [], scriptRun: null,
  };
  state.tabs.push(tab);
  activateTab(tab.id);
  return tab;
}

/** 打开一个已存在的请求。已经开着就切过去，不重复开。 */
export function openRequest(requestId) {
  const opened = state.tabs.find((t) => t.requestId === requestId);
  if (opened) {
    activateTab(opened.id);
    return;
  }
  const found = locate(requestId);
  if (!found) return;
  pushTab(found.request, false);
}

/** 丢掉某个标签页，不弹提示。请求 / 目录 / 项目被删时走这条路。 */
function dropTab(id) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;

  const wasActive = state.activeTabId === id;
  state.tabs.splice(index, 1);
  if (!wasActive) return;

  // 优先接右边那个（和浏览器一致），没有就退左边
  const next = state.tabs[index] || state.tabs[index - 1] || null;
  state.activeTabId = next ? next.id : '';
  state.activeRequestId = next ? next.requestId : '';
  restoreActive(next);
}

/** 把这些请求的标签页全收掉。 */
function dropTabsOf(requestIds) {
  const doomed = state.tabs.filter((t) => requestIds.includes(t.requestId)).map((t) => t.id);
  doomed.forEach(dropTab);
}

/** 关掉全部标签页，回到「什么都没打开」。 */
function resetTabs() {
  state.tabs = [];
  state.activeTabId = '';
  state.activeRequestId = '';
  restoreActive(null);
}

/**
 * 真的把改动写进项目 —— **这是唯一会改到持久化数据的入口**。
 *
 * 写回之后基准跟着更新，标签页随即回到「干净」状态。draft 本身不换对象：
 * 换了编辑器拿到的 prop 就是另一个引用，输入框会闪一下。
 *
 * @param {string} id 标签页 id
 * @param {string} [dirId] 新请求落在哪个目录；不给就用草稿上那个
 */
function saveTabNow(id, dirId) {
  const tab = state.tabs.find((t) => t.id === id);
  const project = activeProject.value;
  if (!tab || !project) return;
  if (!Array.isArray(project.requests)) project.requests = [];

  if (tab.isNew) {
    // 目录由外面定（「保存到哪个目录」那一步问来的）；不给就照草稿上的
    if (dirId !== undefined) tab.draft.dirId = dirId || '';
    // 新请求落到同级末尾：sort 得在这儿补 —— 序号取决于落库那一刻的同级现状
    if (typeof tab.draft.sort !== 'number') {
      tab.draft.sort = nextSort(project, tab.draft.dirId || '');
    }
    project.requests.push(clone(tab.draft));
    tab.isNew = false;
    tab.chooseDir = false;
    tab.baseline = clone(tab.draft);
    return;
  }

  const index = project.requests.findIndex((r) => r.id === tab.requestId);
  if (index < 0) return;
  // 原地赋值，不换对象 —— 换了的话，凡事先拿到过这个请求的地方
  // （列表里正渲染着的那一行、别处缓存的引用）全成了悬空引用。
  // 之所以敢直接 assign：右边是整个深拷贝，params / headers 都是新数组，
  // 不会和 draft 共享同一份
  Object.assign(project.requests[index], clone(tab.draft));
  tab.baseline = clone(tab.draft);
}

/**
 * 问一句「存到哪个目录」。
 *
 * 只有**凭空新建**的那些请求会走这条路 —— 它们是还没定落点就先开着的，保存时
 * 才让人挑。从某个目录的 ＋ 建的，落点早就定了，不该再问一遍。
 */
function askSaveDir(tab, after) {
  // 目录按缩进列出来，层级一眼看得出；「未分组」= 顶层
  const options = [{ value: '', label: '未分组（顶层）' }];
  (interfaceTree.value.rows || []).forEach((row) => {
    if (row.kind !== 'dir') return;
    options.push({ value: row.id, label: '　'.repeat(Math.max(0, row.depth - 1)) + row.name });
  });

  setConfirm({
    title: '保存到哪个目录',
    message: `「${tab.draft.name}」要存在哪个目录里？`,
    confirmText: '保存',
    withSelect: true,
    selectOptions: options,
    selectValue: tab.draft.dirId || '',
    action: (dirId) => {
      saveTabNow(tab.id, dirId);
      // 「保存并关闭」那条路：存完才关 —— 先关的话，等答案回来标签页已经没了
      if (typeof after === 'function') after();
    },
  });
}

/**
 * 保存标签页（编辑器那个「保存」、关闭前那个「保存并关闭」）。
 *
 * 凭空新建的请求先问目录，答案回来才落库 —— 取消（点弹层外面 / Esc）就什么都没
 * 发生：标签页还开着，改动也还在。
 */
export function saveTab(id = state.activeTabId) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.isNew && tab.chooseDir) {
    askSaveDir(tab);
    return;
  }
  saveTabNow(id);
}

/** 批量保存走这个：不再逐个问目录（和「汇总问一次」同一个道理） */
function saveTabQuiet(id) {
  saveTabNow(id);
}

/**
 * 关标签页。有未提交的改动就先问一句 —— 三个出口缺一不可：
 *   只有「保存 / 取消」   → 想丢弃改动时无路可走
 *   只有「保存 / 不保存」 → 少一个反悔的机会
 */
export function closeTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;

  if (!tabIsDirty(tab)) {
    dropTab(id);
    return;
  }

  setConfirm({
    title: '有未保存的改动',
    message: `「${tab.draft.name}」还有改动没保存，关掉这个标签页就会丢掉。`,
    confirmText: '保存并关闭',
    thirdText: '不保存',
    // 取消够得着（点弹层外面 / Esc），按钮区只留两个决定
    hideCancel: true,
    action: () => {
      // 凭空新建的还得先问目录 —— 那种情况下「存」要等答案回来才发生，
      // 所以关也得排在后面，不能在这儿直接 dropTab
      const tab = state.tabs.find((t) => t.id === id);
      if (tab && tab.isNew && tab.chooseDir) {
        askSaveDir(tab, () => dropTab(id));
        return;
      }
      // 先存再关。存完标签页可能已经被别的操作收走了，所以全程认 id
      saveTab(id);
      dropTab(id);
    },
    thirdAction: () => dropTab(id),
  });
}

/**
 * 关掉一批标签页：不传 `exceptId` 就全关，传了就保留它（「关闭其他」）。
 *
 * 有未保存的改动时**汇总问一次**（列出名字），不是挨个问 —— 一次关十几个的话
 * 逐个确认太折磨人；而「取消」这条路本来就在（点弹层外面 / Esc），所以弹层只有
 * 「全部保存并关闭 / 不保存」两个按钮。
 */
export function closeAllTabs(exceptId = '') {
  const targets = state.tabs.filter((t) => t.id !== exceptId);
  if (!targets.length) return;

  const dirty = targets.filter(tabIsDirty);
  if (!dirty.length) {
    targets.forEach((t) => dropTab(t.id));
    return;
  }

  const names = dirty.map((t) => t.draft.name).join('、');
  setConfirm({
    title: '有未保存的改动',
    message: `有 ${dirty.length} 个标签页还没保存（${names}），关掉就会丢掉这些改动。`,
    confirmText: '全部保存并关闭',
    thirdText: '不保存',
    hideCancel: true,
    // 这两个动作都在**点下去那一刻**重新取一遍列表：确认框开着的时候，
    // 标签页可能已经被别的操作收走了
    // 批量保存不再逐个问目录（和「汇总问一次」同一个道理），落草稿上那个目录
    action: () => {
      state.tabs
        .filter((t) => t.id !== exceptId)
        .forEach((t) => {
          saveTabQuiet(t.id);
          dropTab(t.id);
        });
    },
    thirdAction: () => {
      state.tabs.filter((t) => t.id !== exceptId).forEach((t) => dropTab(t.id));
    },
  });
}

// ------------------------------- 项目 / 目录 / 请求 -------------------------------

export function createProject() {
  askInput('新建项目', '给这个项目起个名字：', '项目名称', '', (name) => {
    const project = {
      id: 'prj-' + uid(),
      name: (name || '').trim() || `未命名项目 ${state.projects.length + 1}`,
      description: '还没有描述',
      // 接口树：目录 + 请求（原来那层「集合」已经删掉）
      dirs: [],
      requests: [],
      plans: [],
    };
    state.projects.push(project);
    openProject(project.id);
  });
}

export function removeProject(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) return;
  askConfirm(
    '删除项目',
    `确定删除项目「${project.name}」吗？它下面的 ${(project.dirs || []).length} 个目录和 ${(project.requests || []).length} 个请求都会一起删掉。`,
    () => {
      const index = state.projects.findIndex((p) => p.id === id);
      if (index < 0) return;

      const planIds = new Set((project.plans || []).map((pl) => pl.id));
      state.projects.splice(index, 1);

      // 方案的历次运行按方案 id 存在 state.planRuns（**会落盘**）—— 项目都没了，
      // 别让这些孤儿记录一直留在文件里
      planIds.forEach((planId) => {
        delete state.planRuns[planId];
        delete state.planRunCache[planId];
      });

      // 正在跑的正好是这个项目里的方案：先叫停，否则跑完还会往回收尾写结果
      if (state.planRunningId && planIds.has(state.planRunningId)) {
        runtime.planStop = true;
        runtime.planAbort?.abort();
      }

      if (state.activeProjectId === id) {
        state.activeProjectId = '';
        state.view = 'projects';
        resetTabs();
        resetPlanTabs();
      }
    }
  );
}

// ------------------------------- 项目文件：完整备份 -------------------------------
//
// 「导出 OpenAPI」是给别的工具看的接口文档，装不下方案、测试数据这些 PostMax
// 自己的东西。要整份搬走一个项目（换台机器、留个档），拿它当备份会「看起来成功、
// 其实少了一半」。这里另开一条通道：项目 JSON。
//
// 文件里的 id 原样带出，**导入时全部换新**（见 cloneProjectWithNewIds）：
// 历次运行记在 state.planRuns[方案 id] 上，两份项目共用 id 就会共享运行记录。

// 项目文件的格式标记 / 版本、以及读入时的判定与提示，都在 projectFile.js
// （那边是纯函数，能直接写测试）

/** 最多带多少条历史记录（state.history 本身也是 200 条封顶） */
const PROJECT_FILE_HISTORY_LIMIT = 200;

/**
 * 深拷一个项目，并把里面**会互相引用的 id 全部换新**，引用关系跟着重指。
 *
 * 请求 id 要换：方案步骤的 `sourceId`（以及步骤里那份请求副本的 id）指着它；
 * 方案 id 要换：历次运行记在 `state.planRuns[方案 id]` 上；
 * 目录 / 方案目录 id 要换：请求的 `dirId`、子目录的 `parentId`、方案的 `groupId` 指着它。
 *
 * @returns {{project:Object, planIdMap:Object, requestIdMap:Object}}
 */
function cloneProjectWithNewIds(source) {
  const dirIdMap = new Map();
  // 请求 / 方案的映射是**普通对象**（外面按下标取，和 planIdMap 一个用法）——
  // Map 只在下标取不到值，这个坑已经踩过一次
  const requestIdMap = {};
  const planGroupIdMap = new Map();

  const oldDirs = source.dirs || [];
  const dirs = oldDirs.map((dir) => {
    const id = 'dir-' + uid();
    dirIdMap.set(dir.id, id);
    return { ...clone(dir), id };
  });
  // 父级等映射建好再指，免得依赖遍历顺序
  dirs.forEach((dir, i) => {
    const oldParent = oldDirs[i].parentId || '';
    dir.parentId = oldParent && dirIdMap.has(oldParent) ? dirIdMap.get(oldParent) : '';
  });

  const requests = (source.requests || []).map((request) => {
    const copy = clone(request);
    copy.id = 'req-' + uid();
    requestIdMap[request.id] = copy.id;
    copy.dirId = request.dirId && dirIdMap.has(request.dirId) ? dirIdMap.get(request.dirId) : '';
    return copy;
  });

  const planGroups = (source.planGroups || []).map((group) => {
    const id = 'pg-' + uid();
    planGroupIdMap.set(group.id, id);
    return { ...clone(group), id };
  });

  /** 步骤里那份请求副本：id / dirId 跟着换，否则「同步源头」会认到原来那一份 */
  const remapStepRequest = (request) => {
    if (!request || typeof request !== 'object') return request;
    const copy = clone(request);
    if (copy.id && requestIdMap[copy.id]) copy.id = requestIdMap[copy.id];
    copy.dirId = copy.dirId && dirIdMap.has(copy.dirId) ? dirIdMap.get(copy.dirId) : '';
    return copy;
  };

  const planIdMap = {};
  const plans = (source.plans || []).map((plan) => {
    const copy = clone(plan);
    copy.id = 'plan-' + uid();
    planIdMap[plan.id] = copy.id;
    copy.groupId =
      plan.groupId && planGroupIdMap.has(plan.groupId) ? planGroupIdMap.get(plan.groupId) : '';
    copy.steps = (copy.steps || []).map((step) => ({
      ...step,
      id: 'step-' + uid(),
      sourceId: step.sourceId && requestIdMap[step.sourceId] ? requestIdMap[step.sourceId] : '',
      request: remapStepRequest(step.request),
    }));
    return copy;
  });

  return {
    project: { ...clone(source), id: 'prj-' + uid(), dirs, requests, plans, planGroups },
    planIdMap,
    requestIdMap,
  };
}

/**
 * 复制项目：整份深拷一份，id 全部换新，历次运行记录一起跟过去。
 *
 * 会话级的运行结果缓存（planRunCache，带完整响应体、本来就不落盘）不带。
 */
export function duplicateProject(projectId) {
  const source = state.projects.find((p) => p.id === projectId);
  if (!source) return;

  askInput('复制项目', '新项目的名字：', '项目名称', `${source.name} copy`, (name) => {
    const { project, planIdMap } = cloneProjectWithNewIds(source);
    project.name = (name || '').trim() || `${source.name} copy`;
    state.projects.push(project);

    Object.entries(planIdMap).forEach(([oldId, newId]) => {
      if (state.planRuns[oldId]) state.planRuns[newId] = clone(state.planRuns[oldId]);
    });
  }, '保存');
}

/**
 * 导出一个项目的完整 JSON：接口树（含目录 / 次序）+ 方案（含步骤 / 测试数据 /
 * 运行设置）+ 历次运行记录 + 该项目的历史。
 *
 * 这是「备份 / 换台机器」的通道，和「导出 OpenAPI」（给别的工具看的接口文档）
 * 不是一回事 —— 后者装不下方案和数据。
 */
export function exportProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;

  const planRuns = {};
  (project.plans || []).forEach((plan) => {
    if (state.planRuns[plan.id]) planRuns[plan.id] = clone(state.planRuns[plan.id]);
  });

  const payload = {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    project: clone(project),
    planRuns,
    history: state.history
      .filter((h) => h.projectId === project.id)
      .slice(0, PROJECT_FILE_HISTORY_LIMIT)
      .map(clone),
  };

  const filename = `${safeFileName(project.name) || 'project'}.posmax.json`;
  downloadText(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
}

/** 重名就加序号 —— 导入是「只新增」，不覆盖任何现有项目 */
function uniqueProjectName(base) {
  const taken = new Set(state.projects.map((p) => p.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/**
 * 导入项目文件。
 *
 * **只新增，不覆盖**：覆盖现有项目没法撤销，而这个入口多半就是用来「换台机器接着干」
 * 的 —— 宁可多出一个带后缀的项目，也不要把手头那份悄悄换掉。项目内所有 id 换新，
 * 运行记录与历史按映射落到新 id 上。
 */
export async function importProjectFile(file) {
  try {
    // 「是不是项目文件」的判定、以及判断不出来时给用户看的那句提示，都在 projectFile.js
    const payload = parseProjectFile(await file.text());
    const raw = payload.project;
    // 老格式先并成接口树，再换 id（换 id 那套只认 dirs / requests）
    normalizeProject(raw);

    const { project, planIdMap, requestIdMap } = cloneProjectWithNewIds(raw);
    project.name = uniqueProjectName(String(raw.name).trim());
    state.projects.push(project);

    Object.entries(payload.planRuns || {}).forEach(([oldId, runs]) => {
      const newId = planIdMap[oldId];
      if (newId && Array.isArray(runs)) state.planRuns[newId] = clone(runs);
    });

    const history = (Array.isArray(payload.history) ? payload.history : [])
      .filter((h) => h && typeof h === 'object')
      .map((h) => {
        const copy = clone(h);
        copy.id = 'h-' + uid();
        copy.projectId = project.id;
        if (copy.request?.id && requestIdMap[copy.request.id]) {
          copy.request.id = requestIdMap[copy.request.id];
        }
        return copy;
      });
    if (history.length) {
      state.history = [...history, ...state.history].slice(0, PROJECT_FILE_HISTORY_LIMIT);
    }

    askAlert(
      '导入完成',
      `项目「${project.name}」已导入：${(project.dirs || []).length} 个目录、${(project.requests || []).length} 个请求、${(project.plans || []).length} 个方案。`
    );
  } catch (e) {
    askAlert('导入项目失败', (e && e.message) || String(e));
  }
}

/**
 * 新建请求。
 *
 * 延迟创建：只开一个标签页，项目里什么都不加，点保存才真正落库。
 * 这样「建完反悔」关掉标签页就干净了，不会在侧栏里留个空请求；
 * 也正因如此，新建的标签页关闭时提示「有未保存的改动」才名副其实。
 *
 * @param {string} dirId 挂到哪个目录下；空串 = 根（「未分组」那一栏）
 * @param {boolean} chooseDir 保存时先弹「存到哪个目录」（凭空新建的那些用）
 */
export function createRequest(dirId = '', chooseDir = false) {
  if (!activeProject.value) return;
  pushTab(blankRequest(dirId), true, chooseDir);
}

/** 空项目时的引导：直接加第一个请求（挂根上，也就是「未分组」）。 */
export function createFirstRequest() {
  if (!activeProject.value) return;
  createRequest('');
}

export function removeRequest(requestId) {
  const project = activeProject.value;
  const found = locate(requestId);
  if (!project || !found) return;

  askConfirm('删除请求', `确定删除请求「${found.request.name}」吗？`, () => {
    const at = project.requests.findIndex((r) => r.id === requestId);
    if (at < 0) return;
    project.requests.splice(at, 1);
    // 请求都没了，标签页留着是空壳。这里不再弹提示 ——
    // 上一步的删除确认问的就是「确定要丢掉它吗」
    dropTabsOf([requestId]);
  });
}

/**
 * 批量删除请求（侧栏勾选后走这条）。
 *
 * 勾选是项目级的，选中的散在目录树各处 —— 所以按 id 在项目的请求数组里扫一遍。
 * 删之前问一次，问的就是这几个。
 */
export function removeRequests(requestIds) {
  const ids = new Set((requestIds || []).filter(Boolean));
  const project = activeProject.value;
  if (!ids.size || !project) return;

  askConfirm('删除请求', `确定删除选中的 ${ids.size} 个请求吗？`, () => {
    // 原地改这个数组（不换引用）：别处拿的都是同一个数组
    const kept = project.requests.filter((r) => !ids.has(r.id));
    project.requests.splice(0, project.requests.length, ...kept);
    // 请求都没了，标签页留着是空壳
    dropTabsOf([...ids]);
    /*
     * 勾选在这儿清 —— 不能在调用方清：确认框是异步的，先清掉的话，
     * 点「取消」就等于把攒好的这一批选择白丢了（还得重新一个个勾回来）。
     * 删掉的 id 读的时候本来也会被滤掉，这里清的是「剩下的那点残留」。
     */
    clearPickedRequests();
  });
}

/** 复制某个请求：插在它下面，名字加 copy，并切到副本上。 */
export function duplicateRequest(requestId) {
  const project = activeProject.value;
  if (!project) return;

  const index = project.requests.findIndex((r) => r.id === requestId);
  if (index < 0) return;

  // 请求是纯数据，深拷贝一份再换掉 id 和名字
  const source = project.requests[index];
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = 'req-' + uid();
  copy.name = source.name + 'copy';
  copy.dirId = source.dirId || '';
  // 排到原请求紧后面：先给个夹在中间的 sort，再把同级重排一遍
  copy.sort = (source.sort || 0) + 0.5;

  // 副本直接落库（和新建不同）：复制是个明确的「造一个出来」的动作，
  // 复制完侧栏里就该看到它，不该再等一次保存
  project.requests.splice(index + 1, 0, copy);
  renumber(project, copy.dirId);
  openRequest(copy.id);
}

/** 侧栏点一个请求：打开它的标签页。 */
export function selectRequest(id) {
  openRequest(id);
}

/**
 * 重命名请求。
 *
 * 名字只能从侧栏改（编辑器里没有名字输入框），所以它不走「未提交的编辑」那套：
 * 在列表里改完就该立刻看到、立刻存下来。
 *
 * 但**必须**顺手把标签页里那份 draft 和它的基准一起改掉。draft 是打开标签页时
 * 拷贝出来的，里面揣着旧名字；不同步的话，用户改完名接着编辑 body、一点保存，
 * draft 就会把旧名字写回去 —— 改名被无声地盖掉。基准也要跟着改，
 * 否则这次同步会让标签页凭空变脏。
 */
export function renameRequest({ requestId, name }) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;

  const found = locate(requestId);
  if (found) found.request.name = trimmed;

  const tab = state.tabs.find((t) => t.requestId === requestId);
  if (tab) {
    tab.draft.name = trimmed;
    tab.baseline.name = trimmed;
  }
}

// ------------------------------- 目录 -------------------------------
//
// 项目下就是一棵目录树。目录可以无限嵌套（目录里还能建目录），请求落在任意目录下
// 或根上（根上的归到「未分组」那一栏）。目录只负责整理，删掉目录不删里面的东西。
//
// 拖拽是整棵树里通用的：请求和目录能拖到任意目录下，也能在同级里拖拽调整次序。

/**
 * 把某个请求的目录归属与同级次序同步进它开着的标签页（draft 和基准一起）。
 *
 * draft 是开标签页时拷出来的，揣着旧的 dirId / sort；不同步的话，之后再点保存
 * 就会拿旧 draft 把位置写回去 —— 刚拖好的位置又跳回去。基准一起改才不凭空变脏。
 */
function syncTabPos(request) {
  const tab = state.tabs.find((t) => t.requestId === request.id);
  if (!tab) return;
  const dirId = request.dirId || '';
  const sort = typeof request.sort === 'number' ? request.sort : 0;
  tab.draft.dirId = dirId;
  tab.baseline.dirId = dirId;
  tab.draft.sort = sort;
  tab.baseline.sort = sort;
}

/** 新建目录。parentId 为空 = 建在项目根上（顶层目录）；给了就是它的子目录。 */
export function createDir(parentId = '') {
  const project = activeProject.value;
  if (!project) return;
  askInput('新建目录', '给这个目录起个名字：', '目录名称', '', (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    if (!Array.isArray(project.dirs)) project.dirs = [];
    project.dirs.push({
      id: 'dir-' + uid(),
      name: trimmed,
      parentId: parentId || '',
      sort: nextSort(project, parentId || ''),
    });
  });
}

export function renameDir(dirId) {
  const dir = projectDirs.value.find((d) => d.id === dirId);
  if (!dir) return;

  askInput('重命名目录', '给这个目录起个新名字：', '目录名称', dir.name, (name) => {
    const trimmed = (name || '').trim();
    if (trimmed) dir.name = trimmed;
  }, '保存');
}

/**
 * 删掉一个目录。
 *
 * **里面的东西一个都不删**：子目录和请求都上移到它的父级 —— 目录是整理用的，
 * 顺手删掉一堆请求是最不该有的意外。删除确认里也照实说。
 */
export function removeDir(dirId) {
  const project = activeProject.value;
  const dir = projectDirs.value.find((d) => d.id === dirId);
  if (!project || !dir) return;

  const n = countRequestsUnder(project, dirId);
  askConfirm(
    '删除目录',
    n
      ? `确定删除目录「${dir.name}」吗？里面的 ${n} 个请求不会删，会移到上一级。`
      : `确定删除目录「${dir.name}」吗？`,
    () => {
      const parent = dir.parentId || '';
      // 子目录、请求都提到父级
      (project.dirs || []).forEach((d) => {
        if (d.parentId === dirId) d.parentId = parent;
      });
      const affected = (project.requests || []).filter((r) => r.dirId === dirId);
      affected.forEach((r) => {
        r.dirId = parent;
      });
      // 原地改数组，不换引用：别处拿的都是同一个
      const kept = (project.dirs || []).filter((d) => d.id !== dirId);
      project.dirs.splice(0, project.dirs.length, ...kept);
      renumber(project, parent);
      affected.forEach(syncTabPos);
      state.expandedDirs = state.expandedDirs.filter((id) => id !== dirId);
    }
  );
}

/**
 * 展开 / 收起一个目录。
 *
 * 只动**这一个**目录：子目录各有各的状态，默认都还是折着的，
 * 所以点开一层就只看到一层，不会整棵子树一起铺开。
 */
export function toggleDir(dirId) {
  const list = state.expandedDirs;
  const index = list.indexOf(dirId);
  if (index >= 0) list.splice(index, 1);
  else list.push(dirId);
}

/** 「未分组」那一栏展开 / 收起。整棵树只有这一栏，一个布尔就够。 */
export function toggleUngrouped() {
  state.expandedUngrouped = !state.expandedUngrouped;
}

/**
 * 移动一批节点（请求或目录）到目标位置。
 *
 *   nodes          [{ kind:'req'|'dir', id }]
 *   targetParentId 落到哪个目录下（空串 = 根，也就是「未分组」）
 *   beforeId/afterId  插到哪个同级兄弟的前 / 后；都不给就排到末尾
 *
 * 单个拖拽、批量拖拽、拖拽排序全走这一个入口 —— 落点行为只有一套。
 */
export function moveNodes({
  nodes,
  targetParentId = '',
  beforeId = '',
  afterId = '',
}) {
  const scope = activeProject.value;
  if (!scope) return;
  if (!Array.isArray(scope.dirs)) scope.dirs = [];
  if (!Array.isArray(scope.requests)) scope.requests = [];

  const parent = targetParentId || '';
  const moved = [];

  (nodes || []).forEach(({ kind, id }) => {
    if (!kind || !id) return;

    if (kind === 'dir') {
      const dir = scope.dirs.find((d) => d.id === id);
      if (!dir) return;
      // 不能把目录拖进它自己或它的子孙里，那会把树接成一个环
      if (parent && (parent === id || subtreeDirIds(scope, id).has(parent))) return;

      // 连整棵子树一起摘下来再挂到新位置（形状不变，只是父级换了）
      const dirIds = subtreeDirIds(scope, id);
      const movingDirs = scope.dirs.filter((d) => dirIds.has(d.id));
      const movingReqs = scope.requests.filter((r) => dirIds.has(r.dirId));
      scope.dirs.splice(0, scope.dirs.length, ...scope.dirs.filter((d) => !dirIds.has(d.id)));
      scope.requests.splice(0, scope.requests.length, ...scope.requests.filter((r) => !dirIds.has(r.dirId)));

      dir.parentId = parent;
      scope.dirs.push(...movingDirs);
      scope.requests.push(...movingReqs);
      moved.push({ kind: 'dir', node: dir });
      return;
    }

    const index = scope.requests.findIndex((r) => r.id === id);
    if (index < 0) return;
    const [request] = scope.requests.splice(index, 1);
    request.dirId = parent;
    scope.requests.push(request);
    moved.push({ kind: 'req', node: request });
  });

  if (!moved.length) return;

  // 把移动的节点整体插到目标位置，再按最终顺序重编号。
  // 落点下标在**含被移动节点的原列表**上算，再换算到去掉它们的基线里 ——
  // 否则「拖到某个兄弟前」时，那个兄弟若正是被拖的节点，会算错位置。
  const entries = siblingEntries(scope, parent);
  const movedIds = new Set(moved.map((m) => m.node.id));
  let at = entries.length;
  if (beforeId) {
    const i = entries.findIndex((e) => e.node.id === beforeId);
    if (i >= 0) at = i;
  } else if (afterId) {
    const i = entries.findIndex((e) => e.node.id === afterId);
    if (i >= 0) at = i + 1;
  }
  const rest = entries.filter((e) => !movedIds.has(e.node.id));
  let restIndex = 0;
  for (let i = 0; i < at && i < entries.length; i++) {
    if (!movedIds.has(entries[i].node.id)) restIndex++;
  }
  // 位置定下来后统一重编号：**同一父级下的所有兄弟**都要同步标签页，
  // 不只是被拖的那几个（受影响的兄弟若开着标签页，同样会被旧 sort 写回）
  const ordered = [...rest.slice(0, restIndex), ...moved, ...rest.slice(restIndex)];
  applyOrder(ordered);
}

// ------------------------------- 自动化方案 -------------------------------
//
// 方案存的是请求的**副本**：在方案里改一步，项目里那个请求不受影响。
// 每步记着 sourceId（来自项目里的哪个请求），「同步」靠它把项目里的最新版拉过来。
//
// 方案挂在 project 下，跟着 projects 一起持久化，不用动 PERSISTED_KEYS。

/** 当前项目的方案列表。老存档里没有 plans 字段，兜一下。 */
export const plans = computed(() => activeProject.value?.plans || []);

export const activePlanTab = computed(
  () => state.planTabs.find((t) => t.id === state.activePlanTabId) || null
);

/** 正在编辑的那份方案。左栏和右侧操作的都是它，点保存才写回 plans。 */
export const planDraft = computed(() => activePlanTab.value?.draft || null);

/**
 * 某个方案标签页有没有未保存的改动。左栏列表和标签页上的点都用它。
 *
 * 比较是全量 stringify，而 draft 里挂着整张测试数据表 —— 方案编辑的**每个按键**
 * 都会让它重算，等于每键把整份方案连表序列化两遍，比打字本身还贵。两个手段：
 *   · toRaw 绕开响应式代理 —— 不然 stringify 会把每个嵌套属性都注册成依赖，
 *     上面那句话照样成立；
 *   · 比较结果挂在防抖版本号上（200ms）：手停了才算，「未保存」晚一点点出现。
 * 切标签页 / 点保存走的是另一条路（activePlanTab / baseline 变化立即重算）。
 */
const planDirtyTick = ref(0);
let planDirtyTimer = 0;
watch(
  () => [planDraft.value, activePlanTab.value?.baseline],
  () => {
    clearTimeout(planDirtyTimer);
    planDirtyTimer = setTimeout(() => (planDirtyTick.value += 1), 200);
  },
  { deep: true }
);

export const planTabIsDirty = (tab) => {
  void planDirtyTick.value;
  if (!tab) return false;
  return JSON.stringify(toRaw(tab.draft)) !== JSON.stringify(toRaw(tab.baseline));
};

export const planIsDirty = computed(() => planTabIsDirty(activePlanTab.value));

/**
 * 左栏那份扁平方案列表。
 *
 * 名字取的是**草稿**那份，不是 plans 里已保存的 —— 否则「重命名」和
 * 「从接口树添加接口」之后左栏纹丝不动，人会以为没生效。没开标签页就没有草稿，
 * 用已保存的那份（和它一致）。
 */
export const planTree = computed(() =>
  plans.value.map((plan) => {
    const tab = state.planTabs.find((t) => t.planId === plan.id);
    const draft = tab ? tab.draft : plan;
    return {
      id: plan.id,
      name: draft.name,
      steps: draft.steps || [],
      groupId: draft.groupId || '',
      dirty: planTabIsDirty(tab),
    };
  })
);

/**
 * 左栏的两级树：目录 → 方案。
 *
 * `ungrouped` 单独一栏而不是塞进某个目录：老方案没有 `groupId` 字段，
 * 新方案默认也不进任何目录 —— 自动归到「默认目录」只会让那个目录变成大杂烩。
 *
 * 方案没开标签页时 `planTree` 里也有它（走已保存那份），所以这里不用补。
 */
export const planGroupTree = computed(() => {
  const list = planTree.value;
  const groups = activeProject.value?.planGroups || [];
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  const ungrouped = [];

  list.forEach((plan) => {
    const bucket = plan.groupId && byGroup.has(plan.groupId) ? byGroup.get(plan.groupId) : null;
    // 目录被删掉、方案还指着它的那种，也算未分组 —— 不能让方案凭空消失
    (bucket || ungrouped).push(plan);
  });

  return {
    groups: groups.map((g) => ({
      ...g,
      plans: byGroup.get(g.id),
      collapsed: state.collapsedPlanGroups.includes(g.id),
    })),
    ungrouped,
  };
});

/** 把方案归到某个目录下（空串 = 移出目录） */
export function setPlanGroup(planId, groupId) {
  const plan = plans.value.find((p) => p.id === planId);
  if (!plan) return;
  plan.groupId = groupId || '';

  // 开着标签页的话草稿要跟上，否则之后再点保存会把旧值写回去；
  // **基准也要跟上** —— 归到哪个目录是「整理」，不是方案内容的改动，
  // 只改 draft 会让标签页凭空变脏
  const tab = state.planTabs.find((t) => t.planId === planId);
  if (tab) {
    tab.draft.groupId = plan.groupId;
    tab.baseline.groupId = plan.groupId;
  }
}

export function createPlanGroup() {
  askInput('新建目录', '给这个目录起个名字：', '目录名称', '', (name) => {
    const project = activeProject.value;
    if (!project) return;
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    if (!project.planGroups) project.planGroups = [];
    project.planGroups.push({ id: 'pg-' + uid(), name: trimmed });
  });
}

export function renamePlanGroup(groupId) {
  const project = activeProject.value;
  const group = (project?.planGroups || []).find((g) => g.id === groupId);
  if (!group) return;

  askInput('重命名目录', '给这个目录起个新名字：', '目录名称', group.name, (name) => {
    const trimmed = (name || '').trim();
    if (trimmed) group.name = trimmed;
  }, '保存');
}

/**
 * 删掉一个目录。
 *
 * **里面的方案一个都不删**，只是回到「未分组」—— 目录是整理用的，
 * 删目录顺带删掉十几个方案，是最不该有的意外。删除确认里也照实说。
 */
export function removePlanGroup(groupId) {
  const project = activeProject.value;
  const group = (project?.planGroups || []).find((g) => g.id === groupId);
  if (!group) return;

  const n = plans.value.filter((p) => p.groupId === groupId).length;
  askConfirm(
    '删除目录',
    n
      ? `确定删除目录「${group.name}」吗？里面的 ${n} 个方案不会删，会回到「未分组」。`
      : `确定删除目录「${group.name}」吗？`,
    () => {
      project.planGroups = (project.planGroups || []).filter((g) => g.id !== groupId);
      plans.value.forEach((p) => {
        if (p.groupId !== groupId) return;
        p.groupId = '';
        const tab = state.planTabs.find((t) => t.planId === p.id);
        if (tab) {
          tab.draft.groupId = '';
          tab.baseline.groupId = '';
        }
      });
      state.collapsedPlanGroups = state.collapsedPlanGroups.filter((id) => id !== groupId);
    }
  );
}

export function togglePlanGroup(groupId) {
  const list = state.collapsedPlanGroups;
  const index = list.indexOf(groupId);
  if (index >= 0) list.splice(index, 1);
  else list.push(groupId);
}

/** 收起 / 展开步骤段。 */
export function togglePlanSection(kind) {
  const list = state.collapsedPlanSections;
  const index = list.indexOf(kind);
  if (index >= 0) list.splice(index, 1);
  else list.push(kind);
}

export const activeStep = computed(() => findStep(state.activeStepId)?.step || null);

/**
 * 测试数据的列名。
 *
 * 编辑接口时它们也要出现在 {{ }} 的候选里，否则只能靠记列名。
 */
export const planDataColumns = computed(() => planDraft.value?.data?.columns || []);

/**
 * 找一步的源头请求。
 *
 * 先按 id 认（sourceId，或步骤里那份请求自己带的 id）；认不出 —— 接口被
 * OpenAPI 重新导入覆盖过、请求 id 全换了 —— 再按「名字 + 方法」认：
 * 同名同方法且只有一个，就认它是源头。认不出唯一一个才算真的没了。
 */
function findStepSource(step) {
  if (!step) return null;
  const reqs = allRequests.value;
  const direct =
    reqs.find((r) => r.id === step.sourceId) || reqs.find((r) => r.id === step.request?.id);
  if (direct) return direct;

  const name = step.request?.name;
  const method = step.request?.method;
  if (!name) return null;
  const hits = reqs.filter((r) => r.name === name && r.method === method);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * 这一步相对项目里的请求改过没有。
 * 不加额外标志：两边一比就知道，把改动改回原样标记会自己消失。
 */
export function stepChanged(step) {
  const source = findStepSource(step);
  if (!source) return false;
  // id 不算改动：接口被导入覆盖后 id 会换，内容没变就不该标「改过」
  const strip = (r) => {
    const { id, ...rest } = r || {};
    return rest;
  };
  return JSON.stringify(strip(step.request)) !== JSON.stringify(strip(source));
}

/** 源头请求被删了 —— 同步不回来，只能删掉这一步。 */
export function stepSourceMissing(step) {
  // 手动写入的步骤没有源头（sourceId 为空），不算「没了」
  if (!step?.sourceId) return false;
  return !findStepSource(step);
}

function blankStep(request, sourceId) {
  return { id: 'step-' + uid(), sourceId, enabled: true, request: clone(request) };
}

/** 收掉一个方案标签页，不问。删除方案 / 换项目走这条路。 */
function dropPlanTab(id) {
  const index = state.planTabs.findIndex((t) => t.id === id);
  if (index < 0) return;

  const wasActive = state.activePlanTabId === id;
  state.planTabs.splice(index, 1);
  if (!wasActive) return;

  // 优先接右边那个，和请求标签页一致
  const next = state.planTabs[index] || state.planTabs[index - 1] || null;
  state.activePlanTabId = next ? next.id : '';
  state.activeStepId = next?.draft.steps?.[0]?.id || '';
  // 接过来的那个方案也有自己的运行结果，别当成「没跑过」
  state.planRun = planRunFor(next?.planId);
}

/** 关掉全部方案标签页，回到「什么都没打开」。 */
function resetPlanTabs() {
  state.planTabs = [];
  state.activePlanTabId = '';
  state.activeStepId = '';
  state.stepView = 'steps';
  state.planRun = null;
  // 切项目时把会话里那几份完整结果丢掉：它们的方案已经不在眼前了
  state.planRunCache = {};
}

export function activatePlanTab(id) {
  if (state.activePlanTabId === id) return;
  state.activePlanTabId = id;
  state.stepView = 'steps';
  // 不自动展开任何一步：主区那一列步骤本身就是这一页要看的东西，
  // 一进来就摊开一个编辑器，反而把整条流程挤下去了
  state.activeStepId = '';

  // 把最近一次的结果端出来。会话里跑过的优先（那份带响应体），
  // 其次是落盘那份里最新的（数组第一个）—— 报告读的一直是 state.planRun，
  // 历次运行切换是另外去改它，两边不用分叉
  const tab = state.planTabs.find((t) => t.id === id);
  state.planRun = planRunFor(tab?.planId);
}

/** 打开一个方案。已经开着就切过去，不重复开。 */
export function openPlanTab(planId) {
  const opened = state.planTabs.find((t) => t.planId === planId);
  if (opened) {
    activatePlanTab(opened.id);
    return;
  }
  const plan = plans.value.find((p) => p.id === planId);
  if (!plan) return;

  const draft = clone(plan);
  /*
   * 老方案可能把步骤放在前置 / 后置段（功能已废弃）。合并进主流程，让 UI 和模型统一：
   * 不依赖测试数据的步运行时自动只跑一次（等价于原来的前置），依赖数据的按行重复。
   *
   * 判的是「字段在不在」而不是「非不非空」：早先的版本给每个新方案都建了这两个空数组，
   * 只看非空的话，它们会一直留在存档里。
   */
  if ('setupSteps' in draft || 'teardownSteps' in draft) {
    draft.steps = [
      ...(draft.setupSteps || []),
      ...(draft.steps || []),
      ...(draft.teardownSteps || []),
    ];
    delete draft.setupSteps;
    delete draft.teardownSteps;
  }
  const tab = { id: 'ptab-' + uid(), planId, draft, baseline: clone(draft) };
  state.planTabs.push(tab);
  // 切方案时把上一摊的运行环境临时选择清掉，回到这个方案自己的默认
  state.planEnvOverride = '';
  state.planUserOverride = '';
  activatePlanTab(tab.id);
}

/**
 * 关方案标签页。有未保存的改动先问一句 —— 三个出口缺一不可，
 * 和请求标签页一个道理：少了「不保存」就没法丢弃，少了「取消」就没法反悔。
 */
export function closePlanTab(id = state.activePlanTabId) {
  const tab = state.planTabs.find((t) => t.id === id);
  if (!tab) return;

  // 判的是**要关的这个标签页**脏不脏，不是当前激活那个 —— 关后台的脏标签页
  // 也该弹提示，否则改完切走再关，改动就无声地没了
  if (!planTabIsDirty(tab)) {
    dropPlanTab(id);
    return;
  }

  setConfirm({
    title: '有未保存的改动',
    message: `「${tab.draft.name}」还有改动没保存，关掉这个标签页就会丢掉。`,
    confirmText: '保存并关闭',
    thirdText: '不保存',
    // 同 closeTab：取消靠点外面 / Esc
    hideCancel: true,
    action: () => {
      savePlanTab(id);
      dropPlanTab(id);
    },
    thirdAction: () => dropPlanTab(id),
  });
}

/** 保存草稿 —— **唯一**会改到 project.plans 的入口。 */
export function savePlanTab(id = state.activePlanTabId) {
  const project = activeProject.value;
  const tab = state.planTabs.find((t) => t.id === id);
  if (!project || !tab) return;
  if (!project.plans) project.plans = [];

  const data = clone(tab.draft);
  const index = project.plans.findIndex((p) => p.id === data.id);
  if (index >= 0) project.plans[index] = data;
  else project.plans.push(data);

  tab.baseline = clone(data);
}

/**
 * 新建一个方案。
 *
 * @param {string} groupId 归到哪个目录下，空串 = 未分组。
 *   目录头那个 ＋ 传目录 id，底部那颗「新建方案」不传。
 */
export function createPlan(groupId = '') {
  const project0 = activeProject.value;
  if (!project0) return;
  if (!project0.planGroups) project0.planGroups = [];
  const group = project0.planGroups.find((g) => g.id === groupId);
  const where = group ? `（放进「${group.name}」）` : '';

  askInput('新建方案', `给这个方案起个名字${where}：`, '方案名称', '', (name) => {
    const project = activeProject.value;
    if (!project) return;
    if (!project.plans) project.plans = [];
    const plan = {
      id: 'plan-' + uid(),
      name: (name || '').trim() || `新方案 ${project.plans.length + 1}`,
      groupId: group && (project.planGroups || []).some((g) => g.id === groupId) ? groupId : '',
      envId: state.activeEnvId,
      userId: state.activeUserId,
      // 某一步挂了怎么办。默认**继续跑完** —— 一轮就能把问题看全：挂在第三步，
      // 后面几步照样跑到，不至于只剩一堵「因为缺变量而失败」的红墙
      onError: 'continue',
      // 运行节奏。默认逐个跑、不限速，也就是原来的行为
      concurrency: 1,
      intervalMs: 0,
      /** 失败重试次数。默认 2，见 planRetry */
      retry: 2,
      /** 方案自己的请求超时（ms）。0 = 用全局设置 */
      timeoutMs: 0,
      /**
       * 步骤：一条有序的流程。依赖测试数据的按数据行重复，不依赖的整轮只跑一次
       * （判定见 runPlan）
       */
      steps: [],
      /** 方案自己的变量。环境 / 账号只读，要自己的东西放这儿 */
      vars: [],
      data: null,
      /** 只跑测试数据的前多少行。0 = 全部 */
      dataLimit: 0,
    };
    project.plans.push(plan);
    openPlanTab(plan.id);
  });
}

/**
 * 改方案名。按 id 认方案，不认「当前打开的那个」——
 * 左栏每一行都能改名，改的可能是个没打开的方案。
 *
 * 名字是给左栏列表读的，而它读的是 plans（已保存那份），所以这里**直接落到三处**，
 * 不靠保存按钮 —— 否则改完名字列表里还是旧的。
 * 也不能直接 savePlanTab()：那会把草稿里其他没保存的改动一起提交了。
 */
export function renamePlan(planId) {
  const saved = plans.value.find((p) => p.id === planId);
  if (!saved) return;

  askInput('重命名方案', '给这个方案起个新名字：', '方案名称', saved.name, (name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    saved.name = trimmed;

    // 开着标签页的话，草稿和它的基准都要跟上 ——
    // 不同步的话，之后再点保存会把旧名字写回去
    const tab = state.planTabs.find((t) => t.planId === planId);
    if (tab) {
      tab.draft.name = trimmed;
      tab.baseline.name = trimmed;
    }
  }, '保存');
}

/**
 * 复制一个方案。
 *
 * 步骤要换新 id：不然两个方案的步骤 id 撞上，运行报告里按 stepId 找结果会串。
 * 上次的运行结果不带过来 —— 那是原方案跑出来的，复制品还没跑过。
 */
export function duplicatePlan(planId) {
  const project = activeProject.value;
  const plan = plans.value.find((p) => p.id === planId);
  if (!project || !plan) return;

  const copy = clone(plan);
  copy.id = 'plan-' + uid();
  copy.name = `${plan.name} 副本`;
  copy.steps = (copy.steps || []).map((s) => ({ ...s, id: 'step-' + uid() }));

  const index = project.plans.findIndex((p) => p.id === planId);
  project.plans.splice(index + 1, 0, copy);
  openPlanTab(copy.id);
}

export function removePlan(planId) {
  const plan = plans.value.find((p) => p.id === planId);
  if (!plan) return;

  askConfirm('删除方案', `确定删除方案「${plan.name}」吗？`, () => {
    const list = activeProject.value?.plans || [];
    const index = list.findIndex((p) => p.id === planId);
    if (index >= 0) list.splice(index, 1);

    // 它的运行结果也一并丢掉，别在文件里留一堆孤儿
    delete state.planRuns[planId];
    delete state.planRunCache[planId];

    // 标签页也收掉。走 dropPlanTab，不再问一次「有未保存的改动」——
    // 上一步的删除确认问的就是这个
    const tab = state.planTabs.find((t) => t.planId === planId);
    if (tab) dropPlanTab(tab.id);
  });
}

/**
 * 从接口树里挑接口加进方案：每个挑中的复制一份当步骤，追加在末尾。
 *
 * @param {string[]} requestIds
 */
export function addStepsToPlan(requestIds) {
  const draft = planDraft.value;
  if (!draft) return;
  if (!draft.steps) draft.steps = [];

  const before = draft.steps.length;
  (requestIds || []).forEach((requestId) => {
    const source = allRequests.value.find((r) => r.id === requestId);
    if (source) draft.steps.push(blankStep(source, requestId));
  });

  // 跳到刚加进来的第一步并把它摊开 —— 加完总得配点什么，省一次点击。
  // 视图要回到「步骤」：这一步是在那个列表里摊开的，停在数据 / 报告页会看不到
  if (draft.steps.length > before) {
    state.activeStepId = draft.steps[before].id;
    state.stepView = 'steps';
  }

  // 加完就关掉挑接口那个弹层：它是「挑一次、加一批」的动作，事办完了还杵在那儿，
  // 得再点一次「取消」才能看到刚加的步骤 —— 而这一步多半正是接着要做的事
  closeStepPicker();
}

/**
 * 换一份测试数据。数据是方案级的，见 runPlan 里对「按行重复」的说明。
 *
 * 顺手把「只跑前 N 行」清掉：那个数字是针对上一份数据的，换了数据还留着
 * 只会让人少跑了几百行却不知道为什么。
 */
export function setPlanData(data) {
  const draft = planDraft.value;
  if (!draft) return;
  draft.data = data;
  draft.dataLimit = 0;
}

export function clearPlanData() {
  const draft = planDraft.value;
  if (!draft) return;

  // 清空是不可逆的（导进来的 CSV、手敲的一整张表都会没），必须先问一句
  const rows = (draft.data && draft.data.rows && draft.data.rows.length) || 0;
  askConfirm(
    '清空测试数据',
    rows
      ? `确定清空这张表吗？${rows} 行数据会一起删掉，且不可恢复。`
      : '确定清空这张表吗？',
    () => {
      draft.data = null;
      draft.dataLimit = 0;
    },
    // 不写「确认删除」：它不是删一条，是清空整张表。破坏性动作的确认按钮
    // 一律用中性的「确定」——把动词写在标题和正文里（「清空测试数据」），
    // 按钮上不需要再重复一遍
    '确定'
  );
}

/** 手动新建一张空表：两列一行，够开个头；列名和单元格都是能改的 */
export function createPlanData() {
  setPlanData({ name: '手动填写', columns: ['列1', '列2'], rows: [['', '']] });
}

/** 这次只跑前多少行。0 = 全部 */
export function planDataLimit(plan) {
  const n = Math.floor(Number(plan?.dataLimit));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 这次运行真正要跑的数据行。
 *
 * 「只跑前 N 行」是给调试用的：200 行要跑三分钟，改了一处先跑 10 行看看。
 * 超出行数时按全部算 —— 填了 999 还当成 999 行，进度条会显示成跑不完。
 */
function planDataRows(plan) {
  const rows = plan?.data?.rows || [];
  const limit = planDataLimit(plan);
  return limit ? rows.slice(0, limit) : rows;
}

export function setPlanDataLimit(value) {
  const draft = planDraft.value;
  if (!draft) return;
  const n = Math.floor(Number(value));
  draft.dataLimit = Number.isFinite(n) && n > 0 ? n : 0;
}

/** 导入一份 CSV 当测试数据。解析交给 csv.js，这里只管读文件和报错。 */
export async function importPlanData(file) {
  if (!file || !planDraft.value) return;
  try {
    const { columns, rows, duplicates } = parseCsv(await file.text());
    if (!columns.length) {
      askAlert('这个文件读不出内容', '没有解析到任何列。确认一下是逗号 / 分号分隔的 CSV。');
      return;
    }
    setPlanData({ name: file.name, columns, rows });
    if (duplicates.length) {
      askAlert(
        '有重复的列名',
        `${[...new Set(duplicates)].join('、')} 出现了不止一次，已自动加序号区分（如 ${duplicates[0]}_2）。\n` +
          '接口里取值要用改过之后的名字。'
      );
    }
  } catch (e) {
    askAlert('导入失败', e?.message || String(e));
  }
}

/** 右侧切到 步骤 / 测试数据 / 报告。 */
export function setStepView(view) {
  state.stepView = view;
}

/** 方案里的步骤。就一份列表 —— 前置 / 后置两段已经并进主流程了 */
function planSteps(plan) {
  return plan?.steps || [];
}

/**
 * 按 id 找一步。
 *
 * 勾选 / 删除 / 同步都是「按 id 认步」，调用方不用说明它在哪儿 ——
 * 过去要传「在哪一段」，漏传一次就改错地方。
 */
function findStep(stepId) {
  const draft = planDraft.value;
  const index = planSteps(draft).findIndex((s) => s.id === stepId);
  return index < 0 ? null : { index, step: draft.steps[index] };
}

export function removeStep(stepId) {
  const draft = planDraft.value;
  if (!draft) return;
  const found = findStep(stepId);
  if (!found) return;

  draft.steps.splice(found.index, 1);

  // 删掉的正是当前这一步，就顺势落到原位置那一步上，和关标签页一个道理。
  // 右侧要是空着，人会以为整个方案都空了
  if (state.activeStepId === stepId) {
    const next = draft.steps[found.index] || draft.steps[found.index - 1] || null;
    state.activeStepId = next ? next.id : '';
  }
}

export function toggleStep(stepId) {
  const found = findStep(stepId);
  if (found) found.step.enabled = !found.step.enabled;
}



/**
 * 一次删掉多步。
 *
 * 单步删除是不问的 —— 删错了再挑一次就行。批量不一样：二十步删掉要重新挑
 * 二十次，所以先问一句，而且把数字写进问题里。
 */
export function removeSteps(stepIds) {
  const draft = planDraft.value;
  if (!draft) return;

  const ids = new Set(stepIds);
  const doomed = planSteps(draft).filter((s) => ids.has(s.id));
  if (!doomed.length) return;

  askConfirm(
    '删除步骤',
    `确定删掉这 ${doomed.length} 步吗？项目里的接口不动。`,
    () => {
      draft.steps = draft.steps.filter((s) => !ids.has(s.id));

      // 摊开着的那一步被删掉了，就落到还剩的第一步上。
      // 右侧要是空着，人会以为整个方案都空了
      if (ids.has(state.activeStepId)) {
        state.activeStepId = draft.steps[0]?.id || '';
      }
    }
  );
}

/** 拖拽排序。数组内的移动，直接用 splice 换位置。 */
export function moveStep(from, to) {
  const steps = planDraft.value?.steps;
  if (!steps || from === to) return;
  if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return;
  const [moved] = steps.splice(from, 1);
  steps.splice(to, 0, moved);
}

/** 单步同步：拿项目里那个请求的最新版覆盖这一步。 */
export function syncStep(stepId) {
  const found = findStep(stepId);
  const source = findStepSource(found?.step);
  if (found && source) {
    found.step.request = clone(source);
    // 顺手把失效的 sourceId 修过来：下次按 id 就能直接认到
    found.step.sourceId = source.id;
  }
}

/** 整体同步：所有还能找到源头的步骤都拉一遍。 */
export function syncAllSteps() {
  const draft = planDraft.value;
  if (!draft) return;
  planSteps(draft).forEach((step) => {
    const source = findStepSource(step);
    if (source) {
      step.request = clone(source);
      // 顺手把失效的 sourceId 修过来：下次按 id 就能直接认到
      step.sourceId = source.id;
    }
  });
}

/**
 * 换方案的运行环境：账号跟着切到那个环境的第一个，和外面 selectEnv 一个道理。
 *
 * 注意：只写**会话级**覆盖（state.planEnvOverride），不碰 draft。环境和账号是
 * 「这次跑用哪个」的临时选择，不该被存进方案、也不该让标签页变「未保存」——
 * 刷新页面就回到方案自己的默认配置。真正要落盘的环境在 plan.envId 里。
 */
export function setPlanEnv(envId) {
  state.planEnvOverride = envId;
  const env = state.environments.find((e) => e.id === envId);
  state.planUserOverride = env?.users?.[0]?.id || '';
}

export function setPlanUser(userId) {
  state.planUserOverride = userId;
}

/**
 * 某一步挂了怎么办：stop 停下（默认）/ continue 继续跑完。
 *
 * 默认「继续跑完」：一轮就能把问题看全 —— 十二步挂在第三步，不至于后面九步
 * 压根跑不到。老方案没这个字段也走这条。
 */
export function setPlanOnError(mode) {
  // 是方案自己的设置：写进草稿，点「保存」才落盘
  if (planDraft.value) planDraft.value.onError = mode === 'continue' ? 'continue' : 'stop';
}

/**
 * 并发上限，6。
 *
 * 不是随便定的：前端是往同源的 /api/proxy 发请求，HTTP/1.1 下浏览器对同一个域
 * 最多开 6 个并发连接。设得再大也只是在浏览器里排队，看着像生效了其实没有 ——
 * 与其给一个骗人的数字，不如在这里就卡住。
 *
 * 真要更高，得把并发放到后端（一次收 N 个、后端并发出、结果一起回），
 * 那样前端只占一个连接，后端说了算。现在没做。
 */
export const MAX_CONCURRENCY = 6;

/** 方案的并发数，夹在 1..MAX_CONCURRENCY。老方案没这个字段 → 1（= 原来的串行） */
export function planConcurrency(plan) {
  const n = Math.floor(Number(plan?.concurrency));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_CONCURRENCY, n);
}

/** 两次发起之间至少等多少毫秒。老方案没这个字段 → 0，不限速 */
export function planInterval(plan) {
  const ms = Math.floor(Number(plan?.intervalMs));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** 重试次数上限。填 999 也不会真有人等，夹住免得一个输入框把整轮拖死 */
export const MAX_RETRY = 5;

/**
 * 某一步发失败后重试几次。
 *
 * **默认 2，和并发 / 间隔不一样 —— 这里默认值不是「关」。**
 * 一次网络抖动毁掉一整轮，代价太大，所以默认开着。想关就填 0。
 *
 * 填的是**重试次数**，不是总次数：填 2 = 首发 1 次 + 重试 2 次 = 一共发 3 次。
 * 触发条件是「这一步没成」—— 连不上、超时、状态码 ≥ 400、断言不过，都算，
 * 见 sendStep。被手动叫停不算失败，不重试。
 */
export function planRetry(plan) {
  const n = Math.floor(Number(plan?.retry));
  if (!Number.isFinite(n) || n < 0) return 2;
  return Math.min(MAX_RETRY, n);
}

/** 方案自己的请求超时（毫秒）。0 = 用全局设置里那个 30 秒 */
export function planTimeoutMs(plan) {
  const ms = Math.floor(Number(plan?.timeoutMs));
  return Number.isFinite(ms) && ms > 0 ? Math.min(600000, ms) : 0;
}

/** 两次重试之间先歇一下，别把一个本来就不舒服的服务端打得更死 */
export const RETRY_GAP_MS = 400;

/**
 * 方案自己的变量表，摊平成 { 名: 值 }。
 *
 * 这是方案唯一**可写**的一份数据。环境 / 账号对方案来说是只读的 —— 跑一次
 * 测试就悄悄改掉手配的环境变量，是最不该有的副作用；方案要自己的东西，
 * 就放这儿，和别处隔离。
 */
export function planVarMap(plan) {
  const out = {};
  (plan?.vars || []).forEach((v) => {
    if (v.enabled === false) return;
    const key = String(v.key || '').trim();
    if (key) out[key] = v.value ?? '';
  });
  return out;
}

/**
 * 换掉整个方案变量表。
 *
 * 整表收而不是逐行增删：键值表格本来就是整表提交的（改一个字也发一份新数组），
 * 两边形状一致，不用维护两套更新方式。
 */
export function setPlanVars(rows) {
  if (planDraft.value) planDraft.value.vars = (rows || []).map((r) => ({ ...r }));
}

/**
 * 改运行设置：并发 / 间隔 / 重试 / 超时。
 *
 * 写进**方案草稿**，和步骤、测试数据一样，点「保存」才落盘。
 *
 * 这里以前是会话级临时覆盖（改完刷新就没了），结果是：方案的数据结构里有这几个
 * 字段、界面上也有输入框，但**没有任何路径能把它写进去** —— 用户每次跑都得重设
 * 一遍。节奏参数本来就是方案的一部分，跟「这次跑用哪个环境」不是一回事。
 *
 * 传哪些就改哪些。几个值都在这里夹到合法范围 —— 界面上的输入框可以随便敲，
 * 但落进方案的一定是能跑的。
 */
export function setPlanRunOptions({ concurrency, intervalMs, retry, timeoutMs } = {}) {
  const draft = planDraft.value;
  if (!draft) return;
  /**
   * 空串 / 非法值 = 「清掉这一项」，回落到默认（各 plan* 函数里的兜底）；
   * 给个数字才写进方案，并在这里夹到合法范围。
   */
  const setNum = (key, raw, clamp) => {
    if (raw === undefined) return;
    if (raw === '' || raw === null) {
      delete draft[key];
      return;
    }
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) {
      delete draft[key];
      return;
    }
    draft[key] = clamp(n);
  };
  setNum('concurrency', concurrency, (n) => Math.min(MAX_CONCURRENCY, Math.max(1, n)));
  setNum('intervalMs', intervalMs, (n) => (n > 0 ? n : 0));
  setNum('retry', retry, (n) => Math.min(MAX_RETRY, Math.max(0, n)));
  // 上限 10 分钟：再长就不像「超时」了，更像挂在那儿不动
  setNum('timeoutMs', timeoutMs, (n) => (n > 0 ? Math.min(600000, n) : 0));
}

/** 每个方案留多少次运行。再多也没人往回翻，而它是整份落盘的 */
const MAX_PLAN_RUNS = 10;

/** 落盘时留给每一步的字段。没列在这儿的一律丢掉 */
const STEP_KEEP = [
  'stepId', 'no', 'name', 'method', 'url', 'usedVars',
  'status', 'httpStatus', 'time', 'attempts',
  'assertions', 'extracted', 'error',
  // 这一步的前置脚本改过哪些变量。续跑时被跳过的步骤要靠它把变量还给后面的步骤，
  // 所以刷新之后再点「继续」也得有 —— 见 runOneRow 里捡变量那一段
  'scriptVars',
];

/**
 * 运行结果落盘前的精简。
 *
 * 只留「回看一次运行真正要看的东西」：哪一行挂了、HTTP 多少、耗时多久、
 * 断言过了几条、提取到了什么。这些加起来才几十 KB，随手存。
 *
 * 响应体当然不能存（200 个几百 KB 就能把 data.json 撑到几十兆），这版**连
 * response 整个都不留了** —— 光剥 body 的话，剩下的 headers 里躺着后端补的
 * 那一串（User-Agent / Accept / Accept-Encoding / Content-Length…），
 * 每步四五百字节，一千步就是半兆。而这份快照是**每次改动整份 PUT 回去**的，
 * 跑一次等于往上传几百遍。
 *
 * 例外：**没成功的步骤留一份请求**，因为「复制成 curl」要靠它复现。失败的往往
 * 只是少数几步，加起来可以忽略；要是连失败的都多到撑不住，那本来也该去看报告
 * 而不是接着跑。
 *
 * 代价说清楚：刷新之后再打开这个方案，结论都在，响应体和一个「一切正常」的
 * 步骤的 curl 没了。会话内另存一份完整的（state.planRunCache），切标签页回来
 * 照样能点开看。
 */
function slimStep(step) {
  const slim = {};
  STEP_KEEP.forEach((key) => {
    if (step[key] !== undefined) slim[key] = step[key];
  });
  // 只为「复现」留请求。成功的步骤也留着的话，代价就是上面说的那半兆
  if (step.status !== 'ok' && step.response?.request) {
    slim.response = { request: step.response.request };
  }
  return slim;
}

/** 开头 / 收尾那两段也要跟着精简，它们和一行长得一样（status + steps） */
function slimOnce(part) {
  return part ? { status: part.status, steps: (part.steps || []).map(slimStep) } : undefined;
}

function slimRun(run) {
  return {
    ...run,
    setup: slimOnce(run.setup),
    teardown: slimOnce(run.teardown),
    // 整轮跑一遍的那些：和一行一样精简，但要留着（报告里单占一段）
    shared: (run.shared || []).map((s) => (s ? slimStep(s) : s)),
    rows: (run.rows || []).map((row) => ({
      ...row,
      steps: (row.steps || []).map(slimStep),
    })),
  };
}

/**
 * 老存档里 planRuns[方案] 存的是**一次**运行，现在是「最近几次」的数组。
 * 读盘时统一成数组 —— 不迁移的话，历次运行那块会拿到一个没有 length 的东西。
 */
function normalizePlanRuns() {
  const next = {};
  Object.entries(state.planRuns || {}).forEach(([id, value]) => {
    if (Array.isArray(value)) next[id] = value;
    else if (value && value.at) next[id] = [value];
  });
  state.planRuns = next;
}

/**
 * 老存档没有目录树那套字段，读盘时补齐。
 *
 * 只给**缺字段的**补：已经有 sort 的绝不动，否则每次刷新都会把用户排好的次序
 * 按数组顺序重排一遍。老请求一律落到项目根（未分组），排在现有目录之后。
 */
/**
 * 老存档 / 手改过的环境可能缺 `groups` / `users` / `vars`。
 *
 * 读盘时补齐 —— 这些字段在 envVars、变量解析、方案运行里都是直接遍历的，
 * 缺一个就会抛 TypeError，界面表现是「整个顶栏和预览都没了」。
 */
function normalizeEnvironments() {
  (state.environments || []).forEach((env) => {
    if (!env || typeof env !== 'object') return;
    if (!Array.isArray(env.groups)) env.groups = [];
    if (!Array.isArray(env.users)) env.users = [];
    env.groups.forEach((group) => {
      if (group && !Array.isArray(group.vars)) group.vars = [];
    });
    env.users.forEach((user) => {
      if (user && !Array.isArray(user.vars)) user.vars = [];
    });
  });
}

/**
 * 把老存档里的「集合」并进项目的接口树（一次性迁移）。
 *
 * 规则：**第一个集合直接落到项目根上** —— 只有一个集合的存档（绝大多数）升级后
 * 看不出任何差别；**其余每个集合整体变成一个顶层目录**，名字就是它原来的集合名，
 * 里面的目录和请求原样包着，不多一层也不少一层。
 *
 * 之所以能这么并：集合和目录本来就是同一种东西（都是「装东西的容器」），
 * 原来的集合根 = 现在的项目根，集合里的目录 = 顶层目录。
 */
function migrateCollections(project) {
  const collections = Array.isArray(project.collections) ? project.collections : [];
  if (!collections.length) return;

  const dirs = [];
  const requests = [];
  /** 下一个可用的顶层 sort：新建的 wrapper 要排在既有顶层目录之后 */
  const nextTopSort = () =>
    dirs.reduce((max, d) => (d.parentId ? max : Math.max(max, d.sort || 0)), -1) + 1;

  collections.forEach((collection, index) => {
    const sourceDirs = collection.dirs || [];
    const sourceRequests = collection.requests || [];

    // 第一个集合：内容原样提升到根上（目录还是目录，未分组的还是未分组）
    if (index === 0) {
      sourceDirs.forEach((d) => dirs.push(clone(d)));
      sourceRequests.forEach((r) => requests.push(clone(r)));
      return;
    }

    // 第 2..n 个集合：整棵树装进一个新建的顶层目录里
    const wrapperId = 'dir-' + uid();
    const name = String(collection.name || '').trim() || `未命名目录 ${index + 1}`;
    dirs.push({ id: wrapperId, name, parentId: '', sort: nextTopSort() });
    sourceDirs.forEach((d) => {
      const copy = clone(d);
      if (!copy.parentId) copy.parentId = wrapperId;
      dirs.push(copy);
    });
    sourceRequests.forEach((r) => {
      const copy = clone(r);
      if (!copy.dirId) copy.dirId = wrapperId;
      requests.push(copy);
    });
  });

  project.dirs = dirs;
  project.requests = requests;
  delete project.collections;
}

/**
 * 一个项目的兜底：先把老存档并成接口树，再修掉坏指针。
 *
 * 两类坏指针都会让侧栏显示不出来，必须在读档时修掉：
 *   目录的 parentId 指向不存在的目录，或者顺着它绕成了环 —— 树转不出来，整页卡死；
 *   请求的 dirId 指向不存在的目录 —— 这个请求会从侧栏上消失。
 * 一律提到根上：宁可位置不对，也不能让东西看不见。
 */
function normalizeProject(project) {
  migrateCollections(project);

  if (!Array.isArray(project.dirs)) project.dirs = [];
  if (!Array.isArray(project.requests)) project.requests = [];
  const dirs = project.dirs;

  dirs.forEach((d, i) => {
    if (d.parentId === undefined) d.parentId = '';
    if (typeof d.sort !== 'number') d.sort = i;
  });

  const dirIds = new Set(dirs.map((d) => d.id));
  dirs.forEach((d) => {
    if (!d.parentId) return;
    if (!dirIds.has(d.parentId)) {
      d.parentId = '';
      return;
    }
    const seen = new Set([d.id]);
    let cursor = d.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        d.parentId = '';
        break;
      }
      seen.add(cursor);
      cursor = dirs.find((x) => x.id === cursor)?.parentId || '';
    }
  });

  project.requests.forEach((r, i) => {
    if (r.dirId === undefined) r.dirId = '';
    if (r.dirId && !dirIds.has(r.dirId)) r.dirId = '';
    if (typeof r.sort !== 'number') r.sort = dirs.length + i;
  });
}

function normalizeProjects() {
  (state.projects || []).forEach(normalizeProject);
}

/**
 * 某个方案「现在该显示的那份结果」。
 *
 * 会话里跑过的那份优先（只有它带响应体，点开能看），其次是落盘里最新的一次。
 * 正在跑的那一轮也在 planRunCache 里（runPlan 一开始就写进去了），所以
 * 切走再切回来，看到的是**那个方案自己**的实时进度，而不是别人的。
 */
function planRunFor(planId) {
  if (!planId) return null;
  return state.planRunCache[planId] || state.planRuns[planId]?.[0] || null;
}

/**
 * 当前打开的这个方案是不是正在跑。
 *
 * 报告页的「停止」按钮、运行按钮的禁用态都看它 —— 看的是**这个方案**，
 * 不是「有没有东西在跑」。另一个方案在后台跑，不该让这个方案显示成运行中。
 */
export const activePlanRunning = computed(() => {
  const planId = activePlanTab.value?.planId;
  return !!planId && state.planRunning && state.planRunningId === planId;
});

/**
 * 运行页要显示的那份结果：当前打开方案的那一份（会话里跑过的优先，见 planRunFor）。
 *
 * 和报告页读的是同一个来源 —— 两处数字必须一样，不然「运行页说 12 通过、
 * 报告页说 11」这种对不上会让人不信任何一个。
 */
export const activePlanRun = computed(() => planRunFor(activePlanTab.value?.planId));

/** 翻开运行页：一开跑自动打开，方案工具栏那颗按钮也用它 */
export function openPlanRunPage() {
  if (!activePlanTab.value) return;
  state.planRunPage = true;
}

/** 关掉运行页，回到方案编辑页 —— 运行照旧，不打断 */
export function closePlanRunPage() {
  state.planRunPage = false;
}

/**
 * 这个方案能看的全部运行，新的在前。
 *
 * 会话里刚跑的那份排最前（只有它带响应体，点开能看）；它和落盘里最新一次
 * 往往是同一次（跑完就存过），按开始时间去重。
 */
export const planRunHistory = computed(() => {
  const planId = activePlanTab.value?.planId;
  if (!planId) return [];
  const cached = state.planRunCache[planId];
  const saved = state.planRuns[planId] || [];
  return cached ? [cached, ...saved.filter((r) => r.at !== cached.at)] : saved;
});

/**
 * 这次会话跑出来的那份结果（正在跑的那一轮也算）。
 *
 * 和 planRunHistory 的分工：那份是「能翻到的全部」，含落盘的历史；
 * 这份只认**本次会话**跑出来的，给步骤行上那句「0/9 通过」用。
 *
 * 刷新页面等于开始新的操作：上一轮的失败数不该还挂在各个接口上。
 * 想看之前几次，去报告页的「历次运行」翻 —— 存档还在，只是不再冒充当前状态。
 */
export const sessionPlanRun = computed(() => {
  const planId = activePlanTab.value?.planId;
  if (!planId) return null;
  // 正在跑的这一轮也在里面 —— runPlan 一开始就把结果对象写进了 planRunCache，
  // 所以步骤行上看到的一直是实时的那份
  return state.planRunCache[planId] || null;
});

/** 报告页现在看的是历次里的第几次。对不上（-1）就按最新一次算 */
export const planRunIndex = computed(() => {
  const at = state.planRun?.at;
  const index = planRunHistory.value.findIndex((r) => r.at === at);
  return index < 0 ? 0 : index;
});

/**
 * 所有方案的历次运行，按时间倒序 —— 历史页「自动化运行」那一栏。
 *
 * 和接口请求历史**分开两栏**，不混一张表：一边是「我手动调了一次接口」，一边是
 * 「方案自动跑了一整批」。跑一次方案发几十上百个请求，混在一起的话手调那几条
 * 立刻被淹 —— 回头想找自己试过的那次都翻不到。
 */
export const allPlanRuns = computed(() => {
  const names = new Map((plans.value || []).map((p) => [p.id, p.name]));
  const out = [];
  Object.entries(state.planRuns || {}).forEach(([planId, list]) => {
    // 方案已经删了就不列：历史里点进去也没东西可看
    if (!names.has(planId)) return;
    (list || []).forEach((r) => {
      if (!r?.at) return;
      out.push({ key: `${planId}@${r.at}`, planId, planName: names.get(planId), at: r.at, run: r });
    });
  });
  out.sort((a, b) => b.at - a.at);
  return out;
});

/**
 * 历史页选中的那次运行 —— 右侧把它整份报告摊开。
 *
 * 和接口历史一个路数：**左列表 + 右侧看内容，不切页面**。点一下就跳到自动化页
 * 的话，想再看旁边那条得先摸回历史页，左边那棵树也被换掉了 —— 看一条记录而已，
 * 不该把人从当前上下文里搬走。
 *
 * 会话里跑过的那份带响应体（报告里点得开响应），优先用它；落盘那份只有摘要。
 */
export const historyRun = computed(() => {
  const planId = state.activeHistoryRunPlanId;
  const at = state.activeHistoryRunAt;
  if (!planId || !at) return null;
  const list = state.planRuns[planId] || [];
  if (!list.some((r) => r.at === at)) return null;

  const live = state.planRunCache[planId];
  const run = live && live.at === at ? live : list.find((r) => r.at === at);
  const plan = plans.value.find((p) => p.id === planId);
  return { run, planId, planName: plan?.name || '（方案已删除）' };
});

/** 点一条运行记录：右侧看那一次的报告，左栏高亮跟着走 */
export function openHistoryRun(planId, at) {
  state.activeHistoryRunPlanId = planId;
  state.activeHistoryRunAt = at;
}

/** 切历史页的两栏。各自选中什么都不动 —— 切回来还是那一条 */
export function setHistoryTab(tab) {
  state.historyTab = tab === 'run' ? 'run' : 'req';
}

/**
 * 切到历次运行里的某一次 —— 比如「上一轮还全过，这一轮挂了 3 条」，
 * 把两次都摊开看。
 *
 * 正在跑的时候不给切：那一份还在被 runPlan 往上写，切走了屏幕上就是个不再
 * 更新的旧结果，比不切更让人糊涂。
 */
export function showPlanRun(index) {
  // 只有「这个方案自己在跑」时才不给切；别的方案在后台跑，不挡着翻这份历史
  if (activePlanRunning.value) return;
  state.planRun = planRunHistory.value[index] || state.planRun;
}

/**
 * 点某一步 —— 设置「现在摊开的是哪一步」。
 *
 * 折叠由 PlanView 负责：它算好要摊开哪一行，再把结果发过来（同一行再点一次
 * 就发空）。这里只负责记下来，自己不去翻面 —— 否则「点一下」到底是开还是关，
 * 取决于调用方已经点过几次，两处状态各算各的，迟早对不上。
 */
export function selectStep(stepId) {
  state.activeStepId = stepId;
}

/** 打开「从接口树添加接口」。挑完统一加进方案的主流程步骤。 */
export function openStepPicker() {
  if (!planDraft.value) return;
  state.stepPickerOpen = true;
}

export function closeStepPicker() {
  state.stepPickerOpen = false;
}

/**
 * 手动加一个空白步骤。
 *
 * 「从接口树添加接口」是照着接口树里已有的复制一份；但常常这一步是刚想出来的、
 * 接口树里还没有，得能空着手起个头。加完直接把它摊开，接着就能写。
 *
 * 和「从接口树添加」同一个入口，手动加的空白步骤也进主流程。
 */
export function addBlankStep() {
  const draft = planDraft.value;
  if (!draft) return;

  closeStepPicker();

  // 先要个名字：步骤名是从接口带过来的，手动加的没有源头，不给个命名的地方，
  // 这一行就会一直挂着个「新建请求」，列表里认不出谁是谁
  askInput('手动写入接口', '给这个接口起个名字（加到方案步骤）：', '接口名称', '', (name) => {
    if (!draft.steps) draft.steps = [];
    const step = blankStep(blankRequest(), '');
    step.request.name = (name || '').trim() || '新接口';

    draft.steps.push(step);
    state.activeStepId = step.id;
    state.stepView = 'steps';
  }, '添加');
}

/**
 * 睡一会儿。可以传 signal —— 被叫停时立刻醒，而不是非睡满不可。
 *
 * 「发起间隔」是个能填到几十秒的输入框：点「停止」之后还要等它睡完才真的停下，
 * 界面看着就像没反应。
 */
const sleep = (ms, signal) => {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
};

/**
 * 叫停时抛的哨兵错误。
 *
 * 用它把「我们自己喊停的」和「真的失败了」分开 —— 两者都走 catch，但报告里
 * 一行「失败」、一行「已停止」是两回事，混在一起会让人以为接口挂了。
 */
const abortError = () => {
  const e = new Error('已叫停');
  e.name = 'AbortError';
  return e;
};
const isAbort = (e) => !!(e && e.name === 'AbortError');

/**
 * 记下「叫停的这一刻还有几行正在飞」。
 *
 * 那些行不会被掐断，会照常跑完。于是报告里就成了「失败 1 · 通过 3」——
 * 看着像没停住，其实是那 3 行已经发出去了，等它们回来才不会缺数据。
 * 把数字记下来，报告里才能把这件事说明白。
 *
 * 只在第一次叫停时记：并发时多个 worker 会各自走到这里，记最后一次会把
 * 已经跑完的那些也算进去。
 */
function markInFlight(run) {
  if (!run || run.inFlightWhenHalted !== undefined) return;
  const n = run.rows.filter((r) => r.status === 'running').length;
  if (n) run.inFlightWhenHalted = n;
}

/**
 * 点「停止」。
 *
 * 正在跑：断掉在途的请求，不再往下走。
 * 已经中断（失败停下）：就是把这次运行就此了结，状态标成已停止。
 */
/**
 * 暂停 / 恢复的那道闸门。
 *
 * 引擎里几个「要往下发请求了」的点都 await 它：暂停时它是个还没兑现的 promise，
 * 于是所有 worker 就地停住 —— 在途的请求照常回来、该记的结果照常记，只是不再
 * 往下发。恢复时把它兑现，大家从原地接着跑。
 *
 * 为什么不是「循环 sleep 着看标记」：那样暂停期间每秒都醒一次，纯空转；这里是真的
 * 停住，恢复的延迟只有一次 microtask。
 */
function pauseGate() {
  if (!runtime.planPaused) return Promise.resolve();
  if (!runtime.pauseGate) {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    runtime.pauseGate = { promise, resolve };
  }
  return runtime.pauseGate.promise;
}

/** 暂停这一轮：不打断在途请求，跑完手上那一步就停在那儿 */
export function pausePlan() {
  if (!state.planRunning || runtime.planPaused) return;
  runtime.planPaused = true;
  state.planPaused = true;
}

/** 接着跑 */
export function resumePlan() {
  runtime.planPaused = false;
  state.planPaused = false;
  const gate = runtime.pauseGate;
  runtime.pauseGate = null;
  gate?.resolve();
}

export function stopPlan() {
  // 暂停中叫停：先把闸门放开 —— 否则 worker 还等在 pauseGate 上，永远走不到
  // 下面那些 planStop 检查点，这一轮就成了「停也停不掉、恢复也没恢复」
  if (runtime.planPaused) resumePlan();
  runtime.planStop = true;
  /*
   * 要停的是**正在跑的那一份**，不是 state.planRun。
   *
   * 报告页显示的是当前打开方案的结果，用户完全可以一边跑着 A、一边翻 B 的报告；
   * 按 state.planRun 去标记的话，改的是 B 那份记录，A 那边则完全没停下来。
   */
  const live = state.planRunningId ? state.planRunCache[state.planRunningId] : null;
  if (!live) return;
  if (state.planRunning) {
    markInFlight(live);
    // 真的把在途请求断掉。不这么做的话，一个卡在 30 秒超时上的请求会让
    // 「停止」看着像没生效 —— 界面不动，人也只能干等
    runtime.planAbort?.abort();
  } else {
    live.status = 'stopped';
  }
}

/**
 * 报告里给一行数据起个名：取前两列，**连列名一起写**。
 *
 * 只给值是不行的 —— `1 / 1` 这种谁也认不出来：是编号？行号？还是两个数字？
 * 写成 `userId=1 · postId=1`，一眼就知道说的是哪一行、哪两个字段。
 */
function rowLabel(row, columns) {
  if (!row) return '默认数据';
  const parts = columns
    .slice(0, 2)
    .map((name, i) => {
      const value = row[i] ?? '';
      return value === '' ? '' : `${name}=${value}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : '空行';
}

/**
 * 一轮超过这么多数据行，就先问一句再跑。
 *
 * 不是硬上限（拦着不让跑），只是个刹车：一轮 = 行数 × 行内步骤数 个请求，
 * 全在浏览器里发，而且整份结果要留在内存里给报告点开看。
 */
export const BIG_RUN_ROWS = 1000;

/**
 * 跑方案。
 *
 * 执行就一句话：**按步骤推进** —— 一个步骤把它该跑的每一遍跑完，才轮到下一个步骤。
 * 每个步骤跑几遍由它用到的变量决定（见下面的 scopes）。
 *
 * 数据为什么是方案级而不是步骤级：步骤间传参得先能成立。要是每步各跑各的行数，
 * 「第二步用第一步提取的 token」在行数对不上时就说不清了。
 *
 * 失败（请求报错 / 断言不过）原地重试；重试也没成，记一条失败继续往下 —— 测试要的
 * 是一轮下来看见**所有**问题，而不是撞见第一个错就停。想一错就停，方案设置里有。
 *
 * @param {boolean} force true 表示跳过「请求数很多」的确认（用户已经点过一次了）
 * @param {Map<string,'target'|'dep'>|null} only 「只重跑失败的」要跑的格子
 *   （key 是 `行下标:步骤下标`，整轮一遍的步骤行下标记 -1）。null = 完整跑一轮。
 */
export async function runPlan(force = false, only = null) {
  const draft = planDraft.value;
  if (!draft || state.planRunning) return;

  /** 控制台里区分「哪一轮、哪个方案的日志」用 */
  const planLabel = draft.name || '未命名方案';

  /** 能跑的步骤：勾上了，而且来源请求还在 */
  const usable = (list) => (list || []).filter((s) => s.enabled && !stepSourceMissing(s));
  const allSteps = usable(draft.steps);
  if (!allSteps.length) return;

  // 和单次发送一个规矩：这一轮跑起来，控制台里就只留这一轮（前几步的日志仍在报告里）
  clearConsole();

  const columns = draft.data?.columns || [];

  // 只跑前 N 行（调试用）在 planDataRows 里算，这里拿到的是最终要跑的那些
  const picked = planDataRows(draft);
  /*
   * 没有测试数据（或「运行前 N 行」取不到行）时退化成「一行空数据」——
   * 按行跑的那些步骤也就各跑一遍，不会因为没数据而空转。
   */
  const dataRows = picked.length ? picked : [null];

  /*
   * 每个步骤跑几遍：用到了逐行变化的变量就每行一遍，全固定就整轮一遍。
   *
   * 判定在 planSteps.stepScopes 里（纯函数、有单测）—— 它顺着变量的来源往前追，
   * 所以「下单」用了「取用户」提取出来的 id 也算逐行，不用人手动标。
   * 追不出来的（脚本里动态拼变量名）由步骤上的 scope 手动指定覆盖。
   */
  const scopes = stepScopes(allSteps, columns);
  const eachCount = scopes.filter((x) => x === 'each').length;
  /** 这一轮要发多少个请求：「每行一遍」的按行数算，「整轮一遍」的只算一发 */
  const totalCalls = eachCount * dataRows.length + (scopes.length - eachCount);

  /*
   * 请求数特别多时先问一句。分母按真实请求数算，不是「步骤数 × 行数」——
   * 登录这类整轮一遍的步骤被算成 N 遍的话，这个数会虚高，白白吓人一跳。
   */
  if (!force && totalCalls > BIG_RUN_ROWS) {
    askConfirm(
      '这一轮要发很多请求',
      `一共约 ${totalCalls} 个请求：${scopes.length} 个步骤，其中 ${eachCount} 个按 ${dataRows.length} 行重复。\n` +
        '先用测试数据页上的「运行前 N 行」试几行，通常更稳妥。',
      () => runPlan(true, only),
      '仍要全部运行'
    );
    return;
  }

  /*
   * 每一轮都是**全新的一份结果**，不接着上一轮 —— 变量是这一轮现攒的，上一轮的
   * 一个值都不许进来参与判定（见下面 rowLocals 那段）。
   * 「只重跑失败的」也是新的一轮，只是跑的格子少、结果单存一条。
   */
  state.planRun = { at: Date.now(), finishedAt: 0, status: 'running', rows: [] };
  const run = state.planRun;
  if (only) {
    const kinds = [...only.values()];
    // 报告头部要能说清「这次是重跑：3 个本体 + 2 个陪跑」
    run.only = {
      targets: kinds.filter((k) => k === 'target').length,
      deps: kinds.filter((k) => k === 'dep').length,
    };
  }
  /*
   * 一开跑就把它挂到「这个方案的结果」上。
   *
   * 报告页显示的永远是**当前打开方案**的那份，一开跑就写进去，跑到一半切走再
   * 切回来才看得到实时进度；留到最后才写的话，中途切走就是一片空白。
   */
  state.planRunCache[draft.id] = run;

  /*
   * 这一次总共要发多少个请求 —— 运行页那个百分比环靠它。
   *
   * 不能拿「跑完的步骤数 ÷ 跑完的步骤数」算：没轮到的数据行 steps 还是空的，
   * 比出来永远是 100%。所以在开跑前把预期总数钉在 run 上。落盘时会被精简掉
   * （slimRun 不留它），报告页那边本来也不需要。
   *
   * 「只重跑失败的」那一轮的分母是**挑中的格子数**，不是整套的总数 —— 拿
   * 40 个格子的分母去报只跑 6 格的这一轮，进度环会一直停在 15%。
   */
  run.totals = { rows: dataRows.length, steps: only ? only.size : totalCalls };

  /*
   * 先把每一行的位置占好，状态 pending。
   *
   * 两个理由：并发时完成顺序是乱的，结果得回填到行号对应的格子里（steps 按下标放）；
   * 而几十行也要跑一会儿，得先让人看见总共多少行、还剩多少 —— 否则报告是一格一格
   * 自己长出来的，看不出进度。
   */
  dataRows.forEach((row, r) => {
    if (!run.rows[r]) {
      run.rows[r] = { no: r + 1, label: rowLabel(row, columns), status: 'pending', steps: [] };
    }
  });

  // 跑的时候用方案指定的环境和账号，跑完恢复原样。
  //
  // **只读不写。** 方案能从选中的环境里取值，但一个字节都不会写回去。要自己的
  // 东西就放它自己的变量表（draft.vars），那份是隔离的。
  const envBackup = state.activeEnvId;
  const userBackup = state.activeUserId;
  // 运行设置里临时选的环境 / 账号优先；没选过就用方案自己的默认
  const runEnvId = state.planEnvOverride || draft.envId;
  const runUserId = state.planUserOverride || draft.userId;
  if (runEnvId) state.activeEnvId = runEnvId;
  if (runUserId) state.activeUserId = runUserId;

  /** 方案自己的变量。整个运行期间不变，算一次就够 */
  const planVars = planVarMap(draft);

  /**
   * 这次运行用的环境 / 账号变量：**开跑时取一份快照**。
   *
   * 不能每步现读 `vars.value` —— 跑一轮可能几分钟，中途在顶栏换了环境，现读的话
   * 后面几步会拿**新环境**的变量去发请求。同一轮里前半段一个环境、后半段另一个，
   * 报告根本没法看。运行设置里的环境就是「这次跑用哪个」，落地在开跑那一刻。
   */
  const runEnvVars = { ...vars.value };

  /**
   * 每一行自己的变量表（脚本写的、提取到的都落这儿，**不回写环境**）。
   *
   * 行与行之间互不串：第 2 行提取的 token 不会盖掉第 1 行的。所以要按行下标提前
   * 开好，跨步骤累积（第 1 步在第 2 行提取的东西，第 2 步的第 2 行要用）。
   */
  const rowLocals = dataRows.map(() => ({}));

  /**
   * 「整轮只跑一遍」的步骤共用的变量表。
   *
   * 它们不属于任何数据行，但彼此之间照样要能传值：登录提取的 token，后面的探活、
   * 收尾步骤都得用。所以单独开一份，不掺进 rowLocals。
   */
  const sharedLocals = {};

  /**
   * 被脚本 `env.unset` 删掉的名字，按行 / 整轮各记一份。
   *
   * 变量表是**从下往上盖**出来的（环境 → 方案 → 本行产出 → 数据列），所以光把
   * 本层的键删掉没有用：环境里同名的那份会立刻盖回来，`env.unset('token')` 看着
   * 就像没生效。删过的名字单独存一份，合成之后统一抹掉，不管它来自哪一层。
   */
  const rowRemoved = dataRows.map(() => new Set());
  const sharedRemoved = new Set();

  /** 合成一份变量表：按层盖好之后，把删过的名字抹掉 */
  const mergeVars = (removed, ...layers) => {
    const out = Object.assign({}, ...layers);
    removed.forEach((key) => delete out[key]);
    return out;
  };

  // 整轮一遍的步骤结果不占数据行的格子，按下标单独放（见下面的 runStep）
  run.shared = run.shared || [];

  /**
   * 这一步用到的变量里，哪些现在取不到值 —— 取不到就不发请求。
   *
   * 内置变量（`{{$timestamp}}` 这类）必须放行：它们不来自变量表，是发送那一刻
   * 由 interpolate 现算的（见 api.js 的 resolveVar）。在这儿把它们当成「缺」，
   * 后果是整步被标成「未执行」、一个字节都不发 —— 而界面上明明能插这些变量。
   */
  const missingVars = (request, vars) =>
    requestVarNames(request).filter((name) => {
      if (isBuiltinVar(name)) return false;
      const v = vars[name];
      return v === undefined || v === null || String(v) === '';
    });

  /*
   * 这里原来有一段「续跑时把已成功步骤产出的变量捡回来」，现在不需要了。
   *
   * 「只重跑失败的」会把**整条依赖链**一起挑出来重跑（见 planSteps.rerunTargets），
   * 上游是新跑的，变量自然是新的。捡旧值反而更糟：dep 步骤拿着上一轮的数据照样
   * 能过，报告一片绿 —— 那一轮其实什么都没验证。
   */



  // 运行设置（并发 / 间隔 / 重试 / 超时 / 失败策略）就是方案自己的字段，见 setPlanRunOptions
  const concurrency = Math.min(planConcurrency(draft), dataRows.length);
  const intervalMs = planInterval(draft);
  const stopOnError = draft.onError !== 'continue';
  const retryTimes = planRetry(draft);

  /*
   * 这次运行用的请求设置。
   *
   * 方案自己的超时优先：某个方案整体就是慢（比如要跑批处理接口），但它不该逼着
   * 人去动全局那 30 秒 —— 那会顺带改掉接口页手工发的每一个请求。
   */
  const planTimeout = planTimeoutMs(draft);
  const runSettings = planTimeout ? { ...state.settings, timeout: planTimeout } : state.settings;

  runtime.planStop = false;
  runtime.planAbort = new AbortController();
  // 上一轮要是停在暂停上被关掉，标记得清掉，否则新一轮一开跑就卡在闸门上
  runtime.planPaused = false;
  runtime.pauseGate = null;
  state.planPaused = false;
  state.planRunning = true;
  // 记下跑的是谁：别的方案不该显示成「运行中」，见 activePlanRunning
  state.planRunningId = draft.id;
  /*
   * 一开跑就翻开运行页。
   *
   * 一轮可能几分钟，界面上只留一颗「停止」按钮的话，人既看不出跑到哪儿了，
   * 也够不着别的（比如先暂停下来改个数据）。关掉它只是回到方案编辑页，
   * 运行照旧 —— 想再看点工具栏那颗「运行中…」就回来了。
   */
  state.planRunPage = true;

  let hitFailure = false;
  /** 失败后不再发新的，但**已经在飞的等它们回来** —— 不然报告会缺数据 */
  let stopIssuing = false;

  /**
   * 发一步的请求，没成功就重发。
   *
   * 不按原因分类：连不上、超时、状态码不是成功、断言没过 —— 只要这一步没成
   * 就重发，重试次数用完为止。真去分「哪种值得重试」，漏掉的那种就是要重试的。
   *
   * `attempt.count` 记的是总共发了几次（含第一次）。报告里靠它区分
   * 「一次就过」和「重试两次才过」—— 后者才是接口不稳的信号。
   *
   * @param {{count:number}} attempt 出参，调用方自己持有，成功失败都能读到
   * @returns {Promise<{result:Object, assertions:Array}>}
   */
  const sendStep = async (request, varsNow, attempt) => {
    attempt.count = 0;
    for (;;) {
      // 都喊停了就别再发了
      if (runtime.planStop) throw abortError();
      // 暂停时连重试也一起停住 —— 否则一个正在退避重试的步骤会绕开闸门接着发
      await pauseGate();
      if (runtime.planStop) throw abortError();

      attempt.count += 1;
      let result;
      try {
        result = await send(request, varsNow(), runSettings, runtime.planAbort.signal);
      } catch (e) {
        // 被叫停立刻抛出去，不重试；重试次数用完了也抛
        if (isAbort(e) || attempt.count > retryTimes) throw e;
        await sleep(RETRY_GAP_MS);
        continue;
      }

      const assertions = runAssertions(request.assertions, result);
      const failed = result.status >= 400 || assertions.some((a) => !a.ok);
      if (!failed || attempt.count > retryTimes) return { result, assertions };

      await sleep(RETRY_GAP_MS, runtime.planAbort?.signal);
    }
  };

  /**
   * 跑一串步骤（**一次**）：全局步骤那一段、某一行的步骤，走的都是它。
   *
   * 抽出来是为了让「整轮跑一次」和「每个数据行跑一遍」共用同一套
   * 发请求 → 断言 → 提取，而不是再写两遍。两者只差三件事：变量从哪来、
   * 产出的变量写进哪个表、跑几次 —— 那些都由调用方通过 varsNow / sink 决定。
   *
   * @param {Array} list 要跑的步骤
   * @param {Function} varsNow 取当前变量表
   * @param {Object} sink 脚本 / 提取产出的变量写进这儿
   * @param {Array} entries 结果往这儿推
   * @param {number} noOffset 步骤编号从几开始（续跑时接上）
   * @param {Set} [removed] 被脚本 `env.unset` 删掉的名字，记在这儿（见 mergeVars）
   * @returns {Promise<'ok'|'failed'|'missing'|'stopped'>}
   */
  const runOnce = async (list, varsNow, sink, entries, noOffset = 0, at = -1, removed = null) => {
    /** 前面有没有跑过步骤 —— 第一步之前不用等间隔 */
    let ranBefore = false;
    /**
     * 行内某步失败、但「继续跑完」时，不立刻跳出整行，记下来最后整行标 failed。
     * 否则第一步挂了、同行后面八步全不发，和「继续跑完」的语义对不上。
     */
    let anyFailed = false;

    for (let s = 0; s < list.length; s++) {
      if (runtime.planStop) return 'stopped';
      /*
       * 暂停就停在这一步**之前**：恢复后从这里接着跑，已经跑过的那几步不会重跑。
       * 放在这里而不是「发送前」—— 变量表、步骤记录都在这一步里现算，停在循环顶
       * 最省事，也不会留下一条「跑了一半」的记录。
       */
      await pauseGate();
      if (runtime.planStop) return 'stopped';

      // 「发起间隔」：等**上一步拿到结果**（响应或超时）之后再等这么久，才发
      // 下一步。不是从上次「发起」算起 —— 有些步骤的入参就是上一步的返回值，
      // 必须等它回来。带上 signal：等待期间点「停止」要能立刻醒
      if (ranBefore && intervalMs) await sleep(intervalMs, runtime.planAbort?.signal);
      ranBefore = true;

      const step = list[s];
      const request = step.request;

      const fresh = {
        stepId: step.id,
        no: noOffset + s + 1,
        name: request.name,
        method: request.method,
        url: finalUrl(request, varsNow()),
        usedVars: requestVarNames(request),
        status: 'running',
        httpStatus: 0,
        time: 0,
        assertions: [],
        extracted: [],
        error: '',
        response: null,
        /** 这一步总共发了几次（含第一次）。1 = 没重试 */
        attempts: 0,
      };
      /*
       * 结果放哪儿：给了 at 就按下标放（步骤优先时每个步骤各有固定位置，重跑也
       * 覆盖同一个格子），否则追到末尾。
       */
      if (at >= 0) entries[at] = fresh;
      else entries.push(fresh);

      /*
       * 之后所有状态改动都走**数组里那一份**（响应式代理），不走手上这个原始对象。
       *
       * 直接改原始对象 Vue 是看不见的：界面上的运行页 / 报告页只在「又有新记录写进
       * 数组」时才重算，于是**最后一步**的状态会永远停在「进行中」—— 它之后没有新的
       * 数组写入来触发重算了（实测：整轮一遍的收尾步骤就这么卡住过）。
       */
      const entry = at >= 0 ? entries[at] : entries[entries.length - 1];

      // 放在 try 外面：成功也要读它，失败读到的次数更有意义
      const attempt = { count: 0 };

      try {
        if (request.script) {
          const scriptRun = await runPreScript(request.script, varsNow());
          // 只落本轮。脚本改的变量要是写进环境，就成了「跑一次测试顺手改了配置」
          Object.entries(scriptRun.changes).forEach(([key, value]) => {
            sink[key] = value;
            // 之前删过、这一步又写回来了：把它从「已删名单」里放出来
            if (removed) removed.delete(key);
          });
          scriptRun.removals.forEach((key) => {
            delete sink[key];
            // 只删本层不够：环境 / 方案变量里同名的那份会盖回来，所以单独记一笔
            if (removed) removed.add(key);
          });
          /*
           * 记在本步上。
           *
           * 续跑时被跳过的成功步骤不会重跑，但它们改过的变量得还给后面的步骤 ——
           * 不记的话，「第一步脚本算个签名、第二步用它」这种链条一续跑就断，
           * 后一步会把 {{签名}} 原样发出去。
           */
          entry.scriptVars = { changes: scriptRun.changes, removals: scriptRun.removals };
          // 脚本日志留在本步（报告里就地看），同时进会话控制台（汇总看）。
          // 不进 STEP_KEEP，所以不会落盘撑大存档
          attachScriptRun(entry, 'pre', scriptRun, planLabel);
          if (!scriptRun.ok) {
            entry.status = 'failed';
            entry.error = '前置脚本执行失败：' + scriptRun.error;
            if (stopOnError) return 'failed';
            anyFailed = true;
            continue;
          }
        }

        // 发之前再看一眼有没有被叫停：这一步的请求压根没发出去，条目已经建了，
        // 得自己收拾干净 —— 留成 'running' 的话，报告里会永远显示「跑着呢」，
        // 看着像卡住了
        if (runtime.planStop) {
          entry.status = 'stopped';
          return 'stopped';
        }

        /*
         * 用到的变量一个都没取到值 —— 不发。
         *
         * 发出去就是把 {{token}} 原样送到服务端，换回一个 401 或者一份脏数据；
         * 报告里还会多出几条「失败」，把真正的根因（上一步没成）埋掉。
         * 所以标成「未执行」——它压根没跑，跟失败是两回事。
         *
         * 放在脚本之后：脚本自己也能产出变量（env.set 算签名之类），先让它跑完。
         */
        const missing = missingVars(request, varsNow());
        if (missing.length) {
          entry.status = 'missing';
          entry.error = `缺 ${missing.join('、')}`;
          /*
           * 「停下」策略对这一步同样算数。
           *
           * 它和其他几种「这步没成」是同一件事，只有这一条以前漏了判断 ——
           * 结果就变成：断言不过能停下来，缺变量反而一路跑到底。
           */
          if (stopOnError) return 'missing';
          anyFailed = true;
          continue;
        }

        const { result, assertions } = await sendStep(request, varsNow, attempt);
        entry.attempts = attempt.count;
        entry.httpStatus = result.status;
        entry.time = result.time;
        entry.url = result.request.url;
        entry.response = result;

        entry.assertions = assertions;
        entry.extracted = runExtracts(request.extracts, result).map((item) => {
          const value = item.ok ? formatValue(item.value) : '';
          // 同上：只写本轮，跑完就没了。报告里会逐条列出来，不用靠环境留痕
          if (item.ok) sink[item.key] = value;
          // from / reason 一起留着：报告里要说清楚「从哪儿取的」「为什么没取到」
          return {
            key: item.key,
            path: item.path,
            from: item.from,
            value,
            ok: item.ok,
            reason: item.reason,
          };
        });

        /*
         * 后置脚本：响应到手、断言和提取都做完之后跑。
         *
         * 它读得到完整响应（response.status / headers / body / json），写出来的变量
         * 和前置一样只落本轮 —— 报「算不出来的派生值」交给它，比如从数组里按条件
         * 挑一项、对提取出来的值做变换、多字段联动的判断。
         *
         * 脚本失败 = 这一步失败（请求已经发了，结果照留），和前置脚本一个口径。
         */
        if (request.afterScript) {
          const afterRun = await runPostScript(request.afterScript, varsNow(), result);
          Object.entries(afterRun.changes).forEach(([key, value]) => {
            sink[key] = value;
            if (removed) removed.delete(key);
          });
          afterRun.removals.forEach((key) => {
            delete sink[key];
            if (removed) removed.add(key);
          });
          entry.scriptVars = {
            changes: { ...(entry.scriptVars?.changes || {}), ...afterRun.changes },
            removals: [...new Set([...(entry.scriptVars?.removals || []), ...afterRun.removals])],
          };
          attachScriptRun(entry, 'post', afterRun, planLabel);

          if (!afterRun.ok) {
            entry.status = 'failed';
            entry.error = '后置脚本执行失败：' + afterRun.error;
            if (stopOnError) return 'failed';
            anyFailed = true;
            continue;
          }
        }

        /*
         * 通过与否：HTTP ≥ 400 或断言没过，两条都算失败。
         *
         * 判据在 planSteps.stepVerdict 里（纯函数、有单测）—— 这里曾经只查断言，
         * 于是「返回 500 但没配断言」的步骤会被标成通过，而重试逻辑明明知道它挂了。
         */
        const verdict = stepVerdict(result, entry.assertions);
        if (!verdict.ok) {
          entry.status = 'failed';
          entry.error = verdict.error;
          if (stopOnError) return 'failed';
          anyFailed = true;
          continue;
        }
        entry.status = 'ok';
      } catch (e) {
        entry.attempts = attempt.count;

        // 被叫停不是失败：标成「已停止」，这一轮照样能点开看跑到哪一步了
        if (isAbort(e)) {
          entry.status = 'stopped';
          return 'stopped';
        }

        entry.status = 'failed';
        entry.error = e?.message || String(e);
        if (stopOnError) return 'failed';
        anyFailed = true;
        continue;
      }
    }

    return anyFailed ? 'failed' : 'ok';
  };

  /** 第 r 条数据行的列值（{列名: 值}）。列值整轮不变，现取即可 */
  const rowVarsOf = (r) => {
    const row = dataRows[r];
    if (!row) return {};
    return Object.fromEntries(columns.map((col, i) => [col, row[i] ?? '']));
  };

  /**
   * 跑**一个步骤在一条数据行上**：发请求 → 断言 → 提取。
   *
   * 这是执行的最小单元。整轮就是「对每一个步骤，把它在所有数据行上跑一遍」——
   * 外层步骤、内层数据行，一步一步推进（见下面的执行循环）。
   *
   * 变量优先级（越靠后越具体）：
   *   环境 / 账号  <  方案自己的变量  <  整轮步骤产出的  <  本行脚本 / 提取产出的
   *   <  这条数据行的列值
   *
   * 「整轮步骤产出的」必须在这一层：登录（整轮跑一遍）提取的 token，后面每个
   * 数据行都要带上 —— 漏掉它，所有按行跑的步骤全部「缺 token」，一个请求都发
   * 不出去，而登录明明是成功的。
   *
   * @returns {Promise<'ok'|'failed'|'stopped'>} 这一步在这一行上的结果
   */
  const runOneStep = async (step, s, r, rowVars) => {
    const runRow = run.rows[r];
    const local = rowLocals[r];
    const removed = rowRemoved[r];
    const varsNow = () =>
      mergeVars(removed, runEnvVars, planVars, sharedLocals, local, rowVars);

    runRow.status = 'running';
    // noOffset 与落点都用 s：结果按下标放进这一行的 steps，报告里步骤顺序就和界面上一致
    await runOnce([step], varsNow, local, runRow.steps, s, s, removed);
    // 这一轮是「只重跑失败的」的话，标明这格是本体还是陪跑 —— 报告里要分开列
    const marked = runRow.steps[s];
    if (marked && only) marked.rerun = only.get(`${r}:${s}`) || '';

    /*
     * 这一行现在的状态。
     *
     * 按「已记录的步骤」现算：有失败就是失败；全跑完且全成功才算过；否则还在跑
     * （步骤优先时，第 1 步跑完了、第 2 步还没轮到，这一行就该是「跑到一半」）。
     */
    const recs = (runRow.steps || []).filter(Boolean);
    if (recs.some((x) => x.status === 'failed')) runRow.status = 'failed';
    else if (recs.some((x) => x.status === 'missing')) runRow.status = 'missing';
    else if (recs.some((x) => x.status === 'stopped')) runRow.status = 'stopped';
    else if (recs.length === eachCount && recs.every((x) => x.status === 'ok')) runRow.status = 'ok';
    else runRow.status = 'running';

    return runRow.steps[s]?.status || 'stopped';
  };

  /**
   * 跑**一个步骤**：把它在所有数据行上跑一遍。
   *
   * 这是执行的中间一层 —— 外层是步骤（一步一步来，这一步跑完才轮到下一步），
   * 内层才是数据行。「并发数」作用在数据行之间；设成 1 就是一条接一条。
   *
   * 续跑时跳过「这一步在这一行已经成功过」的那些，只补没成的。
   */
  const runStep = async (s) => {
    const step = allSteps[s];

    /*
     * 整轮只跑一遍的步骤：跑一次，结果记在 run.shared 的对应下标上，不占数据行的格子。
     *
     * 它没用到逐行变化的变量，跑 N 遍就是发 N 次一模一样的请求 —— 登录跑 5 遍会
     * 互相踢掉 token，清理跑 5 遍会删 5 次。（判定见 planSteps.stepScopes）
     */
    if (scopes[s] === 'once') {
      // 「只重跑失败的」没挑中这一步就跳过（整轮一遍的记在 -1 上，和执行时一致）
      if (only && !only.has(`-1:${s}`)) return;
      const varsNow = () => mergeVars(sharedRemoved, runEnvVars, planVars, sharedLocals);
      const outcome = await runOnce([step], varsNow, sharedLocals, run.shared, s, s, sharedRemoved);
      const rec = run.shared[s];
      if (rec && only) rec.rerun = only.get(`-1:${s}`) || '';
      if (outcome === 'failed') {
        hitFailure = true;
        if (stopOnError) stopIssuing = true;
      }
      if (outcome === 'missing' && stopOnError) stopIssuing = true;
      return;
    }

    const todo = [];
    for (let r = 0; r < dataRows.length; r++) {
      // 「只重跑失败的」：这一轮只跑挑中的格子，其余整轮不碰
      if (only && !only.has(`${r}:${s}`)) continue;
      todo.push(r);
    }
    if (!todo.length) return;

    let next = 0;
    const worker = async () => {
      for (;;) {
        if (stopIssuing || runtime.planStop) return;
        // 并列跑的几个 worker 都停在这儿；恢复时一起醒，接着抢数据行
        await pauseGate();
        if (stopIssuing || runtime.planStop) return;
        const i = next++;
        if (i >= todo.length) return;

        const r = todo[i];
        const outcome = await runOneStep(step, s, r, rowVarsOf(r));
        if (outcome === 'failed') {
          hitFailure = true;
          if (stopOnError) {
            stopIssuing = true;
            // 别的 worker 手里还有跑了一半的行，等它们回来，也把这笔账记下来
            markInFlight(run);
            return;
          }
        }
        // 缺变量在「停下」策略下同样停发 —— 但它不是失败，整轮不因此标红
        if (outcome === 'missing' && stopOnError) {
          stopIssuing = true;
          markInFlight(run);
          return;
        }
        if (outcome === 'stopped') return;

        // 「发起间隔」：同一批里上一条拿到结果（或超时）之后再等这么久
        if (intervalMs) await sleep(intervalMs, runtime.planAbort?.signal);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  };

  try {
    /*
     * 一步一步推进：这一步在所有数据行上跑完，才轮到下一步。
     *
     * 后面那步因此能看见前面那步对**全部数据**做过什么（批处理里最要紧的一条），
     * 同一个接口的请求也是连着的 —— 而不是三个接口按数据行交替着来回横跳。
     */
    for (let s = 0; s < allSteps.length; s++) {
      if (runtime.planStop || stopIssuing) break;
      await pauseGate();
      if (runtime.planStop) break;
      await runStep(s);
    }

    run.finishedAt = Date.now();
    if (runtime.planStop) run.status = 'stopped';
    else if (hitFailure) run.status = 'failed';
    else run.status = 'done';
  } catch (e) {
    /*
     * 意料之外的异常（引擎自己出的问题，不是接口挂了）。
     *
     * 不接住的话，状态会永远停在「running」、行全挂着「未执行」—— 界面上看着
     * 还在跑，其实早就断了，而且没有任何地方说明发生了什么。上一轮那个
     * `eff is not defined` 就是这么表现的。
     */
    run.engineError = e?.message || String(e);
  } finally {
    // 状态在这兜底：正常跑完的那条路已经算好了，走到这儿还是 running 就说明是异常中断
    run.finishedAt = run.finishedAt || Date.now();
    if (run.status === 'running' || !run.status) run.status = 'failed';

    // 留两份：会话里那份带响应体（还能点开看，见开头的 planRunCache），
    // 落盘那份只留摘要。落盘的是「最近几次」的数组，新的在前 —— 续跑会更新同一次
    // （at 不变），所以先按 at 去掉旧的再插到最前面，免得同一份结果出现两遍。
    // 放在 finally 里：中途出异常时，跑到哪儿了也得留住。
    // 但方案已经不在了（项目/方案被删）就别写 —— 否则又留一条孤儿记录
    const planStillExists = state.projects.some((p) =>
      (p.plans || []).some((pl) => pl.id === draft.id)
    );
    if (planStillExists) {
      const previous = (state.planRuns[draft.id] || []).filter((r) => r.at !== run.at);
      state.planRuns[draft.id] = [slimRun(run), ...previous].slice(0, MAX_PLAN_RUNS);
    }

    state.planRunning = false;
    state.planRunningId = '';
    runtime.planAbort = null;
    // 暂停标记跟着这一轮一起收掉：留着的话下一轮一开跑就卡在闸门上
    runtime.planPaused = false;
    runtime.pauseGate = null;
    state.planPaused = false;
    /*
     * 环境 / 账号：只有「用户中途没动过」才恢复。
     *
     * 跑一轮可能几分钟，中途在顶栏换了环境，跑完再盖回原样等于把用户的选择
     * 悄悄丢掉 —— 而恢复本来只是为了不让这次运行的临时选择留在界面上。
     */
    if (!runEnvId || state.activeEnvId === runEnvId) state.activeEnvId = envBackup;
    if (!runUserId || state.activeUserId === runUserId) state.activeUserId = userBackup;
  }
}

/** 这一轮重跑会挑中哪些格子（不给界面渲染用，只算大小）。没得挑就返回 null */
function rerunPlanSize(run) {
  const draft = planDraft.value;
  if (!draft || !run || state.planRunning) return null;
  const allSteps = (draft.steps || []).filter((s) => s.enabled && !stepSourceMissing(s));
  if (!allSteps.length) return null;

  const only = rerunTargets(run, allSteps, draft.data?.columns || []);
  if (!only.size) return null;
  const kinds = [...only.values()];
  return {
    targets: kinds.filter((k) => k === 'target').length,
    deps: kinds.filter((k) => k === 'dep').length,
  };
}

/**
 * 只重跑失败的。
 *
 * 为什么不整套重跑：跑 200 行挂 3 行时，整套重来要几分钟，其中 197 行上一轮已经
 * 过了；更麻烦的是很多接口「建过就不能再建」，重复跑还会自己跟自己打架。
 *
 * 单跑那几个失败格子也不行 —— 它们要用的变量是上一轮现攒的，跑完就清了，直接跑
 * 只会得到一片「缺 token」。所以连依赖链一起挑出来，按方案里的原顺序重跑一遍。
 */
export function rerunFailedPlan() {
  const draft = planDraft.value;
  const run = state.planRun;
  if (!draft || !run || state.planRunning) return;

  const allSteps = (draft.steps || []).filter((s) => s.enabled && !stepSourceMissing(s));
  if (!allSteps.length) return;

  const only = rerunTargets(run, allSteps, draft.data?.columns || []);
  if (!only.size) return;

  // 上一轮的结果留在历次运行里，这一轮是一条新记录（run.only 标明重跑的规模）
  runPlan(false, only);
}

// ------------------------------- 环境 -------------------------------

/**
 * 让「当前环境 / 账号」不悬空。
 *
 * 环境页在 activeEnvId 找不到时会回退显示第一个环境，而 store 的 activeEnv
 * **不回退** —— 两边不一致就会出现「页面上看着是环境 A，点新建用户却毫无反应」。
 * 这里只在选中项失效时兜一次底。
 */
function ensureActiveEnvValid() {
  if (state.environments.some((e) => e.id === state.activeEnvId)) return;
  const first = state.environments[0];
  state.activeEnvId = first?.id || '';
  state.activeUserId = first?.users?.[0]?.id || '';
}

export function selectEnv(id) {
  state.activeEnvId = id;
  // 换环境时，用户也要跟着切到该环境的第一个
  const env = state.environments.find((e) => e.id === id);
  state.activeUserId = env?.users?.[0]?.id || '';
}

export function selectUser(id) {
  state.activeUserId = id;
}

export function createEnv() {
  askInput('新建环境', '给这个环境起个名字：', '环境名称', '', (name) => {
    const env = {
      id: 'env-' + uid(),
      name: (name || '').trim() || `新环境 ${state.environments.length + 1}`,
      // 预置一行空的 baseUrl：它是每个环境都必然要配的，先摆在这儿省得每次手动加
      groups: [
        {
          id: 'g-base',
          name: '基础配置',
          vars: [{ enabled: true, key: 'baseUrl', value: '' }],
        },
      ],
      // 不默认预置用户：默认建出来的「默认账号」没法直接用，还得改，
      // 不如让用户自己点「＋ 新建用户」手动添加
      users: [],
    };
    state.environments.push(env);
    state.activeEnvId = env.id;
    state.activeUserId = '';
  });
}

export function createUser() {
  const env = activeEnv.value;
  if (!env) return;
  askInput('新建用户', '给这个用户起个名字：', '用户名称', '', (name) => {
    const user = {
      id: 'u-' + uid(),
      name: (name || '').trim() || `新用户 ${env.users.length + 1}`,
      vars: [],
    };
    env.users.push(user);
    state.activeUserId = user.id;
  });
}

/**
 * 下面三个「改名」是给界面用的写入口。
 *
 * 以前环境页是**直接改传进去的对象**（`env.name = …`）—— 那是 store 里的数据，
 * 等于绕开这一层在背后改。改名的规则（空名字不生效）就这么散在组件里了，
 * 别处想改名也没处可调。
 */

/** 改环境名。按 id 找，不必是当前选中的那个 */
export function renameEnv(id, name) {
  const env = state.environments.find((e) => e.id === id);
  const trimmed = (name || '').trim();
  if (env && trimmed) env.name = trimmed;
}

/** 改当前环境里某个用户的名字 */
export function renameUser(userId, name) {
  const user = activeEnv.value?.users?.find((u) => u.id === userId);
  const trimmed = (name || '').trim();
  if (user && trimmed) user.name = trimmed;
}

/** 改当前环境里某个分组名（分组挂在环境下面，所以先认环境） */
export function renameGroup(groupId, name) {
  const group = (activeEnv.value?.groups || []).find((g) => g.id === groupId);
  const trimmed = (name || '').trim();
  if (group && trimmed) group.name = trimmed;
}

export function removeUser(id) {
  const env = activeEnv.value;
  if (!env) return;
  const user = env.users.find((u) => u.id === id);
  if (!user) return;

  askConfirm('删除用户', `确定删除用户「${user.name}」及其认证信息吗？`, () => {
    const index = env.users.findIndex((u) => u.id === id);
    if (index < 0) return;
    env.users.splice(index, 1);
    // 运行设置里临时选的账号正是它的话，一并清掉 —— 不然下次跑方案会拿
    // 失效的 id 去设 activeUserId，账号信息取不到
    if (state.planUserOverride === id) state.planUserOverride = '';
    if (state.activeUserId === id) state.activeUserId = env.users[0]?.id || '';
  });
}

export function removeEnv(id) {
  const env = state.environments.find((e) => e.id === id);
  if (!env) return;

  askConfirm('删除环境', `确定删除环境「${env.name}」及其全部变量和用户吗？`, () => {
    const index = state.environments.findIndex((e) => e.id === id);
    if (index < 0) return;
    const removedUserIds = new Set((env.users || []).map((u) => u.id));
    state.environments.splice(index, 1);

    // 运行设置里临时选的环境 / 账号属于这个环境的话一并清掉 —— 否则下次跑方案
    // 会拿失效 id 去设 activeEnvId，环境变量整轮取不到，报的还是「变量没配」
    if (state.planEnvOverride === id) {
      state.planEnvOverride = '';
      state.planUserOverride = '';
    } else if (state.planUserOverride && removedUserIds.has(state.planUserOverride)) {
      state.planUserOverride = '';
    }

    if (state.activeEnvId === id) {
      state.activeEnvId = state.environments[0]?.id || '';
      state.activeUserId = state.environments[0]?.users?.[0]?.id || '';
    }
  });
}

/** 删除环境里的某个变量分组（由环境变量页触发）。 */
export function removeGroup(groupId) {
  const env = activeEnv.value;
  if (!env) return;
  const group = env.groups.find((g) => g.id === groupId);
  if (!group) return;

  askConfirm(
    '删除分组',
    `确定删除分组「${group.name}」及其中的 ${group.vars.length} 个变量吗？`,
    () => {
      const groups = env.groups || (env.groups = []);
      const index = groups.findIndex((g) => g.id === groupId);
      if (index >= 0) groups.splice(index, 1);
    }
  );
}

/**
 * 保留分组：**谁写的变量就落在谁那一组**。
 *
 * 脚本 env.set() 写的 → 「脚本变量」；声明式「提取变量」拿到的 → 「提取的变量」。
 * 分两家是因为名字要对得上事实：提取出来的 token 从来没经过任何脚本，混在
 * 「脚本写入的变量」里，用户会以为自己的脚本在乱写（真有人这么报过）。
 *
 * 导入时那套「按分组名还原 id」（RESERVED_ENV_GROUP_IDS）由这张表派生，
 * 以后加保留分组只改这一处。
 */
const RESERVED_GROUPS = {
  script: { id: 'g-script', name: '脚本变量' },
  extract: { id: 'g-extract', name: '提取的变量' },
};

/**
 * 取某个保留分组，没有就建。
 *
 * 新建的放在末尾：读端是「后覆盖前」，刚写进去的这份得是生效的那份。
 */
function reservedGroup(env, { id, name }) {
  if (!Array.isArray(env.groups)) env.groups = [];
  let group = env.groups.find((g) => g.id === id);
  if (!group) {
    group = { id, name, vars: [] };
    env.groups.push(group);
  }
  if (!Array.isArray(group.vars)) group.vars = [];
  return group;
}

/**
 * 写入当前环境的变量：找**真正生效的那一处**改值，没有就放进自己那一组。
 *
 * 顺序必须和读取端（envVars / vars）一致，否则会出现「写进去了却没生效」：
 *   1. 用户级覆盖环境级 —— 所以先找当前用户，它优先级最高；
 *   2. 环境级里同一 key 可能出现在多个分组，生效的是**最后一个**（后覆盖前），
 *      所以要改最后一个，而不是第一个 —— 改被遮住的那个等于没改。
 *
 * @param {'script'|'extract'} [source] 谁在写：脚本 / 声明式提取。默认脚本那条路
 */
export function setEnvVar(key, value, source = 'script') {
  const env = activeEnv.value;
  if (!env) return;

  // 1) 当前用户的认证信息里已有同名变量
  const user = activeUser.value;
  if (user) {
    const found = (user.vars || []).find((v) => v.key === key);
    if (found) {
      found.value = value;
      found.enabled = true;
      return;
    }
  }

  const group = RESERVED_GROUPS[source] || RESERVED_GROUPS.script;
  const otherId =
    group.id === RESERVED_GROUPS.script.id ? RESERVED_GROUPS.extract.id : RESERVED_GROUPS.script.id;

  // 2) 环境级分组里的同名变量：取最后一个命中的。
  //    另一个保留组先跳过 —— 落在那边说明来源换了一路，交给第 3 步「搬家」
  let target = null;
  (env.groups || []).forEach((item) => {
    if (item.id === otherId) return;
    const found = (item.vars || []).find((v) => v.key === key);
    if (found) target = found;
  });
  if (target) {
    target.value = value;
    target.enabled = true;
    return;
  }

  // 3) 没有现成落点 -> 进自己那一组。要是同一个 key 之前落在另一个保留组里，
  //    先把它删掉：两份并存的话「哪一份生效」就取决于分组顺序，而这个函数最怕
  //    的恰恰是「写进去了却没生效」
  const other = (env.groups || []).find((g) => g.id === otherId);
  const stale = other ? (other.vars || []).find((v) => v.key === key) : null;
  if (stale) other.vars.splice(other.vars.indexOf(stale), 1);

  reservedGroup(env, group).vars.push({ enabled: true, key, value });
}

/** 删除变量：环境级分组和当前用户的认证信息里都找一遍。 */
export function unsetEnvVar(key) {
  const env = activeEnv.value;
  if (!env) return;
  const scopes = [...(env.groups || []), activeUser.value].filter(Boolean);
  scopes.forEach((scope) => {
    if (!Array.isArray(scope.vars)) return;
    const index = scope.vars.findIndex((v) => v.key === key);
    if (index >= 0) scope.vars.splice(index, 1);
  });
}

// ------------------------------- 导入 OpenAPI -------------------------------

/**
 * 待确认的导入。
 *
 * 解析完先放这儿，等用户看过预览、点了确认才真正写进项目。
 * 不直接落盘的理由：真实文档的写法千差万别，解析出 0 个请求、
 * 或者跳过了大半个文档的情况都不少见 —— 先让人看一眼，
 * 好过导进去一个残缺的接口、再自己费劲删掉。
 */
export const importPreview = reactive({
  open: false,
  name: '',
  /** 扁平的全部请求，只用于预览列表与计数 */
  requests: [],
  /**
   * 文档里分好的导入内容：`[{ name, dirs, requests }]`，**每一项对应落下来的一个
   * 顶层目录**。
   *
   * 单份文档就一项；多份文档（导出范围选「全部」）有几项就是几个顶层目录 ——
   * 以前一律并成一份，文档里的分组就没了。
   */
  bundles: [],
  /** 文档内嵌的环境与账号，确认时写进环境变量页 */
  environments: [],
  /** 文档里记着导出时选中的环境 / 账号名，导入后顺手选上 */
  activeEnvName: '',
  activeUserName: '',
  warnings: [],
  error: '',
  /** 项目里已有同名顶层目录时填它的名字，确认时整个替换掉 */
  overwriteId: '',
});

/**
 * 读一个本地文件，解析成待确认的导入。
 *
 * 出错也把预览框打开 —— 让用户看到「为什么没导进来」，
 * 总好过点了按钮没反应、不知道发生了什么。
 */
export async function readOpenApiFile(file) {
  resetImport();
  try {
    const text = await file.text();
    const doc = await parseDocument(text);

    // 取不到 info.title 时用文件名兜底，去掉扩展名
    const fallback = String(file.name || '').replace(/\.(ya?ml|json)$/i, '').trim();
    const { bundles, requests, environments, activeEnvName, activeUserName, warnings } =
      toBundles(doc, fallback || '导入的接口');

    // 「有没有同名目录会被替换」只为了预览里给个警示，真正的匹配在确认时按名字逐个做
    const mine = (activeProject.value?.dirs || []).filter((d) => !d.parentId);
    const clash = bundles.find((item) => mine.some((d) => d.name === item.name));

    importPreview.name = bundles[0]?.name || '';
    importPreview.requests = requests;
    importPreview.bundles = bundles;
    importPreview.environments = environments;
    importPreview.activeEnvName = activeEnvName;
    importPreview.activeUserName = activeUserName;
    importPreview.warnings = warnings;
    importPreview.overwriteId = clash ? clash.name : '';
    importPreview.open = true;
  } catch (e) {
    importPreview.error = e?.message || String(e);
    importPreview.open = true;
  }
}

/**
 * 确认导入：把文档里的内容落进当前项目。
 *
 * 落法：**文档里每一项（原来叫「集合」）变成一个顶层目录**，内容原样装在里面 ——
 * 它根上的请求（未分组那部分）挂在顶层目录下，它里面的目录还是目录。
 *
 * 项目里已经有同名顶层目录时**整个替换它**：同一份文档导两次不该越堆越深。
 * 替换时「名字 + 方法」对得上的请求**保留原来的 id** —— 方案步骤靠 sourceId
 * 记源头，id 一换，引用它的步骤就全「源头没了」。
 */
export function confirmImport() {
  const project = activeProject.value;
  const bundles = importPreview.bundles || [];
  if (!project || !bundles.length) {
    closeImport();
    return;
  }
  if (!Array.isArray(project.dirs)) project.dirs = [];
  if (!Array.isArray(project.requests)) project.requests = [];

  const importedById = new Map();
  const importedIds = [];

  bundles.forEach((bundle) => {
    const name = String(bundle.name || '').trim() || '导入的接口';

    // 同名顶层目录 = 之前导过同一份文档：先把它整棵子树摘掉，再装新的
    const existing = project.dirs.find((d) => !d.parentId && d.name === name) || null;
    const doomedIds = existing ? subtreeDirIds(project, existing.id) : new Set();
    const doomedRequests = doomedIds.size
      ? project.requests.filter((r) => doomedIds.has(r.dirId))
      : [];

    if (doomedIds.size) {
      // 原地改这两个数组（别换引用）：别处拿的都是同一个
      const keptDirs = project.dirs.filter((d) => !doomedIds.has(d.id));
      const keptReqs = project.requests.filter((r) => !doomedIds.has(r.dirId));
      project.dirs.splice(0, project.dirs.length, ...keptDirs);
      project.requests.splice(0, project.requests.length, ...keptReqs);
    }

    // 顶层目录本体：替换时沿用原来那个（id 不变，指着它的东西都不用改）
    const root = existing
      ? existing
      : {
          id: 'dir-' + uid(),
          name,
          parentId: '',
          sort:
            project.dirs.reduce(
              (max, d) => (d.parentId ? max : Math.max(max, d.sort || 0)),
              -1
            ) + 1,
        };
    if (!existing) project.dirs.push(root);
    root.name = name;

    // 文档里的目录：换成新 id，父级按映射重指 —— 原来在「项目根」下的挂到顶层目录下
    const dirIdMap = new Map();
    const incomingDirs = bundle.dirs || [];
    incomingDirs.forEach((d) => dirIdMap.set(d.id, 'dir-' + uid()));
    incomingDirs.forEach((d) => {
      project.dirs.push({
        id: dirIdMap.get(d.id),
        name: String(d.name || '').trim() || '未命名目录',
        parentId: d.parentId && dirIdMap.has(d.parentId) ? dirIdMap.get(d.parentId) : root.id,
        sort: typeof d.sort === 'number' ? d.sort : 0,
      });
    });

    (bundle.requests || []).forEach((r, i) => {
      const old = doomedRequests.find((e) => e.name === r.name && e.method === r.method);
      const row = {
        ...r,
        id: old ? old.id : 'req-' + uid(),
        // 文档里在「项目根」上的请求，落到顶层目录下（也就是它的「未分组」）
        dirId: r.dirId && dirIdMap.has(r.dirId) ? dirIdMap.get(r.dirId) : root.id,
        // 文档里带着同级次序就用它，别按数组下标重排 —— 目录与请求共用一套 sort
        sort: typeof r.sort === 'number' ? r.sort : i,
      };
      project.requests.push(row);
      importedById.set(row.id, row);
      importedIds.push(row.id);
    });
  });

  // 文档里内嵌的环境与账号：写进环境变量页
  applyImportedEnvironments(
    importPreview.environments,
    importPreview.activeEnvName,
    importPreview.activeUserName
  );

  // 被替换掉的那些请求可能已经不存在了 —— 对应的标签页得收掉，
  // 否则会留着几个指向空气的壳
  const alive = new Set(allRequests.value.map((r) => r.id));
  dropTabsOf(state.tabs.filter((t) => !alive.has(t.requestId)).map((t) => t.requestId));

  // 「名字 + 方法」对得上、id 被保留的那些请求，内容已经被文档替换了：
  // 开着的标签页得跟着刷新，否则下一次保存会拿导入前的旧 draft 把导入结果盖回去
  state.tabs.forEach((tab) => {
    const request = importedById.get(tab.requestId);
    if (!request) return;
    tab.draft = clone(request);
    tab.baseline = clone(request);
    tab.isNew = false;
  });

  // 直接切到第一个导入的请求，让用户马上看到结果
  if (importedIds.length) openRequest(importedIds[0]);

  closeImport();
}

function resetImport() {
  importPreview.open = false;
  importPreview.name = '';
  importPreview.requests = [];
  importPreview.bundles = [];
  importPreview.environments = [];
  importPreview.activeEnvName = '';
  importPreview.activeUserName = '';
  importPreview.warnings = [];
  importPreview.error = '';
  importPreview.overwriteId = '';
}

/**
 * 保留分组 id：**分组名 → id**。
 *
 * `g-script` / `g-extract` 被 EnvPage 单列成只读区（脚本写的 / 提取来的），
 * `g-base` 是「基础配置」（baseUrl 默认待的那个组）。导出侧只写得到组名，
 * 回导时按名字还原 —— 不还原的话，导入后再跑脚本会**另起一个**「脚本变量」，
 * 环境里就出现两个同名分组，用户手里那个还是死的。
 */
const RESERVED_ENV_GROUP_IDS = {
  基础配置: 'g-base',
  ...Object.fromEntries(Object.values(RESERVED_GROUPS).map((g) => [g.name, g.id])),
};

/**
 * 把导入文档里内嵌的环境写进 state.environments。
 *
 * 同名环境**就地替换**（分组与账号整体覆盖），名字对不上的新建一个 ——
 * 反复导入同一份文档不会堆出一串重名环境。
 */
function applyImportedEnvironments(list, activeEnvName, activeUserName) {
  if (!Array.isArray(list) || !list.length) return;

  const varsOf = (rows) =>
    (rows || [])
      .filter((v) => String(v?.key || '').trim())
      .map((v) => ({
        // 导出侧只给停用的行写 enabled: false；别的工具手写的文档没这个字段，按启用算
        enabled: v.enabled !== false,
        key: String(v.key).trim(),
        value: v.value === undefined || v.value === null ? '' : String(v.value),
      }));

  const applied = [];
  list.forEach((raw) => {
    const name = String(raw?.name || '').trim();
    if (!name) return;
    const usedGroupIds = new Set();
    const groups = (raw.groups || []).map((g) => {
      const groupName = String(g?.name || '').trim() || '未命名分组';
      // 「基础配置」「脚本变量」「提取的变量」是保留分组，id 有特殊含义，按名字还原（重名只认第一个）
      const reserved = RESERVED_ENV_GROUP_IDS[groupName];
      const id = reserved && !usedGroupIds.has(reserved) ? reserved : 'g-' + uid();
      usedGroupIds.add(id);
      return { id, name: groupName, vars: varsOf(g?.vars) };
    });
    const users = (raw.users || []).map((u) => ({
      id: 'u-' + uid(),
      name: String(u?.name || '').trim() || '未命名用户',
      vars: varsOf(u?.vars),
    }));

    const existing = state.environments.find((e) => e.name === name);
    if (existing) {
      existing.groups = groups;
      existing.users = users;
      applied.push(existing);
    } else {
      const env = { id: 'env-' + uid(), name, groups, users };
      state.environments.push(env);
      applied.push(env);
    }
  });

  // 文档里记着导出时选中的环境 / 账号，导进来就顺手选上
  const target = applied.find((e) => e.name === String(activeEnvName || '').trim());
  if (target) {
    state.activeEnvId = target.id;
    const userName = String(activeUserName || '').trim();
    const user = userName ? target.users.find((u) => u.name === userName) : null;
    state.activeUserId = (user || target.users[0])?.id || '';
  }

  // 文档没记选中环境（或选中项已失效）时兜底，别让「页面显示着环境、操作却没反应」
  ensureActiveEnvValid();
}

export function closeImport() {
  resetImport();
}

// ---------------------------------------------------------------------------
// 接口导出（OpenAPI 3.0）
//
// 只读快照：不碰任何存档数据，导出失败也不会留下半截状态。
// 弹窗导出完不自动关 —— warnings 值得人看一眼，关了就再也找不回来。
// ---------------------------------------------------------------------------

export const exportDialog = reactive({
  open: false,
  error: '',
  warnings: [],
  /** 成功导出后写这里，弹窗拿它显示「已导出：xxx」 */
  exportedName: '',
});

export function openExport() {
  exportDialog.open = true;
  exportDialog.error = '';
  exportDialog.warnings = [];
  exportDialog.exportedName = '';
}

export function closeExport() {
  exportDialog.open = false;
  exportDialog.error = '';
  exportDialog.warnings = [];
  exportDialog.exportedName = '';
}

/**
 * 按弹窗选项生成文档并触发浏览器下载。
 *
 * 文档里的 `x-posmax-collections` 是**文件格式**的一部分（别的工具不认，但 PostMax
 * 自己回导要靠它），所以照旧写一个条目：名字取项目名，目录树与请求原样带出去。
 * 回导时这个条目会变成一个同名顶层目录（见 confirmImport）—— 也叫「接口」，
 * 划分清楚，导两次不会越堆越深。
 *
 * @param {{scope:'project'|'selected', selection?:string[],
 *          includeEnv?:boolean, format?:'json'|'yaml', version?:'3.0'|'3.1'}} opts
 */
export function runExport(opts = {}) {
  const project = activeProject.value;
  if (!project) {
    exportDialog.error = '没有活动项目。';
    return;
  }

  const all = project.requests || [];
  const picked =
    opts.scope === 'selected' ? all.filter((r) => (opts.selection || []).includes(r.id)) : all;
  if (!picked.length) {
    exportDialog.error = '选定的范围里没有可导出的请求。';
    return;
  }

  const title = project.name;
  const collections = [
    {
      name: project.name,
      // 目录树一并带上，回导时能还原层级
      dirs: project.dirs || [],
      requests: picked,
    },
  ];

  try {
    const withEnv = opts.includeEnv === true;
    const { doc, warnings } = buildDocument({
      title,
      description: project.description,
      specVersion: opts.version === '3.1' ? '3.1' : '3.0',
      collections,
      // 环境的值（含账号里的 token）原样写出 —— 勾选项上的警示归弹窗管
      environments: withEnv ? state.environments : undefined,
      activeEnvName: withEnv ? activeEnv.value?.name || '' : '',
      activeUserName: withEnv ? activeUser.value?.name || '' : '',
    });

    const asYaml = opts.format === 'yaml';
    const text = asYaml ? dumpYaml(doc) : JSON.stringify(doc, null, 2);
    const filename = exportFileName(title, asYaml ? 'yaml' : 'json');
    downloadText(filename, text, asYaml ? 'text/yaml;charset=utf-8' : 'application/json;charset=utf-8');

    exportDialog.warnings = warnings;
    exportDialog.exportedName = filename;
  } catch (e) {
    exportDialog.error = e?.message || String(e);
  }
}

// ------------------------------- 历史 -------------------------------

/**
 * 一条历史 = 一次调用的快照，两侧都留：
 *
 *   request   原始定义（含 {{变量}}）—— 重放要用它，否则换个环境就发不出去了
 *   detail    后端回来的整份结果（实际发出的请求 + 响应）
 *
 * 光记 method / url / status 是不够的：一个配了 header 和 body 的请求，事后回看
 * 只剩个壳，也说不清当时到底发出去了什么 —— 而那正是「历史」唯一的用处。
 */

/** 响应体落盘的再截一刀。后端那份保留上限是给「当时看」的，这里是要写文件的 */
const HISTORY_BODY_LIMIT = 64 * 1024;

export const activeHistory = computed(
  () => state.history.find((h) => h.id === state.activeHistoryId) || null
);

/** 历史能不能载入成新请求 —— 得有个项目放它 */
export const canReplayHistory = computed(() => !!activeProject.value);

function clipHistory(result) {
  const body = result.body || '';
  const clipped = body.length > HISTORY_BODY_LIMIT;
  if (!clipped) return result;
  // 后端截的是「太大不往下传」，这里截的是「太大不落盘」，两件事各自标记
  return { ...result, body: body.slice(0, HISTORY_BODY_LIMIT), bodyClipped: true };
}

/**
 * 点一条历史：右侧看这条记录本身。
 *
 * 以前这里顺手把对应的请求也打开了。但当前页面是历史页，右侧那条分支根本不显示
 * 编辑器 —— 点下去什么都不会发生，只有左栏高亮变了一下。历史是「发生过什么」的
 * 只读快照，跟「这个请求现在长什么样」是两回事；想再发一次，用「载入到新请求」。
 */
export function openHistory(entry) {
  state.activeHistoryId = entry.id;
}

/**
 * 拿一条历史开一个新的未保存请求。
 *
 * 用**原始定义**而不是实际发出的那份：实际那份里的 {{baseUrl}} 已经换成真地址了，
 * 换到别的环境就跑不动。不直接改原请求 —— 用户点这个是「拿当时那份再发一次」，
 * 多半还要改改，所以开成新标签页，存不存由他决定。
 */
export function replayHistory(entry) {
  const origin = entry.request;
  if (!origin || !activeProject.value) return;

  const request = blankRequest();
  request.name = origin.name || '来自历史';
  request.method = origin.method || 'GET';
  request.url = origin.url || '';
  request.headers = (origin.headers || []).map((h) => ({ ...h }));
  request.params = (origin.params || []).map((p) => ({ ...p }));
  request.pathParams = (origin.pathParams || []).map((p) => ({ ...p }));
  request.body = origin.body || '';
  request.bodyType = origin.bodyType || 'json';
  request.bodyForm = (origin.bodyForm || []).map((f) => ({ ...f }));

  pushTab(request, true);
  // 载入完就切过去，否则新开的标签页在另一个页面里，等于什么都没发生
  state.nav = 'api';
}

export function clearHistory() {
  if (!state.history.length) return;
  askConfirm('清空历史', `确定清空全部 ${state.history.length} 条历史记录吗？`, () => {
    state.history = [];
    state.activeHistoryId = '';
  }, '确定');
}

/**
 * 清空「自动化运行」的历史。
 *
 * 只清运行记录，不动方案本身 —— 和清空接口历史一个道理：删的是「发生过什么」，
 * 不是产生这份记录的东西。会话里那份带响应体的缓存也一起清：留着的话报告页
 * 还翻得到刚删掉的那几次，「清空了怎么还在」比不清更让人糊涂。
 *
 * **正在跑的那一份除外**：引擎还在往它上面写，删了这一轮就没地方落结果了。
 */
export function clearPlanRunHistory() {
  const total = allPlanRuns.value.length;
  if (!total) return;
  askConfirm('清空运行历史', `确定清空全部 ${total} 条运行记录吗？`, () => {
    state.planRuns = {};

    const running = state.planRunning ? state.planRunningId : '';
    Object.keys(state.planRunCache).forEach((planId) => {
      if (planId !== running) delete state.planRunCache[planId];
    });

    state.activeHistoryRunPlanId = '';
    state.activeHistoryRunAt = 0;
    // 报告页摊开的那份可能刚被清掉：收回「这个方案现在该显示的那一份」
    state.planRun = planRunFor(running || activePlanTab.value?.planId);
  }, '确定');
}

// ------------------------------- 控制台 -------------------------------
//
// 脚本里 console.* 的输出**只在这里**——它不是请求日志（那是「历史记录」那一栏的活），
// 收的就是「脚本想说的话」。会话级、不落盘：运行记录是精简摘要，日志可能很长，
// 而且脚本产物本来就是跑完即弃的东西。

/** 上限：再多也不是给人看的了，超了丢最旧并累计 dropped */
const CONSOLE_LIMIT = 1000;

export const consoleLog = reactive({ entries: [], dropped: 0 });

let consoleSeq = 0;

/**
 * 收一次脚本执行的日志。
 *
 * @param {string} source 出处说明（请求名 / 方案·第几步）
 * @param {'pre'|'post'} phase 哪一段脚本
 * @param {Object} run script.js 的返回值
 */
function pushConsole(source, phase, run) {
  const at = Date.now();
  (run.logs || []).forEach((entry) => {
    consoleLog.entries.push({
      id: ++consoleSeq,
      at,
      source,
      phase,
      level: entry.level || 'log',
      args: entry.args || [],
    });
  });
  if (run.droppedLogs) consoleLog.dropped += run.droppedLogs;

  const overflow = consoleLog.entries.length - CONSOLE_LIMIT;
  if (overflow > 0) {
    consoleLog.entries.splice(0, overflow);
    consoleLog.dropped += overflow;
  }
}

export function clearConsole() {
  consoleLog.entries = [];
  consoleLog.dropped = 0;
}

/** 脚本执行结果里要落进结果对象/界面那几项 */
const pickRun = (run) => ({
  ok: run.ok,
  error: run.error,
  logs: run.logs,
  droppedLogs: run.droppedLogs,
  changes: run.changes,
  removals: run.removals,
});

/**
 * 方案运行里：把一次脚本执行挂到某一步上（报告里就地看），
 * 同时进会话控制台（汇总看）。`entry.scripts` 不在 STEP_KEEP 里 —— 不落盘。
 */
function attachScriptRun(entry, phase, run, planLabel) {
  if (!entry.scripts) entry.scripts = { pre: null, post: null };
  entry.scripts[phase] = pickRun(run);
  pushConsole(`${planLabel} · 第${entry.no}步`, phase, run);
}

// ------------------------------- 发请求 -------------------------------

/**
 * 正在飞的那一次发送。点「停止」就是把它叫停。
 *
 * 为什么要有：api.send 本来就收 signal（方案运行的「停止」在用），单个请求却没接上 ——
 * 打到一个连不上的地址只能干等超时，界面上那颗按钮还一直是灰的。
 *
 * 注意只能叫停**等待**：请求可能已经发给上游了，这里只是不再等它回来
 * （前端一断开，这次响应就丢掉了）。
 */
/** 叫停正在发送的那一次。没在发就什么都不做 */
export function stopSend() {
  runtime.sendAbort?.abort();
}

export async function sendRequest() {
  const request = activeRequest.value;
  if (!request || state.sending) return;

  state.sending = true;
  state.error = '';
  state.cancelled = false;
  state.response = null;
  state.assertionResults = [];
  // 控制台只反映这一次：发之前先清掉上一批的输出，免得新旧混在一起分不清
  clearConsole();
  runtime.sendAbort = new AbortController();

  try {
    // 1) 前置脚本：跑在 Web Worker 沙箱里，超时会被强制终止
    const run = await runPreScript(request.script, vars.value);
    state.scriptRun = {
      requestId: request.id,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      pre: request.script ? pickRun(run) : null,
      post: null,
    };
    pushConsole(request.name || '未命名请求', 'pre', run);

    // 脚本里改动的变量，这时才真正落到当前环境上
    Object.entries(run.changes).forEach(([key, value]) => setEnvVar(key, value));
    run.removals.forEach((key) => unsetEnvVar(key));

    if (!run.ok) {
      state.error = '前置脚本执行失败：' + run.error;
      return;
    }

    // 2) 发送（此时 vars 已包含脚本刚写入的变量）
    const result = await send(request, vars.value, state.settings, runtime.sendAbort.signal);
    state.response = result;

    // 3) 断言
    state.assertionResults = runAssertions(request.assertions, result);

    // 4) 提取变量写回环境。来源标成 extract：它进「提取的变量」那一组，
    //    不和脚本 env.set() 写的东西混在一起（脚本没碰过这些值）
    runExtracts(request.extracts, result).forEach((item) => {
      if (item.ok) setEnvVar(item.key, formatValue(item.value), 'extract');
    });

    /*
     * 4.5) 后置脚本：响应到手之后跑，声明的断言和提取都做完了，剩下的交给它。
     *
     * 失败**不回退**这次请求：请求已经发出去、结果是真实的，报告里得留下。
     * 只把错误说清楚（界面上红字），历史照记。
     */
    if (request.afterScript) {
      const afterRun = await runPostScript(request.afterScript, vars.value, result);
      state.scriptRun.post = pickRun(afterRun);
      pushConsole(request.name || '未命名请求', 'post', afterRun);

      Object.entries(afterRun.changes).forEach(([key, value]) => setEnvVar(key, value));
      afterRun.removals.forEach((key) => unsetEnvVar(key));

      if (!afterRun.ok) state.error = '后置脚本执行失败：' + afterRun.error;
    }

    // 5) 历史：每次发送都单独记一条，不去重。
    //    前面那几个字段是列表行要用的摘要，detail 才是「点开能看」的那份
    state.history.unshift({
      id: 'h-' + uid(),
      at: Date.now(),
      projectId: state.activeProjectId,
      requestId: request.id,
      name: request.name,
      method: result.request.method,
      url: result.request.url,
      status: result.status,
      time: result.time,
      request: clone(request),
      detail: clipHistory(result),
    });
    state.history = state.history.slice(0, 200);
  } catch (e) {
    // 自己叫停的别说成「失败」—— 那是我们发的信号，不是接口挂了
    if (isAbort(e)) state.cancelled = true;
    else state.error = e?.message || String(e);
  } finally {
    runtime.sendAbort = null;
    state.sending = false;
  }
}

// ------------------------------- 与后端同步 -------------------------------
//
// 数据落在后端的一个 JSON 文件里（见 backend/storage.py）。
// 前端不做离线存储：换个浏览器、清一次站点数据，数据都还在。

/**
 * 会被写进文件的字段，必须和 backend/storage.py 的 PERSISTED_KEYS 保持一致。
 *
 * 其余字段（当前视图、侧栏宽度、拖拽出的高度、响应内容、发送历史里选中的那条…）
 * 都是会话状态 —— 刷新就该回到默认，刻意不存。
 */
const PERSISTED_KEYS = [
  'projects',
  'environments',
  'activeEnvId',
  'activeUserId',
  'settings',
  'history',
  'planRuns',
  // 存档格式版本：跟着写回去，后端才知道这份数据是哪个版本写的
  'version',
];

/** 同步状态，用来在界面上提示「已保存 / 保存中 / 连不上后端」。 */
export const syncState = reactive({
  ready: false,
  saving: false,
  error: '',
  savedAt: 0,
  /** 后端每次写入自增的号。保存时带回去，后端就能发现「别处也改过」 */
  revision: 0,
  /** 检测到另一个实例改过：暂停自动保存，等用户选「载入磁盘」还是「用我的覆盖」 */
  conflict: false,
  /** 存档版本比本程序新，已停用自动保存（只看不写） */
  readOnly: false,
  /** 读到的那份存档的版本号（比本程序新时非 0，用来给顶栏写提示） */
  newerVersion: 0,
});

function snapshot() {
  const payload = {};
  PERSISTED_KEYS.forEach((key) => {
    payload[key] = state[key];
  });
  return payload;
}

/**
 * 落盘：在途的那次能不能和后面排队的那次合并（那几个开关在文件顶部的 runtime 里）。
 *
 * 防抖只保证「不会连发一串」，保证不了两次请求不重叠：慢盘上第一次还没回来
 * 就又改了，两次 PUT 的 body 是各自发起那一刻的快照 —— 先发的后到就会把
 * 新数据盖回旧值。所以同时只允许一个在途，期间的改动排队补写一次。
 */

/**
 * 立刻把当前数据整份写回后端。
 *
 * @param {{force?: boolean}} [options] force 只有「用我的覆盖」会传：跳过冲突检查。
 */
export async function saveState(options = {}) {
  // 存档比自己新就别写了（见 SCHEMA_VERSION）；冲突没解决前也别写 ——
  // 每 400ms 撞一次 409 只会刷屏
  if (syncState.readOnly) return;
  if (syncState.conflict && !options.force) return;

  if (runtime.saving) {
    runtime.saveAgain = true;
    return runtime.saving;
  }

  syncState.saving = true;
  runtime.saving = (async () => {
    try {
      const res = await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // baseRevision 是这次提交的基线：后端拿它和盘上的对比，对不上就是别人改过
        body: JSON.stringify({
          ...snapshot(),
          baseRevision: syncState.revision,
          force: !!options.force,
        }),
      });

      if (res.status === 409) {
        // 另一个窗口改过这份数据。不写，也不再自动重试 —— 等用户决定
        syncState.conflict = true;
        syncState.error = '';
        return;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);

      const data = await res.json().catch(() => ({}));
      if (typeof data.revision === 'number') syncState.revision = data.revision;
      syncState.conflict = false;
      syncState.error = '';
      syncState.savedAt = Date.now();
    } catch (e) {
      syncState.error = (e && e.message) || String(e);
    } finally {
      syncState.saving = false;
      runtime.saving = null;
    }
  })();

  const inflight = runtime.saving;
  await inflight;

  // 期间又改过：补一次，确保磁盘上停的是最后那份状态
  if (runtime.saveAgain) {
    runtime.saveAgain = false;
    await saveState(options);
  }
}

/**
 * 冲突处理之一：**用本窗口的数据覆盖磁盘**。
 *
 * 会丢掉另一个窗口的改动，所以只在用户明确点了之后才走（force 跳过冲突检查）。
 */
export async function resolveConflictKeepMine() {
  // 先解开闸门，否则 saveState 一看 conflict 就直接返回了
  syncState.conflict = false;
  await saveState({ force: true });
  if (syncState.error) syncState.conflict = true; // 没写成就还是冲突态，让用户再选
}

/**
 * 冲突处理之二：**丢掉本窗口没落盘的改动，改成磁盘上的那份**。
 *
 * 走的是和启动时同一套装载逻辑（applyState），所以字段补齐、选中项兜底、
 * 标签页清理只有一份实现，两条路径不会慢慢长歪。
 */
export async function reloadFromDisk() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    applyState(await res.json());
    syncState.conflict = false;
    syncState.error = '';
    syncState.savedAt = Date.now();
  } catch (e) {
    syncState.error = (e && e.message) || String(e);
  }
}

/** 防抖保存：连着改十几处（比如拖拽、批量命名）也只写一次文件。 */
function scheduleSave() {
  if (!syncState.ready) return;
  // 存档比自己新 / 冲突没解决：先别写，等用户处理（见 syncState 上那几行说明）
  if (syncState.readOnly || syncState.conflict) return;
  clearTimeout(runtime.saveTimer);
  runtime.saveTimer = setTimeout(saveState, 400);
}

/**
 * 把后端给的那份数据装进内存。
 *
 * 启动时与「冲突后载入磁盘」共用这一份：字段补齐、选中项兜底、标签页清理只有
 * 一处实现，两条路径不会慢慢长歪。
 */
function applyState(data) {
  // 重载把整份状态都换了：挂起的测试数据同步是旧 draft 的，放出去会拿旧盖新
  clearTimeout(dataSyncTimer);
  dataSyncTimer = 0;

  // 存档版本比自己新：只看不写（写回去会抹掉只有新版本才有的字段）
  const incoming = Number(data.version) || 0;
  syncState.newerVersion = incoming > SCHEMA_VERSION ? incoming : 0;
  syncState.readOnly = incoming > SCHEMA_VERSION;
  if (typeof data.revision === 'number') syncState.revision = data.revision;

  PERSISTED_KEYS.forEach((key) => {
    const value = data[key];
    if (value === undefined || value === null || value === '') return;

    if (key === 'settings') {
      // 与默认值合并，而不是整个替换：以后往设置里加新项时，老存档里没有这一项，
      // 直接替换会让它变成 undefined —— 界面上就是输入框空白、复选框没勾，
      // 但实际行为又还是默认值，看起来像坏了
      state.settings = { ...state.settings, ...value };
      return;
    }
    state[key] = value;
  });

  // 落盘那份永远记「本程序写的是哪个版本」：老存档里的 0 / 缺失不该被当成新版本写回去
  state.version = SCHEMA_VERSION;

  // 老存档里 planRuns 存的是单次运行，这里统一成数组
  normalizePlanRuns();
  // 老存档里的「集合」并进接口树，顺便把坏指针提到根上
  normalizeProjects();
  // 存档里记的环境可能已经被删了，别让选中项悬空（环境页会回退显示，store 不会）
  ensureActiveEnvValid();

  // 磁盘上可能已经没有某些请求 / 方案了（另一个窗口删过）：收掉指向空气的标签页。
  // 只收「源已经不在」的那些，还在的标签页（哪怕有未保存的草稿）一律不动。
  const alive = new Set(allRequests.value.map((r) => r.id));
  dropTabsOf(state.tabs.filter((t) => !alive.has(t.requestId)).map((t) => t.requestId));
  const planIds = new Set((activeProject.value?.plans || []).map((p) => p.id));
  state.planTabs.filter((t) => t.planId && !planIds.has(t.planId)).forEach((t) => dropPlanTab(t.id));
}

/**
 * 启动时读后端存档。
 *
 * 后端是空的时候也先写一次 —— 让数据文件立刻落地，
 * 用户能马上在磁盘上看到它，而不用等第一次改动才出现。
 */
export async function loadState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // 「后端是空的」只看项目和环境下有没有内容。
    // 不能把 settings 算进来 —— 设置永远带着默认值，永远不为空
    const isEmpty =
      (data.projects || []).length === 0 && (data.environments || []).length === 0;

    syncState.ready = true;
    applyState(data);

    if (isEmpty) {
      // 立刻写一次，让数据文件落地（此时盘上还没有旧档，备份逻辑自己会跳过）
      await saveState();
    }
  } catch (e) {
    // 后端没起来也要能用：数据留在内存里，只是刷新会丢，界面顶部会提示
    syncState.ready = false;
    syncState.error = (e && e.message) || String(e);
  }
}

// 数据一变就安排保存。深度监听是必要的：往项目里加个请求、改个环境变量，
// 都发生在嵌套层级里。
watch(
  () => PERSISTED_KEYS.map((key) => state[key]),
  scheduleSave,
  { deep: true }
);

/**
 * 测试数据一改就落盘。
 *
 * 步骤、变量那些改了都得按「保存」，数据不一样 —— 它要么是导进来的一份 CSV，
 * 要么是手敲的一张表，都是「录进来的资料」。忘了保存就刷新，整张表没了。
 *
 * 顺手把 baseline 一起跟上：不跟的话这份数据会一直算作「未保存的改动」，
 * 标签上那个点永远消不掉。
 *
 * 同步防抖 250ms：deep watch 本身每次按键都会进来，而回调里的「先比再写」
 * 是对整张表 stringify —— 几百行的表逐键比三遍，比打字还卡。等手停了再同步，
 * draft / tab / plan 在**触发那一刻**就抓下来，晚点写也不会写错地方；
 * 重载存档（applyState）时直接丢弃挂起的同步，免得拿旧数据盖新的。
 */
let dataSyncTimer = 0;

watch(
  () => [planDraft.value?.data, planDraft.value?.dataLimit],
  () => {
    const draft = planDraft.value;
    const tab = activePlanTab.value;
    const plan = (activeProject.value?.plans || []).find((p) => p.id === tab?.planId);
    if (!draft || !tab || !plan) return;

    clearTimeout(dataSyncTimer);
    dataSyncTimer = setTimeout(() => syncPlanData(draft, tab, plan), 250);
  },
  { deep: true }
);

function syncPlanData(draft, tab, plan) {
  dataSyncTimer = 0;

  // 写之前先比：值一样就别碰。给一个本来没有这个键的对象赋一次值（哪怕值也是
  // 空的），键就凭空多出来了 —— 而「未保存」是拿 JSON 字符串比的，多一个键
  // 就算改过了。这里的差别全在「有没有这个键」上，不在值上。
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keep = (v) => (v == null ? v : clone(v));

  if (!same(plan.data, draft.data)) plan.data = keep(draft.data);
  if (plan.dataLimit !== draft.dataLimit) plan.dataLimit = draft.dataLimit;
  if (!same(tab.baseline.data, draft.data)) tab.baseline.data = keep(draft.data);
  if (tab.baseline.dataLimit !== draft.dataLimit) tab.baseline.dataLimit = draft.dataLimit;
}
