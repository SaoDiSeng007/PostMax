// ---------------------------------------------------------------------------
// 让 node 的测试进程能 import 'vue'
//
// 浏览器里 `vue` 是靠 index.html 的 importmap 指到 frontend/vendor/ 的，node 不认
// importmap，默认会去 node_modules 找（那儿没有）。这个 loader 把裸模块名映射到同一份
// vendor 文件 —— 于是测试里能直接 import 组件、把它们那些**运行时编译**的模板过一遍
// 编译器（模板语法错了在浏览器里就是白屏，而它不会在别处报错）。
//
// 只给 tests/templates.test.js 用（node --test 每个文件一个进程，互不影响）。
// ---------------------------------------------------------------------------

// file: URL 本身就是合法的模块说明符，不用再转成本地路径
const VUE = new URL('../frontend/vendor/vue.esm-browser.prod.js', import.meta.url).href;
const YAML = new URL('../frontend/vendor/js-yaml.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vue') return { url: VUE, shortCircuit: true };
  if (specifier === 'js-yaml') return { url: YAML, shortCircuit: true };
  return nextResolve(specifier, context);
}
