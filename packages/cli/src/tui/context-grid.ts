/**
 * /context 方块网格（规格 06 §1.2 的简化版）
 *
 * Claude Code 按消息类别分色统计；我们的 engine 只暴露 chars/percent，
 * 就做水位版：已用 ⛁ / 空闲 ⛶，颜色随水位绿 → 琥珀 → 红 ——
 * 跟状态栏仪表条同一套语义，但面积大得多，一眼能看出"还剩多少"。
 *
 * 纯函数输出 ANSI 字符串数组，方便单测（strip 掉颜色断言字符）。
 */
import { paint } from "../theme.js";

const USED = "⛁";
const FREE = "⛶";
const ROWS = 5;

function tint(percent: number): (s: string) => string {
  if (percent >= 80) return paint.danger;
  if (percent >= 50) return paint.warn;
  return paint.success;
}

/** 网格行（ANSI 上色）。width 为每行格子数，按终端宽度传入。 */
export function renderContextGrid(percent: number, width: number): string[] {
  const cols = Math.max(10, width);
  const total = cols * ROWS;
  const used = Math.round((Math.max(0, Math.min(100, percent)) / 100) * total);
  const color = tint(percent);

  const lines: string[] = [];
  for (let row = 0; row < ROWS; row++) {
    let line = "";
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      line += index < used ? color(USED) : paint.frame(FREE);
    }
    lines.push(line);
  }
  return lines;
}

/** /context 的完整输出：标题 + 网格 + 汇总行 */
export function renderContextUsage(
  info: { chars: number; percent: number },
  model: string,
  terminalColumns: number,
): string {
  // 预算总量从 chars/percent 反推（percent=0 时没得推，不显示总量）
  const budget = info.percent > 0 ? Math.round(info.chars / (info.percent / 100)) : 0;
  const kb = (n: number) => `${Math.round(n / 1000)}k`;
  const summary =
    budget > 0
      ? `${model} · ${kb(info.chars)}/${kb(budget)} 字符（${info.percent}%）`
      : `${model} · ${kb(info.chars)} 字符（${info.percent}%）`;

  const gridWidth = Math.max(10, Math.min(40, terminalColumns - 4));
  return ["上下文用量", ...renderContextGrid(info.percent, gridWidth), summary].join("\n");
}
