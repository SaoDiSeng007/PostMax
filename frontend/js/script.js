// ---------------------------------------------------------------------------
// 脚本执行器（主线程侧）：前置 / 后置共用一条通道
//
// 真正的执行放到 script-worker.js 里，这里只负责：创建 Worker、传参、
// 看门狗超时、拿结果、收工。
//
// 超时是这里最关键的能力：脚本写了 while(true) 时，Worker 会被 terminate 掉，
// 页面不会卡死。
//
// 两者的差别只有一处：后置多传一个 response（前置那时候还没发请求）。
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 5000;

/**
 * 跑一段脚本。
 *
 * @param {string} code 脚本源码
 * @param {Object} vars 当前变量的浅拷贝
 * @param {Object|null} response 后置脚本才有的响应；前置传 null
 * @param {{timeout?:number}} options
 * @returns {Promise<{ok:boolean, logs:Array, droppedLogs:number, changes:Object,
 *                    removals:string[], error:string}>}
 */
function runScript(code, vars = {}, response = null, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const empty = { ok: true, logs: [], droppedLogs: 0, changes: {}, removals: [], error: '' };

  if (!code || !String(code).trim()) return Promise.resolve(empty);

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker('./js/script-worker.js');
    } catch (e) {
      resolve({
        ...empty,
        ok: false,
        error: '无法创建脚本沙箱：' + ((e && e.message) || String(e)),
      });
      return;
    }

    // timer 必须在 finish 之前声明：finish 是个闭包，而 worker.onerror 有可能
    // 同步触发 —— 那时 timer 还在 TDZ 里，clearTimeout 会抛 ReferenceError，
    // 把真正的错误原因盖掉
    let timer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    timer = setTimeout(() => {
      finish({
        ...empty,
        ok: false,
        error: `脚本执行超过 ${timeout} ms 已被强制终止（可能是死循环或长时间阻塞）`,
      });
    }, timeout);

    worker.onmessage = (event) => {
      const data = event.data || {};
      finish({
        ok: !!data.ok,
        logs: data.logs || [],
        droppedLogs: data.droppedLogs || 0,
        changes: data.changes || {},
        removals: data.removals || [],
        error: data.error || '',
      });
    };

    worker.onerror = (event) => {
      finish({
        ...empty,
        ok: false,
        error: (event && event.message) || '脚本沙箱执行出错',
      });
    };

    worker.postMessage({
      code: String(code),
      vars: { ...vars },
      // 响应体不截断：用户要的就是「脚本里能看完整响应」。拷贝代价由结构化克隆承担
      response: response || null,
    });
  });
}

/** 前置脚本：发送前跑，拿不到响应 */
export function runPreScript(code, vars = {}, options = {}) {
  return runScript(code, vars, null, options);
}

/** 后置脚本：响应回来之后跑，多一个 response（status / headers / body / json …） */
export function runPostScript(code, vars = {}, response = null, options = {}) {
  return runScript(code, vars, response, options);
}
