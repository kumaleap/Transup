/**
 * 语法高亮 —— 纯函数，输入 markdown 风格文本，输出 ANSI 上色字符串
 *
 * 不引入 highlight.js 之类的重型库：终端里够用的高亮只需要三类信息 ——
 * 注释（暗）、字符串（黄）、关键字（品红），加上 diff 的红删绿增。
 * 覆盖不了的语言按普通文本渲染，永远不会出错。
 */
import { color } from "./ui.js";
// 表格对齐需要 CJK 感知的显示宽度，复用 banner 的实现（纯函数，无 TUI 依赖）
import { displayWidth } from "./tui/banner-render.js";

export interface TerminalTextOptions {
  preserveNewlines?: boolean;
  preserveTabs?: boolean;
}

/** Provider/tool prose boundary: remove C0/C1/DEL while preserving intentional layout only. */
export function sanitizeTerminalText(
  text: string,
  options: TerminalTextOptions = {},
): string {
  const preserveNewlines = options.preserveNewlines ?? true;
  const preserveTabs = options.preserveTabs ?? true;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f) {
      if ((code === 0x0a && preserveNewlines) || (code === 0x09 && preserveTabs)) out += char;
      continue;
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += char;
  }
  return out;
}

/** Diff/preview boundary: make controls inert without hiding byte-level differences. */
export function escapeTerminalControls(
  text: string,
  options: TerminalTextOptions = {},
): string {
  const preserveNewlines = options.preserveNewlines ?? true;
  const preserveTabs = options.preserveTabs ?? true;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a && preserveNewlines) {
      out += char;
    } else if (code === 0x09 && preserveTabs) {
      out += char;
    } else if (char === "\\") {
      out += "\\\\";
    } else if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += char;
    }
  }
  return out;
}

/** Structural terminal field boundary: no control may alter the containing row. */
export function sanitizeTerminalField(text: string): string {
  return sanitizeTerminalText(text, { preserveNewlines: false, preserveTabs: false });
}

function hasTerminalControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

// ── 语言定义 ────────────────────────────────────────────────
interface LangDef {
  /** 单行注释前缀（正则片段） */
  lineComment?: string;
  keywords: Set<string>;
}

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "export", "from", "default", "async",
  "await", "try", "catch", "finally", "throw", "switch", "case", "break",
  "continue", "typeof", "instanceof", "in", "of", "this", "null", "undefined",
  "true", "false", "yield", "static", "get", "set", "interface", "type",
  "enum", "namespace", "readonly", "public", "private", "protected", "as",
]);

const PY_KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "import",
  "from", "as", "try", "except", "finally", "raise", "with", "lambda",
  "yield", "async", "await", "pass", "break", "continue", "global", "None",
  "True", "False", "and", "or", "not", "in", "is", "assert", "del",
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while",
  "case", "esac", "function", "return", "export", "local", "echo", "exit",
]);

const RUST_GO_KEYWORDS = new Set([
  "fn", "let", "mut", "pub", "impl", "struct", "enum", "trait", "match",
  "use", "mod", "crate", "func", "package", "go", "defer", "chan", "map",
  "range", "var", "const", "type", "interface", "return", "if", "else",
  "for", "while", "break", "continue", "true", "false", "nil", "self",
]);

const LANGS: Record<string, LangDef> = {
  js: { lineComment: "//", keywords: JS_KEYWORDS },
  jsx: { lineComment: "//", keywords: JS_KEYWORDS },
  ts: { lineComment: "//", keywords: JS_KEYWORDS },
  tsx: { lineComment: "//", keywords: JS_KEYWORDS },
  javascript: { lineComment: "//", keywords: JS_KEYWORDS },
  typescript: { lineComment: "//", keywords: JS_KEYWORDS },
  json: { keywords: new Set(["true", "false", "null"]) },
  py: { lineComment: "#", keywords: PY_KEYWORDS },
  python: { lineComment: "#", keywords: PY_KEYWORDS },
  sh: { lineComment: "#", keywords: SH_KEYWORDS },
  bash: { lineComment: "#", keywords: SH_KEYWORDS },
  shell: { lineComment: "#", keywords: SH_KEYWORDS },
  zsh: { lineComment: "#", keywords: SH_KEYWORDS },
  yaml: { lineComment: "#", keywords: new Set(["true", "false", "null"]) },
  yml: { lineComment: "#", keywords: new Set(["true", "false", "null"]) },
  toml: { lineComment: "#", keywords: new Set(["true", "false"]) },
  rust: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
  rs: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
  go: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
};

// ── 单行代码高亮 ────────────────────────────────────────────
// 顺序：先摘出注释，再在剩余部分染字符串，最后染关键字。
// 用占位符避免二次匹配污染（关键字正则不会命中已含 ANSI 码的片段，
// 但字符串里的关键字会 —— 所以字符串先行）。
export function highlightCodeLine(line: string, lang: LangDef): string {
  line = sanitizeTerminalText(line, { preserveNewlines: false, preserveTabs: true });
  let comment = "";
  let code = line;
  if (lang.lineComment) {
    // 注意不能把字符串里的 // 当注释（如 "http://"）——简单启发：
    // 注释前缀之前的引号数为偶数才算注释
    const idx = findCommentStart(line, lang.lineComment);
    if (idx !== -1) {
      comment = color.dim(line.slice(idx));
      code = line.slice(0, idx);
    }
  }

  // 字符串染色，同时保护其内容不参与关键字匹配
  const parts: string[] = [];
  const strRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0;
  for (const m of code.matchAll(strRe)) {
    parts.push(highlightKeywords(code.slice(last, m.index), lang.keywords));
    parts.push(color.yellow(m[0]));
    last = m.index + m[0].length;
  }
  parts.push(highlightKeywords(code.slice(last), lang.keywords));
  return parts.join("") + comment;
}

function findCommentStart(line: string, prefix: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (line.startsWith(prefix, i)) {
      return i;
    }
  }
  return -1;
}

function highlightKeywords(text: string, keywords: Set<string>): string {
  return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) =>
    keywords.has(w) ? color.magenta(w) : w,
  );
}

/** diff 行：+ 绿 / - 红 / @@ 青，其余原样 */
export function highlightDiffLine(line: string): string {
  line = sanitizeTerminalText(line, { preserveNewlines: false, preserveTabs: true });
  if (line.startsWith("+") && !line.startsWith("+++")) return color.green(line);
  if (line.startsWith("-") && !line.startsWith("---")) return color.red(line);
  if (line.startsWith("@@")) return color.cyan(line);
  return line;
}

// ── Markdown：inline 渲染 ───────────────────────────────────
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
// *em*：成对单星、内侧非空格才生效，避免误伤 `2 * 3`、glob `*.ts` 之类的裸星号
const EM_STAR_RE = /\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;
// _em_：两侧必须不是单词字符，避免误伤 snake_case
const EM_UNDERSCORE_RE = /(?<![\w_])_([^\s_](?:[^_\n]*[^\s_])?)_(?![\w_])/g;
const LINK_RE = /\[([^\n]*?)\]\(([^)\n]*)\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)\]>]+/g;
const REPO_ISSUE_RE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;

/** OSC 8 终端超链接：现代终端可点击，不支持的终端只显示 text（转义序列零宽） */
function safeHyperlinkDestination(raw: string): string | null {
  if (!raw || /\s/.test(raw) || hasTerminalControl(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return sanitizeTerminalText(raw, { preserveNewlines: false, preserveTabs: false });
}

function hyperlink(rawUrl: string, rawText: string): string {
  const text = sanitizeTerminalText(rawText, { preserveNewlines: false, preserveTabs: false });
  const url = safeHyperlinkDestination(rawUrl);
  return url === null ? text : `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * 行内元素渲染。三步走：
 * 1. codespan / 链接先摘成内部占位符 —— 其内容不参与后续替换
 *    （比如 URL 里的下划线不能被当成 _em_，OSC 8 里的 URL 不能被裸 URL 再包一层）
 * 2. bold → em（顺序重要：先消耗 ** 再匹配单 *）
 * 3. 占位符回填
 * 删除线 ~~ 特意不处理：模型常用 ~ 表约数（如 ~3s），按原样输出最不容易出错。
 */
function renderInline(line: string): string {
  const SLOT_OPEN = "\ue000";
  const SLOT_CLOSE = "\ue001";
  const slots: string[] = [];
  const stash = (s: string) => `${SLOT_OPEN}${slots.push(s) - 1}${SLOT_CLOSE}`;
  line = line.replace(/[\ue000\ue001]/g, "�");

  let s = line.replace(INLINE_CODE_RE, (_, code) =>
    stash(color.cyan(sanitizeTerminalText(code, { preserveNewlines: false, preserveTabs: true }))),
  );

  s = s.replace(LINK_RE, (_, text: string, url: string) => {
    // mailto 剥成纯邮箱文本——终端里点邮件链接没有意义
    if (url.startsWith("mailto:")) {
      return stash(
        sanitizeTerminalText(url.slice("mailto:".length), {
          preserveNewlines: false,
          preserveTabs: false,
        }),
      );
    }
    // text 与 url 相同时效果一样，无需分支
    return stash(hyperlink(url, text));
  });
  s = s.replace(BARE_URL_RE, (url) => {
    // 句尾标点不算 URL 的一部分（"见 https://x.com。" 的句号）
    const tail = url.match(/[.,;:!?、。，；]+$/)?.[0] ?? "";
    const clean = url.slice(0, url.length - tail.length);
    return stash(hyperlink(clean, clean)) + sanitizeTerminalText(tail, {
      preserveNewlines: false,
      preserveTabs: false,
    });
  });
  // owner/repo#123 → GitHub issue 超链接（显示文本不变）
  s = s.replace(REPO_ISSUE_RE, (m, repo, num) =>
    stash(hyperlink(`https://github.com/${repo}/issues/${num}`, m)),
  );

  s = sanitizeTerminalText(s, { preserveNewlines: false, preserveTabs: true });

  s = s.replace(BOLD_RE, (_, t) => color.bold(t));
  s = s.replace(EM_STAR_RE, (_, t) => color.italic(t));
  s = s.replace(EM_UNDERSCORE_RE, (_, t) => color.italic(t));

  return s.replace(new RegExp(`${SLOT_OPEN}(\\d+)${SLOT_CLOSE}`, "g"), (_, i) =>
    slots[Number(i)] ?? "",
  );
}

// ── Markdown：列表 ──────────────────────────────────────────
interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

function matchListItem(line: string): ListItem | null {
  const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (ul) return { indent: ul[1].length, ordered: false, text: ul[2] };
  const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
  if (ol) return { indent: ol[1].length, ordered: true, text: ol[2] };
  return null;
}

/** 小写罗马数字（有序列表深度 3 用） */
function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/** 有序列表标号：深度 0/1 用数字，深度 2 用字母，深度 3+ 用罗马数字 */
function orderedMarker(depth: number, n: number): string {
  if (depth >= 3) return `${toRoman(n)}.`;
  if (depth === 2) return `${String.fromCharCode(97 + ((n - 1) % 26))}.`;
  return `${n}.`;
}

/**
 * 渲染一个列表块。深度按源缩进推断：维护一个缩进栈，缩进变大入栈
 * （深一层）、变小弹栈回到对应层——比"每 2 空格算一层"更稳，因为
 * 模型给有序列表常用 3 空格缩进。渲染统一为每层 2 空格。
 */
function renderListBlock(items: ListItem[]): string {
  const out: string[] = [];
  const indents: number[] = [];
  const counters: number[] = []; // counters[d] = 深度 d 的当前序号
  for (const item of items) {
    while (indents.length > 1 && item.indent < indents[indents.length - 1]) {
      indents.pop();
    }
    if (indents.length === 0) indents.push(item.indent);
    else if (item.indent > indents[indents.length - 1]) indents.push(item.indent);
    const depth = indents.length - 1;
    counters.length = depth + 1; // 回到浅层时重置更深层计数
    let marker = "-";
    if (item.ordered) {
      counters[depth] = (counters[depth] ?? 0) + 1;
      marker = orderedMarker(depth, counters[depth]);
    }
    out.push("  ".repeat(depth) + marker + " " + renderInline(item.text));
  }
  return out.join("\n");
}

// ── Markdown：表格 ──────────────────────────────────────────
type CellAlign = "left" | "center" | "right";

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
/** 整表内容宽度上限（无终端宽度可拿，按常见 80 列保守取值） */
const MAX_TABLE_WIDTH = 80;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const OSC8_RE = /\x1b\]8;;[^\x1b]*\x1b\\/g;

/** 剥掉 ANSI 色码与 OSC 8 链接封套，得到实际可见文本（对齐按它算宽） */
function stripCtl(s: string): string {
  return s.replace(OSC8_RE, "").replace(ANSI_RE, "");
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/** 按显示宽度截断并以 … 收尾（超宽表格的降级路径） */
function truncateWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/**
 * 基础版 Markdown 表格 → 盒线全边框。
 * - 单元格两侧 1 空格 padding；表头居中，数据按对齐标记（默认左）
 * - 列宽 = 内容最宽（displayWidth，CJK 算 2 列）；数据行之间也画 ├┼┤
 * - 超过 MAX_TABLE_WIDTH 时按比例压缩列宽（下限通常为 3，必要时降至 1），溢出格截断加 …
 * - 连 1 列内容宽也放不下全部列时，保留前部列并以末尾 … 列表示省略
 *   （规格里的折行/垂直格式回退不做——纯字符串渲染器拿不到终端宽度，
 *   截断已能保证不撕裂）
 */
function renderTable(rawRows: string[]): string {
  const columnFrameWidth = 3; // 左分隔符 + 两侧 padding；整行另有收尾分隔符
  const minimumColumnWidth = 1;
  const preferredMinimumWidth = 3;
  const rawHeaderCells = splitTableRow(rawRows[0]);
  const rawAligns: CellAlign[] = splitTableRow(rawRows[1]).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
  const rawDataRows = rawRows.slice(2).map(splitTableRow);
  const sourceCols = Math.max(
    rawHeaderCells.length,
    rawAligns.length,
    1,
    ...rawDataRows.map((r) => r.length),
  );
  const maxVisibleCols = Math.floor(
    (MAX_TABLE_WIDTH - 1) / (columnFrameWidth + minimumColumnWidth),
  );
  const cols = Math.min(sourceCols, maxVisibleCols);
  const omitsColumns = sourceCols > cols;
  const visibleCells = (cells: string[]) =>
    Array.from({ length: cols }, (_, c) => (omitsColumns && c === cols - 1 ? "…" : cells[c]));
  const headerCells = visibleCells(rawHeaderCells);
  const aligns: CellAlign[] = Array.from({ length: cols }, (_, c) =>
    omitsColumns && c === cols - 1 ? "center" : (rawAligns[c] ?? "left"),
  );
  const dataRows = rawDataRows.map(visibleCells);

  // 每格预渲染 inline 样式；宽度按剥掉控制序列后的可见文本算
  const mk = (raw: string | undefined) => {
    const rendered = renderInline(raw ?? "");
    const plain = stripCtl(rendered);
    return { rendered, plain, width: displayWidth(plain) };
  };
  const head = Array.from({ length: cols }, (_, c) => mk(headerCells[c]));
  const body = dataRows.map((r) => Array.from({ length: cols }, (_, c) => mk(r[c])));

  let widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, head[c].width, ...body.map((r) => r[c].width)),
  );
  const budget = MAX_TABLE_WIDTH - (columnFrameWidth * cols + 1);
  const total = widths.reduce((a, b) => a + b, 0);
  const minWidth = Math.max(
    minimumColumnWidth,
    Math.min(preferredMinimumWidth, Math.floor(budget / cols)),
  );
  if (total > budget) {
    const remainingBudget = budget - cols * minWidth;
    const extraWidths = widths.map((w) => Math.max(0, w - minWidth));
    const extraTotal = extraWidths.reduce((a, b) => a + b, 0);
    widths = extraWidths.map(
      (extra) => minWidth + Math.floor((extra * remainingBudget) / extraTotal),
    );
  }

  const cell = (c: { rendered: string; plain: string; width: number }, w: number, align: CellAlign) => {
    if (c.width > w) return truncateWidth(c.plain, w); // 截断格放弃样式，保住对齐
    const pad = w - c.width;
    if (align === "center") {
      return " ".repeat(Math.floor(pad / 2)) + c.rendered + " ".repeat(Math.ceil(pad / 2));
    }
    return align === "right" ? " ".repeat(pad) + c.rendered : c.rendered + " ".repeat(pad);
  };
  const row = (cells: ReturnType<typeof mk>[], alignOf: (i: number) => CellAlign) =>
    "│" + cells.map((c, i) => ` ${cell(c, widths[i], alignOf(i))} `).join("│") + "│";
  const border = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;

  const out = [border("┌", "┬", "┐"), row(head, () => "center"), border("├", "┼", "┤")];
  body.forEach((cells, idx) => {
    if (idx > 0) out.push(border("├", "┼", "┤")); // 数据行之间也画分隔线
    out.push(row(cells, (i) => aligns[i] ?? "left"));
  });
  out.push(border("└", "┴", "┘"));
  return out.join("\n");
}

// ── Markdown：块级渲染 ──────────────────────────────────────
/**
 * 把 markdown 风格文本渲染为 ANSI 字符串。按块解析：
 * - fenced code block：fence 行暗色，代码按语言高亮，diff 红绿
 * - 标题去掉 # 号：H1 粗体+斜体+下划线，H2+ 粗体
 * - 引用块：dim 的 ▎ 竖条 + 斜体正文（正文不 dim——暗色主题下几乎看不见）
 * - 列表：无序统一 `- `，有序分层标号（数字/字母/罗马），每层缩进 2 空格
 * - hr（--- 或 星号×3 或 ___ 单独成行）→ 字面 `---`（dim）
 * - 表格 → 盒线全边框
 * - inline：`code` 青色、**bold**、*em*、OSC 8 链接（见 renderInline）
 * 块与块之间空一行（对齐 Claude Code 的 Box gap={1}），首尾不留空行；
 * 列表整体算一个块，项与项之间不插空行。
 * 未闭合的 fence（流式输出中常见）按已开启的代码块渲染。
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let para: string[] = []; // 相邻普通行聚成一个段落块
  const flushPara = () => {
    if (para.length) {
      blocks.push(para.join("\n"));
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block（含未闭合容错）
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushPara();
      const tag = fence[1].toLowerCase();
      const isDiff = tag === "diff" || tag === "patch";
      const lang = LANGS[tag] ?? null;
      const buf = [
        color.dim(sanitizeTerminalText(line, { preserveNewlines: false, preserveTabs: true })),
      ];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        const l = lines[i];
        buf.push(
          isDiff
            ? highlightDiffLine(l)
            : lang
              ? highlightCodeLine(l, lang)
              : sanitizeTerminalText(l, { preserveNewlines: false, preserveTabs: true }),
        );
        i++;
      }
      if (i < lines.length) {
        buf.push(
          color.dim(
            sanitizeTerminalText(lines[i], { preserveNewlines: false, preserveTabs: true }),
          ),
        );
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // 空行只作块分隔，本身不输出（连续空行折叠为一个块间距）
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const title = renderInline(heading[2]);
      blocks.push(
        heading[1].length === 1
          ? color.bold(color.italic(color.underline(title)))
          : color.bold(title),
      );
      i++;
      continue;
    }

    // hr：--- / *** / ___ 单独成行 → 统一渲染为字面 ---（dim）
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      blocks.push(color.dim("---"));
      i++;
      continue;
    }

    // 引用块：连续 > 行算一个块
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        const m = lines[i].match(/^\s*>\s?(.*)$/)!;
        buf.push(color.dim("▎ ") + color.italic(renderInline(m[1])));
        i++;
      }
      blocks.push(buf.join("\n"));
      continue;
    }

    // 表格：| 行 + 分隔行开头才算（否则当普通段落）
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara();
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push(renderTable(rows));
      continue;
    }

    // 列表块：连续列表项算一个块；项间空行不断开（宽松列表），
    // 但空行后不是列表项则块结束
    if (matchListItem(line)) {
      flushPara();
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = matchListItem(lines[i]);
        if (item) {
          items.push(item);
          i++;
          continue;
        }
        if (/^\s*$/.test(lines[i])) {
          let j = i + 1;
          while (j < lines.length && /^\s*$/.test(lines[j])) j++;
          if (j < lines.length && matchListItem(lines[j])) {
            i = j;
            continue;
          }
        }
        break;
      }
      blocks.push(renderListBlock(items));
      continue;
    }

    para.push(renderInline(line));
    i++;
  }
  flushPara();
  return blocks.join("\n\n");
}
