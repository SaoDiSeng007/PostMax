// ---------------------------------------------------------------------------
// 自动写入的变量落在哪一组
//
// 「脚本 env.set() 写的」和「声明式提取变量拿到的」是两回事，原先都塞进
// 「脚本变量」那一组，环境页也就把它整块显示成「前置脚本写入的变量」——
// 用户提取了个 token，看到自己的名字挂在"脚本写入"底下，会以为脚本在乱写。
//
// 需要 DOM 桩 + vue（见 tests/vue-loader.mjs 的说明）。跑：npm test
// ---------------------------------------------------------------------------
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./vue-loader.mjs', import.meta.url);

await import('vue');

globalThis.window = {
  innerHeight: 900,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = { documentElement: { dataset: {} } };

const S = await import('../frontend/js/store.js');

const env = () => S.state.environments[0];
const groupOf = (id) => (env().groups || []).find((g) => g.id === id);
const keysIn = (id) => (groupOf(id)?.vars || []).map((v) => v.key);

/** 全环境里某个 key 一共出现了几份（含账号） */
const copiesOf = (key) => {
  const scopes = [...(env().groups || []), ...(env().users || [])];
  return scopes.reduce((n, s) => n + (s.vars || []).filter((v) => v.key === key).length, 0);
};

beforeEach(() => {
  S.state.environments = [{ id: 'env-1', name: '演示', groups: [], users: [] }];
  S.state.activeEnvId = 'env-1';
  S.state.activeUserId = '';
});

test('脚本写的进「脚本变量」', () => {
  S.setEnvVar('sig', 'abc');
  assert.equal(groupOf('g-script').name, '脚本变量');
  assert.deepEqual(keysIn('g-script'), ['sig']);
  assert.equal(groupOf('g-extract'), undefined, '没提取过就不该冒出提取那一组');
});

test('提取来的进「提取的变量」，不混进脚本那一组', () => {
  S.setEnvVar('token', '1123', 'extract');
  assert.equal(groupOf('g-extract').name, '提取的变量');
  assert.deepEqual(keysIn('g-extract'), ['token']);
  assert.equal(groupOf('g-script'), undefined);
});

test('普通分组里已有同名变量：就地改值，不新建保留组', () => {
  env().groups = [{ id: 'g-1', name: '业务变量', vars: [{ enabled: true, key: 'token', value: '老值' }] }];
  S.setEnvVar('token', '1123', 'extract');
  assert.equal(env().groups[0].vars[0].value, '1123');
  assert.equal(groupOf('g-extract'), undefined);
});

test('当前账号里已有同名变量：改账号里那份（优先级最高）', () => {
  env().users = [{ id: 'u-1', name: '演示账号', vars: [{ enabled: true, key: 'token', value: '老' }] }];
  S.state.activeUserId = 'u-1';
  S.setEnvVar('token', '新值', 'extract');
  assert.equal(env().users[0].vars[0].value, '新值');
  assert.equal(groupOf('g-extract'), undefined);
});

test('老数据残留：同一 key 被提取写时，从「脚本变量」搬进「提取的变量」', () => {
  S.setEnvVar('token', '旧值'); // 老行为：落进脚本那一组
  assert.deepEqual(keysIn('g-script'), ['token']);

  S.setEnvVar('token', '1123', 'extract');
  assert.deepEqual(keysIn('g-extract'), ['token']);
  assert.deepEqual(keysIn('g-script'), [], '旧那份要搬走 —— 两处各留一份，谁生效就看分组顺序了');
  assert.equal(copiesOf('token'), 1);
});

test('反过来也一样：脚本写同一个 key 时把它搬回「脚本变量」', () => {
  S.setEnvVar('token', 'a', 'extract');
  S.setEnvVar('token', 'b');
  assert.deepEqual(keysIn('g-script'), ['token']);
  assert.deepEqual(keysIn('g-extract'), []);
  assert.equal(copiesOf('token'), 1);
});

test('搬过去之后值是最新的那份', () => {
  S.setEnvVar('token', '旧值');
  S.setEnvVar('token', '1123', 'extract');
  assert.equal(groupOf('g-extract').vars[0].value, '1123');
  assert.equal(groupOf('g-extract').vars[0].enabled, true);
});

test('没有当前环境时静默返回，不炸', () => {
  S.state.activeEnvId = '';
  assert.doesNotThrow(() => S.setEnvVar('x', '1', 'extract'));
});
