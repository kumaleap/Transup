/**
 * 工具调用分组折叠 —— 纯模块，不 import React/Ink。
 *
 * 两段 assistant 文本之间的连续成功工具调用在主屏折叠成一行摘要：
 *   运行中（live）：`Pondering… · editing 2 files +35 · running 4 shell commands`
 *   落卡后（done）：`Thought for 2m56s · made 2 edits +35 · ran 4 shell commands`
 * done 形式固定用 "Thought for"——采样动词表里有 Moonwalking 这类彩蛋，
 * 无法机械变位成过去式。
 */
import { formatDuration } from "./activity/status-line.js";

/** 与 Transcript.tsx 的 inline.bold 同款：闭合用 22 不用 0，嵌在 dim 里不串色 */
const bold = (s: string | number) => `\x1b[1m${s}\x1b[22m`;

export interface ToolGroupEntry {
  /** 注册名（edit_file / bash / …），分类依据 */
  name: string;
  /** 展示名（Update / Read / …），Ctrl+O 全文屏用 */
  displayName: string;
  argSummary: string;
  preview: string;
  /** 未截断完整输出 —— 全文屏展开用 */
  full?: string;
  /** 编辑类工具的行数净差（tool_start 时从 parsedArgs 算出） */
  lineDelta?: number;
}

/**
 * 编辑类工具的行数净差：edit_file 用 new/old 行数差，write_file 用 content 行数。
 * 参数缺失（模型给了坏参数）或非编辑类返回 undefined。
 */
export function editLineDelta(
  name: string,
  args: Record<string, unknown>,
): number | undefined {
  const lines = (s: string) => s.split("\n").length;
  if (name === "edit_file") {
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      return undefined;
    }
    return lines(args.new_string) - lines(args.old_string);
  }
  if (name === "write_file") {
    if (typeof args.content !== "string") return undefined;
    return lines(args.content);
  }
  return undefined;
}

/** 只有 1 条时保持现状逐条显示，≥2 条才值得折叠 */
export function shouldCollapse(entries: ToolGroupEntry[]): boolean {
  return entries.length >= 2;
}

type Category = "edit" | "read" | "search" | "shell" | "other";

function categorize(name: string): Category {
  switch (name) {
    case "edit_file":
    case "write_file":
      return "edit";
    case "read_file":
      return "read";
    case "grep":
    case "list_dir":
      return "search";
    case "bash":
      return "shell";
    default:
      return "other";
  }
}

/** 分类段文案：[单数名词, 复数名词] × [live 动词, done 动词] */
const CATEGORY_TEXT: Record<Category, { live: string; done: string; noun: [string, string] }> = {
  edit: { live: "editing", done: "made", noun: ["file", "files"] },
  read: { live: "reading", done: "read", noun: ["file", "files"] },
  search: { live: "searching", done: "searched", noun: ["pattern", "patterns"] },
  shell: { live: "running", done: "ran", noun: ["shell command", "shell commands"] },
  other: { live: "calling", done: "called", noun: ["tool", "tools"] },
};

/** edit 的 done 形式名词特殊："made N edits" 而非 "made N files" */
const EDIT_DONE_NOUN: [string, string] = ["edit", "edits"];

/** 分类段固定顺序 */
const CATEGORY_ORDER: Category[] = ["edit", "read", "search", "shell", "other"];

export interface SummarizeGroupOptions {
  /** live=运行中进行时（动态区），done=落卡过去式（Static） */
  tense: "live" | "done";
  /** 本轮采样动词（Thinking/Pondering/…）；仅 live 使用 */
  verb: string;
  /** 段耗时（从段边界起算，含模型思考）；仅 done 使用，<1s 省略 */
  elapsedMs: number;
  entries: ToolGroupEntry[];
}

/** 组摘要一行：各段以 " · " 连接，计数 bold */
export function summarizeGroup(opts: SummarizeGroupOptions): string {
  const { tense, verb, elapsedMs, entries } = opts;
  const counts = new Map<Category, { n: number; delta: number }>();
  for (const e of entries) {
    const cat = categorize(e.name);
    const c = counts.get(cat) ?? { n: 0, delta: 0 };
    c.n += 1;
    c.delta += e.lineDelta ?? 0;
    counts.set(cat, c);
  }

  const segments: string[] = [];
  if (tense === "live") {
    segments.push(`${verb}…`);
  } else if (elapsedMs >= 1000) {
    segments.push(`Thought for ${formatDuration(elapsedMs)}`);
  }

  for (const cat of CATEGORY_ORDER) {
    const c = counts.get(cat);
    if (!c) continue;
    const text = CATEGORY_TEXT[cat];
    const noun =
      cat === "edit" && tense === "done" ? EDIT_DONE_NOUN : text.noun;
    let seg = `${tense === "live" ? text.live : text.done} ${bold(c.n)} ${noun[c.n === 1 ? 0 : 1]}`;
    if (cat === "edit" && c.delta !== 0) {
      seg += ` ${c.delta > 0 ? "+" : ""}${c.delta}`;
    }
    segments.push(seg);
  }

  return segments.join(" · ");
}
