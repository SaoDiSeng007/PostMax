import { defineComponent, ref } from 'vue';
import VarSuggest from './VarSuggest.js';
import VarPicker from './VarPicker.js';
import VarHighlight from './VarHighlight.js';
import { useVarInsert } from '../useVarInsert.js';

/**
 * 可编辑的键值表格，Headers / Params / 环境变量都会复用它。
 * 行结构：{ enabled, key, value }
 *
 * 传了 vars 才启用 value 列的 `{{` 变量补全。不传就是一张普通表格 ——
 * 「环境变量」页那种正在定义变量的地方，显然不该再弹变量候选。
 */
export default defineComponent({
  name: 'KeyValueTable',
  components: { VarSuggest, VarPicker, VarHighlight },
  props: {
    modelValue: { type: Array, required: true },
    keyPlaceholder: { type: String, default: 'Key' },
    valuePlaceholder: { type: String, default: 'Value' },
    vars: { type: Object, default: null },
    /**
     * 给某些行挂个小角标：`{ 变量名: { label, title } }`。
     *
     * 环境页用来说明「这一行被账号里的同名变量盖住了」—— 覆盖是静默的，
     * 不标出来的话，在环境里改了值却不生效会完全摸不着头脑。
     */
    marks: { type: Object, default: null },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const update = (index, field, value) => {
      const next = props.modelValue.map((row, i) =>
        i === index ? { ...row, [field]: value } : row
      );
      emit('update:modelValue', next);
    };

    const add = () =>
      emit('update:modelValue', [
        ...props.modelValue,
        { enabled: true, key: '', value: '' },
      ]);

    const remove = (index) =>
      emit(
        'update:modelValue',
        props.modelValue.filter((_, i) => i !== index)
      );

    // ---------------- value 列的变量补全 + 「插入数据」浮层 ----------------
    // 逻辑都在 useVarInsert 里（Body 共用同一份）。这里只有两处不同：
    //   1) 每行各有一个输入框，但共用一份状态，所以要记住「正在编的是哪一行」
    //   2) value 是单行输入框，按钮纵向按框高居中
    const activeRow = ref(-1);
    let activeEl = null;

    const {
      suggest,
      caretPos,
      pickerOpen,
      focused,
      insertBtnStyle,
      suggestStyle,
      pickerStyle,
      measure: measureCaret,
      close: closeFloats,
      onInput: scanValueInput,
      pick: pickVar,
      openPanel: openPicker,
      insert: insertRowVar,
      onKeydown: onValueKeydown,
      onFocus: markFocus,
      onBlur: onValueBlur,
    } = useVarInsert({
      getVars: () => props.vars,
      getHost: () => activeEl,
      commit: (text) => {
        update(activeRow.value, 'value', text);
      },
    });

    /**
     * 先把「现在编的是哪一行」记下来，再交给补全逻辑。
     * 顺序不能反：提交内容时要靠 activeRow 找到那一行。
     */
    function onValueInput(row, event) {
      update(row, 'value', event.target.value);

      activeRow.value = row;
      activeEl = event.target;
      scanValueInput(event);
    }

    function onValueFocus(row, event) {
      activeRow.value = row;
      activeEl = event.target;
      markFocus();
    }

    /** 点某一行的「插入数据」按钮：先认下是哪一行，再开浮层。 */
    function openFor(row) {
      activeRow.value = row;
      openPicker();
    }

    /** 这一行有没有角标（没有就什么都不渲染） */
    const markOf = (row) => (props.marks && row.key ? props.marks[row.key.trim()] || null : null);

    return {
      update, add, remove, markOf,
      onValueInput, pickVar, onValueKeydown,
      activeRow, focused, pickerOpen, onValueFocus, onValueBlur, insertRowVar,
      closeFloats, openFor, measureCaret, insertBtnStyle, suggestStyle, pickerStyle,
      suggest, caretPos,
    };
  },
  template: `
    <div>
      <div class="kv-row" v-for="(row, i) in modelValue" :key="i">
        <input type="checkbox" v-model="row.enabled" title="启用 / 停用" />
        <input
          class="kv-input key"
          :placeholder="keyPlaceholder"
          :value="row.key"
          @input="update(i, 'key', $event.target.value)"
        />
        <!--
          值这一格再套一层：角标要贴着值显示，但 .kv-row 是 4 列网格，
          多插一个兄弟节点会把列数搅乱（Headers / Params 也共用这张表）
        -->
        <div class="kv-value">
          <div class="var-anchor hl-kv" @focusout="onValueBlur">
            <VarHighlight
              :text="row.value"
              :vars="vars || {}"
              :scroll-left="caretPos.scrollLeft"
            />
            <input
              class="kv-input hl-input"
              :placeholder="valuePlaceholder"
              :value="row.value"
              @input="onValueInput(i, $event)"
              @keydown="onValueKeydown"
              @keyup="measureCaret"
              @click="measureCaret"
              @scroll="measureCaret"
              @focus="onValueFocus(i, $event)"
              @mousedown="closeFloats"
            />
            <button
              class="insert-btn"
              v-if="vars && focused && activeRow === i"
              :style="insertBtnStyle"
              title="插入数据"
              @mousedown.prevent="openFor(i)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="m3 21 9-9" />
                <path d="M15 4V2" /><path d="M15 16v-2" />
                <path d="M8 9h2" /><path d="M20 9h2" />
                <path d="M17.8 11.8 19 13" /><path d="M17.8 6.2 19 5" /><path d="M12.2 6.2 11 5" />
              </svg>
            </button>
            <VarSuggest
              v-if="suggest.open && activeRow === i"
              :style="suggestStyle"
              :items="suggest.items"
              :active-index="suggest.index"
              @pick="pickVar"
              @hover="suggest.index = $event"
            />
            <VarPicker
              v-if="pickerOpen && activeRow === i"
              :style="pickerStyle"
              :vars="vars || {}"
              @pick="insertRowVar"
              @close="closeFloats()"
            />
          </div>
          <span
            v-if="markOf(row)"
            class="kv-mark"
            :title="markOf(row).title"
          >{{ markOf(row).label }}</span>
        </div>
        <button class="btn-icon" title="删除该行" @click="remove(i)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
      <button class="btn btn-sm" @click="add">+ 添加一行</button>
    </div>
  `,
});
