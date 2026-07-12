/**
 * 状态栏 —— 常驻输入框下方一行
 *
 * ◆ deepseek-chat · openai-compat ⋮ mcp 3 ⋮ ↑1.2k ↓340 ⋮ 上下文 ▰▰▱▱▱▱▱▱ 25%
 *
 * 上下文水位用 8 段仪表条：颜色随水位从主题青 → 琥珀 → 霓虹粉，
 * 比一个百分比数字更早引起注意。
 */
import React from "react";
import {Box, Text} from "./runtime/index.js";
import { T } from "../theme.js";

export interface StatusInfo {
  providerId: string;
  model: string;
  sessionId: string;
  totalInput: number;
  totalOutput: number;
  cacheRead: number;
  /** 上下文占预算百分比（0-100+） */
  contextPercent: number;
  mcpToolCount: number;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const METER_SEGMENTS = 8;

function meter(pct: number): { bar: string; color: string } {
  const filled = Math.max(0, Math.min(METER_SEGMENTS, Math.round((pct / 100) * METER_SEGMENTS)));
  return {
    bar: "▰".repeat(filled) + "▱".repeat(METER_SEGMENTS - filled),
    color: pct >= 80 ? T.danger : pct >= 60 ? T.warn : T.primary,
  };
}

export function StatusBar({ status }: { status: StatusInfo }) {
  const m = meter(status.contextPercent);
  const cache = status.cacheRead > 0 ? ` (缓存 ${fmtTokens(status.cacheRead)})` : "";

  return (
    <Box>
      <Text color={T.primary}>◆ {status.model}</Text>
      <Text dimColor> · {status.providerId}</Text>
      {status.mcpToolCount > 0 && <Text dimColor> ⋮ mcp {status.mcpToolCount}</Text>}
      <Text dimColor>
        {" "}
        ⋮ ↑{fmtTokens(status.totalInput)} ↓{fmtTokens(status.totalOutput)}
        {cache} ⋮ 上下文{" "}
      </Text>
      <Text color={m.color}>
        {m.bar} {status.contextPercent}%
      </Text>
    </Box>
  );
}
