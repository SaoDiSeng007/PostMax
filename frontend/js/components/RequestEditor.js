import { computed, defineComponent, nextTick, reactive, ref, watch } from 'vue';
import { EXTRACT_SOURCES, OP_LABELS } from '../assert.js';
import KeyValueTable from './KeyValueTable.js';
import VarSuggest from './VarSuggest.js';
import VarPicker from './VarPicker.js';
import VarHighlight from './VarHighlight.js';
import ScriptSuggest from './ScriptSuggest.js';
import {
  activeHeaders,
  BODY_TYPES,
  buildQuery,
  bodyTypeOf,
  finalUrl,
  interpolateJson,
  pathParamNames,
  splitUnresolved,
  stripJsonComments,
} from '../api.js';
import { useVarInsert } from '../useVarInsert.js';
import { applyScriptPick, buildScriptCandidates, detectScriptTrigger } from '../scriptsuggest.js';
import { SCRIPT_HINTS } from '../scriptApi.js';
import { SCRIPT_PANEL_SIZE } from '../caret.js';
import { VAR_TOKEN_G, VAR_TOKEN_HEAD, varNameOf } from '../vartoken.js';
import { requestVarNames } from '../planSteps.js';
import { parseCurl, toCurl } from '../curl.js';
import { useCopyFlag } from '../useCopy.js';

/** 主编辑区：URL 栏 + Params / Headers / Body / 前置脚本 / 断言 / 提取变量。 */
export default defineComponent({
  name: 'RequestEditor',
  components: { KeyValueTable, VarSuggest, VarPicker, VarHighlight, ScriptSuggest },
  props: {
    request: { type: Object, required: true },
    vars: { type: Object, default: () => ({}) },
    /** URL 栏的候选来源：只有环境配置，不含当前用户的认证信息（见 store.js 的 envVars） */
    urlVars: { type: Object, default: () => ({}) },
    /**
     * 「编辑时本来就取不到值、但不算漏配」的变量名（如方案里的测试数据列）。
     * 它们的值取决于跑到哪一行，编辑时无从得知 —— 不能按「空 = 没配」报警，
     * 否则在步骤里引用 {{列名}} 会被误报成「这些变量没取到值」。
     */
    placeholderVars: { type: Array, default: () => [] },
    sending: { type: Boolean, default: false },
    scriptRun: { type: Object, default: null },
    /** 有没有未提交的改动。false 时保存按钮置灰 —— 改都没改，没什么可存 */
    canSave: { type: Boolean, default: false },
    /**
     * 藏掉右下角的「保存 / 发送」。
     * 自动化里编辑的是方案步骤，发送和保存都归方案管，这两个按钮在这儿没意义。
     */
    hideActions: { type: Boolean, default: false },
  },
  emits: ['send', 'save', 'stop'],
  setup(props, { emit }) {
    const tab = ref('params');
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const urlPlaceholder = 'https://api.example.com/users/{{userId}}';
    const kvKeyPlaceholder = 'Header 名';
    const kvValuePlaceholder = '值，支持 {{token}}';
    const paramKeyPlaceholder = '参数名';
    const paramValuePlaceholder = '参数值，支持 {{token}}';
    const pathValuePlaceholder = '路径参数值，支持 {{token}}';
    const curlPlaceholder = "curl 'https://api.example.com/users' -H 'Accept: application/json'";
    // 说明文案里要出现字面量 {{var}}，必须放在 JS 字符串里
    const extractHint =
      '提取到的值当场就能用 {{变量名}} 引用。接口页里会写进当前环境变量；' +
      '方案里跑，只在那一次运行的这一行内部往后传，不会改环境。';
    const scriptHint =
      '发送前在沙箱里执行（超时 5 秒会被强制终止）。用 env.set 或 pm.environment.set 写入当前环境变量，其他请求用 {{变量名}} 就能读到。';
    const afterScriptHint =
      '响应回来之后在沙箱里执行（超时 5 秒会被强制终止），拿得到 response —— 从上面取不到的值' +
      '（数组里按条件挑、拼接、做变换）在这一段算；用 env.set 写的变量和前置脚本一样生效。' +
      '脚本抛错时这一步判失败，但请求已经发出，响应仍留在报告里。';

    const scriptPlaceholder =
      '// 发送前执行，可读写当前环境的变量（env.* 或 Postman 的 pm.environment.*）\n' +
      'var ts = Math.round(new Date() / 1000)\n' +
      "var sign = appId + ts + secretKey\n" +
      'var hac = CryptoJS.HmacSHA256(sign, secretKey)\n' +
      'var signature = CryptoJS.enc.Base64.stringify(hac)\n' +
      "pm.environment.set('auth', signature)\n" +
      "pm.environment.set('timestamp', ts)";

    const afterScriptPlaceholder =
      '// 响应回来之后执行，response 里是这次的结果\n' +
      'var data = response.json\n' +
      'if (!data) console.warn("响应不是 JSON，状态码", response.status)\n' +
      'if (data && data.list) {\n' +
      '  // 声明式的「提取」只能按下标取，按条件挑一项要在这儿写\n' +
      "  var main = data.list.filter(function (x) { return x.type === 'main' })[0]\n" +
      "  if (main) env.set('mainId', main.id)\n" +
      '}\n' +
      "console.log('耗时', response.time, 'ms')";

    // ---------------- URL ←→ Params 双向同步 ----------------
    let syncingUrl = false;
    const paramRows = computed(() => props.request.params || []);

    // ---------------- 路径参数 ----------------
    /*
     * URL 里写了 {名称}，这里就多出一行给它填值。
     *
     * 路径参数那几行**跟着 URL 走**，不让用户自己加、也不给删除按钮：这两处是同一件事的
     * 两种写法，各加各的必然对不上。URL 上删掉 {id}，这一行就自己没了。
     *
     * 表里允许有 URL 上已经不存在的行（改错名字再改回来，填过的值还在），
     * 所以下面一律以 URL 扫出来的键为准，多的忽略、少的不显示。
     */
    const pathKeys = computed(() => pathParamNames(props.request.url));
    const pathLabel = (key) => '{' + key + '}';

    const pathValue = (key) => {
      const row = (props.request.pathParams || []).find((r) => r.key === key);
      return row ? row.value : '';
    };

    function setPathValue(key, value) {
      if (!props.request.pathParams) props.request.pathParams = [];
      const rows = props.request.pathParams;
      const at = rows.findIndex((r) => r.key === key);
      if (at >= 0) rows[at].value = value;
      else rows.push({ key, value });
    }

    /** 还有几个没填。URL 上留着字面量 {id} 发出去必然不对，得让人看见 */
    const unfilledPaths = computed(
      () => pathKeys.value.filter((k) => !String(pathValue(k)).trim()).length
    );

    function syncParamsFromUrl() {
      const url = props.request.url || '';
      const qIndex = url.indexOf('?');
      const query = qIndex >= 0 ? url.slice(qIndex + 1) : '';
      props.request.params = query
        ? query
            .split('&')
            .filter((pair) => pair !== '')
            .map((pair) => {
              const eq = pair.indexOf('=');
              return eq >= 0
                ? { enabled: true, key: pair.slice(0, eq), value: pair.slice(eq + 1) }
                : { enabled: true, key: pair, value: '' };
            })
        : [];
    }

    /*
     * URL 变了就重新解析出 params —— 只响应用户改 URL（手输、curl 导入、
     * 在 URL 里插变量），**不能在编辑器挂载时跑**。
     *
     * 这里原本带着 immediate: true，那是错的。params 才是查询串的真身：
     * 改表格会反过来重写 URL（见下面 onParamsChange），发送时用的又只有 URL
     * —— 两个方向里，打开时该信的是 params。
     *
     * 挂载时反向从 URL 重建会把它冲掉：OpenAPI 导入的接口，query 参数只放在
     * params 里、URL 上没有 `?`（见 openapi.js），一进来就被清成空数组。
     * 症状是标签页刚打开就显示「有未保存的改动」，实际还把导入的参数弄丢了。
     * 新建的请求 params 本来就是空的，清完还是空的，所以只有导入的会发作。
     */
    watch(
      () => props.request.url,
      () => {
        if (syncingUrl) return;
        syncParamsFromUrl();
      },
      // sync：onParamsChange 会先置 syncingUrl 再写 URL，同步 flush 才能在这
      // 一次写入里就被拦下；换成默认的异步 flush，拦截会晚一拍，params 被自己冲掉
      { flush: 'sync' }
    );

    function onParamsChange(rows) {
      props.request.params = rows;
      const base = (props.request.url || '').split('?')[0];
      // 拼法和 OpenAPI 导入共用同一个函数，两边不会跑偏
      const query = buildQuery(rows);
      syncingUrl = true;
      props.request.url = query ? `${base}?${query}` : base;
      nextTick(() => {
        syncingUrl = false;
      });
    }

    // ---------------- curl 导入 / 导出 ----------------
    const showCurl = ref(false);
    const curlText = ref('');
    const curlError = ref('');
    const { copied: curlCopied, copy: copyToClipboard } = useCopyFlag();

    function applyCurl() {
      curlError.value = '';
      try {
        const parsed = parseCurl(curlText.value);
        props.request.method = parsed.method;
        props.request.url = parsed.url;
        if (parsed.headers.length) props.request.headers = parsed.headers;
        props.request.body = parsed.body || '';
        showCurl.value = false;
        curlText.value = '';
      } catch (e) {
        curlError.value = '解析失败：' + ((e && e.message) || String(e));
      }
    }

    async function copyCurl() {
      const text = toCurl({
        method: props.request.method,
        url: finalUrl(props.request, props.vars),
        headers: activeHeaders(props.request, props.vars),
        body: props.request.body,
      });
      const ok = await copyToClipboard(text);
      if (ok) {
        return;
      }
      // 复制失败就把内容摊在下面的框里，让用户自己选
      curlText.value = text;
      showCurl.value = true;
      curlError.value = '自动复制失败，请在下面的框里手动复制';
    }

    // ---------------- 变量解析状态 ----------------
    /** 编辑时取不到值、也不算漏配的名字（测试数据列、前面步骤提取的变量） */
    const placeholderNames = computed(() => new Set(props.placeholderVars || []));

    /** 这一小段没解析出来的 {{变量}}，是不是「编辑时本来就取不到值」的那个 */
    const isPlaceholderPart = (text) => {
      const m = VAR_TOKEN_HEAD.exec(text);
      return !!m && placeholderNames.value.has(m[1]);
    };

    /*
     * 最终 URL 的分段。占位变量不标红 —— 它没解析出来是正常的（值在运行时才有），
     * 标红等于把「正常的运行时变量」显示成「配错了」，和下面那条警告自相矛盾。
     */
    const finalUrlParts = computed(() =>
      splitUnresolved(finalUrl(props.request, props.vars)).map((p) => ({
        ...p,
        miss: p.miss && !isPlaceholderPart(p.text),
      }))
    );
    const urlHasMissing = computed(() => finalUrlParts.value.some((p) => p.miss));

    /**
     * 整个请求里引用到、但当前环境取不到值的变量。
     * URL / Params / Headers / Body / 前置脚本 全部扫一遍 —— 只标 URL 不够，
     * 实际最容易漏配的是 Authorization 里的 token。
     */
    const missingVars = computed(() => {
      /*
       * 哪些字段算「引用到了变量」交给 planSteps 的 requestVarTexts。
       *
       * 这里**曾经**自己列一遍字段，而执行引擎那边也列了一遍，两边还不一致：
       * 一个含 bodyForm 不含 pathParams，另一个反过来 —— 于是「这一步依不依赖数据」
       * 和「有没有变量漏配」各说各话。enabledOnly：停用的 params / headers 不算漏配。
       */
      const names = requestVarNames(props.request, { enabledOnly: true });

      return names.filter(
        (n) =>
          // 内置变量（$timestamp 之类）由前端现算，不该被当成漏配
          !n.startsWith('$') &&
          // 测试数据列编辑时值本来就是空的，也不算漏配
          !placeholderNames.value.has(n) &&
          (!Object.prototype.hasOwnProperty.call(props.vars, n) || props.vars[n] === '')
      );
    });

    // ---------------- Headers 快捷添加 ----------------
    // value 为空 = 只插头名，值留给用户自己填（有些服务用的头名不规范，
    // 也不走 Bearer 那套，硬塞个示例值反而要删）
    const commonHeaders = [
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Accept', value: 'application/json' },
      { key: 'Authorization', value: 'Bearer {{token}}' },
      { key: 'authoration', value: '' },
      { key: 'User-Agent', value: 'postmax' },
    ];

    /** 快捷添加撞名时的提示 —— 以前直接 return，点下去像没反应 */
    const headerHint = ref('');
    let headerHintTimer = null;

    function addHeader(item) {
      const headers = props.request.headers || (props.request.headers = []);
      const exists = headers.some(
        (h) => h.key.trim().toLowerCase() === item.key.toLowerCase()
      );
      if (exists) {
        headerHint.value = `${item.key} 已经在头部里了`;
        clearTimeout(headerHintTimer);
        headerHintTimer = setTimeout(() => (headerHint.value = ''), 2000);
        return;
      }
      headers.push({ enabled: true, key: item.key, value: item.value });
    }

    // ---------------- 其它 ----------------
    const enabledHeaderCount = computed(
      () => (props.request.headers || []).filter((h) => h.enabled && h.key.trim()).length
    );

    const tabs = computed(() => [
      {
        id: 'params',
        label: 'Params',
        count: paramRows.value.filter((p) => p.enabled && p.key.trim()).length,
      },
      { id: 'headers', label: 'Headers', count: enabledHeaderCount.value },
      { id: 'body', label: 'Body', count: (props.request.body || '').trim() ? 1 : 0 },
      {
        id: 'script',
        label: '前置脚本',
        count: (props.request.script || '').trim() ? 1 : 0,
      },
      {
        id: 'afterScript',
        label: '后置脚本',
        count: (props.request.afterScript || '').trim() ? 1 : 0,
      },
      { id: 'assert', label: '断言', count: (props.request.assertions || []).length },
      { id: 'extract', label: '提取变量', count: (props.request.extracts || []).length },
    ]);

    const bodyTypes = BODY_TYPES;

    /** 当前 body 格式。老请求没有 bodyType 字段，bodyTypeOf 会兜到 JSON。 */
    const currentBodyType = computed(() => bodyTypeOf(props.request.bodyType));

    // 只有 JSON 需要格式校验：纯文本没有「格式」，XML 浏览器里也没有现成的校验器
    const bodyCheck = computed(() => {
      if (currentBodyType.value.id !== 'json') return { ok: true, msg: '' };

      // 注释（`//` 到行尾）发送时会被去掉，所以校验前先做同一件事：
      // 否则一段合法的、只是带了注释的 body 会被报成 JSON 语法错误。
      // 全是注释时去掉后为空，和「body 空着」一样算通过。
      const raw = stripJsonComments(props.request.body).trim();
      if (!raw) return { ok: true, msg: '' };

      /*
       * 先替换变量、再校验，而且用的是 interpolateJson —— 和真正发出去的那份
       * 完全同一套替换，校验通过就等于发送没问题。
       *
       * 拿带占位符的原文去 JSON.parse 必然失败，但那不是用户的错：
       * `"pass": {{pass}}` 本来就是给变量留位置的。
       */
      // 测试数据列（方案里的 {{列名}}）编辑时本来就没有值，但不算漏配。
      // 先给它们一个普通字符串占位：interpolateJson 会按「带引号 / 裸值」两种情况
      // 分别放好，JSON 语法校验得以照常跑，也不会把它们误报成未赋值。
      const checkVars = { ...props.vars };
      placeholderNames.value.forEach((n) => {
        if (checkVars[n] === undefined || checkVars[n] === '') checkVars[n] = 'x';
      });
      const resolved = interpolateJson(raw, checkVars);

      // 变量还没配上的，占位符会原样留着。这时候报「JSON 语法错误」等于误导，
      // 直接说清楚缺哪个变量更有用
      //
      // 占位符里可能是 `'明文'|sha256` 这种，变量名要单独提出来；提不出来
      // （明文套了个不认识的过滤器）就把整段摆出来 —— 总之得让人看见是哪一处。
      const missing = [...resolved.matchAll(VAR_TOKEN_G)].map((m) => varNameOf(m[1]) || m[1]);
      if (missing.length) {
        return { ok: false, msg: `变量未赋值：${[...new Set(missing)].join('、')}` };
      }

      try {
        JSON.parse(resolved);
        return { ok: true, msg: 'JSON 格式正确' };
      } catch (e) {
        return { ok: false, msg: e.message };
      }
    });

    // Body 里的 {{变量}} 高亮由 <VarHighlight> 负责，位置数据取自 caretPos

    // ---------------- 格式化 ----------------

    /**
     * 按当前格式做「一键格式化」。认不出来的内容一律保持原样 ——
     * 格式化失败时把内容改坏，比不格式化糟得多。
     */
    function formatBody() {
      const type = currentBodyType.value.id;

      if (type === 'form') {
        // 表单没有「缩进」可言，排序才是它的格式化：两次请求的字段顺序对齐后好对比
        (props.request.bodyForm || []).sort((a, b) =>
          String(a.key || '').localeCompare(String(b.key || ''))
        );
        return;
      }

      if (type === 'text') return;

      const raw = props.request.body || '';
      if (!raw.trim()) return;

      try {
        if (type === 'json') {
          props.request.body = JSON.stringify(JSON.parse(raw), null, 2);
        } else if (type === 'xml') {
          const beautify = window.js_beautify;
          if (typeof beautify === 'function') {
            props.request.body = beautify(raw, {
              indent_size: 2,
              end_with_newline: false,
            });
          }
        }
      } catch (e) {
        // 解析不了就保持原样，错误提示由 bodyCheck 负责
      }
    }

    /** 当前编辑的是哪一段脚本（前置 / 后置共用同一块编辑区） */
    const isAfterScript = computed(() => tab.value === 'afterScript');
    const scriptField = computed(() => (isAfterScript.value ? 'afterScript' : 'script'));

    /** 当前这一段的执行结果（前置 / 后置各一份，都在 state.scriptRun 里） */
    const currentScriptRun = computed(() => {
      const run = props.scriptRun;
      if (!run || run.requestId !== props.request.id) return null;
      return isAfterScript.value ? run.post : run.pre;
    });

    /** 脚本：用 js-beautify 重排缩进。前置 / 后置都走这儿 */
    function formatScript() {
      const field = scriptField.value;
      const raw = props.request[field] || '';
      if (!raw.trim()) return;
      const beautify = window.js_beautify;
      if (typeof beautify !== 'function') return;
      try {
        props.request[field] = beautify(raw, {
          indent_size: 2,
          preserve_newlines: true,
          max_preserve_newlines: 2,
          end_with_newline: false,
        });
      } catch (e) {
        // 格式化失败就保持原样
      }
    }

    const addAssertion = () => {
      props.request.assertions.push({ target: 'status', path: '', op: 'eq', expect: '200' });
    };
    const removeAssertion = (i) => props.request.assertions.splice(i, 1);

    const addExtract = () => {
      props.request.extracts.push({ from: 'body', path: '', to: '' });
    };
    const removeExtract = (i) => props.request.extracts.splice(i, 1);

    // ---------------- Body 的变量补全 + 「插入数据」浮层 ----------------
    // 逻辑都在 useVarInsert 里（键值表格共用同一份）。这里只需要交代清楚
    // 「在这个组件里意味着什么」：值写在 request.body，输入框是下面那个 textarea。
    const bodyEl = ref(null);

    const {
      suggest: bodySuggest,
      caretPos: bodyCaretPos,
      pickerOpen,
      focused: bodyFocused,
      insertBtnStyle,
      suggestStyle,
      pickerStyle,
      measure: measureCaret,
      close: closeFloats,
      onInput: onBodyInput,
      pick: pickBodyVar,
      openPanel: openPicker,
      insert: insertBodyVar,
      onKeydown: onBodyKeydown,
      onFocus: onBodyFocus,
      onBlur: onBodyBlur,
    } = useVarInsert({
      getVars: () => props.vars,
      getHost: () => bodyEl.value,
      commit: (text) => {
        props.request.body = text;
      },
      multiline: true,
      // 插入变量的浮层钉在输入框左上角，不跟着光标跑
      pinPanel: true,
    });

    /*
     * ---------------- URL 栏的变量插入 ----------------
     *
     * 候选只来自「环境配置」，不包含当前用户的认证信息 —— 地址里该引用的
     * 永远是 baseUrl、版本号这类东西，token 混进来只会干扰。
     * 注意只是**候选范围**收窄：手写一个认证变量照样能解析，替换走的是完整的 vars。
     */
    const urlEl = ref(null);

    const {
      suggest: urlSuggest,
      caretPos: urlCaretPos,
      pickerOpen: urlPickerOpen,
      focused: urlFocused,
      insertBtnStyle: urlBtnStyle,
      suggestStyle: urlSuggestStyle,
      pickerStyle: urlPickerStyle,
      measure: measureUrlCaret,
      close: closeUrlFloats,
      onInput: onUrlInput,
      pick: pickUrlVar,
      openPanel: openUrlPicker,
      insert: insertUrlVar,
      onKeydown: onUrlKeydown,
      onFocus: onUrlFocus,
      onBlur: onUrlBlur,
    } = useVarInsert({
      getVars: () => props.urlVars,
      getHost: () => urlEl.value,
      commit: (text) => {
        props.request.url = text;
      },
    });

    /*
     * ---------------- 脚本编辑器的代码补全 ----------------
     *
     * 和上面两处共用同一套浮层机制（useVarInsert）—— 光标定位、跟着滚动、撤销友好的
     * 插入、上下键选择全都不用重写，差别只有「触发 / 候选 / 替换」三件事，走策略传进去。
     *
     * 补什么由 scriptApi.js 的词表说了算，而那份词表由 tests/script-api.test.js
     * 对着真沙箱逐项核对 —— 补全许诺了沙箱里没有的东西，比没有补全更坑。
     */
    const scriptEl = ref(null);

    const {
      suggest: scriptSuggest,
      measure: measureScriptCaret,
      close: closeScriptSuggest,
      onInput: onScriptInput,
      pick: pickScript,
      onKeydown: onScriptKeydown,
      onFocus: onScriptFocus,
      onBlur: onScriptBlur,
      suggestStyle: scriptSuggestStyle,
    } = useVarInsert({
      getVars: () => props.vars,
      getHost: () => scriptEl.value,
      commit: (text) => {
        props.request[scriptField.value] = text;
      },
      multiline: true,
      /*
       * 策略用函数给，是因为「能不能补 response」要现读：前置脚本执行时它还不存在，
       * 补出一堆用不了的属性只会浪费时间。
       */
      getSuggest: () => ({
        detect: detectScriptTrigger,
        candidates: (vars, trigger) =>
          buildScriptCandidates(trigger, vars, { afterScript: isAfterScript.value }),
        apply: applyScriptPick,
        // 插的是 get('') 这类带引号的骨架：光标落进引号里，接着就该写变量名
        afterPick: (text, caret) =>
          (text[caret - 1] === "'" || text[caret - 1] === '"') && text[caret - 2] === '(',
      }),
      panelSize: SCRIPT_PANEL_SIZE,
    });

    /** 页脚那排「常用写法」：和补全同一个词表，前置 / 后置各一套 */
    const scriptHints = computed(() => SCRIPT_HINTS[isAfterScript.value ? 'post' : 'pre']);

    /**
     * URL 栏按回车发送。
     *
     * 但正在选变量时不能发：那一瞬间回车是「选中候选」，顺手把请求发出去会很意外。
     */
    function onUrlEnter() {
      if (urlSuggest.open) return;
      emit('send');
    }

    // 下拉直接从 assert.js 那份生成，不再抄一遍 —— 否则加个操作符要改两个文件
    const ops = Object.entries(OP_LABELS).map(([value, label]) => ({ value, label }));
    const extractSources = EXTRACT_SOURCES;

    /**
     * 断言「期望值」那一栏的提示。不同操作符要填的东西差得远 ——
     * 一个「期望值」摆在所有操作符后面，等于没说。
     */
    const expectPlaceholder = (op) => {
      if (op === 'matches') return '正则，如 ^\\d+$ 或 /^tr-/i';
      if (op === 'type') return 'string / number / integer / boolean / object / array / null';
      if (op === 'length') return '长度，如 3 或 >0';
      if (op === 'schema') return 'JSON Schema，如 {"type":"object","required":["token"]}';
      return '期望值';
    };

    /** 断言第二栏填什么，跟着目标变 */
    const assertPathPlaceholder = (target) => {
      if (target === 'json') return 'data.token';
      if (target === 'header') return 'Content-Type';
      return '—';
    };
    /** 只有 JSON 和响应头需要第二栏 */
    const needAssertPath = (target) => target === 'json' || target === 'header';

    /** 提取的第二栏含义跟着来源变：JSON 路径 / 头名 / 正则 */
    const extractPathPlaceholder = (from) => {
      if (from === 'header') return '响应头名，如 Authorization';
      if (from === 'text') return '正则，如 token=([^&]+)';
      if (from === 'status') return '—';
      return '响应 JSON 路径，如 data.token';
    };

    return {
      tab, methods, tabs, bodyCheck, urlPlaceholder,
      bodyTypes, currentBodyType,
      formatBody, formatScript,
      finalUrlParts, urlHasMissing, missingVars,
      commonHeaders, addHeader, headerHint,
      kvKeyPlaceholder, kvValuePlaceholder, paramKeyPlaceholder, paramValuePlaceholder,
      pathValuePlaceholder, pathKeys, pathLabel, pathValue, setPathValue, unfilledPaths,
      ops, extractSources, extractHint, scriptHint, scriptPlaceholder,
      afterScriptHint, afterScriptPlaceholder, isAfterScript, scriptField, currentScriptRun,
      assertPathPlaceholder, needAssertPath, extractPathPlaceholder, expectPlaceholder,
      paramRows, onParamsChange,
      showCurl, curlText, curlError, curlCopied, curlPlaceholder, applyCurl, copyCurl,
      addAssertion, removeAssertion, addExtract, removeExtract,
      bodyEl, bodyCaretPos, urlCaretPos,
      bodySuggest, pickerOpen, bodyFocused, onBodyInput, onBodyKeydown, pickBodyVar,
      insertBodyVar, onBodyBlur, closeFloats,
      onBodyFocus, measureCaret, openPicker, insertBtnStyle, suggestStyle, pickerStyle,
      urlEl, urlSuggest, urlPickerOpen, urlFocused, urlBtnStyle, urlSuggestStyle, urlPickerStyle,
      onUrlInput, pickUrlVar, openUrlPicker, insertUrlVar, onUrlKeydown, onUrlFocus, onUrlBlur,
      closeUrlFloats, measureUrlCaret, onUrlEnter,
      scriptEl, scriptSuggest, scriptSuggestStyle, scriptHints,
      onScriptInput, onScriptKeydown, onScriptFocus, onScriptBlur,
      closeScriptSuggest, measureScriptCaret, pickScript,
      emit,
    };
  },
  template: `
    <div class="card card-editor">
      <div class="urlbar">
        <select class="method-select" v-model="request.method">
          <option v-for="m in methods" :key="m" :value="m">{{ m }}</option>
        </select>
        <div class="var-anchor url-anchor hl-url" @focusout="onUrlBlur">
          <VarHighlight
            :text="request.url"
            :vars="vars"
            :scroll-left="urlCaretPos.scrollLeft"
          />
          <input
            ref="urlEl"
            class="url-input hl-input"
            :class="{ 'has-missing': urlHasMissing }"
            v-model="request.url"
            :placeholder="urlPlaceholder"
            :title="urlHasMissing ? 'URL 里有变量没解析出来' : ''"
            @input="onUrlInput"
            @keydown="onUrlKeydown"
            @keyup="measureUrlCaret"
            @keyup.enter="onUrlEnter"
            @click="measureUrlCaret"
            @scroll="measureUrlCaret"
            @focus="onUrlFocus"
            @mousedown="closeUrlFloats"
          />
          <button
            class="insert-btn"
            v-if="urlFocused"
            :style="urlBtnStyle"
            title="插入环境变量"
            @mousedown.prevent="openUrlPicker"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="m3 21 9-9" />
              <path d="M15 4V2" /><path d="M15 16v-2" />
              <path d="M8 9h2" /><path d="M20 9h2" />
              <path d="M17.8 11.8 19 13" /><path d="M17.8 6.2 19 5" /><path d="M12.2 6.2 11 5" />
            </svg>
          </button>
          <VarSuggest
            v-if="urlSuggest.open"
            :style="urlSuggestStyle"
            :items="urlSuggest.items"
            :active-index="urlSuggest.index"
            @pick="pickUrlVar"
            @hover="urlSuggest.index = $event"
          />
          <VarPicker
            v-if="urlPickerOpen"
            :style="urlPickerStyle"
            :vars="urlVars"
            @pick="insertUrlVar"
            @close="closeUrlFloats()"
          />
        </div>
        <template v-if="!hideActions">
          <button
            class="btn btn-save"
            :class="{ 'btn-primary': canSave }"
            :disabled="!canSave || sending"
            :title="canSave ? '保存这个请求（Ctrl+S）' : '没有未保存的改动'"
            @click="emit('save')"
          >
            保存
          </button>
          <!--
            发送中这颗按钮变成「停止」而不是置灰：卡在超时上的请求（默认 30 秒、
            最长 10 分钟）只能干等，是最难熬的一种卡。点了只中止等待，见 store.stopSend
          -->
          <button
            v-if="sending"
            class="btn btn-stop"
            title="不等这次响应了（请求可能已经发到上游）"
            @click="emit('stop')"
          >停止</button>
          <button v-else class="btn btn-primary" @click="emit('send')">发送</button>
        </template>
        <button
          class="btn-square"
          :title="showCurl ? '收起 curl 导入' : '粘贴 curl 导入'"
          @click="showCurl = !showCurl"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v10" /><path d="m8 9 4 4 4-4" />
            <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </button>
        <button
          class="btn-square"
          :title="curlCopied ? '已复制' : '复制为 curl'"
          @click="copyCurl"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" />
          </svg>
        </button>
      </div>

      <div class="curl-box" v-if="showCurl">
        <textarea
          class="json-editor curl-text"
          v-model="curlText"
          spellcheck="false"
          :placeholder="curlPlaceholder"
        ></textarea>
        <div class="curl-actions">
          <button class="btn btn-primary btn-sm" @click="applyCurl">解析并填入</button>
          <button class="btn btn-sm" @click="showCurl = false">取消</button>
          <span class="error-text" v-if="curlError">{{ curlError }}</span>
        </div>
      </div>

      <div class="hint final-line">
        <span class="final-method">{{ request.method }}</span>
        <span
          v-for="(p, i) in finalUrlParts"
          :key="i"
          :class="{ 'var-miss': p.miss }"
        >{{ p.text }}</span>
      </div>

      <div class="var-warning" v-if="missingVars.length">
        <span>这些变量没取到值：</span>
        <span class="var-miss" v-for="n in missingVars" :key="n">{{ n }}</span>
        <span>—— 检查当前环境和用户里是否配好（URL、Params、Headers、Body、脚本都已检查）</span>
      </div>

      <div class="tabs">
        <button
          class="tab"
          v-for="t in tabs"
          :key="t.id"
          :class="{ active: tab === t.id }"
          @click="tab = t.id"
        >
          {{ t.label }}<span class="tab-badge" v-if="t.count">{{ t.count }}</span>
        </button>
      </div>

      <div class="pane">
        <template v-if="tab === 'params'">
          <!--
            路径参数：URL 里写了 {名称} 才有这一段，行也是从 URL 扫出来的。
            放 query 表格上面 —— 它在 URL 里的位置本来也更靠前。
          -->
          <div class="path-params">
            <div class="path-params-head">
              <span>路径参数</span>
              <!--
                没有路径参数时也留着这一段，只换一句说明。
                以前是整块 v-if 掉，结果「有这个功能」得先会写 {id} 才知道 ——
                看不见的能力等于没有。
              -->
              <span class="hint" v-if="pathKeys.length">URL 里的花括号占位。值只对当前这个请求生效</span>
              <span class="hint" v-else>URL 写成 /users/{id} 这样，这里就会出现一行</span>
              <span class="unfilled" v-if="unfilledPaths">{{ unfilledPaths }} 个没填</span>
            </div>

            <div class="path-row" v-for="k in pathKeys" :key="k">
              <span class="path-key" :title="pathLabel(k)">{{ pathLabel(k) }}</span>
              <input
                class="kv-input"
                :class="{ miss: !String(pathValue(k)).trim() }"
                :value="pathValue(k)"
                :placeholder="pathValuePlaceholder"
                @input="setPathValue(k, $event.target.value)"
              />
            </div>
          </div>

          <KeyValueTable
            :model-value="paramRows"
            @update:model-value="onParamsChange"
            :key-placeholder="paramKeyPlaceholder"
            :value-placeholder="paramValuePlaceholder"
            :vars="vars"
          />
        </template>

        <template v-else-if="tab === 'headers'">
          <div class="quick-row">
            <span class="hint">快捷添加</span>
            <button
              class="chip"
              v-for="h in commonHeaders"
              :key="h.key"
              @click="addHeader(h)"
            >{{ h.key }}</button>
            <span class="copy-fail" v-if="headerHint">{{ headerHint }}</span>
          </div>
          <KeyValueTable
            v-model="request.headers"
            :key-placeholder="kvKeyPlaceholder"
            :value-placeholder="kvValuePlaceholder"
            :vars="vars"
          />
        </template>

        <template v-else-if="tab === 'body'">
          <div class="editor-tools">
            <div class="body-types">
              <button
                class="body-type"
                v-for="t in bodyTypes"
                :key="t.id"
                :class="{ active: currentBodyType.id === t.id }"
                @click="request.bodyType = t.id"
              >{{ t.label }}</button>
            </div>
            <button class="btn btn-sm" @click="formatBody">
              {{ currentBodyType.id === 'form' ? '按 key 排序' : '格式化' }}
            </button>
            <span class="hint" v-if="!bodyCheck.ok" style="color: var(--red)">
              格式有问题：{{ bodyCheck.msg }}
            </span>
            <span class="hint" v-else-if="bodyCheck.msg">{{ bodyCheck.msg }}</span>
            <span class="hint" v-else-if="currentBodyType.id === 'text'">
              纯文本，不做格式校验
            </span>
            <span class="hint" v-else-if="currentBodyType.id === 'form'">
              字段按行填在下面，发送时拼成 a=1&amp;b=2
            </span>
          </div>

          <KeyValueTable
            v-if="currentBodyType.id === 'form'"
            :model-value="request.bodyForm || []"
            @update:model-value="request.bodyForm = $event"
            key-placeholder="字段名"
            value-placeholder="字段值，支持变量"
            :vars="vars"
          />

          <div class="var-anchor hl-body" v-else @focusout="onBodyBlur">
            <VarHighlight
              :text="request.body"
              :vars="vars"
              :json="currentBodyType.id === 'json'"
              :scroll-top="bodyCaretPos.scrollTop"
            />
            <textarea
              ref="bodyEl"
              class="json-editor hl-input"
              :class="{ invalid: !bodyCheck.ok, 'hl-code': currentBodyType.id === 'json' }"
              v-model="request.body"
              spellcheck="false"
              @input="onBodyInput"
              @keydown="onBodyKeydown"
              @keyup="measureCaret"
              @click="measureCaret"
              @scroll="measureCaret"
              @focus="onBodyFocus"
              @mousedown="closeFloats"
            ></textarea>
            <button
              class="insert-btn"
              v-if="bodyFocused"
              :style="insertBtnStyle"
              title="插入数据"
              @mousedown.prevent="openPicker"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="m3 21 9-9" />
                <path d="M15 4V2" /><path d="M15 16v-2" />
                <path d="M8 9h2" /><path d="M20 9h2" />
                <path d="M17.8 11.8 19 13" /><path d="M17.8 6.2 19 5" /><path d="M12.2 6.2 11 5" />
              </svg>
            </button>
            <VarSuggest
              v-if="bodySuggest.open"
              :style="suggestStyle"
              :items="bodySuggest.items"
              :active-index="bodySuggest.index"
              @pick="pickBodyVar"
              @hover="bodySuggest.index = $event"
            />
            <VarPicker
              v-if="pickerOpen"
              :style="pickerStyle"
              :vars="vars"
              @pick="insertBodyVar"
              @close="pickerOpen = false"
            />
          </div>
        </template>

        <!-- 前置 / 后置脚本共用这一块：只有取的字段和文案不同 -->
        <template v-else-if="tab === 'script' || tab === 'afterScript'">
          <div class="editor-tools">
            <button class="btn btn-sm" @click="formatScript">格式化 JS</button>
            <span class="hint">按 2 空格缩进重排，注释和空行保留</span>
          </div>

          <!-- 锚点容器：候选下拉相对它定位（和 Body / URL 那两处一个套路） -->
          <div class="var-anchor script-anchor" @focusout="onScriptBlur">
            <textarea
              ref="scriptEl"
              class="json-editor script-editor"
              v-model="request[scriptField]"
              spellcheck="false"
              :placeholder="isAfterScript ? afterScriptPlaceholder : scriptPlaceholder"
              @input="onScriptInput"
              @keydown="onScriptKeydown"
              @keyup="measureScriptCaret"
              @click="measureScriptCaret"
              @scroll="measureScriptCaret"
              @focus="onScriptFocus"
              @mousedown="closeScriptSuggest"
            ></textarea>
            <ScriptSuggest
              v-if="scriptSuggest.open"
              :style="scriptSuggestStyle"
              :items="scriptSuggest.items"
              :active-index="scriptSuggest.index"
              @pick="pickScript"
              @hover="scriptSuggest.index = $event"
            />
          </div>

          <div class="script-api">
            <code v-for="(h, i) in scriptHints" :key="i">{{ h }}</code>
          </div>

          <div class="hint">{{ isAfterScript ? afterScriptHint : scriptHint }}</div>

          <div class="script-result" v-if="currentScriptRun">
            <div class="script-result-head">
              <span class="badge" :class="currentScriptRun.ok ? 'ok' : 'err'">
                {{ currentScriptRun.ok ? '执行成功' : '执行失败' }}
              </span>
              <span class="metric">{{ scriptRun.at }}</span>
              <span class="metric" v-if="currentScriptRun.logs.length">
                日志 {{ currentScriptRun.logs.length }} 条，见响应区的「控制台」
              </span>
            </div>
            <pre class="script-logs" v-if="currentScriptRun.error">{{ currentScriptRun.error }}</pre>
            <div class="hint" style="padding: 8px 10px" v-else-if="currentScriptRun.droppedLogs">
              另有 {{ currentScriptRun.droppedLogs }} 条日志因超出上限未保留
            </div>
          </div>
        </template>

        <template v-else-if="tab === 'assert'">
          <div class="assert-row" v-for="(a, i) in request.assertions" :key="i">
            <select class="kv-input" v-model="a.target">
              <option value="status">状态码</option>
              <option value="time">响应耗时</option>
              <option value="size">响应大小（字节）</option>
              <option value="header">响应头</option>
              <option value="json">JSON 路径</option>
            </select>
            <input
              class="kv-input"
              v-model="a.path"
              :disabled="!needAssertPath(a.target)"
              :placeholder="assertPathPlaceholder(a.target)"
            />
            <select class="kv-input" v-model="a.op">
              <option v-for="o in ops" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input
              class="kv-input"
              v-model="a.expect"
              :disabled="a.op === 'exists'"
              :placeholder="expectPlaceholder(a.op)"
            />
            <button class="btn-icon" title="删除" @click="removeAssertion(i)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
          <button class="btn btn-sm" @click="addAssertion">＋ 添加断言</button>
          <div class="hint" style="margin-top: 8px">
            每次发送后自动校验，结果在下方的「断言」标签里。
          </div>
        </template>

        <template v-else>
          <div class="extract-row" v-for="(x, i) in request.extracts" :key="i">
            <!-- 老数据没有 from，缺省当 JSON / body（那时只有这一种来源） -->
            <select
              class="kv-input"
              :value="x.from || 'body'"
              @change="x.from = $event.target.value"
            >
              <option v-for="s in extractSources" :key="s.value" :value="s.value">
                {{ s.label }}
              </option>
            </select>
            <input
              class="kv-input"
              v-model="x.path"
              :disabled="(x.from || 'body') === 'status'"
              :placeholder="extractPathPlaceholder(x.from || 'body')"
            />
            <span style="color: var(--text-mute); text-align: center">→</span>
            <input class="kv-input key" v-model="x.to" placeholder="写入变量名，如 token" />
            <button class="btn-icon" title="删除" @click="removeExtract(i)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
          <button class="btn btn-sm" @click="addExtract">＋ 添加提取</button>
          <div class="hint" style="margin-top: 8px">{{ extractHint }}</div>
        </template>
      </div>
    </div>
  `,
});
