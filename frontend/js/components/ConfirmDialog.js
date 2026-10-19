import { computed, defineComponent, onUnmounted, ref, watch } from 'vue';
import { enterDialog, leaveDialog, trapTab } from '../dialogFocus.js';

/**
 * 页内弹层，四种用法：
 *   - 确认删除（默认，红色按钮）
 *   - 纯提示（alertOnly，只有「知道了」）
 *   - 带输入框的命名（withInput，蓝色「创建」按钮，回车提交、Esc 取消）
 *   - 二选一 / 三选一（thirdText 多一个「不保存」；再给 hideCancel 就把「取消」也去掉）
 *
 * 替代浏览器原生 confirm / alert / prompt：原生弹窗一旦被用户勾选
 * 「阻止此页面创建更多对话框」，确认会静默返回 false，操作会莫名失效。
 *
 * 取消有三条路，够得着：取消按钮（可关）、点弹层外面（@click.self）、Esc。
 *
 * 键盘：打开时把焦点搬进来（见 focusTarget —— 有取消就落取消，没有就落确认按钮，
 * 反正不能落在「不保存」那种会丢数据的按钮上），Tab 在弹层里循环，关闭时还给
 * 打开它的元素。见 ../dialogFocus.js。
 */
export default defineComponent({
  name: 'ConfirmDialog',
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: '确认操作' },
    message: { type: String, default: '' },
    confirmText: { type: String, default: '确认删除' },
    alertOnly: { type: Boolean, default: false },
    withInput: { type: Boolean, default: false },
    inputPlaceholder: { type: String, default: '' },
    inputValue: { type: String, default: '' },
    /** 第三个按钮的文案。为空就不渲染 —— 只有「有未保存的改动」那类弹层用得上 */
    thirdText: { type: String, default: '' },
    /**
     * 不渲染「取消」按钮（取消靠点弹层外面或 Esc）。
     * 只有「关标签页时发现有未保存改动」那条流程用：三个按钮里「取消」和点外面
     * 是同一件事，砍掉它少一次取舍。
     */
    hideCancel: { type: Boolean, default: false },
    /** 弹层里放一个下拉选择（「保存到哪个目录」用它） */
    withSelect: { type: Boolean, default: false },
    /** [{ value, label }] */
    selectOptions: { type: Array, default: () => [] },
    selectValue: { type: String, default: '' },
  },
  emits: ['confirm', 'cancel', 'third'],
  setup(props, { emit }) {
    const text = ref('');
    const inputRef = ref(null);
    const boxRef = ref(null);

    // withInput 是主开关；万一调用方只给了 placeholder 没设开关，也按「要输入」处理
    const showInput = computed(() => props.withInput || !!props.inputPlaceholder);
    // 下拉同理：给了选项就算要选
    const showSelect = computed(() => props.withSelect || props.selectOptions.length > 0);

    /** 下拉里选中的值 */
    const choice = ref('');

    /**
     * 打开时焦点落在哪。
     *
     * 有「取消」就落取消上 —— 危险操作的默认焦点放在安全那一边，手快按回车不会
     * 直接删掉。没有取消按钮时（hideCancel / alertOnly）落**确认按钮**上：那个位置
     * 必须是「回车不会丢数据」的动作（关标签页时它是「保存并关闭」）。
     *
     * 千万别靠 enterDialog 的兜底（命中不了就取第一个可聚焦元素）—— 未保存提示里
     * 第一个可聚焦元素是「不保存」，回车一下改动就没了。
     */
    const focusTarget = computed(() => {
      if (showInput.value) return '.dialog-input';
      // 有下拉就把焦点给它：进来就是要选一个
      if (showSelect.value) return '.dialog-select';
      if (!props.alertOnly && !props.hideCancel) return '.dialog-cancel';
      return '.dialog-confirm';
    });

    watch(
      () => props.open,
      async (open) => {
        if (!open) {
          await leaveDialog();
          return;
        }
        text.value = props.inputValue || '';
        choice.value = props.selectValue || '';
        await enterDialog(() => boxRef.value, focusTarget.value);
      }
    );

    // Esc 关闭
    const onKeydown = (e) => {
      if (e.key === 'Escape' && props.open) emit('cancel');
    };
    window.addEventListener('keydown', onKeydown);
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    /** 输入框给输入的内容，下拉给选中的值；别的弹层不需要参数（store 那边认开关） */
    const submit = () => emit('confirm', showInput.value ? text.value : choice.value);

    /** Tab 在弹层里循环，别让焦点跑到遮罩后面的页面上 */
    const onDialogKeydown = (event) => trapTab(event, boxRef.value);

    return {
      text, choice, inputRef, boxRef, showInput, showSelect, submit, onDialogKeydown,
    };
  },
  template: `
    <div class="mask" v-if="open" @click.self="$emit('cancel')">
      <div
        class="dialog"
        ref="boxRef"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @keydown="onDialogKeydown"
      >
        <div class="dialog-title">{{ title }}</div>
        <div class="dialog-message" v-if="message">{{ message }}</div>
        <input
          v-if="showInput"
          ref="inputRef"
          class="dialog-input"
          v-model="text"
          :placeholder="inputPlaceholder"
          @keyup.enter="submit"
        />
        <select
          v-else-if="showSelect"
          class="dialog-select"
          v-model="choice"
          :aria-label="title"
          @keyup.enter="submit"
        >
          <option v-for="opt in selectOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <div class="dialog-actions">
          <button v-if="thirdText" class="btn btn-sm" @click="$emit('third')">
            {{ thirdText }}
          </button>
          <button
            v-if="!alertOnly && !hideCancel"
            class="btn btn-sm dialog-cancel"
            @click="$emit('cancel')"
          >取消</button>
          <button
            class="btn btn-sm dialog-confirm"
            :class="alertOnly || showInput ? 'btn-primary' : 'btn-danger'"
            @click="submit"
          >
            {{ alertOnly ? '知道了' : confirmText }}
          </button>
        </div>
      </div>
    </div>
  `,
});
