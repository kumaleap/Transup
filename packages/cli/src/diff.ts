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
/** 每个改动块上下各保留的 context 行数（规格 §3.4；单 hunk 时不裁剪、全显） */
const CONTEXT_LINES = 3;
/** 词级 diff 的变化比例阈值：超过则放弃词级、整行高亮（规格 §3.3） */
const CHANGE_THRESHOLD = 0.4;
/** 单行词级 diff 的 token 上限，超长行不做词级（DP 代价与视觉收益都不划算） */
const MAX_WORD_DIFF_TOKENS = 120;

type RowKind = "add" | "del" | "ctx";
interface Row {
  kind: RowKind;
  no: number;
  text: string;
}

/** 词级 diff 的分段：changed 段刷"亮一档"的词级背景，未变段只有整行底色 */
interface Seg {
  text: string;
  changed: boolean;
}

/** 渲染用行：diff 行可携带词级分段；gap 行表示被裁剪掉的 context */
type DisplayRow = (Row & { segs?: Seg[] }) | { kind: "gap"; hidden: number };

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

// ── 词级 diff（§3.3）───────────────────────────────────────

/** 按空白分词且保留空白 token（diffWordsWithSpace 语义）：空白也参与对齐 */
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

/**
 * 一对 remove/add 行的词级 diff。返回 [旧行分段, 新行分段]；
 * 变化比例（变化字符数 / 两行总字符数）> CHANGE_THRESHOLD 或行过长时
 * 返回 null，调用方回退为整行高亮。
 */
function diffWords(oldLine: string, newLine: string): [Seg[], Seg[]] | null {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  if (a.length === 0 || b.length === 0) return null;
  if (a.length > MAX_WORD_DIFF_TOKENS || b.length > MAX_WORD_DIFF_TOKENS) return null;

  // 与行级同款的 LCS DP，只是对象从"行"换成"词"
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // 相邻同类 token 合并成段，减少 ANSI 码切换
  const push = (segs: Seg[], text: string, changed: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };

  const oldSegs: Seg[] = [];
  const newSegs: Seg[] = [];
  let changedChars = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(oldSegs, a[i], false);
      push(newSegs, b[j], false);
      i++;
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      push(oldSegs, a[i], true);
      changedChars += a[i].length;
      i++;
    } else {
      push(newSegs, b[j], true);
      changedChars += b[j].length;
      j++;
    }
  }

  const ratio = changedChars / Math.max(oldLine.length + newLine.length, 1);
  if (ratio > CHANGE_THRESHOLD) return null;
  return [oldSegs, newSegs];
}

/** 相邻的 del 块与 add 块两两配对做词级 diff，命中的行挂上 segs */
function attachWordDiffs(rows: Row[]): (Row & { segs?: Seg[] })[] {
  const out: (Row & { segs?: Seg[] })[] = rows.map((r) => ({ ...r }));
  let i = 0;
  while (i < out.length) {
    if (out[i].kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < out.length && out[d].kind === "del") d++;
    let a = d;
    while (a < out.length && out[a].kind === "add") a++;
    // del 块第 k 行 ↔ add 块第 k 行；多出来的行保持整行高亮
    for (let k = 0; k < Math.min(d - i, a - d); k++) {
      const pair = diffWords(out[i + k].text, out[d + k].text);
      if (pair) {
        out[i + k].segs = pair[0];
        out[d + k].segs = pair[1];
      }
    }
    i = a;
  }
  return out;
}

// ── 上下文裁剪（§3.4）─────────────────────────────────────

/**
 * 每个改动块只保留上下各 CONTEXT_LINES 行 context，中间用 gap 行表示。
 * 单 hunk（只有一个改动块）时不裁剪——old_string 本来就是用户选定的
 * 最小区域，全显更直观；总量仍由 MAX_PREVIEW_LINES 兜底。
 */
function trimContext(rows: (Row & { segs?: Seg[] })[]): DisplayRow[] {
  let blocks = 0;
  let inBlock = false;
  for (const r of rows) {
    if (r.kind !== "ctx" && !inBlock) blocks++;
    inBlock = r.kind !== "ctx";
  }
  if (blocks <= 1) return rows;

  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "ctx") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "ctx") j++;
    const run = rows.slice(i, j);
    // 开头的 context 只需贴住下方改动，结尾的只需贴住上方改动
    const keepHead = i === 0 ? 0 : CONTEXT_LINES;
    const keepTail = j === rows.length ? 0 : CONTEXT_LINES;
    if (run.length <= keepHead + keepTail + 1) {
      // 只省得下 1 行时不值得放省略行，直接全显
      out.push(...run);
    } else {
      out.push(...run.slice(0, keepHead));
      out.push({ kind: "gap", hidden: run.length - keepHead - keepTail });
      out.push(...run.slice(run.length - keepTail));
    }
    i = j;
  }
  return out;
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
  // 规格 diff 宽 = columns - 12：为权限框边框+padding（4 列）、预览缩进
  // （2 列）和右侧呼吸感留余量；超宽终端仍帽在 120，免得整行背景横贯全屏。
  return Math.min(process.stdout.columns ?? 80, 120) - 12;
}

/** 分段列表截到 width 列以内，超出以 …（未变段样式）收尾 */
function fitSegs(segs: Seg[], width: number): Seg[] {
  const total = segs.reduce((n, s) => n + displayWidth(s.text), 0);
  if (total <= width) return segs;
  const out: Seg[] = [];
  let w = 0;
  for (const s of segs) {
    let kept = "";
    let whole = true;
    for (const ch of s.text) {
      const cw = displayWidth(ch);
      if (w + cw > width - 1) {
        whole = false;
        break;
      }
      kept += ch;
      w += cw;
    }
    if (kept) out.push({ text: kept, changed: s.changed });
    if (!whole) break;
  }
  out.push({ text: "…", changed: false });
  return out;
}

/** rows → 上色文本行。gutter = 行号右对齐 + 1 空格 + 符号，增删行铺背景。 */
function renderRows(rows: Row[], width = defaultWidth()): string[] {
  const display = trimContext(attachWordDiffs(rows));
  const shown = display.slice(0, MAX_PREVIEW_LINES);
  const gutterW = Math.max(
    ...shown.map((r) => (r.kind === "gap" ? 1 : String(r.no).length)),
    1,
  );

  const out = shown.map((r) => {
    if (r.kind === "gap") {
      // 被裁剪的 context，对齐到代码列起点（与截断话术同款 dim 省略行）
      return color.dim(`${" ".repeat(gutterW + 3)}… ${r.hidden} 行未变 …`);
    }
    const marker = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
    const prefix = `${String(r.no).padStart(gutterW)} ${marker} `;
    const bodyW = width - gutterW - 3;
    if (r.kind === "ctx") {
      const body = prefix + fitWidth(r.text, bodyW);
      return color.dim(body.slice(0, gutterW)) + body.slice(gutterW);
    }
    // 背景铺满整行：逐段各自带完整的开色/reset，段间无缝衔接不会撕裂；
    // 变化词刷"亮一档"的词级背景，其余（含 gutter 和右侧补齐）只有整行底色
    const lineBg = r.kind === "add" ? paint.diffAddBg : paint.diffRemoveBg;
    const wordBg = r.kind === "add" ? paint.diffAddWordBg : paint.diffRemoveWordBg;
    const segs = fitSegs(r.segs ?? [{ text: r.text, changed: false }], bodyW);
    const used =
      displayWidth(prefix) + segs.reduce((n, s) => n + displayWidth(s.text), 0);
    const pad = " ".repeat(Math.max(width - used, 0));
    return (
      lineBg(prefix) +
      segs.map((s) => (s.changed ? wordBg : lineBg)(s.text)).join("") +
      (pad ? lineBg(pad) : "")
    );
  });

  if (display.length > shown.length) {
    out.push(color.dim(`… +${display.length - shown.length} 行`));
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

  // 统计数字加粗（规格 §3.4）；bold 不能嵌在 dim 里（reset 会互相截断），
  // 所以数字段单独成段：dim 文案 + bold 数字交替拼接
  const header =
    color.bold(`  修改 ${path}`) +
    color.dim("（+") +
    color.bold(String(added)) +
    color.dim(" 行，-") +
    color.bold(String(removed)) +
    color.dim(" 行）");
  return [header, ...renderRows(rows, width).map((l) => `  ${l}`)].join("\n");
}

/** write_file 的预览：新建显示内容头部，覆盖则明确警告 */
export function renderWritePreview(args: Record<string, unknown>, width?: number): string {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const lineCount = content.split("\n").length;

  const overwriting = existsSync(path);
  // 与 renderEditPreview 同款：统计数字 bold，dim 文案分段拼接
  const header = overwriting
    ? color.red(color.bold(`  ⚠ 覆盖已有文件 ${path}`)) +
      color.dim("（原文件 ") +
      color.bold(String(readFileSync(path, "utf-8").split("\n").length)) +
      color.dim(" 行 → 新 ") +
      color.bold(String(lineCount)) +
      color.dim(" 行）")
    : color.bold(`  新建 ${path}`) +
      color.dim("（") +
      color.bold(String(lineCount)) +
      color.dim(" 行）");

  const rows = content
    .split("\n")
    .map((text, i): Row => ({ kind: "add", no: i + 1, text }));
  return [header, ...renderRows(rows, width).map((l) => `  ${l}`)].join("\n");
}
