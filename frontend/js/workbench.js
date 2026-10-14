// ---------------------------------------------------------------------------
// 工作台的工具清单
//
// 工作台是**只读**的本地工具台：每个工具都在浏览器里算完，结果只经「复制 / 下载」
// 出去 —— 不读存档，也不写任何项目数据。所以这里没有 store 依赖，就是一张表。
//
// 加一个工具是两件事：
//   1. 在这里加一条（左栏的清单直接读它）
//   2. 在 WorkbenchView 的 TOOL_VIEWS 里给它一个组件
//
// group 先都留空：工具少的时候分类只是多一次点击。等超过八个再按组渲染标题。
// ---------------------------------------------------------------------------

export const WORKBENCH_TOOLS = [
  {
    id: 'img2b64',
    group: '',
    name: '图片 → Base64',
    desc: '粘贴 / 拖拽 / 选文件，转成 data URL 或纯 base64',
  },
  {
    id: 'ts',
    group: '',
    name: '时间戳互转',
    desc: '时间戳 ↔ 北京时间 / UTC',
  },
  {
    id: 'json',
    group: '',
    name: 'JSON 取路径',
    desc: '格式化、校验，点节点复制断言用的路径',
  },
  {
    id: 'random',
    group: '',
    name: 'UUID / 随机值',
    desc: 'UUID v4、随机字符串，可批量生成',
  },
  {
    id: 'regex',
    group: '',
    name: '正则测试',
    desc: '实时标出命中和分组，配合 matches 断言',
  },
  {
    id: 'hash',
    group: '',
    name: '哈希',
    desc: 'SHA-256 / MD5，可对期望值',
  },
  {
    id: 'diff',
    group: '',
    name: '文本对比',
    desc: '两段文本逐行比，可按 JSON 归一后比',
  },
];

/**
 * 按 id 取工具。
 *
 * 找不到（没选过、或者清单改过之后存档里还留着旧 id）一律落到第一个 ——
 * 工作台是随手打开就要能用的地方，不该因为一个空 id 白屏。
 */
export function workbenchTool(id) {
  return WORKBENCH_TOOLS.find((t) => t.id === id) || WORKBENCH_TOOLS[0];
}
