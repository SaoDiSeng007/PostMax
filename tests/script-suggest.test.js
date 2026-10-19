// ---------------------------------------------------------------------------
// 脚本补全的纯逻辑：什么时候弹、弹什么、插进去是什么样
//
// 词表和沙箱的一致性由 script-api.test.js 管（那需要真跑 worker）；
// 这里只管「认不认得出来、认出来给什么」，对着光标位置一条条钉死。
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyScriptPick,
  buildScriptCandidates,
  detectScriptTrigger,
  lookupApiPath,
} from '../frontend/js/scriptsuggest.js';

/** 光标在末尾的简写：大多数用例都是「刚敲完这一串」 */
const at = (text) => detectScriptTrigger(text, text.length);

const labels = (items) => items.map((it) => it.label);

test('lookupApiPath：顺着词表走，ref 会跟到目标节点', () => {
  assert.equal(lookupApiPath('env').doc.includes('变量'), true);
  assert.equal(lookupApiPath('pm.environment'), lookupApiPath('env'), 'pm.environment 应该指到 env');
  assert.equal(lookupApiPath('CryptoJS.enc.Hex').name, 'Hex');
  assert.equal(lookupApiPath('env.nope'), null);
  assert.equal(lookupApiPath('nope'), null);
  assert.equal(lookupApiPath(''), null);
});

test('detectScriptTrigger：点后面是成员，先查词表再决定弹不弹', () => {
  const env = at('env.');
  assert.equal(env.active, true);
  assert.equal(env.kind, 'member');
  assert.equal(env.start, 4);
  assert.equal(env.query, '');

  const partial = at('env.ge');
  assert.equal(partial.kind, 'member');
  assert.equal(partial.query, 'ge');
  assert.equal(partial.start, 4, '替换要从点后面开始，别把 env 也吃掉');

  const chained = at('pm.environment.');
  assert.equal(chained.active, true, '两节的链子也要认');
  assert.equal(chained.start, 15);

  const nested = at('CryptoJS.enc.');
  assert.equal(nested.active, true);

  assert.equal(at('foo.').active, false, '词表里没有的根，不该弹');
  assert.equal(at('env.nope.').active, false, '成员里也没有的，不弹');
});

test('detectScriptTrigger：取变量那几个方法的引号里补变量名', () => {
  const empty = at("env.get('");
  assert.equal(empty.kind, 'var');
  assert.equal(empty.query, '');
  assert.equal(empty.start, 9, '替换起点在引号后面');

  const typed = at("env.get('to");
  assert.equal(typed.kind, 'var');
  assert.equal(typed.query, 'to');
  assert.equal(typed.start, 9);

  assert.equal(at('pm.variables.set("base').kind, 'var', '双引号也要认');
  assert.equal(at('env.unse').kind, 'member', '还没打引号就还是成员补全');
  assert.equal(at('env.unset(').active, false, '括号一开就不再给成员候选');
});

test('detectScriptTrigger：光秃秃一个词时给根和关键字', () => {
  const root = at('conso');
  assert.equal(root.kind, 'root');
  assert.equal(root.query, 'conso');
  assert.equal(root.start, 0);

  const indented = at('  env');
  assert.equal(indented.start, 2, '行首缩进不算在词里');

  // 字符串里写字、属性名里接着写（点已由成员那条吃掉）都不该插嘴
  assert.equal(at("const a = 'x").active, false);
  assert.equal(at('"abc').active, false);
  assert.equal(at(' ').active, false);
  assert.equal(at('1 +').active, false);
});

test('detectScriptTrigger：注释里不弹（行注释够用，块注释不管）', () => {
  assert.equal(at('// env.').active, false);
  assert.equal(at('  // 说明 env.set').active, false);
  // 注释后面真的代码，照常弹
  assert.equal(at('// 说明\nenv.').active, true);
});

test('buildScriptCandidates：前置不给 response，后置才给', () => {
  // 用 'e' 当过滤词：env / console / response 都沾上，正好能看出前置后置的差别
  const pre = labels(buildScriptCandidates(at('e'), {}, { afterScript: false }));
  assert.ok(pre.includes('env'));
  assert.ok(pre.includes('console'));
  assert.ok(!pre.includes('response'), '前置脚本里 response 根本不存在');

  const post = labels(buildScriptCandidates(at('e'), {}, { afterScript: true }));
  assert.ok(post.includes('response'));

  assert.deepEqual(
    labels(buildScriptCandidates(at('response.'), {}, { afterScript: false })),
    [],
    '手写出来 response. 也不该补前置'
  );
  assert.equal(
    buildScriptCandidates(at('response.'), {}, { afterScript: true }).length,
    7,
    '后置的 response 有 7 个字段'
  );
});

test('buildScriptCandidates：成员按词表给，ref 会展开', () => {
  assert.deepEqual(labels(buildScriptCandidates(at('env.'), {})), ['get', 'has', 'all', 'set', 'unset']);
  assert.deepEqual(labels(buildScriptCandidates(at('pm.environment.'), {})), ['get', 'has', 'all', 'set', 'unset']);
  assert.deepEqual(labels(buildScriptCandidates(at('CryptoJS.enc.'), {})), ['Hex', 'Base64', 'Utf8', 'Latin1']);
  assert.deepEqual(labels(buildScriptCandidates(at('env.g'), {})), ['get'], '过滤词只留命中的');
});

test('buildScriptCandidates：变量名候选带上当前值，过滤不吃大小写', () => {
  const vars = { token: 'T1', baseUrl: '', TOKEN_X: 'z' };
  const typed = buildScriptCandidates(at("env.get('to"), vars);
  assert.deepEqual(labels(typed), ['token', 'TOKEN_X'], '大小写不敏感，两个都该出现');
  assert.equal(typed[0].detail, 'T1');

  const empty = buildScriptCandidates(at("env.get('"), vars);
  assert.deepEqual(labels(empty), ['token', 'baseUrl', 'TOKEN_X'], '没过词就是全部');
  assert.equal(empty[1].detail, '空值', '空值要说出来，不然以为没取到');
});

test('buildScriptCandidates：前缀命中优先，根排在关键字前面', () => {
  assert.deepEqual(labels(buildScriptCandidates(at('cry'), {})), ['CryptoJS'], '前缀不吃大小写');
  assert.deepEqual(labels(buildScriptCandidates(at('con'), {})), ['console', 'const'], '根先给，关键字在后');
  assert.deepEqual(
    labels(buildScriptCandidates(at('CryptoJS.S'), {})).slice(0, 3),
    ['SHA256', 'SHA1', 'SHA512'],
    '大写打头的最先'
  );
  assert.deepEqual(labels(buildScriptCandidates(at('zzz'), {})), [], '一个都不沾就别硬塞');
});

test('applyScriptPick：插完光标落在括号里，方便直接写参数', () => {
  const item = { label: 'get', insert: "get('')", caretIn: 5 };
  const r = applyScriptPick('env.g', 4, 5, item);
  assert.equal(r.text, "env.get('')");
  assert.equal(r.caret, 9, '光标要停在两个引号中间');
  assert.equal(r.inserted, "get('')");

  // 键盘选中传的是整条，点击传的也是整条 —— 两种路径同一个结果
  const viaName = applyScriptPick('env.', 4, 4, item);
  assert.equal(viaName.text, "env.get('')");
  assert.equal(viaName.caret, 9);
});

test('applyScriptPick：变量名和关键字就地替换，不吃掉后面的内容', () => {
  const r = applyScriptPick("env.get('to')", 9, 11, { label: 'token', insert: 'token' });
  assert.equal(r.text, "env.get('token')");
  assert.equal(r.caret, 14);

  const kw = applyScriptPick('con', 0, 3, { label: 'const', insert: 'const' });
  assert.equal(kw.text, 'const');
  assert.equal(kw.caret, 5);
});

test('applyScriptPick：光标位置不合法时不炸，也别把内容搞乱', () => {
  // 光标跑到起点前面（理论上不该发生）时退化成「在起点插入」，后面的内容一个不丢
  const r = applyScriptPick('abc', 2, 1, { insert: 'x' });
  assert.equal(r.text, 'abxc');
  assert.equal(r.start, 2);
  assert.equal(r.end, 2);
});
