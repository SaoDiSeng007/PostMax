// ---------------------------------------------------------------------------
// 项目文件的读入侧
//
// 盯的是「喂错文件时，用户看到的那句话」。原样的 JSON.parse 报错是
//   Unexpected token 'o', "openapi: 3"... is not valid JSON
// —— 用户照着这句做不了任何事。实测就有人拿 OpenAPI 文档去点「导入项目」，
// 卡在这一句上，还以为文件坏了。
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  parseProjectFile,
} from '../frontend/js/projectFile.js';

/** 走一遍解析，把抛出来的那句话拿回来（没抛就是空串） */
function why(text) {
  try {
    parseProjectFile(text);
    return '';
  } catch (e) {
    return String(e.message);
  }
}

const projectFile = (project) =>
  JSON.stringify({ kind: PROJECT_FILE_KIND, version: PROJECT_FILE_VERSION, project });

test('正常的项目文件：认得下来，payload 原样给回去', () => {
  const payload = parseProjectFile(
    projectFile({ name: '演示', requests: [{ id: 'r1', name: '列表', method: 'GET', url: '/u' }] })
  );
  assert.equal(payload.kind, PROJECT_FILE_KIND);
  assert.equal(payload.project.name, '演示');
  assert.equal(payload.project.requests.length, 1);
});

test('老格式（collections）照样认', () => {
  const payload = parseProjectFile(projectFile({ name: '老项目', collections: [{ id: 'c1', name: '用户' }] }));
  assert.equal(payload.project.collections.length, 1);
});

test('带 BOM 也认（Windows 记事本另存为会塞一个）', () => {
  const text = '\uFEFF' + projectFile({ name: '带BOM', requests: [] });
  assert.equal(parseProjectFile(text).project.name, '带BOM');
});

test('喂 YAML 版接口文档：指到正确入口，不再甩 JSON 报错', () => {
  const yaml = ['openapi: 3.0.3', 'info:', '  title: 测试环境-勿删', 'paths: {}'].join('\n');
  const msg = why(yaml);
  assert.match(msg, /OpenAPI/);
  assert.match(msg, /导入 OpenAPI/);
  assert.equal(msg.includes('Unexpected token'), false, 'JSON.parse 那句原始报错不该再露脸');
});

test('swagger 2.0 的文档给同一句提示', () => {
  assert.match(why('swagger: "2.0"\ninfo:\n  title: x\npaths: {}\n'), /导入 OpenAPI/);
});

test('JSON 版的接口文档（本来就是合法 JSON）同样识别', () => {
  const json = JSON.stringify({ openapi: '3.0.3', info: { title: 'x' }, paths: {} });
  assert.match(why(json), /导入 OpenAPI/);
});

test('运行报告：明说报告只能导出、没有导入', () => {
  const report = JSON.stringify({ plan: { name: '主流程' }, at: 1, status: 'ok', counts: {}, rows: [] });
  assert.match(why(report), /运行报告/);
});

test('合法 JSON 但不是项目文件：保留原来那句话', () => {
  assert.match(why('{"hello":"world"}'), /这不是 PostMax 项目文件/);
  assert.match(why('[]'), /这不是 PostMax 项目文件/);
});

test('项目文件缺名字、或缺请求列表：说清楚缺什么', () => {
  assert.match(why(projectFile({ name: '   ', requests: [] })), /项目文件不完整/);
  assert.match(why(projectFile({ name: '有名字没树' })), /项目文件不完整/);
});

test('kind 不是项目文件的那个标记：照旧报「不是项目文件」', () => {
  const text = JSON.stringify({ kind: 'postman-collection', project: { name: 'x', requests: [] } });
  assert.match(why(text), /这不是 PostMax 项目文件/);
});

test('压根不是 JSON 的文本：说「不是合法 JSON」，并把原始报错留在后面备查', () => {
  const msg = why('随便写点什么，不是 JSON 也不是接口文档');
  assert.match(msg, /不是合法 JSON/);
  assert.ok(msg.length > 12, '别只剩一句空话，原始报错要跟着');
});

test('空文件 / 只有空白：不炸，给一句能看懂的', () => {
  assert.match(why(''), /不是合法 JSON/);
  assert.match(why('   \n  '), /不是合法 JSON/);
});
