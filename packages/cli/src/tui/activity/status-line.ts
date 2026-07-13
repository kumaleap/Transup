// spinner 状态括号：耗时与 token 计数段的纯格式化。
// 纯模块——不 import React/Ink；渲染层负责用 " · " 连接各段并加括号、整体 dim。

/** 耗时与 token 段的显示门槛：超过 30 秒才出现（严格大于） */
export const SHOW_TIMER_TOKENS_AFTER_MS = 30_000;

/** 紧凑 token 数：1234 → 1.2k，12345 → 12k（与 App.tsx 原 fmtTokens 规则一致） */
export function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
}

/** 耗时：<60s 显示 "Ns"，>=60s 显示 "NmMs"（秒补零两位，如 "1m05s"） */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export interface StatusPartsOptions {
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * 状态括号内的段数组：30s 门槛前返回 []，之后返回 ['Ns', '↑1.2k ↓3.4k tokens']。
 * tokens 全为 0 时省略 token 段。
 */
export function statusParts(opts: StatusPartsOptions): string[] {
  const {elapsedMs, inputTokens, outputTokens} = opts;
  if (elapsedMs <= SHOW_TIMER_TOKENS_AFTER_MS) return [];
  const parts = [formatDuration(elapsedMs)];
  if (inputTokens > 0 || outputTokens > 0) {
    parts.push(`↑${fmtTokens(inputTokens)} ↓${fmtTokens(outputTokens)} tokens`);
  }
  return parts;
}
