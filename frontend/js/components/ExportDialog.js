import { computed, defineComponent, onUnmounted, reactive, ref, watch } from 'vue';
import Caret from './Caret.js';
import { enterDialog, leaveDialog, trapTab } from '../dialogFocus.js';
import { allPicked, applyPick, somePicked } from '../pickScope.js';

/**
 * 接口导出（OpenAPI 3.0）弹窗。
 *
 * 范围二选一：全部 / 部分。选「部分」时下面展开勾选树挑接口，选「全部」没有
 * 可配的就不展开。勾选树里的目录可以各自收起 —— 它和侧栏那几棵树是同一套三角（Caret）。
 *
 * 环境和账号可以一并内嵌到同一份文档（x-posmax-environments）——
 * 那是明文值，勾上时必须让人看见红字警示再走。
 *
 * 导出完弹窗不关：warnings（哪些请求被跳过、servers 里留着 {{变量}} 之类）
 * 值得看一眼，下载已经发生，看一眼再关不亏。
 */
export default defineComponent({
  name: 'ExportDialog',
  components: { Caret },
  props: {
    open: { type: Boolean, default: false },
    /** interfaceTree 那份：{ rows, ungrouped }，勾选范围直接读它 */
    tree: { type: Object, default: () => ({ rows: [], ungrouped: [] }) },
    envCount: { type: Number, default: 0 },
    error: { type: String, default: '' },
    warnings: { type: Array, default: () => [] },
    exportedName: { type: String, default: '' },
  },
  emits: ['export', 'close'],
  setup(props, { emit }) {
    const boxRef = ref(null);
    const form = reactive({
      scope: 'project',
      /** 「部分」模式的勾选结果：请求 id 的扁平数组 */
      selection: [],
      includeEnv: false,
      format: 'yaml',
      version: '3.0',
    });

    /** 勾选树里哪些目录展开着。默认全折叠 —— 接口多的时候铺开一整屏，找目录反而费劲 */
    const openGroups = reactive({});

    /**
     * 按顶层目录分组（和 StepPicker 同一套分法）：树是前序铺开的，depth 1 的目录
     * 开一组，它后面的请求都归这一组；根上的请求归「未分组」。
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

    // 每次打开都归位：默认「全部 + YAML」，勾选清空
    watch(
      () => props.open,
      async (open) => {
        if (!open) {
          await leaveDialog();
          return;
        }
        form.scope = 'project';
        form.selection = [];
        groups.value.forEach((g) => {
          openGroups[g.id] = false;
        });
        form.includeEnv = false;
        form.format = 'yaml';
        form.version = '3.0';
        await enterDialog(() => boxRef.value);
      }
    );

    /** Tab 在弹层里循环，别让焦点跑到遮罩后面去 */
    const onDialogKeydown = (event) => trapTab(event, boxRef.value);

    const toggleOpen = (g) => {
      openGroups[g.id] = !openGroups[g.id];
    };

    const requestTotal = () => groups.value.reduce((n, g) => n + g.requests.length, 0);

    const selectedCount = () => form.selection.length;

    const selCount = (g) => g.requests.filter((r) => form.selection.includes(r.id)).length;

    const reqIds = (g) => g.requests.map((r) => r.id);

    // 三态判定和整组勾选统一走 pickScope.js（和接口树、方案步骤、挑接口一个口径）
    const groupAllChecked = (g) => allPicked(reqIds(g), form.selection);
    const groupSomeChecked = (g) => somePicked(reqIds(g), form.selection);
    const toggleGroup = (g, checked) => {
      form.selection = applyPick(form.selection, reqIds(g), checked);
    };

    const toggleReq = (r, checked) => {
      form.selection = applyPick(form.selection, [r.id], checked);
    };

    /** 当前范围会导出几个请求 —— 按它禁用导出按钮，省得点了才报「空的」 */
    const scopeCount = () => (form.scope === 'selected' ? selectedCount() : requestTotal());

    const canExport = () => scopeCount() > 0;

    /** 底部那颗动作按钮：范围是全部就叫「导出全部」，否则「导出部分」 */
    const exportLabel = () => (form.scope === 'selected' ? '导出部分' : '导出全部');

    const doExport = () => {
      emit('export', {
        scope: form.scope,
        selection: form.selection,
        includeEnv: form.includeEnv,
        format: form.format,
        version: form.version,
      });
    };

    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.open) emit('close');
    };
    window.addEventListener('keydown', onKeydown);
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    /** Enter / 空格折叠导出范围里的目录。行里还有勾选框，所以只在行自身聚焦时响应 */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyActivate,
      form, groups, selCount, openGroups, toggleOpen, groupAllChecked, groupSomeChecked,
      toggleGroup, toggleReq, scopeCount, canExport, exportLabel, doExport,
      boxRef, onDialogKeydown,
    };
  },
  template: `
    <div class="mask" v-if="open" @click.self="$emit('close')">
      <div
        class="dialog export-dialog"
        ref="boxRef"
        role="dialog"
        aria-modal="true"
        aria-label="导出 OpenAPI"
        @keydown="onDialogKeydown"
      >

        <!-- 头部 -->
        <div class="export-head">
          <div class="export-head-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </div>
          <div class="export-head-text">
            <div class="export-title">导出 OpenAPI</div>
            <div class="export-sub">断言、提取、前置脚本随 x-posmax 扩展字段一并写入，可无损导回</div>
          </div>
          <button class="icon-btn export-close" title="关闭" @click="$emit('close')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>
            </svg>
          </button>
        </div>

        <div class="export-body">
          <template v-if="groups.length">
            <!-- 文件格式：第一行，默认 YAML -->
            <div class="opt-row">
              <span class="opt-label">文件格式</span>
              <div class="seg">
                <button type="button" :class="{ on: form.format === 'yaml' }" @click="form.format = 'yaml'">YAML</button>
                <button type="button" :class="{ on: form.format === 'json' }" @click="form.format = 'json'">JSON</button>
              </div>
              <span class="opt-label" style="margin-left: 12px;">版本</span>
              <div class="seg">
                <button type="button" :class="{ on: form.version === '3.0' }" @click="form.version = '3.0'">3.0</button>
                <button type="button" :class="{ on: form.version === '3.1' }" @click="form.version = '3.1'">3.1</button>
              </div>
            </div>

            <!-- 导出范围：全部 / 部分 -->
            <div class="opt-row">
              <span class="opt-label">导出范围</span>
              <div class="seg">
                <button type="button" :class="{ on: form.scope === 'project' }" @click="form.scope = 'project'">全部</button>
                <button type="button" :class="{ on: form.scope === 'selected' }" @click="form.scope = 'selected'">部分</button>
              </div>
            </div>

            <!-- 选「部分」才展开勾选树 -->
            <div class="scope-expand" v-if="form.scope === 'selected'">
              <div class="scope-tree">
                <div class="tree-col" v-for="g in groups" :key="g.id">
                  <!-- 点整行收 / 放；勾选框只管勾选，不带着折叠一起动 -->
                  <div
                    class="tree-head"
                    tabindex="0"
                    role="button"
                    :aria-expanded="openGroups[g.id] ? 'true' : 'false'"
                    @click="toggleOpen(g)"
                    @keydown="keyActivate($event, () => toggleOpen(g))"
                  >
                    <Caret :open="!!openGroups[g.id]" />
                    <input type="checkbox"
                           :checked="groupAllChecked(g)"
                           :indeterminate.prop="groupSomeChecked(g)"
                           @click.stop
                           @change="toggleGroup(g, $event.target.checked)" />
                    <span class="tree-name">{{ g.name }}</span>
                    <span class="tree-count">{{ selCount(g) }} / {{ g.requests.length }}</span>
                  </div>
                  <div class="tree-reqs" v-show="openGroups[g.id]">
                    <label class="tree-req" v-for="r in g.requests" :key="r.id">
                      <input type="checkbox"
                             :checked="form.selection.includes(r.id)"
                             @change="toggleReq(r, $event.target.checked)" />
                      <span class="method" :class="r.method">{{ r.method }}</span>
                      <span class="tree-req-name">{{ r.name }}</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <!-- 附加内容 -->
            <div class="opt-row">
              <span class="opt-label">附加内容</span>
              <label class="env-check" :class="{ 'is-off': !envCount }">
                <input type="checkbox" v-model="form.includeEnv" :disabled="!envCount" />
                <span class="env-text">
                  <span class="env-name">包含环境变量与账号</span>
                  <span class="env-desc">
                    <template v-if="envCount">{{ envCount }} 个环境，含分组与账号，内嵌到同一份文档</template>
                    <template v-else>当前项目还没有环境</template>
                  </span>
                </span>
              </label>
            </div>

            <div class="env-warn" v-if="form.includeEnv">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span>环境和账号里的变量值会<strong>原样写进文件</strong>（token、密码都是明文）。</span>
            </div>
          </template>
          <p class="hint" v-else>项目里还没有接口。</p>

          <!-- 导出结果 -->
          <div class="export-result" v-if="exportedName || error || warnings.length">
            <div class="export-ok" v-if="exportedName">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span>已导出 <b class="mono">{{ exportedName }}</b></span>
            </div>
            <div class="export-err" v-if="error">{{ error }}</div>
            <div class="export-warns" v-if="warnings.length">
              <div class="export-warns-title">{{ warnings.length }} 条提示 · 以下内容被跳过或需要注意</div>
              <div class="export-warn" v-for="(w, i) in warnings" :key="i">{{ w }}</div>
            </div>
          </div>
        </div>

        <!-- 底部：摘要 + 操作 -->
        <div class="export-foot">
          <div class="foot-sum">
            <template v-if="canExport()">
              将导出 <b>{{ scopeCount() }}</b> 个接口
              <span class="foot-chip">{{ form.format.toUpperCase() }}</span>
              <span class="foot-chip">OpenAPI {{ form.version }}</span>
              <span class="foot-chip env" v-if="form.includeEnv">含环境</span>
            </template>
            <template v-else-if="form.scope === 'selected' && groups.length">还没勾选接口</template>
            <template v-else>没有可导出的接口</template>
          </div>
          <div class="dialog-actions">
            <button class="btn btn-sm" @click="$emit('close')">{{ exportedName ? '关闭' : '取消' }}</button>
            <button class="btn btn-sm btn-primary" :disabled="!canExport()" @click="doExport">{{ exportLabel() }}</button>
          </div>
        </div>

      </div>
    </div>
  `,
});
