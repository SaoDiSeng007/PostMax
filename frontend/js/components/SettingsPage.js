import { defineComponent } from 'vue';

/**
 * 设置页：全局的请求选项。
 *
 * 为什么放全局而不是每个请求一份 —— 超时、证书校验、重定向这几项，
 * 在同一个项目里基本不会变。做成每个请求一份的代价是：新建请求要配一遍、
 * 改一次要挨个改回去，而这些选项本身又很难记得住。放全局，改一次就够。
 */
export default defineComponent({
  name: 'SettingsPage',
  props: {
    settings: { type: Object, required: true },
  },
  emits: ['back'],
  setup() {
    // 说明文案统一放 JS 里返回，模板只做普通插值
    const timeoutHint = '单位毫秒。留空按默认 30000（也就是 30 秒）。';
    const redirectHint = '关掉之后，遇到 3xx 会直接把响应交给你，可以看到 Location 头和状态码本身。';
    const tlsHint = '连自签证书的测试环境时需要打开。开启后不再校验服务器身份，别在生产环境用。';
    const themeHint = '界面配色，纯外观。深色那套只是换了一组颜色变量，功能完全一样。';

    return { timeoutHint, redirectHint, tlsHint, themeHint };
  },
  template: `
    <div class="project-page">
      <header class="project-head">
        <button class="btn-square" title="返回" @click="$emit('back')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
          </svg>
        </button>
        <div class="brand">
          <img class="brand-mark" src="./favicon.svg" alt="" /><span>设置</span>
        </div>
        <div class="topbar-spacer"></div>
        <span class="topbar-label">对所有请求生效，改完自动保存</span>
      </header>

      <div class="project-body">
        <div class="settings-card">
          <div class="settings-row">
            <div class="settings-info">
              <div class="settings-name">主题</div>
              <div class="settings-desc">{{ themeHint }}</div>
            </div>
            <div class="seg">
              <button
                type="button"
                :class="{ on: settings.theme !== 'dark' }"
                @click="settings.theme = 'light'"
              >浅色</button>
              <button
                type="button"
                :class="{ on: settings.theme === 'dark' }"
                @click="settings.theme = 'dark'"
              >深色</button>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <div class="settings-name">超时</div>
              <div class="settings-desc">{{ timeoutHint }}</div>
            </div>
            <input
              class="kv-input settings-num"
              type="number"
              min="0"
              step="1000"
              v-model.number="settings.timeout"
              placeholder="30000"
            />
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <div class="settings-name">跟随重定向</div>
              <div class="settings-desc">{{ redirectHint }}</div>
            </div>
            <label class="check">
              <input type="checkbox" v-model="settings.followRedirects" />
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <div class="settings-name">跳过 TLS 证书校验</div>
              <div class="settings-desc">{{ tlsHint }}</div>
            </div>
            <label class="check">
              <input type="checkbox" v-model="settings.skipTlsVerify" />
            </label>
          </div>
        </div>
      </div>
    </div>
  `,
});
