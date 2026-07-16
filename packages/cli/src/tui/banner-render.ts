/**
 * 首屏横幅渲染 —— 对标 Codex CLI 的紧凑信息盒
 *
 * 形态（宽度贴合内容，不再撑满终端）：
 *   ╭──────────────────────────────╮
 *   │ >_ transup v0.1.0            │
 *   │                              │
 *   │ 模型  deepseek-chat          │
 *   │ 目录  ~/workspace/demo       │
 *   │ MCP   已接入 3 个工具        │
 *   ╰──────────────────────────────╯
 *
 * 为什么手写字符串而不用 Ink 的 Box：横幅是纯静态内容，字符串渲染
 * 可以对"每行显示宽度一致"写测试（CJK 对齐的回归护栏）。
 */
import { color } from "../ui.js";
import { paint } from "../theme.js";
import { sanitizeTerminalField } from "../terminal-sanitize.js";
import {abbreviateHome} from "./workspace-path.js";

export interface BannerInfo {
  version: string;
  model: string;
  cwd: string;
  mcpToolCount: number;
}

// ── 显示宽度（CJK 双宽）────────────────────────────────────
// 只覆盖本产品会遇到的范围；box-drawing/block 字符都是单宽。

function charWidth(cp: number): number {
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** 按显示宽度截断，超出时以 … 收尾 */
function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

// ── 行模型 ──────────────────────────────────────────────────
// 一行 = 可选的暗色标签列 + 值；先按纯文本对齐，再上色（色码零宽）。

interface Cell {
  label?: string;
  text: string;
  paint?: (s: string) => string;
}

/** 标签列宽（"模型"/"目录" 均为 4）+ 与值之间的间距 */
const LABEL_WIDTH = 4;
const LABEL_GAP = 2;

const cell = (text: string, paintFn?: (s: string) => string): Cell => ({ text, paint: paintFn });
const labeled = (label: string, text: string): Cell => ({ label, text });
const blank: Cell = { text: "" };

function cellNaturalWidth(c: Cell): number {
  return (c.label ? LABEL_WIDTH + LABEL_GAP : 0) + displayWidth(c.text);
}

function renderCell(c: Cell, width: number): string {
  const labelCols = c.label ? LABEL_WIDTH + LABEL_GAP : 0;
  const text = truncate(c.text, Math.max(width - labelCols, 1));
  const pad = Math.max(width - labelCols - displayWidth(text), 0);
  const painted = c.paint ? c.paint(text) : text;
  const label = c.label
    ? color.dim(c.label) + " ".repeat(LABEL_WIDTH - displayWidth(c.label) + LABEL_GAP)
    : "";
  return label + painted + " ".repeat(pad);
}

// ── 内容组装 ────────────────────────────────────────────────

function contentRows(info: BannerInfo): Cell[] {
  return [
    // 标题进盒内首行；品牌绿是一屏唯一的常驻彩色
    cell(`>_ transup v${info.version}`, (s) => color.bold(paint.primary(s))),
    blank,
    labeled("模型", info.model),
    labeled("目录", abbreviateHome(info.cwd)),
    ...(info.mcpToolCount > 0 ? [labeled("MCP", `已接入 ${info.mcpToolCount} 个工具`)] : []),
  ];
}

// ── 盒子 ────────────────────────────────────────────────────

const MAX_WIDTH = 72;

export function renderBanner(info: BannerInfo, columns: number): string {
  // 窄到连"边框 + 标签列 + 一个字符"都放不下时，跳过比强制折行更安全。
  if (columns < 14) return "";

  const safeInfo: BannerInfo = {
    ...info,
    version: sanitizeTerminalField(info.version),
    model: sanitizeTerminalField(info.model),
    cwd: sanitizeTerminalField(info.cwd),
  };
  const rows = contentRows(safeInfo);

  // 宽度贴合最长内容行；满宽渲染在部分终端会触发自动折行，留 1 列余量
  const natural = Math.max(...rows.map(cellNaturalWidth)) + 4; // "│ " + " │"
  const W = Math.min(natural, columns - 1, MAX_WIDTH);
  const inner = W - 4;

  const bar = paint.frame("│");
  const lines: string[] = [paint.frame("╭" + "─".repeat(W - 2) + "╮")];
  for (const row of rows) {
    lines.push(`${bar} ${renderCell(row, inner)} ${bar}`);
  }
  lines.push(paint.frame("╰" + "─".repeat(W - 2) + "╯"));
  return lines.join("\n");
}
