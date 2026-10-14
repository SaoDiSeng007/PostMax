import { defineComponent, ref } from 'vue';

/** 主页面：项目列表，点击卡片进入工作区，支持复制 / 导出 / 重命名 / 删除。 */
export default defineComponent({
  name: 'ProjectPage',
  props: {
    projects: { type: Array, required: true },
  },
  emits: ['open', 'create', 'remove', 'duplicate', 'export', 'import', 'open-env'],
  setup(props, { emit }) {
    const editingId = ref('');
    const editingName = ref('');
    const fileEl = ref(null);

    const countRequests = (project) => (project.requests || []).length;
    const countDirs = (project) => (project.dirs || []).length;
    const countPlans = (project) => (project.plans || []).length;

    const startRename = (project) => {
      editingId.value = project.id;
      editingName.value = project.name;
    };

    const commitRename = () => {
      const project = props.projects.find((p) => p.id === editingId.value);
      if (project && editingName.value.trim()) project.name = editingName.value.trim();
      editingId.value = '';
    };

    /** 导入项目 JSON。和侧栏导入 OpenAPI 一个路数：先清空，否则连着选同一个文件不触发 */
    const pickProjectFile = () => {
      if (fileEl.value) fileEl.value.value = '';
      fileEl.value?.click();
    };

    const onProjectFile = (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) emit('import', file);
    };

    /** Enter / 空格打开项目卡片 */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyActivate,
      editingId, editingName, fileEl,
      countRequests, countDirs, countPlans,
      startRename, commitRename, pickProjectFile, onProjectFile, emit,
    };
  },
  template: `
    <div class="project-page">
      <header class="project-head">
        <div class="brand"><img class="brand-mark" src="./favicon.svg" alt="" /><span>PostMax</span></div>
        <span class="topbar-label">
          {{ projects.length ? '选择一个项目开始' : '还没有项目，点下面的卡片新建一个' }}
        </span>
        <div class="topbar-spacer"></div>
        <span class="topbar-label">{{ projects.length }} 个项目</span>
        <button
          class="btn btn-sm"
          title="从项目 JSON 文件导入一个项目（只新增，不覆盖现有项目）"
          @click="pickProjectFile"
        >
          导入项目
        </button>
        <button class="btn-square" title="环境变量" @click="emit('open-env')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 7h9" /><path d="M17 7h3" /><circle cx="15" cy="7" r="2" />
            <path d="M4 17h3" /><path d="M11 17h9" /><circle cx="9" cy="17" r="2" />
          </svg>
        </button>
        <input
          ref="fileEl"
          type="file"
          accept=".json,application/json"
          style="display: none"
          @change="onProjectFile"
        />
      </header>

      <div class="project-body">
        <div class="project-grid">
          <div
            class="project-card"
            v-for="p in projects"
            :key="p.id"
            tabindex="0"
            role="button"
            @click="emit('open', p.id)"
            @keydown="keyActivate($event, () => emit('open', p.id))"
          >
            <div class="project-card-head">
              <input
                v-if="editingId === p.id"
                v-focus
                class="kv-input"
                v-model="editingName"
                @keyup.enter="commitRename"
                @blur="commitRename"
                @click.stop
              />
              <div v-else class="project-name">{{ p.name }}</div>

              <button class="btn-icon" title="复制项目（含方案与测试数据）" @click.stop="emit('duplicate', p.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              </button>
              <button class="btn-icon" title="导出项目 JSON（完整备份：含方案、测试数据与历史）" @click.stop="emit('export', p.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 21h16" />
                </svg>
              </button>
              <button class="btn-icon edit" title="重命名" @click.stop="startRename(p)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
              <button class="btn-icon" title="删除项目" @click.stop="emit('remove', p.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>

            <div class="project-desc">{{ p.description }}</div>
            <div class="project-meta">
              <span>{{ countDirs(p) }} 个目录</span>
              <span>·</span>
              <span>{{ countRequests(p) }} 个请求</span>
              <span>·</span>
              <span>{{ countPlans(p) }} 个方案</span>
            </div>
          </div>

          <div
            class="project-card new"
            tabindex="0"
            role="button"
            @click="emit('create')"
            @keydown="keyActivate($event, () => emit('create'))"
          >
            <div class="project-name">＋ 新建项目</div>
            <div class="project-desc">创建一个新项目来组织接口</div>
            <div class="project-meta"><span>未命名</span></div>
          </div>
        </div>
      </div>
    </div>
  `,
});
