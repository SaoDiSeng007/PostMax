import { defineComponent, onUnmounted, ref, watch } from 'vue';
import { enterDialog, leaveDialog, trapTab } from '../dialogFocus.js';

/**
 * OpenAPI 导入前的预览。
 *
 * 为什么要多这一步：真实文档的写法千差万别，解析出 0 个请求、
 * 或者跳过一大半的情况都不少见。让人先看清楚「会导进来什么、什么被跳过了」，
 * 好过导完发现不对再自己删。
 *
 * 出错时也走这个框 —— 把原因摆出来，总好过点了按钮没反应。
 *
 * 键盘：默认焦点落在第一个按钮上（「取消 / 知道了」）—— 导入会整个替换同名顶层目录，
 * 别让手快的回车直接把项目改了；Tab 在弹层里循环，关闭时焦点还给打开它的元素。
 */
export default defineComponent({
  name: 'ImportPreview',
  props: {
    open: { type: Boolean, default: false },
    name: { type: String, default: '' },
    requests: { type: Array, default: () => [] },
    /** 文档里分了几份（每份落成一个顶层目录） / 几个内嵌环境，让人知道这些也会一起导入 */
    bundleCount: { type: Number, default: 1 },
    envCount: { type: Number, default: 0 },
    warnings: { type: Array, default: () => [] },
    error: { type: String, default: '' },
    /** 项目里已有同名顶层目录，确认后会整个替换掉 */
    overwrite: { type: Boolean, default: false },
  },
  emits: ['confirm', 'cancel'],
  setup(props, { emit }) {
    const boxRef = ref(null);

    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.open) emit('cancel');
    };
    window.addEventListener('keydown', onKeydown);
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    watch(
      () => props.open,
      async (open) => {
        if (!open) {
          await leaveDialog();
          return;
        }
        await enterDialog(() => boxRef.value);
      }
    );

    /** Tab 在弹层里循环，别让焦点跑到遮罩后面去 */
    const onDialogKeydown = (event) => trapTab(event, boxRef.value);

    return { boxRef, onDialogKeydown };
  },
  template: `
    <div class="mask" v-if="open" @click.self="$emit('cancel')">
      <div
        class="dialog dialog-wide"
        ref="boxRef"
        role="dialog"
        aria-modal="true"
        aria-label="导入 OpenAPI 文档"
        @keydown="onDialogKeydown"
      >
        <div class="dialog-title">导入 OpenAPI 文档</div>

        <template v-if="error">
          <div class="dialog-message" style="color: var(--red)">{{ error }}</div>
        </template>

        <template v-else>
          <div class="dialog-message">
            <template v-if="bundleCount > 1">
              <b>{{ bundleCount }}</b> 个目录 · 共 <b>{{ requests.length }}</b> 个请求
            </template>
            <template v-else>
              顶层目录「{{ name }}」· 解析到 <b>{{ requests.length }}</b> 个请求
            </template>
            <template v-if="envCount">· <b>{{ envCount }}</b> 个环境（写入环境变量页）</template>
          </div>

          <div class="import-alert" v-if="overwrite">
            项目里已经有同名顶层目录，确认后会<strong>整个替换</strong>掉它 ——
            其中包括你在 PostMax 里对请求做过的修改。
          </div>

          <div class="import-list">
            <div class="import-row" v-for="(r, i) in requests" :key="i">
              <span class="method" :class="r.method">{{ r.method }}</span>
              <span class="import-name">{{ r.name }}</span>
              <span class="import-url">{{ r.url }}</span>
            </div>
          </div>

          <div class="import-warnings" v-if="warnings.length">
            <div class="import-warnings-title">以下内容被跳过（不影响其余部分导入）</div>
            <div class="import-warning" v-for="(w, i) in warnings" :key="i">{{ w }}</div>
          </div>
        </template>

        <div class="dialog-actions">
          <button class="btn btn-sm" @click="$emit('cancel')">
            {{ error ? '知道了' : '取消' }}
          </button>
          <button
            v-if="!error"
            class="btn btn-sm btn-primary"
            @click="$emit('confirm')"
          >{{ overwrite ? '替换并导入' : '导入' }}</button>
        </div>
      </div>
    </div>
  `,
});
