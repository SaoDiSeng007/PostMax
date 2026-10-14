// ---------------------------------------------------------------------------
// 应用入口：只管页面骨架
//
//   store.js  全局状态 + 数据操作
//   ui.js     拖拽、快捷键等视图行为
//   main.js   组件注册、setup 装配、模板、挂载（就是本文件）
// ---------------------------------------------------------------------------
import { computed, createApp, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ProjectPage from './components/ProjectPage.js';
import EnvPage from './components/EnvPage.js';
import SettingsPage from './components/SettingsPage.js';
import FeatureRail from './components/FeatureRail.js';
import Sidebar from './components/Sidebar.js';
import HistoryPanel from './components/HistoryPanel.js';
import HistoryDetail from './components/HistoryDetail.js';
import AutomationPanel from './components/AutomationPanel.js';
import RequestEditor from './components/RequestEditor.js';
import PickBar from './components/PickBar.js';
import RowMenu from './components/RowMenu.js';
import ResponsePanel from './components/ResponsePanel.js';
import ConfirmDialog from './components/ConfirmDialog.js';
import ImportPreview from './components/ImportPreview.js';
import ExportDialog from './components/ExportDialog.js';
import StepPicker from './components/StepPicker.js';
import PlanView from './components/PlanView.js';
import PlanRunPage from './components/PlanRunPage.js';
import PlanRunResult from './components/PlanRunResult.js';
import WorkbenchPanel from './components/WorkbenchPanel.js';
import WorkbenchView from './components/WorkbenchView.js';
import {
  SCHEMA_VERSION,
  state,
  activeEnv,
  activePlanTab,
  activeProject,
  activeRequest,
  activeStep,
  activeTab,
  activeUser,
  activatePlanTab,
  activateTab,
  addBlankStep,
  addStepsToPlan,
  backToProjects,
  clearHistory,
  clearPlanRunHistory,
  clearConsole,
  consoleLog,
  closeConfirm,
  closeEnvPage,
  closePlanTab,
  closeSettings,
  closeStepPicker,
  closeAllTabs,
  closeTab,
  interfaceTree,
  confirmThird,
  confirmYes,
  createDir,
  createEnv,
  createFirstRequest,
  createPlan,
  createProject,
  createRequest,
  createUser,
  dirtyRequestIds,
  duplicatePlan,
  duplicateProject,
  duplicateRequest,
  loadState,
  moveNodes,
  moveStep,
  openEnvPage,
  importPreview,
  importProjectFile,
  readOpenApiFile,
  confirmImport,
  closeImport,
  exportDialog,
  exportProject,
  openExport,
  closeExport,
  runExport,
  openHistory,
  activeHistory,
  canReplayHistory,
  replayHistory,
  openPlanTab,
  openStepPicker,
  openProject,
  openSettings,
  planGroupTree,
  createPlanGroup,
  renamePlanGroup,
  removePlanGroup,
  setPlanGroup,
  togglePlanGroup,
  toggleDir,
  toggleUngrouped,
  allPlanRuns,
  historyRun,
  openHistoryRun,
  setHistoryTab,
  planDraft,
  planDataColumns,
  planIsDirty,
  planTabIsDirty,
  planRunHistory,
  planRunIndex,
  showPlanRun,
  setPlanOnError,
  setPlanRunOptions,
  removeDir,
  removeEnv,
  removeGroup,
  removePlan,
  renamePlan,
  removeProject,
  removeRequest,
  removeRequests,
  removeStep,
  removeSteps,
  renameDir,
  renameRequest,
  reloadFromDisk,
  removeUser,
  requestCount,
  rerunFailedPlan,
  resolveConflictKeepMine,
  runPlan,
  savePlanTab,
  saveTab,
  selectEnv,
  selectRequest,
  selectStep,
  selectUser,
  sendRequest,
  stopSend,
  clearPlanData,
  importPlanData,
  setPlanData,
  createPlanData,
  setPlanDataLimit,
  setPlanEnv,
  setPlanUser,
  setPlanVars,
  planVarMap,
  sessionPlanRun,
  activePlanRunning,
  activePlanRun,
  pausePlan,
  resumePlan,
  openPlanRunPage,
  closePlanRunPage,
  setStepView,
  stepChanged,
  stepSourceMissing,
  stopPlan,
  syncAllSteps,
  syncStep,
  toggleStep,
  envVars,
  selectWorkbenchTool,
  setNav,
  syncState,
  tabCanSave,
  tabIsDirty,
  toggleNav,
  pickedRequestIds,
  vars,
} from './store.js';
import { beginPanScroll, beginResizeResponse, beginResizeSidebar, resizeByKey } from './ui.js';

const App = {
  components: {
    ProjectPage,
    EnvPage,
    SettingsPage,
    FeatureRail,
    Sidebar,
    HistoryPanel,
    HistoryDetail,
    AutomationPanel,
    RequestEditor,
    PickBar,
    ResponsePanel,
    RowMenu,
    ConfirmDialog,
    ImportPreview,
    ExportDialog,
    StepPicker,
    PlanView,
    PlanRunPage,
    PlanRunResult,
    WorkbenchPanel,
    WorkbenchView,
  },
  setup() {
    /** 顶栏上的同步状态。平时就是一句「已保存」，出问题才需要显眼。 */
    const syncText = computed(() => {
      if (syncState.conflict) return '有冲突';
      if (syncState.readOnly) return `只读（存档 v${syncState.newerVersion}）`;
      if (syncState.error) return '保存失败';
      if (syncState.saving) return '保存中…';
      if (!syncState.ready) return '未连接后端';
      return '已保存';
    });

    /** 徽标那句话的完整解释 —— 顶栏太窄，细节挂在 title 上 */
    const syncTitle = computed(() => {
      if (syncState.conflict) {
        return '另一个窗口改过同一份数据，本窗口的改动还没落盘。选「载入磁盘」放弃本窗口的改动，' +
          '或选「用我的覆盖」把本窗口的数据写回去。';
      }
      if (syncState.readOnly) {
        return `存档版本 v${syncState.newerVersion} 比本程序（v${SCHEMA_VERSION}）新，已停用自动保存：` +
          '旧版本读不懂新字段，写回去会把它们抹掉。请用更新的版本打开它，或先备份再降级。';
      }
      return syncState.error || '数据保存在后端目录的 data/data.json';
    });

    /**
     * Ctrl/Cmd + S 保存当前标签页。
     *
     * 手动保存的东西不给快捷键，迟早会因为忘了点而丢内容。顺手把浏览器自带的
     * 「保存网页」也拦掉 —— 不拦的话按下去弹的是下载框，看着像坏了。
     */
    const onKeydown = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      // 保存的是「眼前这一摊」：自动化页存方案，接口页存请求
      if (state.nav === 'automation') savePlanTab();
      else saveTab();
    };
    onMounted(() => window.addEventListener('keydown', onKeydown));
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    /** 方案选的那个环境下的账号列表 —— 和顶栏那两个下拉是一个道理 */
    const planUsers = computed(() => {
      // 运行设置里临时切的环境优先：账号列表得跟着新环境走，不能还停在方案默认那个
      const envId = state.planEnvOverride || planDraft.value?.envId || '';
      const env = state.environments.find((e) => e.id === envId);
      return env?.users || [];
    });

    /**
     * 左栏方案行那个 ⋯ 里点了什么。
     *
     * 三个动作都按方案 id 走 —— 点的是哪一行就动哪一行，
     * 跟右侧现在开着哪个方案没关系。
     */
    const onPlanAction = ({ planId, action }) => {
      if (action === 'rename') return renamePlan(planId);
      if (action === 'duplicate') return duplicatePlan(planId);
      if (action === 'remove') return removePlan(planId);
    };

    /** 左栏目录行那个 ⋯ 里点了什么，和方案行一个路数 */
    const onGroupAction = ({ groupId, action }) => {
      if (action === 'rename') return renamePlanGroup(groupId);
      if (action === 'remove') return removePlanGroup(groupId);
    };

    /** 目录行的 ⋯ 里点了什么 */
    const onDirAction = ({ dirId, action }) => {
      if (action === 'rename') return renameDir(dirId);
      if (action === 'remove') return removeDir(dirId);
    };

    /** 侧栏建请求：可能在项目根（未分组），也可能在某个目录下 */
    const onTreeCreateRequest = ({ dirId }) => createRequest(dirId || '');

    /**
     * 步骤编辑器里的变量表 = 环境 + 用户 + **方案自己的变量** + 测试数据的列名。
     *
     * 方案变量要放进来：不然在方案里定义了一个变量，步骤里打 `{{` 却看不到它，
     * 会被当成「没配的变量」高亮成红的。
     *
     * 列名的值给空串：它真正的值取决于跑到哪一行，编辑时并不知道。
     * 摆进去是为了让打 `{` 弹出的候选里能看见列名 —— 否则只能靠记。
     */
    const stepVars = computed(() => {
      const out = { ...vars.value, ...planVarMap(planDraft.value) };
      planDataColumns.value.forEach((col) => {
        if (!(col in out)) out[col] = '';
      });
      return out;
    });

    /**
     * 方案步骤的 URL 栏用哪份变量表。
     *
     * 和 envVars 一样不含账号的认证信息（token 该写进请求头，不该出现在地址里），
     * 但要把方案自己的变量加进去 —— 地址里引用 {{tenant}} 这类是完全正常的。
     */
    const planUrlVars = computed(() => ({
      ...envVars.value,
      ...planVarMap(planDraft.value),
    }));

    /**
     * 行级键盘操作：Enter / 空格触发这一行的动作。
     *
     * 只在元素自己被聚焦时响应 —— 标签页里还嵌着关闭按钮，事件会冒泡上来，
     * 不判一下的话在关闭按钮上按空格会顺带把标签页切过去。
     */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    // ------------------------------ 标签条 ------------------------------
    /**
     * 标签条**右端固定**：标签页多了就滚到最右，于是最右边那一格永远是刚开的
     * 那个，老的被裁到左边去。被裁掉的那些得在菜单里列出来（它们还在，只是看不见）。
     *
     * 滚的是里面那层 `.tabbar-tabs`，不是外面整条：右端那颗 ＋ 得钉在框里不动。
     * 它要是跟着一起滚，滚到别处时它自己就没了。
     */
    const tabbarEl = ref(null);
    /** 标签页 id → 元素。按 id 存不按下标：关掉一个标签页后下标全挪位，按下标存会量错人 */
    const tabEls = {};
    const setTabEl = (el, id) => {
      if (el) tabEls[id] = el;
      else delete tabEls[id];
    };

    /** 当前被裁掉的标签页 */
    const hiddenTabs = ref([]);

    /** 量一遍谁没露在框里（只量，不动滚动位置） */
    const measureTabs = () => {
      const el = tabbarEl.value;
      if (!el) {
        hiddenTabs.value = [];
        return;
      }
      const box = el.getBoundingClientRect();
      hiddenTabs.value = state.tabs.filter((t) => {
        const node = tabEls[t.id];
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        // 露出一丝就算看得见
        return !(rect.right > box.left + 1 && rect.left < box.right - 1);
      });
    };

    /** DOM 换完再量 —— 标签页刚增删的那一瞬，元素和状态还对不上号 */
    const measureSoon = async () => {
      await nextTick();
      measureTabs();
    };

    /** 新开的标签页在最右，跟着滚过去把它露出来 */
    const scrollTabsToEnd = async () => {
      await nextTick();
      const el = tabbarEl.value;
      if (!el) return;
      el.scrollLeft = el.scrollWidth;
      measureTabs();
    };

    /**
     * 把某个标签页滚进可视区（点左栏、从菜单里跳、关掉当前页后接位都走这里）。
     *
     * 只动标签条自己的 scrollLeft，而且只滚到「看得见」为止：
     * scrollIntoView 会连带滚祖先容器，居中还会把右端的 ＋ 顶出去。
     */
    const revealTab = async (tabId) => {
      await nextTick();
      const el = tabbarEl.value;
      const node = tabEls[tabId];
      if (!el || !node) {
        measureTabs();
        return;
      }
      const box = el.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      if (rect.left < box.left) el.scrollLeft += rect.left - box.left;
      else if (rect.right > box.right) el.scrollLeft += rect.right - box.right;
      measureTabs();
    };

    // 开新标签页 → 滚到最右；切标签页 → 让它自己露出来。
    // 以前两种都滚到最右，于是从菜单里跳到老标签页＝切过去了但看不见
    watch(() => state.tabs.length, (now, before) => {
      if (now > before) scrollTabsToEnd();
      else measureSoon();
    });
    watch(() => state.activeTabId, () => revealTab(state.activeTabId));
    // 切走再切回来标签条是重建的（v-if），scrollLeft 归零，得重新对一次位置
    watch(() => state.nav, () => revealTab(state.activeTabId));
    watch(() => state.sidebarWidth, () => measureSoon());

    const tabMenu = computed(() => {
      const items = [
        { id: 'new', label: '＋ 新建请求' },
        { id: 'close-all', label: '关闭所有' },
        { id: 'close-others', label: '关闭其他' },
      ];
      if (hiddenTabs.value.length) {
        items.push({ id: '__sep', label: '', sep: true });
        hiddenTabs.value.forEach((tab) => {
          items.push({ id: 'tab:' + tab.id, label: `${tab.draft.method} ${tab.draft.name}` });
        });
      }
      return items;
    });

    const onTabMenu = (id) => {
      // 凭空新建：保存时会先问「存到哪个目录」
      if (id === 'new') return createRequest('', true);
      if (id === 'close-all') return closeAllTabs();
      if (id === 'close-others') return closeAllTabs(state.activeTabId);
      if (id.startsWith('tab:')) {
        const tabId = id.slice(4);
        activateTab(tabId);
        // 已经就是当前页时上面那次切换不会触发 watch，这里再露一次（幂等，重复了也不动）
        revealTab(tabId);
      }
    };

    return {
      keyActivate,
      tabbarEl, setTabEl, tabMenu, onTabMenu, measureTabs, beginPanScroll,
      syncState,
      syncText,
      syncTitle,
      reloadFromDisk,
      resolveConflictKeepMine,
      state,
      activeProject,
      interfaceTree,
      createDir,
      moveNodes,
      removeDir,
      renameDir,
      toggleDir,
      toggleUngrouped,
      onDirAction,
      onTreeCreateRequest,
      activeRequest,
      activeTab,
      activateTab,
      closeTab,
      saveTab,
      tabCanSave,
      tabIsDirty,
      dirtyRequestIds,
      confirmThird,
      activeEnv,
      activeUser,
      planGroupTree,
      allPlanRuns,
      historyRun,
      openHistoryRun,
      setHistoryTab,
      planDraft,
      planIsDirty,
      planRunHistory,
      planRunIndex,
      showPlanRun,
      activePlanTab,
      setPlanOnError,
      setPlanRunOptions,
      activeStep,
      planUsers,
      stepVars,
      planUrlVars,
      setPlanVars,
      planTabIsDirty,
      addBlankStep,
      addStepsToPlan,
      openPlanTab,
      activatePlanTab,
      closePlanTab,
      createPlan,
      onPlanAction,
      onGroupAction,
      togglePlanGroup,
      createPlanGroup,
      setPlanGroup,
      removePlan,
      renamePlan,
      savePlanTab,
      syncAllSteps,
      syncStep,
      stepChanged,
      stepSourceMissing,
      moveStep,
      toggleStep,
      removeStep,
      removeSteps,
      selectStep,
      openStepPicker,
      closeStepPicker,
      setPlanEnv,
      setPlanUser,
      sessionPlanRun,
      activePlanRunning,
      activePlanRun,
      pausePlan,
      resumePlan,
      openPlanRunPage,
      closePlanRunPage,
      setStepView,
      importPlanData,
      clearPlanData,
      createPlanData,
      setPlanDataLimit,
      rerunFailedPlan,
      runPlan,
      stopPlan,
      vars,
      envVars,
      requestCount,
      openProject,
      backToProjects,
      openEnvPage,
      closeEnvPage,
      openSettings,
      closeSettings,
      closeConfirm,
      confirmYes,
      removeGroup,
      setNav,
      toggleNav,
      selectWorkbenchTool,
      createProject,
      duplicateProject,
      exportProject,
      importProjectFile,
      removeProject,
      createRequest,
      createFirstRequest,
      duplicateRequest,
      removeRequest,
      removeRequests,
      pickedRequestIds,
      renameRequest,
      selectRequest,
      selectEnv,
      selectUser,
      createEnv,
      createUser,
      removeEnv,
      removeUser,
      openHistory,
      activeHistory,
      canReplayHistory,
      replayHistory,
      clearHistory,
      clearPlanRunHistory,
      consoleLog,
      clearConsole,
      sendRequest,
      stopSend,
      importPreview,
      readOpenApiFile,
      confirmImport,
      closeImport,
      exportDialog,
      openExport,
      closeExport,
      runExport,
      beginResizeResponse,
      beginResizeSidebar,
      resizeByKey,
    };
  },
  template: `
    <div class="app">
      <ProjectPage
        v-if="state.view === 'projects'"
        :projects="state.projects"
        @open="openProject"
        @create="createProject"
        @duplicate="duplicateProject"
        @export="exportProject"
        @import="importProjectFile"
        @remove="removeProject"
        @open-env="openEnvPage"
      />

      <EnvPage
        v-else-if="state.view === 'environments'"
        :environments="state.environments"
        :active-env-id="state.activeEnvId"
        :active-user-id="state.activeUserId"
        @back="closeEnvPage"
        @select="selectEnv"
        @create="createEnv"
        @remove="removeEnv"
        @select-user="selectUser"
        @create-user="createUser"
        @remove-user="removeUser"
        @remove-group="removeGroup"
      />

      <SettingsPage
        v-else-if="state.view === 'settings'"
        :settings="state.settings"
        @back="closeSettings"
      />

      <template v-else-if="activeProject">
        <header class="topbar">
          <button
            class="btn-square"
            :class="{ on: state.showNav }"
            :title="state.showNav ? '隐藏侧栏' : '显示侧栏'"
            @click="toggleNav"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <button class="btn-square" title="返回项目列表" @click="backToProjects">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
            </svg>
          </button>
          <div class="brand"><img class="brand-mark" src="./favicon.svg" alt="" /><span>{{ activeProject.name }}</span></div>
          <!--
            全局环境 / 账号只在接口页出现。
            方案自带环境和账号（一个方案可能只在预发跑），自动化页由方案工具条承担；
            同屏两个「环境」下拉，改错哪个都不知道。历史是只读记录，更不需要。
          -->
          <template v-if="state.nav === 'api'">
            <span class="topbar-label">环境</span>
            <select
              class="method-select"
              style="width: 132px; font-weight: 500"
              :value="state.activeEnvId"
              @change="selectEnv($event.target.value)"
            >
              <option v-if="!state.environments.length" value="">还没有环境</option>
              <option v-for="e in state.environments" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
            <span class="topbar-label">用户</span>
            <select
              class="method-select"
              style="width: 132px; font-weight: 500"
              :value="state.activeUserId"
              @change="selectUser($event.target.value)"
            >
              <option v-if="!activeEnv || !activeEnv.users.length" value="">没有账号</option>
              <option v-for="u in (activeEnv ? activeEnv.users : [])" :key="u.id" :value="u.id">
                {{ u.name }}
              </option>
            </select>
          </template>
          <!--
            管理环境变量。自动化页不在这儿放 —— 那边右栏已经有一颗了
            （方案自带环境，和接口页的全局环境是两件事）；
            工作台也不放：它整页都是本地小工具，和环境变量没关系。
          -->
          <button
            v-if="state.nav !== 'automation' && state.nav !== 'workbench'"
            class="btn-square"
            title="管理环境变量"
            @click="openEnvPage"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h9" /><path d="M17 7h3" /><circle cx="15" cy="7" r="2" />
              <path d="M4 17h3" /><path d="M11 17h9" /><circle cx="9" cy="17" r="2" />
            </svg>
          </button>
          <div class="topbar-spacer"></div>
          <span class="topbar-label">
            {{ requestCount }} 个请求
          </span>
          <span
            class="sync-badge"
            :class="{
              err: syncState.error || syncState.conflict || syncState.readOnly,
              saving: syncState.saving,
            }"
            :title="syncTitle"
          >{{ syncText }}</span>
          <!--
            冲突时给两条出路。放在顶栏而不是弹层：冲突不影响继续看数据，
            弹层会拦着人 —— 而用户很可能想先去另一份里抄点东西再决定。
          -->
          <template v-if="syncState.conflict">
            <button
              class="btn btn-sm"
              title="放弃本窗口未落盘的改动，改成磁盘上的那份"
              @click="reloadFromDisk"
            >载入磁盘</button>
            <button
              class="btn btn-sm"
              title="用本窗口的数据覆盖磁盘（另一个窗口的改动会丢）"
              @click="resolveConflictKeepMine"
            >用我的覆盖</button>
          </template>
        </header>

        <div class="layout">
          <FeatureRail
            v-if="state.showNav"
            :nav="state.nav"
            @change="setNav"
            @settings="openSettings"
          />

          <template v-if="state.showNav">
            <aside class="sidebar" :style="{ width: state.sidebarWidth + 'px' }">
              <Sidebar
                v-if="state.nav === 'api'"
                :tree="interfaceTree"
                :active-id="state.activeRequestId"
                :dirty-ids="dirtyRequestIds"
                @select="selectRequest"
                @create-request="onTreeCreateRequest"
                @rename-request="renameRequest"
                @remove-request="removeRequest"
                @remove-requests="removeRequests"
                @duplicate-request="duplicateRequest"
                @import-openapi="readOpenApiFile"
                @export="openExport"
                @create-dir="createDir($event.parentId)"
                @dir-action="onDirAction"
                @toggle-dir="toggleDir"
                @toggle-ungrouped="toggleUngrouped"
                @move-nodes="moveNodes"
              />
              <HistoryPanel
                v-else-if="state.nav === 'history'"
                :history="state.history"
                :runs="allPlanRuns"
                :tab="state.historyTab"
                :active-id="state.activeHistoryId"
                :active-run-at="state.activeHistoryRunAt"
                @open="openHistory"
                @clear="clearHistory"
                @clear-runs="clearPlanRunHistory"
                @open-run="openHistoryRun($event.planId, $event.at)"
                @set-tab="setHistoryTab"
              />
              <!--
                工作台：左栏是工具清单，主区是当前那个工具（见 WorkbenchPanel / WorkbenchView）。
                它和项目本身无关，但入口跟工作区走 —— 和设置页一个处理。
              -->
              <WorkbenchPanel
                v-else-if="state.nav === 'workbench'"
                :active="state.workbenchTool"
                @pick="selectWorkbenchTool"
              />
              <!--
                左栏是「目录 → 方案」两级，是导航。步骤回到右侧主区（见 PlanView）——
                262px 一列塞不下一条流程，只留名字反而要靠展开收起去找。
              -->
              <AutomationPanel
                v-else-if="state.nav === 'automation'"
                :tree="planGroupTree"
                :active-plan-id="activePlanTab ? activePlanTab.planId : ''"
                @open-plan="openPlanTab"
                @create-plan="createPlan"
                @create-group="createPlanGroup"
                @plan-action="onPlanAction"
                @group-action="onGroupAction"
                @toggle-group="togglePlanGroup"
                @move-plan="setPlanGroup($event.planId, $event.groupId)"
              />
            </aside>
            <div
              class="splitter-v"
              title="拖拽调整宽度（键盘：← / →）"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整侧栏宽度"
              :aria-valuenow="state.sidebarWidth"
              tabindex="0"
              @mousedown="beginResizeSidebar"
              @keydown="resizeByKey('sidebar', $event)"
            ></div>
          </template>

          <!--
            勾选接口之后（.picking）：这一栏虚化退后 —— 只盖这一栏，别处不动
            （见 .main.picking）。而这一栏是复杂的编辑器界面，这会儿用不上。

            条件里带着 nav === 'api'，和下面那条浮条**一字不差**：这两件事是一回事
            （虚化是为了让浮条浮上来），判定必须同生同灭。少了这一半的话 —— 勾着几条
            切到自动化 / 历史 / 工作台，浮条不渲染，主区却还糊着一层，人只会以为自己
            的界面坏了，而且没有任何出路（只能切回接口页）。勾选本身照旧留着。
          -->
          <main class="main" :class="{ picking: state.nav === 'api' && pickedRequestIds.length }">
            <!--
              勾选了接口之后的操作条：浮在这一栏的顶上（.pick-float 是 absolute，
              定位参照就是 .main），只在这一栏是接口树时出现。
            -->
            <PickBar
              v-if="state.nav === 'api'"
              :tree="interfaceTree"
              @move-nodes="moveNodes"
              @remove-requests="removeRequests"
            />

            <!--
              右侧内容跟着左侧那一列走。切走时标签页**不清** —— 它们存在 store 的
              state.tabs 里，草稿也在那儿，切回接口直接就在，未保存的编辑一起带回来。
            -->
            <template v-if="state.nav === 'api'">
              <div class="tabbar" v-if="state.tabs.length">
                <div
                  class="tabbar-tabs"
                  role="tablist"
                  aria-label="打开的请求"
                  ref="tabbarEl"
                  @scroll="measureTabs"
                  @mousedown="beginPanScroll"
                >
                  <div
                    v-for="tab in state.tabs"
                    :key="tab.id"
                    :ref="(el) => setTabEl(el, tab.id)"
                    class="tab"
                    :class="{ active: tab.id === state.activeTabId }"
                    :title="tab.draft.url"
                    tabindex="0"
                    role="tab"
                    :aria-selected="tab.id === state.activeTabId ? 'true' : 'false'"
                    @click="activateTab(tab.id)"
                    @keydown="keyActivate($event, () => activateTab(tab.id))"
                  >
                    <span class="tab-method" :class="tab.draft.method">{{ tab.draft.method }}</span>
                    <span class="tab-name">{{ tab.draft.name }}</span>
                    <span v-if="tabIsDirty(tab)" class="tab-dot" title="有未保存的改动"></span>
                    <button class="tab-close" title="关闭这个标签页" @click.stop="closeTab(tab.id)">
                      ✕
                    </button>
                  </div>
                </div>

                <!-- 钉在行末，不跟着滚：它得一直在，才能随时跳回被裁掉的那些 -->
                <RowMenu
                  :items="tabMenu"
                  :width="200"
                  title="标签页操作"
                  label="＋"
                  @pick="onTabMenu"
                />
              </div>

              <template v-if="activeRequest">
                <RequestEditor
                  :request="activeRequest"
                  :vars="vars"
                  :url-vars="envVars"
                  :sending="state.sending"
                  :script-run="state.scriptRun"
                  :can-save="tabCanSave(activeTab)"
                  :style="{ height: state.editorHeight + 'px' }"
                  @send="sendRequest"
                  @stop="stopSend"
                  @save="saveTab()"
                />
                <div
                  class="splitter-h"
                  title="拖拽调整响应区高度（键盘：↑ / ↓）"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="调整响应区高度"
                  :aria-valuenow="state.editorHeight"
                  tabindex="0"
                  @mousedown="beginResizeResponse"
                  @keydown="resizeByKey('response', $event)"
                ></div>
                <ResponsePanel
                  :response="state.response"
                  :sending="state.sending"
                  :error="state.error"
                  :cancelled="state.cancelled"
                  :assertions="state.assertionResults"
                  :console-entries="consoleLog.entries"
                  :console-dropped="consoleLog.dropped"
                  @clear-console="clearConsole"
                />
              </template>

              <div v-else class="card" style="flex: 1">
                <div class="empty">
                  <span class="empty-title">
                    {{ requestCount ? '没有打开任何请求' : '这个项目还没有请求' }}
                  </span>
                  <span class="empty-hint">
                    {{ requestCount
                      ? '在左边点一个请求，它会在上方开一个标签页'
                      : '新建一个请求，或者从 OpenAPI 文档导入一整个目录树' }}
                  </span>
                  <button
                    v-if="!requestCount"
                    class="btn btn-primary btn-sm"
                    @click="createFirstRequest"
                  >＋ 添加 request</button>
                </div>
              </div>
            </template>

            <!--
              历史页选了「自动化运行」里的一条：右侧就地摊开那次报告。
              和接口历史一样是「左列表 + 右侧看内容」，不切页面 —— 看一条记录
              不该把人从当前上下文里搬走。

              两个条件都要：**在哪一栏**（historyTab）和**选了哪条**（historyRun）。
              只看选没选的话，切回「接口请求」栏时右边还挂着上一栏那份报告。
            -->
            <PlanRunResult
              v-else-if="state.nav === 'history' && state.historyTab === 'run' && historyRun"
              :run="historyRun.run"
              :plan-name="historyRun.planName"
              readonly
            />

            <!-- 在这一栏但还没点：给句话，别把接口历史那条详情顶上来 -->
            <div
              class="empty"
              v-else-if="state.nav === 'history' && state.historyTab === 'run'"
            >
              <span class="empty-title">在这里看运行报告</span>
              <span class="empty-hint">在左边点一条运行记录，报告就在这儿摊开</span>
            </div>

            <HistoryDetail
              v-else-if="state.nav === 'history'"
              :entry="activeHistory"
              :can-replay="canReplayHistory"
              @replay="replayHistory(activeHistory)"
            />

            <WorkbenchView
              v-else-if="state.nav === 'workbench'"
              :tool="state.workbenchTool"
            />

            <template v-else-if="planDraft">
              <div class="tabbar" v-if="state.planTabs.length">
                <div
                  v-for="t in state.planTabs"
                  :key="t.id"
                  class="tab"
                  :class="{ active: t.id === state.activePlanTabId }"
                  tabindex="0"
                  role="tab"
                  :aria-selected="t.id === state.activePlanTabId ? 'true' : 'false'"
                  @click="activatePlanTab(t.id)"
                  @keydown="keyActivate($event, () => activatePlanTab(t.id))"
                >
                  <span class="tab-name">{{ t.draft.name }}</span>
                  <span v-if="planTabIsDirty(t)" class="tab-dot" title="有未保存的改动"></span>
                  <button
                    class="tab-close"
                    title="关闭这个方案"
                    @click.stop="closePlanTab(t.id)"
                  >✕</button>
                </div>
              </div>

              <PlanView
                :plan="planDraft"
                :step="activeStep"
                :view="state.stepView"
                :dirty="planIsDirty"
                :environments="state.environments"
                :users="planUsers"
                :step-vars="stepVars"
                :url-vars="planUrlVars"
                :run="state.planRun"
                :session-run="sessionPlanRun"
                :running="activePlanRunning"
                :plan-run-history="planRunHistory"
                :run-index="planRunIndex"
                :changed="stepChanged"
                :missing="stepSourceMissing"
                :editor-height="state.editorHeight"
                @open-picker="openStepPicker"
                @set-view="setStepView"
                @select-step="selectStep"
                @toggle-step="toggleStep"
                @move-step="moveStep($event.from, $event.to)"
                @remove-step="removeStep"
                @remove-steps="removeSteps"
                @sync-step="syncStep"
                @change-env="setPlanEnv"
                @change-user="setPlanUser"
                @change-on-error="setPlanOnError"
                @change-run-options="setPlanRunOptions"
                @change-vars="setPlanVars"
                @create-data="createPlanData"
                @set-data-limit="setPlanDataLimit"
                @pick-run="showPlanRun"
                @save="savePlanTab()"
                @sync-all="syncAllSteps"
                @run="runPlan()"
                @stop="stopPlan"
                @open-run="openPlanRunPage"
                @rerun-failed="rerunFailedPlan()"
                @import-data="importPlanData"
                @clear-data="clearPlanData"
              />
            </template>

            <div v-else class="card" style="flex: 1">
              <div class="empty">
                <span class="empty-title">测试方案</span>
                <span class="empty-hint">左侧新建一个方案，或者点开已有的</span>
              </div>
            </div>

            <!--
              运行页：跑起来自动翻开的那一屏（进度环 / 逐条明细 / 暂停 / 终止）。
              **只铺第三栏**：左边两栏是导航 —— 左栏的方案列表还等着被点开看别的
              方案，糊住它们等于把人的回头路挡上；而这一屏从头到尾讲的都是「主区里
              这件事」。它跟着自动化栏走：切到接口 / 历史，主区照常显示那些内容，
              切回来它还在（运行不受影响）。
            -->
            <PlanRunPage
              v-if="state.planRunPage && activePlanTab && state.nav === 'automation'"
              :plan-name="planDraft ? planDraft.name : ''"
              :plan="planDraft"
              :run="activePlanRun"
              :running="activePlanRunning"
              :paused="state.planPaused"
              @pause="pausePlan"
              @resume="resumePlan"
              @stop="stopPlan"
              @rerun="runPlan()"
              @close="closePlanRunPage"
            />
          </main>
        </div>
      </template>

      <ConfirmDialog
        :open="state.confirm.open"
        :title="state.confirm.title"
        :message="state.confirm.message"
        :confirm-text="state.confirm.confirmText"
        :alert-only="state.confirm.alertOnly"
        :with-input="state.confirm.withInput"
        :input-placeholder="state.confirm.inputPlaceholder"
        :input-value="state.confirm.inputValue"
        :third-text="state.confirm.thirdText"
        :hide-cancel="state.confirm.hideCancel"
        :with-select="state.confirm.withSelect"
        :select-options="state.confirm.selectOptions"
        :select-value="state.confirm.selectValue"
        @confirm="confirmYes"
        @third="confirmThird"
        @cancel="closeConfirm"
      />

      <ImportPreview
        :open="importPreview.open"
        :name="importPreview.name"
        :requests="importPreview.requests"
        :bundle-count="importPreview.bundles.length"
        :env-count="importPreview.environments.length"
        :warnings="importPreview.warnings"
        :error="importPreview.error"
        :overwrite="!!importPreview.overwriteId"
        @confirm="confirmImport"
        @cancel="closeImport"
      />

      <ExportDialog
        :open="exportDialog.open"
        :tree="interfaceTree"
        :env-count="state.environments.length"
        :error="exportDialog.error"
        :warnings="exportDialog.warnings"
        :exported-name="exportDialog.exportedName"
        @export="runExport"
        @close="closeExport"
      />

      <StepPicker
        :open="state.stepPickerOpen"
        :tree="interfaceTree"
        @confirm="addStepsToPlan($event)"
        @manual="addBlankStep"
        @cancel="closeStepPicker"
      />

    </div>
  `,
};

const app = createApp(App);

// 重命名输入框一出现就自动聚焦并全选：
// 只有「先获得焦点、再失焦」才会触发 blur，否则点别处退不出编辑状态。
app.directive('focus', {
  mounted(el) {
    el.focus();
    if (typeof el.select === 'function') el.select();
  },
});

// 先把后端存档读进来再挂载。否则会先渲染一下内存里的示例数据、
// 紧接着被真实数据替换，看起来像界面自己抽了一下
await loadState();

app.mount('#app');
