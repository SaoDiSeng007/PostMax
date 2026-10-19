import { defineComponent } from 'vue';

/** 最左侧的功能列：接口 / 历史 / 自动化测试，底部是设置。 */
export default defineComponent({
  name: 'FeatureRail',
  props: {
    nav: { type: String, required: true },
  },
  emits: ['change', 'settings'],
  template: `
    <nav class="rail">
      <button
        class="rail-item"
        :class="{ active: nav === 'api' }"
        title="接口（目录与请求）"
        @click="$emit('change', 'api')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span>接口</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: nav === 'history' }"
        title="历史记录"
        @click="$emit('change', 'history')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span>历史</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: nav === 'automation' }"
        title="自动化测试"
        @click="$emit('change', 'automation')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
        </svg>
        <span>自动化</span>
      </button>

      <button
        class="rail-item"
        :class="{ active: nav === 'workbench' }"
        title="工作台（本地小工具：图片转 base64 等）"
        @click="$emit('change', 'workbench')"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.6" />
          <rect x="14" y="3" width="7" height="7" rx="1.6" />
          <rect x="3" y="14" width="7" height="7" rx="1.6" />
          <rect x="14" y="14" width="7" height="7" rx="1.6" />
        </svg>
        <span>工作台</span>
      </button>

      <!-- 设置单独放到底部：它不属于「切换左侧那一列」，
           而是打开一个独立页面，所以不复用 nav 状态 -->
      <div class="rail-spacer"></div>

      <button class="rail-item" title="设置" @click="$emit('settings')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>设置</span>
      </button>
    </nav>
  `,
});
