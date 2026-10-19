import { computed, defineComponent, ref, watch } from 'vue';
import { md5Hex } from '../md5.js';
import { useCopy } from '../useCopy.js';

// ---------------------------------------------------------------------------
// 哈希：SHA-256 走 WebCrypto，MD5 走自带的 md5.js（WebCrypto 不收 MD5）。
// 算法用页签选，选哪个算哪个、显示哪个 —— 贴期望值对得上就打勾。
// ---------------------------------------------------------------------------

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * 算 SHA-256。crypto.subtle 只在安全上下文（https / localhost）里有，
 * 拿不到就报成一句人话，别让人以为是输入错了。
 */
async function sha256Hex(text) {
  if (!crypto?.subtle) throw new Error('当前环境没有 WebCrypto（要用 https 或 localhost 打开）');
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export default defineComponent({
  name: 'WbHash',
  setup() {
    const algo = ref('sha256');
    const text = ref('');
    const expect = ref('');
    const sha = ref('');
    /** WebCrypto 缺席这类环境问题 */
    const error = ref('');
    const { copied, copy: copyValue } = useCopy();
    let timer = 0;

    // 只算选中的那个：选 MD5 就不碰 WebCrypto，环境缺它也不报错
    async function compute() {
      if (algo.value !== 'sha256') {
        sha.value = '';
        error.value = '';
        return;
      }
      const t = text.value;
      try {
        sha.value = t ? await sha256Hex(t) : '';
        error.value = '';
      } catch (e) {
        sha.value = '';
        error.value = (e && e.message) || String(e);
      }
    }

    // 边打边算、切算法也算，缓 250ms
    watch([text, algo], () => {
      clearTimeout(timer);
      timer = setTimeout(compute, 250);
    }, { immediate: true });

    const md5 = computed(() => (text.value ? md5Hex(text.value) : ''));

    const algoLabel = computed(() => (algo.value === 'sha256' ? 'SHA-256' : 'MD5'));
    const digest = computed(() => (algo.value === 'sha256' ? sha.value : md5.value));

    /** 期望值比对（忽略大小写），只对选中的算法 */
    const matchResult = computed(() => {
      const e = expect.value.trim().toLowerCase();
      if (!e || !digest.value) return '';
      return e === digest.value ? 'yes' : 'no';
    });

    return { algo, text, expect, algoLabel, digest, error, matchResult, copyValue, copied };
  },
  template: `
    <div class="wb-tool">
      <!-- 不带外框的切换：两颗按钮，选中的那条字是主色 + 下划线 -->
      <div class="seg-bare">
        <button type="button" :class="{ on: algo === 'sha256' }" @click="algo = 'sha256'">SHA-256</button>
        <button type="button" :class="{ on: algo === 'md5' }" @click="algo = 'md5'">MD5</button>
      </div>

      <textarea
        class="wb-ta"
        v-model="text"
        placeholder="要算哈希的文本"
        spellcheck="false"
      ></textarea>
      <span class="error-text" v-if="error">{{ error }}</span>

      <div
        class="wb-kv wb-kv-copy"
        v-if="digest"
        :class="{ copied: copied === 'd' }"
        title="点击复制"
        @click="copyValue(digest, 'd')"
      >
        <span class="wb-kv-label">{{ algoLabel }}</span>
        <span class="wb-kv-val">{{ digest }}</span>
        <span class="wb-kv-hint">{{ copied === 'd' ? '已复制' : '复制' }}</span>
      </div>

      <div class="wb-line">
        <input class="wb-in wb-grow" v-model="expect" placeholder="期望值" spellcheck="false" />
        <span class="wb-warn-ok" v-if="matchResult === 'yes'">✓ 一致</span>
        <span class="wb-warn" v-else-if="matchResult === 'no'">✗ 对不上</span>
      </div>
    </div>
  `,
});
