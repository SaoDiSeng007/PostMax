import { computed, defineComponent, onMounted, onUnmounted, ref } from 'vue';
import { downloadText, safeFileName } from '../download.js';
import { formatSize } from '../format.js';
import { useCopy } from '../useCopy.js';

/** 读成 data URL。FileReader 是回调式的，包成 Promise */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 量图片真实尺寸。量不出来返回 0 —— 不是致命错误，界面上显示成「—」 */
function measure(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = dataUrl;
  });
}

/** 超过它就提醒一句。base64 是要往请求体 / 变量里塞的，太沉了不好用 */
const BIG = 2 * 1024 * 1024;

/**
 * 图片 → Base64。
 *
 * 三种喂法：选文件、拖进来、**直接粘贴截图**（做接口时最常用的一种）。
 * 一次可以进多张，每张单独复制或下载。
 *
 * 整条链路都在浏览器里：图片不发给任何人，也不进存档。贴完复制走，页面上的
 * 那份只在内存里 —— 切走这个工具就没了（本来也不该留）。
 */
export default defineComponent({
  name: 'Img2Base64',
  setup() {
    /** [{ id, name, size, w, h, dataUrl, b64, big }] */
    const items = ref([]);
    /** 输出形式：整份 data URL（能直接当 src / 塞进 JSON），还是逗号后面那截纯 base64 */
    const mode = ref('dataurl');
    const error = ref('');
    const reading = ref(false);
    /** 刚复制过哪一张，用来闪一下「已复制」 */
    const { copied: copiedId, copy } = useCopy();
    /** 文件正拖在上面 */
    const over = ref(false);
    const fileEl = ref(null);

    /** 收下一批文件。文件名重复不管 —— 多张同名图是常事，各自独立一行 */
    async function addFiles(list) {
      const files = [...(list || [])].filter((f) => f && String(f.type).startsWith('image/'));
      if (!files.length) {
        error.value = '这里没有图片（只认 png / jpg / gif / webp 这类）';
        return;
      }
      error.value = '';
      reading.value = true;

      for (const file of files) {
        try {
          const dataUrl = await readAsDataURL(file);
          const size = await measure(dataUrl);
          items.value.push({
            id: 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
            name: file.name || '剪贴板里的图片',
            size: file.size,
            w: size.w,
            h: size.h,
            dataUrl,
            // 逗号后面那截就是纯 base64；没有逗号说明不是正常的 data URL
            b64: dataUrl.slice(dataUrl.indexOf(',') + 1),
            big: file.size > BIG,
          });
        } catch (e) {
          error.value = `「${file.name}」读不出来：${(e && e.message) || e}`;
        }
      }

      reading.value = false;
    }

    const outputOf = (item) => (mode.value === 'raw' ? item.b64 : item.dataUrl);

    const pickFiles = () => fileEl.value?.click();

    const onPicked = (event) => {
      addFiles(event.target.files);
      // 清空一下，否则连着选同一张文件不会再触发 change
      event.target.value = '';
    };

    const onDrop = (event) => {
      over.value = false;
      addFiles(event.dataTransfer && event.dataTransfer.files);
    };

    /**
     * 粘贴：截个图直接贴进来。
     *
     * 只认剪贴板里的**图片**，别的（文本、从网页复制的富文本）一律放过 ——
     * 都拦下来会把「往输入框里贴一段 JSON」这种正常操作弄坏。
     */
    function onPaste(event) {
      const files = [...((event.clipboardData && event.clipboardData.files) || [])];
      const images = files.filter((f) => String(f.type).startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      addFiles(images);
    }

    onMounted(() => window.addEventListener('paste', onPaste));
    onUnmounted(() => window.removeEventListener('paste', onPaste));

    async function copyItem(item) {
      if (await copy(outputOf(item), item.id)) {
        error.value = '';
        return;
      }
      error.value = '复制失败：浏览器没让写剪贴板';
    }

    function saveItem(item) {
      const suffix = mode.value === 'raw' ? '.base64.txt' : '.dataurl.txt';
      downloadText(safeFileName(item.name) + suffix, outputOf(item));
    }

    const remove = (id) => {
      items.value = items.value.filter((it) => it.id !== id);
    };

    const clear = () => {
      items.value = [];
      error.value = '';
    };

    /** base64 全是 ASCII，一个字符就是一字节，长度即体积 */
    const totalText = computed(() => formatSize(items.value.reduce((n, it) => n + it.b64.length, 0)));

    return {
      items, mode, error, reading, copiedId, over, fileEl,
      pickFiles, onPicked, onDrop, copyItem, saveItem, remove, clear, totalText,
      formatSize,
    };
  },
  template: `
    <div class="wb-tool">
      <input ref="fileEl" type="file" accept="image/*" multiple hidden @change="onPicked" />

      <div
        class="wb-drop"
        :class="{ over }"
        @dragover.prevent="over = true"
        @dragleave="over = false"
        @drop.prevent="onDrop"
      >
        <span class="wb-drop-title">把图片拖到这里</span>
        <span class="wb-drop-hint">或者直接 <b>Ctrl + V</b> 粘贴截图</span>
        <button class="btn btn-primary btn-sm" type="button" @click="pickFiles">选择图片…</button>
        <span class="wb-drop-hint">一次可以选多张；图片只在本地转，不会发出去</span>
      </div>

      <p class="error-text" v-if="error">{{ error }}</p>
      <p class="hint" v-if="reading">正在读取…</p>

      <template v-if="items.length">
        <div class="wb-bar">
          <div class="seg">
            <button type="button" :class="{ on: mode === 'dataurl' }" @click="mode = 'dataurl'">Data URL</button>
            <button type="button" :class="{ on: mode === 'raw' }" @click="mode = 'raw'">纯 Base64</button>
          </div>
          <span class="wb-count">已导入 {{ items.length }} 张 · 合起来 {{ totalText }}</span>
          <button class="btn btn-sm" type="button" @click="clear">清空</button>
        </div>

        <div class="wb-list">
          <div class="wb-row" v-for="it in items" :key="it.id">
            <img class="wb-thumb" :src="it.dataUrl" :alt="it.name" />
            <div class="wb-meta">
              <span class="wb-name" :title="it.name">{{ it.name }}</span>
              <span class="wb-sub">
                {{ it.w ? it.w + '×' + it.h + ' · ' : '' }}{{ formatSize(it.size) }}
                → base64 {{ formatSize(it.b64.length) }}
              </span>
              <span class="wb-warn" v-if="it.big">原图偏大，塞进请求体或变量里会很沉</span>
            </div>
            <button class="btn btn-sm" type="button" @click="copyItem(it)">
              {{ copiedId === it.id ? '已复制' : '复制' }}
            </button>
            <button class="btn btn-sm" type="button" @click="saveItem(it)">下载</button>
            <button class="btn-icon" type="button" title="移除这一张" @click="remove(it.id)">✕</button>
          </div>
        </div>
      </template>
    </div>
  `,
});
