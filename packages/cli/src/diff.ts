/**
 * diff 预览 —— 权限确认体验的关键
 *
 * 用户批准一次文件修改前，看到的应该是"改了什么"。格式对齐行业顶尖
 * 交互规格（docs/claude-code-interactions/03）：每行 = 行号右对齐 +
 * 1 空格 + 符号(+/-/空格) + 代码，增删行整行铺深绿/深红背景，
 * 未变化行作为上下文原样穿插。diff 本身用 LCS 按行对齐，不引入库。
 */
import { existsSync, readFileSync } from "node:fs";
import { color } from "./ui.js";
import { paint } from "./theme.js";

const MAX_PREVIEW_LINES = 40;
/** LCS 的 DP 规模上限，超过退化为整段删除+整段新增（预览语义不变） */
const MAX_LCS_LINES = 300;

type RowKind = "add" | "del" | "ctx";
interface Row {
  kind: RowKind;
  no: number;
  text: string;
}

// ── 行级 diff（LCS）────────────────────────────────────────

/**
 * old/new 两段文本按行对齐。行号从 startNo 起：删除行用旧侧行号、
 * 新增行用新侧行号，两侧同段共享起点（规格里的 numberDiffLines 行为）。
 */
export function diffRows(oldText: string, newText: string, startNo: number): Row[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [
      ...a.map((text, i) => ({ kind: "del" as const, no: startNo + i, text })),
      ...b.map((text, i) => ({ kind: "add" as const, no: startNo + i, text })),
    ];
  }

  // 经典 LCS DP：lcs[i][j] = a[i:] 与 b[j:] 的最长公共行数
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ kind: "ctx", no: startNo + j, text: b[j] });
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // 并列时先删后增：同一段的 - 行在 + 行上面，符合阅读习惯
      rows.push({ kind: "del", no: startNo + i, text: a[i] });
      i++;
    } else {
      rows.push({ kind: "add", no: startNo + j, text: b[j] });
      j++;
    }
  }
  return rows;
}

// ── 渲染 ────────────────────────────────────────────────────

/** 终端显示宽度（CJK 等全角算 2 列），背景铺满整行时对齐用 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/** 截到 width 列以内（背景行不允许折行撕裂），超出以 … 收尾 */
function fitWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function defaultWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 120) - 4;
}

/** rows → 上色文本行。gutter = 行号右对齐 + 1 空格 + 符号，增删行铺背景。 */
function renderRows(rows: Row[], width = defaultWidth()): string[] {
  const shown = rows.slice(0, MAX_PREVIEW_LINES);
  const gutterW = Math.max(...shown.map((r) => String(r.no).length), 1);

  const out = shown.map((r) => {
    const marker = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
    const body = `${String(r.no).padStart(gutterW)} ${marker} ${fitWidth(r.text, width - gutterW - 3)}`;
    if (r.kind === "ctx") {
      return color.dim(body.slice(0, gutterW)) + body.slice(gutterW);
    }
    // 背景铺满整行：右侧补齐空格；行内不再嵌其它 ANSI（reset 会截断背景）
    const padded = body + " ".repeat(Math.max(width - displayWidth(body), 0));
    return (r.kind === "add" ? paint.diffAddBg : paint.diffRemoveBg)(padded);
  });

  if (rows.length > shown.length) {
    out.push(color.dim(`… +${rows.length - shown.length} 行`));
  }
  return out;
}

/** old_string 在文件里的起始行号（找不到或读不了则从 1 起） */
function startLineOf(path: string, oldStr: string): number {
  try {
    const src = readFileSync(path, "utf-8");
    const idx = src.indexOf(oldStr);
    if (idx >= 0) return src.slice(0, idx).split("\n").length;
  } catch {
    // 预览是尽力而为，行号回退到 1 即可
  }
  return 1;
}

/** edit_file 的预览：行号 + 红删绿增（整行背景），头部统计增删行数 */
export function renderEditPreview(args: Record<string, unknown>, width?: number): string {
  const path = String(args.path ?? "");
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");

  const rows = diffRows(oldStr, newStr, startLineOf(path, oldStr));
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;

  const header =
    color.bold(`  修改 ${path}`) + color.dim(`（+${added} 行，-${removed} 行）`);
  return [header, ...renderRows(rows, width).map((l) => `  ${l}`)].join("\n");
}

/** write_file 的预览：新建显示内容头部，覆盖则明确警告 */
export function renderWritePreview(args: Record<string, unknown>, width?: number): string {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const lineCount = content.split("\n").length;

  const overwriting = existsSync(path);
  const header = overwriting
    ? color.red(color.bold(`  ⚠ 覆盖已有文件 ${path}`)) +
      color.dim(`（原文件 ${readFileSync(path, "utf-8").split("\n").length} 行 → 新 ${lineCount} 行）`)
    : color.bold(`  新建 ${path}`) + color.dim(`（${lineCount} 行）`);

  const rows = content
    .split("\n")
    .map((text, i): Row => ({ kind: "add", no: i + 1, text }));
  return [header, ...renderRows(rows, width).map((l) => `  ${l}`)].join("\n");
}
