import { computed, defineComponent, ref } from 'vue';
import KeyValueTable from './KeyValueTable.js';
import { renameEnv, renameGroup, renameUser, state, uid } from '../store.js';

/**
 * 环境变量页面。
 *   左列：环境列表 + 用户列表（新建按钮都在各自列表底部）
 *   右区：当前环境的「环境变量」分组 + 当前选中用户的「认证信息」
 *
 * 变量在请求里统一用 {{名字}} 引用，用户级的同名变量会覆盖环境级的。
 */
export default defineComponent({
  name: 'EnvPage',
  components: { KeyValueTable },
  props: {
    environments: { type: Array, required: true },
    activeEnvId: { type: String, default: '' },
    activeUserId: { type: String, default: '' },
  },
  emits: [
    'back', 'select', 'create', 'remove',
    'select-user', 'create-user', 'remove-user',
    'remove-group',
  ],
  setup(props, { emit }) {
    const editingId = ref('');
    const editingName = ref('');
    const editingGroupId = ref('');
    const editingGroupName = ref('');
    const editingUserId = ref('');
    const editingUserName = ref('');

    // 说明文字里要出现字面量 {{var}}，必须放在 JS 字符串里
    const hint = '请求里用 {{名字}} 引用；用户级的同名变量会覆盖环境级。';
    const keyPlaceholder = '变量名，如 baseUrl';
    const valuePlaceholder = '变量值';
    const authKeyPlaceholder = '变量名，如 token';
    const authValuePlaceholder = '值';

    const currentEnv = computed(
      () =>
        props.environments.find((e) => e.id === props.activeEnvId) ||
        props.environments[0] ||
        null
    );

    const currentUser = computed(() => {
      const env = currentEnv.value;
      if (!env || !env.users) return null;
      return env.users.find((u) => u.id === props.activeUserId) || env.users[0] || null;
    });

    // ---------------- 自动写入的变量：脚本写的 / 提取来的，两区都只读 ----------------
    // 脚本 env.set() 写的落在 g-script，声明式「提取变量」拿到的落在 g-extract
    // （见 store.js 的 RESERVED_GROUPS）。两边都只读：值下次运行 / 发送就会被覆盖，
    // 能编辑只会让人以为手改有效。分成两块是因为名字得对得上事实 ——
    // 提取出来的 token 从来没经过脚本，混在「脚本写入的变量」里有人真以为是脚本乱写。
    const SCRIPT_GROUP_ID = 'g-script';
    const EXTRACT_GROUP_ID = 'g-extract';
    const AUTO_GROUP_IDS = [SCRIPT_GROUP_ID, EXTRACT_GROUP_ID];

    const editableGroups = computed(() =>
      (currentEnv.value?.groups || []).filter((g) => !AUTO_GROUP_IDS.includes(g.id))
    );

    /** 某个保留分组里的变量（滤掉占位的空行） */
    const varsIn = (id) => {
      const group = (currentEnv.value?.groups || []).find((g) => g.id === id);
      return (group?.vars || []).filter((v) => v.key);
    };

    const scriptVars = computed(() => varsIn(SCRIPT_GROUP_ID));
    const extractVars = computed(() => varsIn(EXTRACT_GROUP_ID));

    // ---------------- 「被账号覆盖」的角标 ----------------
    /**
     * 当前账号里盖住了环境级的那些变量，按键名给 KeyValueTable 挂角标。
     *
     * 覆盖是静默的：在环境里改 baseUrl 却不见效（账号里也有一个同名的）是最容易
     * 踩的一个坑，而页面上只有一句"用户级会覆盖环境级"的规则说明，看不出谁盖了谁。
     *
     * 判定口径必须和 store.vars 一致：`enabled && key.trim()` 就算数 ——
     * **值是空的也算覆盖**（它会把环境里的值盖成空串），这种最该被看见。
     */
    const overriddenMarks = computed(() => {
      const marks = {};
      const user = currentUser.value;
      (user?.vars || []).forEach((v) => {
        const key = String(v.key || '').trim();
        if (!v.enabled || !key) return;
        marks[key] = {
          label: '被账号覆盖',
          title:
            `环境里这一行不生效：账号「${user.name}」里也有 ${key}，` +
            `实际用的是账号里的值${v.value === '' ? '（空值）' : `：${v.value}`}`,
        };
      });
      return marks;
    });

    // ---------------- 环境 / 用户：改名 ----------------
    const startRename = (env) => {
      editingId.value = env.id;
      editingName.value = env.name;
    };

    const commitRename = () => {
      renameEnv(editingId.value, editingName.value);
      editingId.value = '';
    };

    const startUserRename = (user) => {
      editingUserId.value = user.id;
      editingUserName.value = user.name;
    };

    const commitUserRename = () => {
      renameUser(editingUserId.value, editingUserName.value);
      editingUserId.value = '';
    };

    // ---------------- 分组：增 / 改名 / 删 ----------------
    const startGroupRename = (group) => {
      editingGroupId.value = group.id;
      editingGroupName.value = group.name;
    };

    const commitGroupRename = () => {
      renameGroup(editingGroupId.value, editingGroupName.value);
      editingGroupId.value = '';
    };

    const addGroup = () => {
      const env = currentEnv.value;
      if (!env) return;
      if (!env.groups) env.groups = [];
      const group = {
        // 和其它地方统一走 uid()：以前这里单独用 Math.random，
        // 两套并存的直接风险是和保留 id（g-base / g-script）撞上
        id: 'g-' + uid(),
        name: '新分组',
        vars: [],
      };
      env.groups.push(group);
      startGroupRename(group);
    };

    // 删除是不可逆操作，交给父组件统一下发确认弹层
    const removeGroup = (group) => emit('remove-group', group.id);

    /** Enter / 空格选中这一项（环境 / 用户列表都能用键盘走） */
    const keyActivate = (event, action) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      action();
    };

    return {
      keyActivate,
      state,
      editingId, editingName,
      editingGroupId, editingGroupName,
      editingUserId, editingUserName,
      currentEnv, currentUser, hint,
      editableGroups, scriptVars, extractVars, overriddenMarks,
      keyPlaceholder, valuePlaceholder, authKeyPlaceholder, authValuePlaceholder,
      startRename, commitRename,
      startUserRename, commitUserRename,
      addGroup, startGroupRename, commitGroupRename, removeGroup,
      emit,
    };
  },
  template: `
    <div class="project-page">
      <header class="project-head">
        <button class="btn-square" title="返回" @click="emit('back')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        <div class="brand"><img class="brand-mark" src="./favicon.svg" alt="" /><span>环境变量</span></div>
        <div class="topbar-spacer"></div>
        <span class="topbar-label">{{ environments.length }} 个环境</span>
      </header>

      <div class="env-body">
        <!-- 宽度跟接口 / 历史那栏一个值（store 的 sidebarWidth，可拖）——
             两边宽窄一致，来回切页面时左列不会突然收一截 -->
        <aside class="env-side" :style="{ width: state.sidebarWidth + 'px' }">
          <div class="env-list">
            <div class="env-list-title">环境</div>
            <div
              class="env-item"
              v-for="e in environments"
              :key="e.id"
              :class="{ active: currentEnv && e.id === currentEnv.id }"
              tabindex="0"
              role="button"
              @click="emit('select', e.id)"
              @keydown="keyActivate($event, () => emit('select', e.id))"
            >
              <input
                v-if="editingId === e.id"
                v-focus
                class="kv-input"
                v-model="editingName"
                @keyup.enter="commitRename"
                @blur="commitRename"
                @click.stop
              />
              <span v-else class="req-name">{{ e.name }}</span>
              <button class="btn-icon edit" title="重命名" @click.stop="startRename(e)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
              <button class="btn-icon" title="删除该环境" @click.stop="emit('remove', e.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
            <button class="btn btn-sm" style="width: 100%" @click="emit('create')">
              ＋ 新建环境
            </button>
          </div>

          <div class="env-list" v-if="currentEnv">
            <div class="env-list-title">用户（认证信息）</div>
            <div
              class="env-item"
              v-for="u in currentEnv.users"
              :key="u.id"
              :class="{ active: currentUser && u.id === currentUser.id }"
              tabindex="0"
              role="button"
              @click="emit('select-user', u.id)"
              @keydown="keyActivate($event, () => emit('select-user', u.id))"
            >
              <input
                v-if="editingUserId === u.id"
                v-focus
                class="kv-input"
                v-model="editingUserName"
                @keyup.enter="commitUserRename"
                @blur="commitUserRename"
                @click.stop
              />
              <span v-else class="req-name">{{ u.name }}</span>
              <button class="btn-icon edit" title="重命名" @click.stop="startUserRename(u)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
              <button class="btn-icon" title="删除该用户" @click.stop="emit('remove-user', u.id)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
            <button class="btn btn-sm" style="width: 100%" @click="emit('create-user')">
              ＋ 新建用户
            </button>
          </div>
        </aside>

        <div class="env-detail">
          <template v-if="currentEnv">
            <div class="env-detail-head">
              <span class="rail-title">{{ currentEnv.name }} · 环境变量</span>
              <span class="hint">{{ hint }}</span>
              <div class="topbar-spacer"></div>
              <button class="btn btn-sm" @click="addGroup">＋ 添加分组</button>
            </div>

            <div class="env-group" v-for="g in editableGroups" :key="g.id">
              <div class="env-group-head">
                <input
                  v-if="editingGroupId === g.id"
                  v-focus
                  class="kv-input"
                  v-model="editingGroupName"
                  @keyup.enter="commitGroupRename"
                  @blur="commitGroupRename"
                />
                <template v-else>
                  <span class="env-group-name">{{ g.name }}</span>
                  <span class="count">{{ g.vars.length }}</span>
                  <button class="btn-icon edit" title="重命名分组" @click="startGroupRename(g)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
                  <button class="btn-icon" title="删除分组" @click="removeGroup(g)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
                </template>
              </div>

              <KeyValueTable
                :model-value="g.vars"
                @update:model-value="g.vars = $event"
                :key-placeholder="keyPlaceholder"
                :value-placeholder="valuePlaceholder"
                :marks="overriddenMarks"
              />
            </div>

            <div class="env-group" v-if="currentUser">
              <div class="env-group-head auth-head">
                <span class="env-group-name">{{ currentUser.name }} · 认证信息</span>
                <span class="count">{{ currentUser.vars.length }}</span>
              </div>
              <KeyValueTable
                :model-value="currentUser.vars"
                @update:model-value="currentUser.vars = $event"
                :key-placeholder="authKeyPlaceholder"
                :value-placeholder="authValuePlaceholder"
              />
            </div>

            <div class="env-group">
              <div class="env-group-head">
                <span class="env-group-name">提取的变量</span>
                <span class="count">{{ extractVars.length }}</span>
                <span class="hint" style="margin-left: 8px">每次发送都会重新提取覆盖，不在这里编辑</span>
              </div>
              <div class="script-vars" v-if="extractVars.length">
                <div class="script-var" v-for="v in extractVars" :key="v.key">
                  <span class="sv-key">{{ v.key }}</span>
                  <span class="sv-value" v-if="v.value !== ''">{{ v.value }}</span>
                  <span class="sv-value sv-empty" v-else>空值</span>
                </div>
              </div>
              <div class="hint" v-else>
                请求的「提取变量」页签里配的提取，发送后结果会写在这里。
              </div>
            </div>

            <div class="env-group">
              <div class="env-group-head">
                <span class="env-group-name">脚本写入的变量</span>
                <span class="count">{{ scriptVars.length }}</span>
                <span class="hint" style="margin-left: 8px">脚本每次运行都会覆盖，不在这里编辑</span>
              </div>
              <div class="script-vars" v-if="scriptVars.length">
                <div class="script-var" v-for="v in scriptVars" :key="v.key">
                  <span class="sv-key">{{ v.key }}</span>
                  <span class="sv-value" v-if="v.value !== ''">{{ v.value }}</span>
                  <span class="sv-value sv-empty" v-else>空值</span>
                </div>
              </div>
              <div class="hint" v-else>
                前置 / 后置脚本里用 env.set() 写入的变量会出现在这里。
              </div>
            </div>
          </template>

          <div v-else class="hint">左边先建一个环境。</div>
        </div>
      </div>
    </div>
  `,
});
