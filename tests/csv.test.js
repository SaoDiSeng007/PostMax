// ---------------------------------------------------------------------------
// 测试数据的 CSV 解析（B 组用例）
//
// 这是「安静出错」的重灾区：解析错了不会报错，只会让某几行数据变成别的值，
// 报告却照样全绿。所以边界一条条钉住：
//   · 表头空 / 重名 —— 重名会让 {{列名}} 只能取到后一个，等于少一列数据
//   · 引号里的逗号和换行 —— 按 RFC 4180，不能被当成分隔符和换行
//   · 分隔符嗅探 —— 只数表头那一行，且引号里的不算
//
// 跑：npm test（等价于 node --test tests/）
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, parseTsv } from '../frontend/js/csv.js';

test('B2 表头当列名；空表头补「列N」', () => {
  const r = parseCsv('userId,,备注\n1,2,管理员');
  assert.deepEqual(r.columns, ['userId', '列2', '备注']);
  assert.deepEqual(r.rows, [['1', '2', '管理员']]);
});

test('B2 BOM 不算进第一个列名', () => {
  // Excel 存 UTF-8 CSV 会带 BOM，不去掉的话第一列列名前面多一个看不见的字符，
  // {{userId}} 就永远取不到值
  const r = parseCsv('\uFEFFuserId,备注\n1,a');
  assert.deepEqual(r.columns, ['userId', '备注']);
});

test('B3 分隔符：分号 / Tab 都认；都数不到就按逗号', () => {
  assert.deepEqual(parseCsv('a;b\n1;2').columns, ['a', 'b']);
  assert.deepEqual(parseCsv('a\tb\n1\t2').columns, ['a', 'b']);
  assert.deepEqual(parseCsv('only\n1').columns, ['only']);
});

test('B4 引号："" 是一个引号，引号里可以有逗号和换行', () => {
  const r = parseCsv('a,b\n"x,1","他""说"\n"多\n行",2');
  assert.deepEqual(r.rows, [
    ['x,1', '他"说'],
    ['多\n行', '2'],
  ]);
});

test('B4 引号里的分隔符不参与嗅探', () => {
  // 表头是 "a,b";c —— 引号里那个逗号不该把分隔符带偏成逗号
  assert.deepEqual(parseCsv('"a,b";c\n1;2').columns, ['a,b', 'c']);
});

test('B5 重名列加序号，并把原名报回去', () => {
  const r = parseCsv('id,id,id\n1,2,3');
  assert.deepEqual(r.columns, ['id', 'id_2', 'id_3']);
  assert.deepEqual(r.duplicates, ['id', 'id'], '要把改了哪些告诉调用方，界面上好提示');
  assert.deepEqual(r.rows, [['1', '2', '3']]);
});

test('B6 短行右补空；尾部空行丢掉', () => {
  const r = parseCsv('a,b,c\n1,2\n3\n\n');
  assert.deepEqual(r.rows, [
    ['1', '2', ''],
    ['3', '', ''],
  ]);
});

test('B7 空内容 / 只有空白：没有列，且字段齐全', () => {
  assert.deepEqual(parseCsv(''), { columns: [], rows: [], duplicates: [] });
  assert.deepEqual(parseCsv('\n\n'), { columns: [], rows: [], duplicates: [] });
});

test('CRLF 文件（Excel 存的）解析正常', () => {
  const r = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(r.columns, ['a', 'b']);
  assert.deepEqual(r.rows, [['1', '2']]);
});

test('B8 粘贴：只认制表符、不转义，末尾空行丢掉', () => {
  assert.deepEqual(parseTsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  // 格格里真带个引号，那就是那个值本身 —— 粘贴的内容不走 CSV 的转义规则
  assert.deepEqual(parseTsv('"x"\t2'), [['"x"', '2']]);
  assert.deepEqual(parseTsv(''), []);
});
