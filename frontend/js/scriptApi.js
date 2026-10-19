// ---------------------------------------------------------------------------
// 脚本沙箱里有什么 —— 补全和页面提示的唯一来源
//
// 这份表必须和 script-worker.js 实际注入的东西一字不差。手工对齐迟早漂移，
// 所以 tests/script-api.test.js 会把 worker 真跑一遍，从沙箱里问出它到底有哪些
// 成员，再和这里逐个对。改了 worker 忘了改这里，测试会红。
//
// 每条的形状：
//   name    成员名（补全里显示的那个）
//   detail  右侧的签名提示，如 get(key)
//   insert  选中后真正插进去的文本
//   caretIn 插完光标落在插入文本里的偏移（get('') → 5，光标落在两个引号之间）
//   doc     一句话说明，悬停时看
//   ref     指向另一个节点（pm.environment 就是 env，写 pm.environment. 也能补出 env 的成员）
// ---------------------------------------------------------------------------

/** 取变量那一类方法的签名，几个地方重复，抽出来免得写歪 */
const varArg = (name, extra) => ({
  name,
  detail: extra ? `${name}(key, ${extra})` : `${name}(key)`,
  insert: `${name}('')`,
  caretIn: name.length + 2,
});

export const SCRIPT_API = {
  env: {
    doc: '当前环境的变量（合并了当前账号的认证信息）',
    members: [
      { ...varArg('get'), doc: '读一个变量；没有这个变量给 undefined' },
      { ...varArg('has'), doc: '判断变量在不在，返回 true / false' },
      { name: 'all', detail: 'all()', insert: 'all()', doc: '取全部变量，是个普通对象' },
      { ...varArg('set', 'value'), doc: '写回环境（发送结束后生效，后面的步骤都能读到）' },
      { ...varArg('unset'), doc: '删掉一个变量' },
    ],
  },

  pm: {
    doc: '和 env 同一个对象，用顺手哪种写哪种',
    members: [
      { name: 'environment', detail: 'environment', insert: 'environment', ref: 'env', doc: '环境变量，等价于 env' },
      { name: 'variables', detail: 'variables', insert: 'variables', ref: 'env', doc: '同上，Postman 里的老叫法' },
    ],
  },

  console: {
    doc: '输出到响应区的「控制台」',
    members: [
      { name: 'log', detail: 'log(...)', insert: 'log()', caretIn: 4, doc: '一条普通日志，可以带对象' },
      { name: 'info', detail: 'info(...)', insert: 'info()', caretIn: 5, doc: '同上，等级是 info' },
      { name: 'warn', detail: 'warn(...)', insert: 'warn()', caretIn: 5, doc: '黄色显示' },
      { name: 'error', detail: 'error(...)', insert: 'error()', caretIn: 6, doc: '红色显示' },
    ],
  },

  response: {
    doc: '这次请求的响应，只有后置脚本能拿到',
    afterOnly: true,
    members: [
      { name: 'status', detail: 'status', insert: 'status', doc: '状态码，数字' },
      { name: 'statusText', detail: 'statusText', insert: 'statusText', doc: '状态短语，如 OK' },
      { name: 'time', detail: 'time', insert: 'time', doc: '耗时（毫秒）' },
      { name: 'size', detail: 'size', insert: 'size', doc: '响应体字节数' },
      { name: 'headers', detail: 'headers', insert: 'headers', doc: '[{ key, value }] 数组' },
      { name: 'body', detail: 'body', insert: 'body', doc: '响应体原文（字符串）' },
      { name: 'json', detail: 'json', insert: 'json', doc: '解析好的对象；不是 JSON 时是 null' },
    ],
  },

  CryptoJS: {
    doc: '加密库，签名参数基本都靠它',
    members: [
      { name: 'HmacSHA256', detail: 'HmacSHA256(msg, key)', insert: 'HmacSHA256()', caretIn: 11, doc: '接口签名最常用的那个' },
      { name: 'HmacSHA1', detail: 'HmacSHA1(msg, key)', insert: 'HmacSHA1()', caretIn: 9, doc: '' },
      { name: 'HmacMD5', detail: 'HmacMD5(msg, key)', insert: 'HmacMD5()', caretIn: 8, doc: '' },
      { name: 'SHA256', detail: 'SHA256(msg)', insert: 'SHA256()', caretIn: 7, doc: '纯哈希，不带密钥' },
      { name: 'SHA1', detail: 'SHA1(msg)', insert: 'SHA1()', caretIn: 5, doc: '' },
      { name: 'SHA512', detail: 'SHA512(msg)', insert: 'SHA512()', caretIn: 7, doc: '' },
      { name: 'MD5', detail: 'MD5(msg)', insert: 'MD5()', caretIn: 4, doc: '' },
      { name: 'AES', detail: 'AES', insert: 'AES', doc: '对称加密' },
      { name: 'TripleDES', detail: 'TripleDES', insert: 'TripleDES', doc: '' },
      { name: 'PBKDF2', detail: 'PBKDF2(pwd, salt, opt)', insert: 'PBKDF2()', caretIn: 7, doc: '口令派生' },
      {
        name: 'enc',
        detail: 'enc',
        insert: 'enc',
        doc: '编码转换',
        members: [
          { name: 'Hex', detail: 'enc.Hex', insert: 'Hex', doc: '十六进制' },
          { name: 'Base64', detail: 'enc.Base64', insert: 'Base64', doc: '' },
          { name: 'Utf8', detail: 'enc.Utf8', insert: 'Utf8', doc: '中文要先 enc.Utf8.parse 再算' },
          { name: 'Latin1', detail: 'enc.Latin1', insert: 'Latin1', doc: '' },
        ],
      },
      {
        name: 'lib',
        detail: 'lib',
        insert: 'lib',
        doc: '底层结构',
        members: [{ name: 'WordArray', detail: 'lib.WordArray', insert: 'WordArray', doc: '字节数组' }],
      },
    ],
  },
};

/**
 * 光秃秃敲标识符时一起给的 JS 关键字和全局对象。
 *
 * 这些不在 SCRIPT_API 里 —— 它们是语言自带的，沙箱没有选择权（只摘掉了网络那几张），
 * 所以契约测试也不该管它们。列常用的就够，全列反而把候选搅浑。
 */
export const SCRIPT_KEYWORDS = [
  'const', 'let', 'var', 'if', 'else', 'for', 'while', 'return', 'function',
  'try', 'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'delete',
  'JSON', 'Math', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Date',
  'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent',
];

/**
 * 页脚那排「常用写法」。
 *
 * 和补全同源：写在这里的都是上面表里真有的东西，tests 会核对每个写法的根和成员
 * 在 SCRIPT_API 里查得到 —— 免得页脚教人写一个沙箱里没有的函数。
 */
export const SCRIPT_HINTS = {
  pre: ["env.get('key')", "env.set('key', value)", "env.unset('key')", 'console.log(...)', 'CryptoJS.HmacSHA256(...)'],
  post: ["env.get('key')", "env.set('key', value)", 'response.status', 'response.json', 'console.log(...)', 'CryptoJS.HmacSHA256(...)'],
};
