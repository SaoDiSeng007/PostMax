// ---------------------------------------------------------------------------
// MD5。工作台「哈希」工具用 —— WebCrypto 至今不收 MD5，只能自己带一份。
//
// 纯函数：进 string（按 UTF-8 编）或 Uint8Array，出 32 位小写 hex。
// 没有任何依赖，node --test 直接测（tests/wb-tools.test.js 里有标准向量）。
// ---------------------------------------------------------------------------

/** 每轮的循环左移位数，MD5 规范里的四组各重复四遍 */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(2^32 × |sin(i+1)|)。规范给的常数表，现算和抄表等价 */
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;

/**
 * 算 MD5，返回小写 hex。
 *
 * @param {string|Uint8Array} input 字符串按 UTF-8 编码后计算
 * @returns {string}
 */
export function md5Hex(input) {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const len = msg.length;

  // 填充：原文 + 0x80 + 补零，使总长 ≡ 56 (mod 64)，末尾 8 字节放比特长度（小端）
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLen = len * 8;
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  for (let off = 0; off < total; off += 64) {
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);

    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const s = SHIFTS[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  // 摘要是 a/b/c/d 四个字按小端拼起来
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}
