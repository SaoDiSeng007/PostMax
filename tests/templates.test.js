// ---------------------------------------------------------------------------
// 模板编译：所有组件的 template + main.js 里那整块 App 模板
//
// 这个项目**没有构建步骤**，模板是浏览器里运行时编译的 —— 语法错了不会在别处报错，
// 表现就是白屏。这个测试把它们提前编一遍（已经抓到过两次真错误：多一个 </div>、
// 少一个闭合标签）。
//
// 跑：npm test
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';

register('./vue-loader.mjs', import.meta.url);

const { compile } = await import('vue');

// 有的组件在模块顶层就摸 window（量窗口宽度之类），只编译模板也得给个桩。
// 必须放在 import vue 之后：vue 初始化时会按「有没有 document」决定走不走浏览器分支。
globalThis.window = {
  innerHeight: 900,
  innerWidth: 1200,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const jsDir = new URL('../frontend/js/', import.meta.url);
const files = readdirSync(new URL('components/', jsDir))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `components/${name}`);

// ---------------------------------------------------------------------------
// 标签配平
//
// 编译那一步抓不到这个：多出来的 `</div>` 在 prod 构建里**既不报 error 也不报
// warning**（实测如此），但它会把 `<main>` 提前关掉 —— 编辑器那一整块掉到外面去，
// 页面看着就是「位置不对」。而这种错只有肉眼能看见，所以自己数一遍。
// ---------------------------------------------------------------------------
const VOID = new Set([
  'input', 'br', 'hr', 'img', 'meta', 'link', 'source', 'col', 'area', 'base', 'embed', 'track', 'wbr',
]);

/** @returns {string} 空串 = 配平的；否则是问题所在 */
export function checkBalance(template, label = '') {
  const src = template.replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{[\s\S]*?\}\}/g, '');
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    // 自闭合标签与空元素没有配对问题
    if (m[4] === '/' || VOID.has(name)) continue;
    if (!closing) {
      stack.push(name);
      continue;
    }
    if (!stack.length) return `${label}：多出来的 </${name}>`;
    const top = stack.pop();
    if (top !== name) return `${label}：</${name}> 对不上 <${top}>`;
  }
  return stack.length ? `${label}：没闭合的 <${stack.join(' > <')}>` : '';
}

const seen = new Set();
const failures = [];

/** 递归收集组件（含它声明用到的子组件）的模板，逐个编译 */
function check(name, component) {
  if (!component || typeof component !== 'object' || seen.has(component)) return;
  seen.add(component);
  if (component.template) {
    try {
      compile(component.template, {
        decodeEntities: (raw) => raw,
        onError: (err) => {
          throw err;
        },
      });
    } catch (err) {
      failures.push(`${name}：${err.message}`);
    }
  }
  Object.entries(component.components || {}).forEach(([key, child]) => check(`${name} > ${key}`, child));
}

/** 组件（含子组件）模板的配平问题 */
const balanceProblems = () => {
  const problems = [];
  const done = new Set();
  const walk = (label, component) => {
    if (!component || typeof component !== 'object' || done.has(component)) return;
    done.add(component);
    if (component.template) {
      const msg = checkBalance(component.template, label);
      if (msg) problems.push(msg);
    }
    Object.entries(component.components || {}).forEach(([key, child]) =>
      walk(`${label} > ${key}`, child)
    );
  };
  for (const [file, mod] of modules) walk(file, mod.default);
  return problems;
};

const modules = [];
for (const file of files) {
  const mod = await import(new URL(file, jsDir).href);
  modules.push([file, mod]);
  check(file, mod.default);
}

const mainSrc = readFileSync(new URL('main.js', jsDir), 'utf8');
const from = mainSrc.indexOf('template: `') + 'template: `'.length;
const mainTemplate = mainSrc.slice(from, mainSrc.indexOf('`', from));
try {
  compile(mainTemplate, {
    decodeEntities: (raw) => raw,
    onError: (err) => {
      throw err;
    },
  });
} catch (err) {
  failures.push(`main.js：${err.message}`);
}

test(`组件模板全部能编译（共 ${files.length} 个文件 + main.js）`, () => {
  assert.deepEqual(failures, []);
});

test('模板的标签是配平的（多一个 </div> 会把布局弄乱，编译器却不吭声）', () => {
  const problems = balanceProblems();
  if (checkBalance(mainTemplate, 'main.js')) problems.push(checkBalance(mainTemplate, 'main.js'));
  assert.deepEqual(problems, []);
});

test('配平检查自己得灵（否则它会变成一个永远通过的空壳）', () => {
  assert.notEqual(
    checkBalance('<main><div><span>x</span></div></div><p>y</p></main>', '自检'),
    '',
    '多出来的 </div> 必须被抓到'
  );
  assert.equal(checkBalance('<main><div><span>x</span></div></main>', '自检'), '');
  assert.notEqual(checkBalance('<main><div></main>', '自检'), '', '没闭合也要抓到');
});

test('组件个数对得上 —— 万一 readdir / 导入悄悄失效，别让它空过', () => {
  assert.ok(files.length > 10, `只读到 ${files.length} 个组件文件，路径大概不对`);
  assert.ok(seen.size >= files.length, `只收集到 ${seen.size} 个组件，少于 ${files.length} 个文件`);
});
