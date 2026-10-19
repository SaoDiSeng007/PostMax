// ---------------------------------------------------------------------------
// CSV 解析
//
// 只做一件事：把一段 CSV 文本解析成表头 + 数据行。
// 引号规则按 RFC 4180 来，因为 Excel / WPS 导出的就是这个，常见的坑都在那儿：
//   - 字段用引号包起来时，里面可以有逗号、换行
//   - 引号里的 "" 表示一个字面量引号
//   - 引号外的 \r 是 CRLF 的一半，直接跳掉
//
// 另外两件「不处理就会安静出错」的事：
//   - 分隔符可能是分号或 Tab（Excel 在有些区域设置下就这么导），猜一下；
//   - 列名可能重复。重名的后果是 {{列名}} 只能取到其中一个，等于少一列数据，
//     而报告还会是全绿的 —— 所以重名一律加序号，并告诉调用方改了哪些。
// ---------------------------------------------------------------------------

/**
 * 猜分隔符：只数表头那一行，引号里的不算。
 *
 * CSV 本身没有「声明分隔符」的地方，只能数。一个都没数到就当逗号（单列的表也有）。
 */
function sniffDelimiter(text) {
  const line = String(text ?? '').split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (counts[ch] !== undefined) counts[ch] += 1;
  }
  let best = ',';
  let max = 0;
  // Object.entries 的顺序就是定义时的顺序 —— 打平时逗号优先
  Object.entries(counts).forEach(([ch, n]) => {
    if (n > max) {
      max = n;
      best = ch;
    }
  });
  return best;
}

/**
 * 粘贴用的解析：从 Excel / 网页表格复制出来是「制表符分列、换行分行」。
 *
 * 和 parseCsv 不是一回事，别合并：
 *   · CSV 是**文件**，别人给的 —— 要认引号、逃逸、还得嗅探分隔符；
 *   · 这个只认制表符（剪贴板里的形状是固定的），而且**不做转义处理**：格子里真
 *     带个引号，那就是那个值本身。
 *
 * 末尾那个空行丢掉：从 Excel 复制一片区域，末尾常跟着一个空行。
 *
 * @returns {string[][]} 每行一个数组；空内容给 []
 */
export function parseTsv(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

/**
 * @param {string} text CSV 原文
 * @returns {{columns: string[], rows: string[][], duplicates: string[]}}
 *   表头和内容（都去掉了尾部空行）；duplicates 是被改了名的重名列（原始名字）
 */
export function parseCsv(text) {
  // 去掉 BOM —— Excel 存 UTF-8 CSV 时会带上，不去掉第一列列名会多一个看不见的字符
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(src);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // 收尾：最后一行后面没有换行符
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  // 尾部空行（编辑器存文件常留一个）
  while (rows.length && rows[rows.length - 1].every((cell) => cell.trim() === '')) rows.pop();
  // 空文件也要带全字段：调用方是直接读 `结果.duplicates` 的，少一个键就是 undefined
  if (!rows.length) return { columns: [], rows: [], duplicates: [] };

  /*
   * 表头：空了给个占位名（否则那一列没法引用），重名加序号。
   *
   * 重名必须处理：数据行是按列名摊成 { 列名: 值 } 的（见 store 的 runOneRow），
   * 两个同名列里只有后一个能取到 —— 少了一列数据，报告却可能全绿，最难查。
   */
  const seen = new Map();
  const duplicates = [];
  const columns = rows[0].map((cell, index) => {
    const base = cell.trim() || `列${index + 1}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n === 1) return base;
    duplicates.push(base);
    return `${base}_${n}`;
  });

  // 补齐短行：后面的列留空，免得取值时下标越界
  const data = rows.slice(1).map((cells) => columns.map((_, index) => cells[index] ?? ''));

  return { columns, rows: data, duplicates };
}
