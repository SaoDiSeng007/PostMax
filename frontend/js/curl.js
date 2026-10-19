// ---------------------------------------------------------------------------
// curl 双向：粘贴解析成请求 / 把请求生成 curl
// ---------------------------------------------------------------------------

/** 去掉换行续行（bash 的 \ 和 Windows cmd 的 ^）。 */
function normalize(text) {
  return String(text || '')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\^\r?\n/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 按 shell 规则切分参数，支持单引号 / 双引号 / 反斜杠转义。 */
function tokenize(input) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === quote) {
        quote = '';
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

const METHOD_FLAGS = new Set(['-X', '--request']);
const HEADER_FLAGS = new Set(['-H', '--header']);
const DATA_FLAGS = new Set([
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
]);

/**
 * 解析一段 curl，返回 { method, url, headers, body }。
 * 解析不了就抛错，由调用方展示给用户。
 */
export function parseCurl(text) {
  const tokens = tokenize(normalize(text));
  if (!tokens.length) throw new Error('内容为空');

  let i = 0;
  if (tokens[0].toLowerCase() === 'curl') i = 1;

  const result = { method: '', url: '', headers: [], body: '' };
  const dataParts = [];

  for (; i < tokens.length; i++) {
    const token = tokens[i];

    if (METHOD_FLAGS.has(token)) {
      result.method = (tokens[++i] || '').toUpperCase();
      continue;
    }

    if (HEADER_FLAGS.has(token)) {
      const value = tokens[++i] || '';
      const sep = value.indexOf(':');
      if (sep > 0) {
        result.headers.push({
          enabled: true,
          key: value.slice(0, sep).trim(),
          value: value.slice(sep + 1).trim(),
        });
      }
      continue;
    }

    if (DATA_FLAGS.has(token)) {
      dataParts.push(tokens[++i] || '');
      continue;
    }

    if (token.startsWith('-')) continue; // 其它选项一律忽略
    if (!result.url) result.url = token;
  }

  if (dataParts.length) {
    result.body = dataParts.join('&');
    if (!result.method) result.method = 'POST';
  }
  if (!result.method) result.method = 'GET';
  if (!result.url) throw new Error('没有解析到 URL');

  return result;
}

/**
 * 用单引号包住一段文本，内部的单引号按 bash 的写法转义。
 *
 * 不能只写 `'${value}'`：值里只要有一个单引号（`?q=it's` 这种很常见），
 * 引号就提前闭合了，命令行会被截断成语法错误。
 */
function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 把当前请求生成 curl 命令。
 *
 * header 判断用 `enabled !== false` 而不是 `enabled`：项目里的请求每个 header 都带
 * `enabled`，但「实际发出的请求」是后端回来的（proxy.py 里那份 prepared.headers），
 * 里面根本没有这个字段 —— 写成 `h.enabled` 会把它们全过滤掉，导出一个没有头部的 curl。
 */
export function toCurl({ method, url, headers = [], body = '' }) {
  const lines = [`curl -X ${method} ${quote(url)}`];

  headers
    .filter((h) => h.enabled !== false && String(h.key || '').trim())
    .forEach((h) => lines.push(`  -H ${quote(`${h.key}: ${h.value}`)}`));

  if (body && body.trim()) {
    lines.push(`  -d ${quote(body)}`);
  }

  return lines.join(' \\\n');
}
