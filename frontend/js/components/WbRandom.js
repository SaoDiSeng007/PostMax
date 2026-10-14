import { computed, defineComponent, onMounted, ref, watch } from 'vue';
import { downloadText, safeFileName } from '../download.js';
import { useCopy } from '../useCopy.js';

// ---------------------------------------------------------------------------
// UUID / 随机值。UUID 用 crypto.randomUUID（没有就手搓 v4），随机串用
// crypto.getRandomValues —— 都是密码学源，不是 Math.random。
//
// 随机串取字符用拒绝采样：256 不能整除字符池长度时，落在尾段里的字节重抽，
// 否则池子里靠前的字符会比靠后的出现概率高那么一点点。
// ---------------------------------------------------------------------------

function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const POOLS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digit: '0123456789',
  symbol: '!@#$%^&*_-+=',
};

const POOL_LABELS = { lower: '小写 a-z', upper: '大写 A-Z', digit: '数字 0-9', symbol: '符号 !@#_' };

/** 从池子里均匀抽 n 个字符。池子为空返回空串 */
export function randomFrom(pool, n) {
  if (!pool || n <= 0) return '';
  const len = pool.length;
  if (len === 1) return pool.repeat(n);
  // 256 之内能整除的最大倍数，超过它的字节重抽
  const limit = Math.floor(256 / len) * len;
  let out = '';
  let spare = [];
  while (out.length < n) {
    if (!spare.length) spare = [...crypto.getRandomValues(new Uint8Array(Math.max(16, n - out.length) * 2))];
    const b = spare.pop();
    if (b < limit) out += pool[b % len];
  }
  return out;
}

/**
 * UUID / 随机值生成。
 *
 * 结果一块输出：每行悬停露出「复制」，要整批就复制全部 / 下载。
 * 没生成之前给一句提示，不留一块空白让人猜。
 */
export default defineComponent({
  name: 'WbRandom',
  setup() {
    const mode = ref('uuid');

    const uuidCount = ref(5);
    const uuids = ref([]);
    /** 大写默认关、横杠默认去掉 —— 大多数接口要的就是 32 位小写 hex */
    const uuidUpper = ref(false);
    const uuidNoDash = ref(true);
    const strLen = ref(16);
    const strCount = ref(5);
    const pools = ref({ lower: true, upper: false, digit: true, symbol: false });
    const strings = ref([]);
    const error = ref('');
    const { copied, copy } = useCopy();

    const activePool = computed(() =>
      Object.keys(POOLS)
        .filter((k) => pools.value[k])
        .map((k) => POOLS[k])
        .join('')
    );

    const clampInt = (v, min, max, fallback) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };

    function make() {
      error.value = '';
      if (mode.value === 'uuid') {
        const n = clampInt(uuidCount.value, 1, 200, 5);
        uuidCount.value = n;
        uuids.value = Array.from({ length: n }, uuidv4);
      } else {
        const pool = activePool.value;
        if (!pool) {
          error.value = '至少勾一种字符';
          return;
        }
        const n = clampInt(strCount.value, 1, 200, 5);
        const len = clampInt(strLen.value, 1, 256, 16);
        strCount.value = n;
        strLen.value = len;
        strings.value = Array.from({ length: n }, () => randomFrom(pool, len));
      }
    }

    /** 格式化在展示层做：切大小写 / 横杠时，已生成的这批立刻跟着变 */
    const fmtUuid = (u) => {
      const s = uuidNoDash.value ? u.replace(/-/g, '') : u;
      return uuidUpper.value ? s.toUpperCase() : s;
    };

    const list = computed(() =>
      mode.value === 'uuid' ? uuids.value.map(fmtUuid) : strings.value
    );

    const copyAll = () => copy(list.value.join('\n'), '__all__');
    const save = () =>
      downloadText(safeFileName(mode.value === 'uuid' ? 'uuid' : 'random') + '.txt', list.value.join('\n'));

    // 进来就有东西（uuidgenerator.net 的规矩）：打开就给生成好，别让人对着空页猜
    onMounted(make);
    // 切到随机串那边时若还没生成过，也先来一批
    watch(mode, (m) => {
      if (m === 'str' && !strings.value.length) make();
    });

    return { mode, uuidCount, uuidUpper, uuidNoDash, strLen, strCount, pools, POOL_LABELS, strings, list, error, copied, make, copy, copyAll, save };
  },
  template: `
    <div class="wb-tool">
      <div class="wb-line">
        <div class="seg">
          <button type="button" :class="{ on: mode === 'uuid' }" @click="mode = 'uuid'">UUID v4</button>
          <button type="button" :class="{ on: mode === 'str' }" @click="mode = 'str'">随机字符串</button>
        </div>

        <template v-if="mode === 'uuid'">
          <label class="wb-inline-label">数量 <input class="wb-in wb-in-num" type="number" min="1" max="200" v-model="uuidCount" /></label>
          <label class="wb-check"><input type="checkbox" v-model="uuidUpper" />大写</label>
          <label class="wb-check"><input type="checkbox" v-model="uuidNoDash" />去横杠</label>
        </template>
        <template v-else>
          <label class="wb-inline-label">长度 <input class="wb-in wb-in-num" type="number" min="1" max="256" v-model="strLen" /></label>
          <label class="wb-inline-label">数量 <input class="wb-in wb-in-num" type="number" min="1" max="200" v-model="strCount" /></label>
        </template>

        <button class="btn btn-primary btn-sm" type="button" @click="make">生成</button>
      </div>

      <div class="wb-line" v-if="mode === 'str'">
        <label class="wb-check" v-for="(label, key) in POOL_LABELS" :key="key">
          <input type="checkbox" v-model="pools[key]" />{{ label }}
        </label>
      </div>

      <p class="error-text" v-if="error">{{ error }}</p>

      <template v-if="list.length">
        <div class="wb-line">
          <span class="wb-chip">共 {{ list.length }} 条</span>
          <button class="btn btn-sm" type="button" @click="copyAll">
            {{ copied === '__all__' ? '已复制' : '复制全部' }}
          </button>
          <button class="btn btn-sm" type="button" @click="save">下载</button>
        </div>
        <div class="wb-out">
          <!-- 整行点击就复制：光标是手，悬停冒「复制」，点完闪绿 —— 和时间戳一个手感 -->
          <div
            class="wb-rand-row wb-kv-copy"
            v-for="(s, i) in list"
            :key="i"
            :class="{ copied: copied === i }"
            title="点击复制"
            @click="copy(s, i)"
          >
            <span class="wb-kv-val">{{ s }}</span>
            <span class="wb-kv-hint">{{ copied === i ? '已复制' : '复制' }}</span>
          </div>
        </div>
      </template>
      <p class="hint" v-else>点「生成」来一批。</p>
    </div>
  `,
});
