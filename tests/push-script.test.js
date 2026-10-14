// ---------------------------------------------------------------------------
// 推送脚本（推送两端.sh）里几条「改坏就会出事」的约定
//
// 脚本本身在 node 里跑不起来（要 git、要网络），但它的安全性恰恰是由几个字面量
// 决定的 —— 改错一个，轻则推不上去，重则把用户本机另一份工作副本搅乱、或者
// 抹掉 GitHub 上那份 LICENSE。所以照 tests/quick-headers.test.js 的老办法，
// 直接从源码里核这几条。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const script = readFileSync(at('推送两端.sh'), 'utf8');
const gitignore = readFileSync(at('.gitignore'), 'utf8');

/** 脚本里带 git 的某类命令行 */
const gitLines = (verb) =>
  script.split('\n').filter((line) => new RegExp(`\\bgit\\b.*\\b${verb}\\b`).test(line));

test('两端互相独立：不用 set -e，一处失败不拖累其它', () => {
  assert.match(script, /set -uo pipefail/, '保留这份容错的选项组合');
  assert.doesNotMatch(
    script,
    /^set -[a-z]*e/m,
    'set -e 会让 gitee 一失败就整体中止，github 跟着不推 —— 这正是当初改掉它的原因'
  );
});

test('快照要带上 GitHub 那份 LICENSE —— 本地没有它，覆盖过去就没了', () => {
  assert.ok(
    gitLines('checkout').some((l) => /github\/main\s+--\s+LICENSE/.test(l)),
    '快照前得把 github/main 上的 LICENSE 取进来'
  );
});

test('快照推完必须切回 main，并把带出来的 LICENSE 清掉', () => {
  assert.ok(
    gitLines('checkout').some((l) => /checkout\s+-q\s+main/.test(l)),
    '别把工作区留在快照分支上'
  );
  assert.match(script, /rm -f LICENSE/, 'LICENSE 只该存在于 GitHub，本地不留');
});

test('同步本机其它副本一律 --ff-only —— 绝不替谁做合并', () => {
  const merges = gitLines('merge');
  assert.ok(merges.length, '脚本里应当有快进本机副本的动作');
  merges.forEach((line) => {
    assert.match(
      line,
      /--ff-only/,
      `这一行没限定 --ff-only，会真的替人合并、可能搅乱对方的分支：${line.trim()}`
    );
  });
});

test('要同步哪些副本写在 .sync-copies，没这个文件就整段跳过', () => {
  assert.match(script, /\[\s+-f\s+\.sync-copies\s+\]/, '先判断文件在不在');
  assert.match(script, /done\s+<\s+\.sync-copies/, '清单从 .sync-copies 逐行读');
});

test('.sync-copies 不进仓库（里面是本机绝对路径）', () => {
  assert.match(
    gitignore,
    /^\.sync-copies$/m,
    '.gitignore 里要有它 —— 本机绝对路径不该推到公开仓库'
  );
});
