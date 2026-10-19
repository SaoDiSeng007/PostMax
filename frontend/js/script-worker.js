// ---------------------------------------------------------------------------
// 脚本的沙箱执行环境（前置 / 后置共用）
//
// 跑在 Web Worker 里，有三层好处：
//   1. 拿不到页面的 window / document / DOM，脚本无法乱动界面，是天然的隔离层；
//   2. Worker 自带的网络能力（fetch / XHR / WebSocket / importScripts）也摘掉了，
//      见下面的 sealNetworkGlobals —— 否则一句 fetch('/api/state') 就能读到整份存档；
//   3. 主线程可以随时 worker.terminate()，死循环也能被强制掐掉。
//
// 变量不直接改环境，而是把「改了什么、删了什么」回传主线程，由主线程统一应用。
//
// 前置拿不到响应（那时候还没发），后置多一个 response 形参 —— 两侧的
// env / console / pm / CryptoJS 完全一致。
// ---------------------------------------------------------------------------

const MAX_LOGS = 200;
let cryptoLoaded = false;

function loadCrypto() {
  if (cryptoLoaded) return;
  cryptoLoaded = true;
  try {
    // 相对 Worker 脚本自身的位置解析
    importScripts('../vendor/crypto-js.min.js');
  } catch (e) {
    // 加载失败时 self.CryptoJS 为 undefined，下面会给脚本一个明确的报错
  }
}

// ---------------------------------------------------------------------------
// 把 Worker 全局上的网络能力摘掉
//
// new Function 的作用域链会落到 Worker 全局，而 Worker 上有 fetch / XMLHttpRequest /
// importScripts / WebSocket —— 只注入 env/console/pm/CryptoJS 四个形参是挡不住的：
// 脚本里一句 fetch('/api/state') 就能读到整份存档（含 token），或者绕过 /api/proxy
// 直连外部。那样这个「沙箱」就名不副实了。
//
// 顺序要紧：必须在 loadCrypto 之后（CryptoJS 是 importScripts 进来的）。
// 删不掉的（有的环境把这类属性设成不可删）就换成一个直接抛错的桩，不能留在那儿。
// ---------------------------------------------------------------------------

/** 先把「回传结果」这条路抓在手里，再删掉 postMessage —— 否则脚本能自己伪造一条结果 */
const postResult = self.postMessage.bind(self);

function sealNetworkGlobals() {
  const deny = () => {
    throw new Error('脚本沙箱不提供网络能力：要发请求就发接口本身，要读写变量用 env / pm');
  };

  [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts',
    'caches', 'indexedDB', 'Worker', 'SharedWorker', 'BroadcastChannel', 'postMessage',
  ].forEach((name) => {
    try {
      delete self[name];
    } catch (e) {
      // 删不掉就走下面的兜底
    }
    if (name in self) {
      try {
        self[name] = deny;
      } catch (e) {
        // 连赋值都不允许：只能作罢
      }
    }
  });
}

loadCrypto();
sealNetworkGlobals();

/**
 * 变量最终是存在环境里的字符串。
 * 对象 / 数组转成 JSON，避免直接 String() 变成 "[object Object]"。
 */
function toStoredValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 日志值的结构化回传
//
// 控制台要能把对象折开看，所以日志不能再在沙箱里就 stringify 成一行文本 ——
// 那样一个嵌套对象进去，出来就是一坨字符串。这里把值转成「能结构化克隆、
// 又能被 JSON 树渲染」的形状：普通对象和数组原样保留，特殊类型（函数、
// 符号、Error、循环引用……）标成 {__t: '...'} 的小牌子。
// ---------------------------------------------------------------------------

const LOG_DEPTH = 8;
const LOG_ENTRIES = 200;

function toLogValue(value, depth = 0, seen = new Set()) {
  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'undefined') return { __t: 'undefined' };
  if (t === 'bigint') return { __t: 'bigint', value: String(value) };
  if (t === 'symbol') return { __t: 'symbol', value: String(value) };
  if (t === 'function') return { __t: 'function', value: String(value).slice(0, 200) };

  if (value instanceof Error) {
    return { __t: 'error', name: value.name, message: value.message, stack: value.stack || '' };
  }
  if (value instanceof Date) return { __t: 'date', value: value.toISOString() };
  if (value instanceof RegExp) return { __t: 'regexp', value: String(value) };

  if (depth >= LOG_DEPTH) return { __t: 'deep' };
  if (seen.has(value)) return { __t: 'circular' };
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, LOG_ENTRIES).map((v) => toLogValue(v, depth + 1, seen));
      if (value.length > LOG_ENTRIES) out.push({ __t: 'more', count: value.length - LOG_ENTRIES });
      return out;
    }
    if (value instanceof Map) {
      return { __t: 'map', entries: [...value.entries()].slice(0, LOG_ENTRIES).map(([k, v]) => [toLogValue(k, depth + 1, seen), toLogValue(v, depth + 1, seen)]) };
    }
    if (value instanceof Set) {
      return { __t: 'set', values: [...value.values()].slice(0, LOG_ENTRIES).map((v) => toLogValue(v, depth + 1, seen)) };
    }
    if (t === 'object') {
      const out = {};
      const keys = Object.keys(value);
      keys.slice(0, LOG_ENTRIES).forEach((k) => {
        out[k] = toLogValue(value[k], depth + 1, seen);
      });
      if (keys.length > LOG_ENTRIES) out.__more = { __t: 'more', count: keys.length - LOG_ENTRIES };
      return out;
    }
  } finally {
    seen.delete(value);
  }

  return String(value);
}

/**
 * 后置脚本看到的响应对象。
 *
 * json 做成惰性 getter：脚本只读 status 时不白解析 10MB 的 body；
 * 解析失败给 null（脚本里 `response.json && ...` 就能防住），不抛错阻断脚本。
 */
function makeResponse(raw) {
  if (!raw) return undefined;
  let parsed;
  let done = false;
  const out = {
    status: raw.status,
    statusText: raw.statusText,
    time: raw.time,
    size: raw.size,
    headers: raw.headers || [],
    body: raw.body === undefined ? '' : raw.body,
  };
  Object.defineProperty(out, 'json', {
    enumerable: true,
    get() {
      if (!done) {
        done = true;
        try {
          parsed = JSON.parse(out.body);
        } catch {
          parsed = null;
        }
      }
      return parsed;
    },
  });
  return out;
}

self.onmessage = (event) => {
  const { code, vars, response } = event.data || {};
  const logs = [];
  let droppedLogs = 0;
  const changes = {};
  const removals = [];

  const makeLogger = (level) => (...args) => {
    if (logs.length >= MAX_LOGS) {
      droppedLogs += 1;
      return;
    }
    logs.push({ level, args: args.map((a) => toLogValue(a)) });
  };

  /** 这个名字还没被这次脚本删掉 */
  const alive = (key) => !removals.includes(String(key));

  const env = {
    /*
     * 读的是**这一步脚本自己改过之后**的那一份：set 过的能读回来，unset 过的读不到。
     *
     * 只读最开始那个快照的话，`env.set('a', 1); env.get('a')` 会返回旧值 ——
     */
    get: (key) => {
      const name = String(key);
      if (Object.prototype.hasOwnProperty.call(changes, name)) return changes[name];
      return alive(name) ? vars[name] : undefined;
    },
    has: (key) => {
      const name = String(key);
      return (
        Object.prototype.hasOwnProperty.call(changes, name) ||
        (alive(name) && Object.prototype.hasOwnProperty.call(vars, name))
      );
    },
    all: () => {
      const out = {};
      Object.keys(vars).forEach((k) => {
        if (alive(k)) out[k] = vars[k];
      });
      return Object.assign(out, changes);
    },
    set: (key, value) => {
      const name = String(key);
      changes[name] = toStoredValue(value);
      // 先删又写回来：以最后一次为准
      const i = removals.indexOf(name);
      if (i >= 0) removals.splice(i, 1);
    },
    unset: (key) => {
      const name = String(key);
      // 同理：先 set 过、后 unset，那就是删。两边都留一份会让「哪个算数」变成看运气
      delete changes[name];
      if (!removals.includes(name)) removals.push(name);
    },
  };

  const pm = { environment: env, variables: env };
  const sandboxConsole = {
    log: makeLogger('log'),
    info: makeLogger('info'),
    warn: makeLogger('warn'),
    error: makeLogger('error'),
  };

  if (!self.CryptoJS) {
    try {
      self.CryptoJS = new Proxy(
        {},
        {
          get() {
            throw new Error('CryptoJS 未能加载，这里用不了加密函数');
          },
        }
      );
    } catch (e) {
      // 忽略：下面执行时自然会报错
    }
  }

  const done = (extra) => postResult({ logs, droppedLogs, changes, removals, ...extra });

  try {
    // 前置把 response 传成 undefined：脚本里误用会立刻 TypeError，比给个空壳子强
    const fn = new Function('env', 'console', 'pm', 'CryptoJS', 'response', '"use strict";\n' + code);
    fn(env, sandboxConsole, pm, self.CryptoJS, makeResponse(response));
    done({ ok: true });
  } catch (e) {
    done({ ok: false, error: (e && e.message) || String(e) });
  }
};
