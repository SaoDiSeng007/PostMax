// ---------------------------------------------------------------------------
// SHA-256（frontend/js/sha256.js）
//
// 这是自己带的一份实现 —— 因为 WebCrypto 的 digest 是异步的，而变量替换整条
// 链路是同步的。自己写的哈希最怕「大部分输入都对、某几个长度错」，所以除了
// 规范给的标准向量，还要**按长度逐个和 node 自带的 crypto 对拍**，
// 把填充的每一个边界（55/56/57、63/64/65…）都压到。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../frontend/js/sha256.js';

/** 标尺：node 自带的实现 */
const ref = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('标准向量（FIPS 180-4 附录里的那几条）', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
  );
});

test('输出形状：64 位小写 hex', () => {
  const out = sha256Hex('随便什么');
  assert.match(out, /^[0-9a-f]{64}$/);
});

test('按长度和 node 的 crypto 对拍 —— 填充的每个边界都要压到', () => {
  /*
   * 0-300 覆盖了所有关键位置：
   *   55 / 56 / 57  —— 正好卡在「末尾 8 字节长度放不放得下」的坎上
   *   63 / 64 / 65  —— 正好一个分组的边界
   * 填充写错的话，只有这几个长度会错，随手测两句是发现不了的。
   */
  for (let n = 0; n <= 300; n++) {
    const s = 'a'.repeat(n);
    assert.equal(sha256Hex(s), ref(s), `长度 ${n} 对不上`);
  }
});

test('按 UTF-8 字节算，不是按字符', () => {
  for (const s of ['中文', 'Ünïcödé', '😀', 'a中文b', 'Vss_2024']) {
    assert.equal(sha256Hex(s), ref(s), `「${s}」对不上`);
  }
  // 一个汉字是 3 个字节：这里的长度差异要能体现在结果上
  assert.notEqual(sha256Hex('中'), sha256Hex('中中'));
});

test('也能直接吃 Uint8Array', () => {
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), ref('abc'));
});

test('长输入（多个分组）也对', () => {
  const long = 'a'.repeat(1000) + '中文' + 'x'.repeat(5000);
  assert.equal(sha256Hex(long), ref(long));
});
