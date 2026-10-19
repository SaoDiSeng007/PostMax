import { computed, defineComponent } from 'vue';
import { VAR_TOKEN_G, VAR_TOKEN_HEAD, VAR_UNRESOLVED_G } from '../vartoken.js';
import { canResolveVar } from '../api.js';

/**
 * 输入框的高亮层：铺在 textarea / input 下面，负责「显示」，输入框本身只管编辑。
 *
 * 为什么要有这一层 —— 输入框（input / textarea）没法给局部文字单独上色，
 * 所以做法是两层叠着放：
 *   · 输入框文字设成透明，只留下光标和选区
 *   · 这一层显示真正看得见的文字，想怎么染色就怎么染色
 *
 * 两层的排版必须完全一致，否则会整体错位。所以排版不是各写一遍，而是由主题类
 * （.hl-url / .hl-kv / .hl-body）给出几个 CSS 变量，两层共用 —— 见 style.css。
 *
 * 两件事都在这层做：
 *   · {{变量}} —— 已赋值的和取不到值的用不同底色
 *   · JSON 语法 —— key / 字符串 / 数字 / 字面量 / 注释各一种颜色（只在 json 为真时开）
 */
export default defineComponent({
  name: 'VarHighlight',
  props: {
    text: { type: String, default: '' },
    vars: { type: Object, default: () => ({}) },
    /** 按 JSON 语法给 key / value 上不同颜色。非 JSON 内容不要开 */
    json: { type: Boolean, default: false },
    /** 输入框当前的滚动量。内层整体平移，外层负责裁剪，边界不会露出底色。 */
    scrollTop: { type: Number, default: 0 },
    scrollLeft: { type: Number, default: 0 },
  },
  setup(props) {
    const html = computed(() => {
      const raw = String(props.text || '');
      if (!raw) return '';

      const tokens = props.json ? scanJson(raw) : scanVars(raw);
      return tokens.map(renderToken).join('');
    });

    const innerStyle = computed(() => ({
      transform: `translate(${-props.scrollLeft}px, ${-props.scrollTop}px)`,
    }));

    /** 先转义再拼标签。顺序反了的话，文本里本来写的 < > 会被当成 HTML */
    function escapeHtml(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function renderToken(token) {
      const safe = escapeHtml(token.text);

      /*
       * 绿 / 红由 canResolveVar 说了算，而它就是替换时用的那一个判据 ——
       * 所以「标绿」和「发送时真能替换掉」永远是同一件事。
       *
       * 里面顺带覆盖了内置变量（{{$timestamp}}）和明文（{{'x'|sha256}}）：
       * 前者不在变量表里、后者压根不是变量，拿 hasOwnProperty 直接判都会误标红。
       */
      if (token.cls === 'var') {
        const known = canResolveVar(token.expr, props.vars || {});
        return `<mark class="${known ? 'ok' : 'miss'}">${safe}</mark>`;
      }
      return token.cls ? `<span class="tk-${token.cls}">${safe}</span>` : safe;
    }

    return { html, innerStyle };
  },
  template: `
    <div class="hl-layer" :class="{ 'hl-shown': json }" aria-hidden="true">
      <div class="hl-inner" :style="innerStyle" v-html="html"></div>
    </div>
  `,
});

const VAR_TOKEN = VAR_TOKEN_HEAD;

/**
 * 把一段普通文本里的 {{变量}} 拆出来，给非 JSON 输入框（URL / params / headers value）用。
 *
 * 不识别 JSON 语法，只认变量占位符；没匹配到的部分保持原样。
 */
function scanVars(src) {
  const re = new RegExp(VAR_TOKEN_G.source, 'gu');
  const out = [];
  let cursor = 0;
  let m;

  while ((m = re.exec(src)) !== null) {
    if (m.index > cursor) out.push({ text: src.slice(cursor, m.index), cls: '' });
    out.push({ text: m[0], cls: 'var', expr: m[1] });
    cursor = m.index + m[0].length;
  }

  if (cursor < src.length) out.push({ text: src.slice(cursor), cls: '' });
  return out;
}
const NUMBER_TOKEN = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const LITERAL_TOKEN = /^(?:true|false|null)\b/;

/**
 * 把 JSON 文本扫成一串 token。
 *
 * 这是个「够用就行」的扫描器：只为上色，不校验语法，也不要求 token 能拼成
 * 合法的 JSON。用户敲到一半、引号还没闭合的时候照样能扫，最坏的结果只是
 * 某几个字符的颜色不对 —— 而不会报错或者卡住。
 *
 * 它不改变任何内容：输出拼起来和输入完全一样，只是多套了几层标签。
 */
export function scanJson(src) {
  const out = [];
  let plain = '';
  let i = 0;

  const flush = () => {
    if (plain) {
      out.push({ text: plain, cls: '' });
      plain = '';
    }
  };

  while (i < src.length) {
    const rest = src.slice(i);

    /*
     * 注释：`//` 吃到行尾（换行本身不算注释，行号才不会跟着变色）。
     *
     * 必须排在变量判断**前面**：注释里的 {{变量}} 发送时会被整段丢掉，
     * 高亮成变量会让人以为它还会被替换。
     * 也不用担心误伤 `"url": "http://a.com"` —— 能走到这里就说明不在字符串里，
     * 上面那个引号分支会把整个字符串连内容一起吃掉。
     */
    if (src[i] === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j += 1;
      flush();
      out.push({ text: src.slice(i, j), cls: 'comment' });
      i = j;
      continue;
    }

    // 变量占位符先认：不然它在字符串里会被当成普通文本，颜色少一层
    const varMatch = rest.match(VAR_TOKEN);
    if (varMatch) {
      flush();
      out.push({ text: varMatch[0], cls: 'var', expr: varMatch[1] });
      i += varMatch[0].length;
      continue;
    }

    // 字符串：从 " 开始吃到收尾的 "，中途的 \" 要跳过
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }

      // 后面（跳过空白）紧跟冒号的，是 key；否则是字符串 value
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k += 1;

      flush();
      pushString(src.slice(i, j), src[k] === ':' ? 'key' : 'string');
      i = j;
      continue;
    }

    const numMatch = rest.match(NUMBER_TOKEN);
    if (numMatch) {
      flush();
      out.push({ text: numMatch[0], cls: 'number' });
      i += numMatch[0].length;
      continue;
    }

    const litMatch = rest.match(LITERAL_TOKEN);
    if (litMatch) {
      flush();
      out.push({ text: litMatch[0], cls: litMatch[0] === 'null' ? 'null' : 'literal' });
      i += litMatch[0].length;
      continue;
    }

    plain += src[i];
    i += 1;
  }

  flush();
  return out;

  /**
   * 把一段字符串切开，让嵌在里面的 {{变量}} 能单独上色。
   *
   * `"url": "{{base}}/users"` 这种写法在接口文档里到处都是 ——
   * 整段当一个字符串的话，变量就没有底色了，和别处的表现对不上。
   */
  function pushString(text, cls) {
    const re = new RegExp(VAR_UNRESOLVED_G.source, 'gu');
    let cursor = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      if (m.index > cursor) out.push({ text: text.slice(cursor, m.index), cls });
      out.push({ text: m[0], cls: 'var', expr: m[0].slice(2, -2).trim() });
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), cls });
  }
}
