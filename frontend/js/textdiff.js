// ---------------------------------------------------------------------------
// 逐行文本对比。工作台「文本对比」工具的逻辑部分，拆出来是为了能进 node --test。
//
// 算法是最朴素的 LCS 动态规划：行数几百上千毫无压力。两头先裁掉公共前后缀，
// 中间那一小段才真正进 O(n²) 的表 —— 对比两份只差几行的响应时，表小得可以忽略。
// ---------------------------------------------------------------------------

/** 超过这个行数就不算了 —— 再大表会吃几百兆内存，得让用户先删一删 */
export const MAX_LINES = 3000;

/**
 * 归一化 JSON 文本：parse 之后键排序、两空格缩进重新序列化。
 *
 * 用途：「按 JSON 归一后比」—— 两次响应只是键序不同、缩进不同，不该算差异。
 * 解析失败返回 null，调用方回退成纯文本比。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function normalizeJson(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      // 标量/null 归一完就是它自己，没有键序可言
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(sortKeys(parsed), null, 2);
  } catch {
    return null;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/**
 * 逐行对比。
 *
 * @param {string} aText
 * @param {string} bText
 * @returns {{ tooBig?: true, ops?: Array<{type:'same'|'del'|'add', text:string, aNo?:number, bNo?:number}> }}
 *   del = 只在 A（左）里，add = 只在 B（右）里；行号从 1 起，只在各自的行上有。
 */
export function diffLines(aText, bText) {
  const a = String(aText ?? '').split('\n');
  const b = String(bText ?? '').split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) return { tooBig: true };

  // 裁公共前后缀：真正要算 LCS 的只有中间那段
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'same', text: a[i], aNo: i + 1, bNo: i + 1 });

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  pushLcs(midA, midB, ops, pre, pre);

  const baseA = a.length - suf;
  const baseB = b.length - suf;
  for (let i = 0; i < suf; i++) {
    ops.push({ type: 'same', text: a[baseA + i], aNo: baseA + i + 1, bNo: baseB + i + 1 });
  }
  return { ops };
}

/** 对中间段跑 LCS，把结果按顺序插进 ops（行号按各自在全文里的偏移算） */
function pushLcs(x, y, ops, aOff, bOff) {
  const n = x.length;
  const m = y.length;
  if (!n || !m) {
    for (let i = 0; i < n; i++) ops.push({ type: 'del', text: x[i], aNo: aOff + i + 1 });
    for (let j = 0; j < m; j++) ops.push({ type: 'add', text: y[j], bNo: bOff + j + 1 });
    return;
  }

  // table[i][j] = x[i..] 与 y[j..] 的 LCS 长度。从后往前填，回溯时直接顺着走
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        x[i] === y[j]
          ? table[(i + 1) * w + j + 1] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ type: 'same', text: x[i], aNo: aOff + i + 1, bNo: bOff + j + 1 });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
      ops.push({ type: 'del', text: x[i], aNo: aOff + i + 1 });
      i++;
    } else {
      ops.push({ type: 'add', text: y[j], bNo: bOff + j + 1 });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ type: 'del', text: x[i], aNo: aOff + i + 1 });
  for (; j < m; j++) ops.push({ type: 'add', text: y[j], bNo: bOff + j + 1 });
}
