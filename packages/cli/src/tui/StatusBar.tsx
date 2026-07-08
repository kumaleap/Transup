/**
 * 状态栏 —— 常驻输入框下方一行：模型 · 会话 · tokens · 上下文水位
 */
import React from "react";
import { Box, Text } from "ink";

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

export function StatusBar({ status }: { status: StatusInfo }) {
  const ctx = status.contextPercent;
  const ctxColor = ctx >= 80 ? "red" : ctx >= 60 ? "yellow" : undefined;
  const cache = status.cacheRead > 0 ? ` (缓存 ${fmtTokens(status.cacheRead)})` : "";
  const mcp = status.mcpToolCount > 0 ? ` · mcp ${status.mcpToolCount}` : "";

  return (
    <Box>
      <Text dimColor>
        {status.providerId}:{status.model}
        {mcp} · ↑{fmtTokens(status.totalInput)} ↓{fmtTokens(status.totalOutput)}
        {cache} · 上下文{" "}
      </Text>
      <Text dimColor={!ctxColor} color={ctxColor}>
        {ctx}%
      </Text>
    </Box>
  );
}
