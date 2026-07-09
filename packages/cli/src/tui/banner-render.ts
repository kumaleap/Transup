/**
 * 首屏横幅渲染 —— 对标 Claude Code 的开场盒子
 *
 * 形态（宽终端，双栏）：
 *   ╭─── transup v0.1.0 ──────────────────────────────╮
 *   │        欢迎回来，kuma！        │ 上手提示        │
 *   │        （乌贼 logo）           │ …               │
 *   │        做极致体验的编程 agent  │ ───────         │
 *   │        模型 · 目录 · 会话      │ 最近更新        │
 *   ╰──────────────────────────────────────────────────╯
 *   窄终端（< 84 列）退化为单栏。
 *
 * 为什么手写字符串而不用 Ink 的 Box：标题要嵌进上边框、双栏中间要有
 * 分隔线，Ink 的 border 都做不到；而横幅是纯静态内容，字符串渲染
 * 反而可以对"每行显示宽度一致"写测试（CJK 对齐的回归护栏）。
 *
 * logo 是一只乌贼：头部像向上的箭头（up —— 产出质量向上的代码），
 * 底部是圆润柔软的触手（trans —— 吸收各路模型与信息）。
 */
import { homedir, userInfo } from "node:os";
import { color } from "../ui.js";

export interface BannerInfo {
  version: string;
  providerId: string;
  model: string;
  sessionId: string;
  /** 恢复的历史消息条数；0 = 全新会话 */
  resumedMessages: number;
  cwd: string;
  mcpToolCount: number;
}

/** 乌贼：箭头头部 + 圆润触手 */
const LOGO = [
  "   ▟▙   ",
  "  ▟██▙  ",
  " ▟████▙ ",
  "▐██████▌",
  "▝▜████▛▘",
  "╭╯╰╮╭╯╰╮",
  "╰╮ ╰╯ ╭╯",
];

const TAGLINE = "做极致体验的编程 agent";

const TIPS = [
  "输入任务直接开始，/help 查看全部命令",
  "@路径 可以把文件内容带进对话",
  "写操作会先展示 diff，确认后才落盘",
];

/** 每个版本手工更新的亮点（对标 Claude Code 的 What's new） */
const WHATS_NEW = [
  "运行时韧性：断流重试 / 截断续跑 / 循环熔断",
  'headless 模式：transup -p "任务"（管道/CI）',
  "MCP：settings.json 可接入外部工具",
];

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

/** 一行单元格：先按纯文本对齐，再整行上色（色码零宽，不参与对齐计算） */
interface Cell {
  text: string;
  paint?: (s: string) => string;
}

const cell = (text: string, paint?: (s: string) => string): Cell => ({ text, paint });
const blank: Cell = { text: "" };

function renderCell(c: Cell, width: number, align: "left" | "center"): string {
  const text = truncate(c.text, width);
  const pad = width - displayWidth(text);
  const padded =
    align === "center"
      ? " ".repeat(Math.floor(pad / 2)) + text + " ".repeat(Math.ceil(pad / 2))
      : text + " ".repeat(pad);
  // 上色包住内容但不包住补位空格也可以 —— 空格无色差，这里整段包更简单
  return c.paint ? c.paint(padded) : padded;
}

function shortenPath(p: string, max: number): string {
  const home = homedir();
  const s = p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return truncate(s, max);
}

// ── 内容组装 ────────────────────────────────────────────────

function leftColumn(info: BannerInfo, width: number): Cell[] {
  let name = "";
  try {
    name = userInfo().username;
  } catch {
    /* 极少数环境拿不到，欢迎语退化 */
  }
  const session =
    `会话 ${info.sessionId}` +
    (info.resumedMessages > 0 ? `（续 ${info.resumedMessages} 条）` : "");

  return [
    blank,
    cell(name ? `欢迎回来，${name}！` : "欢迎！", (s) => color.bold(s)),
    blank,
    ...LOGO.map((l) => cell(l, (s) => color.cyan(s))),
    blank,
    cell(TAGLINE, (s) => color.bold(color.cyan(s))),
    blank,
    cell(`${info.model} · ${info.providerId}`),
    cell(shortenPath(info.cwd, width), (s) => color.dim(s)),
    cell(session, (s) => color.dim(s)),
    ...(info.mcpToolCount > 0
      ? [cell(`已接入 ${info.mcpToolCount} 个 MCP 工具`, (s) => color.dim(s))]
      : []),
    blank,
  ];
}

function rightColumn(width: number): Cell[] {
  return [
    cell("上手提示", (s) => color.bold(s)),
    ...TIPS.map((t) => cell(t, (s) => color.dim(s))),
    cell("─".repeat(width), (s) => color.dim(s)),
    cell("最近更新", (s) => color.bold(s)),
    ...WHATS_NEW.map((t) => cell(t, (s) => color.dim(s))),
    cell("完整进展见 ROADMAP.md", (s) => color.dim(s)),
  ];
}

// ── 盒子 ────────────────────────────────────────────────────

const MIN_TWO_COL = 84;
const MAX_WIDTH = 104;

export function renderBanner(info: BannerInfo, columns: number): string {
  // 满宽渲染在部分终端会触发自动折行，留 1 列余量
  const W = Math.max(46, Math.min(columns - 1, MAX_WIDTH));
  const twoCol = W >= MIN_TWO_COL;

  // 内容区宽度：W 减去两侧边框和内边距（"│ " + " │"）
  const inner = W - 4;
  // 双栏：左栏固定，右栏吃剩余（中间 " │ " 占 3）
  const leftW = twoCol ? 36 : inner;
  const rightW = inner - leftW - 3;

  const left = leftColumn(info, leftW);
  const right = twoCol ? rightColumn(rightW) : [];
  const rows = Math.max(left.length, right.length);
  // 短的一栏垂直居中
  const leftPad = Math.floor((rows - left.length) / 2);
  const rightPad = Math.floor((rows - right.length) / 2);

  const lines: string[] = [];

  // 标题嵌进上边框：╭─── transup v0.1.0 ───…───╮
  const title = `transup v${info.version}`;
  const fill = W - displayWidth(title) - 7; // "╭─── " + " " + "╮"
  lines.push(
    color.dim("╭─── ") + color.bold(title) + color.dim(" " + "─".repeat(Math.max(fill, 1)) + "╮"),
  );

  const bar = color.dim("│");
  for (let i = 0; i < rows; i++) {
    const l = renderCell(left[i - leftPad] ?? blank, leftW, "center");
    if (twoCol) {
      const r = renderCell(right[i - rightPad] ?? blank, rightW, "left");
      lines.push(`${bar} ${l} ${bar} ${r} ${bar}`);
    } else {
      lines.push(`${bar} ${l} ${bar}`);
    }
  }

  lines.push(color.dim("╰" + "─".repeat(W - 2) + "╯"));
  return lines.join("\n");
}
