// ---------------------------------------------------------------------------
// 脚本编辑器的补全：env. / pm.environment. / CryptoJS.enc. 后面该跟什么，
// env.get(' 里面有哪些变量名，光秃秃敲字母时有哪些关键字
//
// 只有纯逻辑（该不该弹、弹哪些、插什么），不碰 DOM —— 和 varsuggest.js 分工一样：
// 怎么显示、怎么插进输入框交给 useVarInsert 那套现成机制。
//
// 和变量补全（{{}}）的区别在于「触发」：那个只要认 `{{`，这里要认标识符和点，
// 所以触发、候选、替换三件事都做成了可替换的策略，两边共用同一套浮层机制。
// ---------------------------------------------------------------------------

import { SCRIPT_API, SCRIPT_KEYWORDS } from './scriptApi.js';

/** 标识符允许的形状（JS 那一套，够用就行） */
const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * 这个位置是不是在行注释里。
 *
 * 不解析语法，就看同一行里 `//` 是不是出现在前面 —— 覆盖「// 说明 env.」这种
 * 顺手写注释的场景。块注释里照弹，那个代价比为一个注释写 tokenizer 划算。
 */
function inLineComment(before, start) {
  const lineStart = before.lastIndexOf('\n') + 1;
  const comment = before.indexOf('//', lineStart);
  return comment >= 0 && comment < start;
}

/**
 * 沿路径取词表里的节点：'env' → env 节点，'pm.environment' → env 节点（跟着 ref 走）。
 * 取不到返回 null —— 触发判断靠它决定「这个点后面到底该不该补」。
 */
export function lookupApiPath(path) {
  const parts = String(path || '').split('.');
  let node = SCRIPT_API[parts[0]];
  for (let i = 1; i < parts.length && node; i += 1) {
    const member = (node.members || []).find((m) => m.name === parts[i]);
    node = member ? (member.ref ? SCRIPT_API[member.ref] : member) : null;
  }
  return node || null;
}

/**
 * 光标处该不该弹候选。
 *
 * 三种情形，优先级从高到低：
 *   var     `env.get('` 里面 —— 补变量名，拿当前环境的真实变量
 *   member  `env.` / `pm.environment.` —— 先顺着词表查这个对象，查不到就不弹
 *   root    光秃秃一个词 —— 补根对象和关键字
 *
 * @param {string} text 编辑器全文
 * @param {number} caret 光标位置
 * @returns {{active:boolean, kind:string, query:string, start:number, node?:Object}}
 *   start 是替换起点：选中候选时从这里到光标整段换掉
 */
export function detectScriptTrigger(text, caret) {
  const before = String(text ?? '').slice(0, Math.max(0, caret ?? 0));
  const idle = { active: false, kind: '', query: '', start: -1 };

  // 1) 取变量那几个方法的引号里。写成 " 还是 ' 都认，因为两种都能用
  const inCall = before.match(new RegExp(`\\.(get|set|has|unset)\\(\\s*(['"])([\\w$.-]*)$`));
  if (inCall) {
    const typed = inCall[3];
    const start = before.length - typed.length;
    if (inLineComment(before, start)) return idle;
    return { active: true, kind: 'var', query: typed, start };
  }

  // 2) 点后面：环境变量、console、response、CryptoJS 这些的成员。
  //    链子整段取出来（pm.environment 是两节），能不能补由词表说了算。
  const chained = before.match(new RegExp(`(${IDENT}(?:\\.${IDENT})*)\\.([\\w$]*)$`));
  if (chained) {
    const node = lookupApiPath(chained[1]);
    if (!node) return idle;
    const typed = chained[2];
    if (inLineComment(before, before.length - typed.length)) return idle;
    return {
      active: true,
      kind: 'member',
      base: chained[1],
      node,
      query: typed,
      start: before.length - typed.length,
    };
  }

  // 3) 光秃秃一个词。前面是点的情况上面吃掉了；是引号的说明在写字符串，别插嘴
  const word = before.match(new RegExp(`${IDENT}$`));
  if (word) {
    const start = before.length - word[0].length;
    const prev = start > 0 ? before[start - 1] : '';
    if (prev === '.' || prev === "'" || prev === '"') return idle;
    if (inLineComment(before, start)) return idle;
    return { active: true, kind: 'root', query: word[0], start };
  }

  return idle;
}

/** 候选排序：正常大小写的前缀 > 不分大小写的前缀 > 中间命中，同档保持原顺序 */
function rank(items, query) {
  if (!query) return items;
  const q = query.toLowerCase();
  return items
    .filter((it) => it.label.toLowerCase().includes(q))
    .map((it, i) => {
      let score = 2;
      if (it.label.startsWith(query)) score = 0;
      else if (it.label.toLowerCase().startsWith(q)) score = 1;
      return { it, i, score };
    })
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((s) => s.it);
}

/** 变量名的候选：右侧顺手把当前值给他看一眼，省得插错 */
const varItem = (name, vars) => ({
  label: name,
  detail: vars[name] === '' ? '空值' : String(vars[name]),
  insert: name,
  kind: 'var',
});

const memberItem = (m) => ({
  label: m.name,
  detail: m.detail || m.name,
  doc: m.doc || '',
  insert: m.insert || m.name,
  caretIn: m.caretIn,
  kind: 'member',
});

/**
 * 拼候选列表。
 *
 * @param {Object} trigger detectScriptTrigger 的结果
 * @param {Object} vars 当前生效的变量表（环境 + 当前账号的认证信息）
 * @param {{afterScript?:boolean}} [options] 后置脚本才拿得到 response，前置不给补
 */
export function buildScriptCandidates(trigger, vars = {}, options = {}) {
  if (!trigger || !trigger.active) return [];
  const after = !!options.afterScript;
  const query = String(trigger.query || '');

  if (trigger.kind === 'var') {
    return rank(Object.keys(vars).map((name) => varItem(name, vars)), query);
  }

  if (trigger.kind === 'member') {
    // 前置脚本里 response 还不存在，别补出一堆用不了的属性
    if (trigger.node.afterOnly && !after) return [];
    return rank((trigger.node.members || []).map(memberItem), query);
  }

  const roots = Object.entries(SCRIPT_API)
    .filter(([, node]) => !node.afterOnly || after)
    .map(([name, node]) => ({ label: name, detail: node.doc || '', insert: name, kind: 'root' }));
  const keywords = SCRIPT_KEYWORDS.map((k) => ({ label: k, detail: '关键字', insert: k, kind: 'kw' }));
  return rank([...roots, ...keywords], query);
}

/**
 * 把选中的候选写回。接口和 varsuggest.applyVarPick 一样，好让两边共用 useVarInsert。
 *
 * caretIn 是「插完光标落在插入文本里的第几个字符」——get('') 插进去光标要停在
 * 两个引号中间，不然还得自己挪一下，补全就白补了。
 */
export function applyScriptPick(text, start, caret, item) {
  const source = String(text ?? '');
  const from = Math.max(0, start);
  const end = Math.max(from, caret ?? from);
  const inserted = String(item?.insert ?? item?.label ?? '');
  const before = source.slice(0, from);
  const tail = Number.isInteger(item?.caretIn) ? item.caretIn : inserted.length;

  return {
    text: before + inserted + source.slice(end),
    caret: before.length + tail,
    inserted,
    start: from,
    end,
  };
}
