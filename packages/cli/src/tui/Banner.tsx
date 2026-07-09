/**
 * 首屏横幅 —— 产品的第一印象
 *
 * 对标 Claude Code / Codex 的开场：logo + 版本 + 一屏交代关键状态
 * （模型、工作目录、会话、MCP）。宽度控制在 ~40 列以内，小终端不折行。
 *
 * 作为 transcript 条目渲染进 <Static>：它属于会话记录的一部分
 * （写入真实滚动缓冲，往上翻还能看到），而不是常驻的动态 UI。
 */
import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";

/** 2 行块字 "TRANSUP"（约 27 列宽 —— 手机竖屏级别的终端也放得下） */
const LOGO = ["▀█▀ █▀█ ▄▀█ █▄ █ █▀ █ █ █▀█", " █  █▀▄ █▀█ █ ▀█ ▄█ █▄█ █▀ "];

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

/** 家目录缩写成 ~，路径太长时保留头尾 */
function shortenPath(p: string): string {
  const home = homedir();
  let s = p.startsWith(home) ? "~" + p.slice(home.length) : p;
  if (s.length > 48) s = s.slice(0, 20) + "…" + s.slice(-27);
  return s;
}

/** label 由调用方补空格对齐 —— CJK 双宽，padEnd 按字符数补会歪 */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text>
      <Text dimColor>{label}</Text>
      {children}
    </Text>
  );
}

export function Banner({ info }: { info: BannerInfo }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan">{LOGO[0]}</Text>
      <Text>
        <Text color="cyan">{LOGO[1]}</Text>
        <Text dimColor>  v{info.version}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>任何模型都是一等公民 · any model is a first-class citizen</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
        <Row label="模型  ">
          <Text color="cyan">{info.model}</Text>
          <Text dimColor> · {info.providerId}</Text>
        </Row>
        <Row label="目录  ">
          <Text>{shortenPath(info.cwd)}</Text>
        </Row>
        <Row label="会话  ">
          <Text>{info.sessionId}</Text>
          {info.resumedMessages > 0 && (
            <Text color="green">（已恢复 {info.resumedMessages} 条消息）</Text>
          )}
        </Row>
        {info.mcpToolCount > 0 && (
          <Row label="MCP   ">
            <Text>{info.mcpToolCount} 个外部工具</Text>
          </Row>
        )}
      </Box>

      <Text dimColor>/help 查看命令 · @路径 引用文件 · Ctrl+C 中断任务</Text>
    </Box>
  );
}
