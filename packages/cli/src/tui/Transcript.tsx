/**
 * 会话记录条目 —— 已完成的内容进 <Static> 区（写进真实终端滚动缓冲，
 * 可以往上翻），正在进行的内容在动态区渲染。
 */
import React from "react";
import {Box, Text} from "./runtime/index.js";
import { renderMarkdown } from "../highlight.js";
import { T } from "../theme.js";
import { Banner, type BannerInfo } from "./Banner.js";

export type TranscriptItem =
  | { id: number; kind: "banner"; info: BannerInfo }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | {
      id: number;
      kind: "tool";
      name: string;
      argSummary: string;
      /** 结果预览行（已截断）；流式显示过的长输出这里只留统计 */
      preview: string;
      isError: boolean;
    }
  | { id: number; kind: "info"; text: string; tone: "dim" | "green" | "yellow" | "red" };

export function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 120);
}

/** 工具结果 → 预览字符串（最多 3 行 + 剩余行数） */
export function previewResult(content: string, streamed: boolean): string {
  const lines = content.split("\n");
  if (streamed) return `(已流式显示，共 ${lines.length} 行)`;
  // 只剩 1 行时直接显示，避免"… +1 行"的尴尬
  if (lines.length <= 4) return content;
  return `${lines.slice(0, 3).join("\n")}\n… +${lines.length - 3} 行`;
}

/** 消息/工具行左侧圆点（⏺ 垂直居中更好，但 Win/Linux 终端常缺字形） */
export const DOT = process.platform === "darwin" ? "⏺" : "●";

/**
 * ⎿ 结果行：前缀恒 5 列（"  ⎿  "，dim），内容列自动折行，
 * 续行对齐到第 6 列。所有工具子行统一走这里。
 */
function ResultLine({ children, color }: { children: string; color?: string }) {
  return (
    <Box>
      <Box minWidth={5} flexShrink={0}>
        <Text dimColor>{"  ⎿  "}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor={!color} color={color}>
          {children}
        </Text>
      </Box>
    </Box>
  );
}

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "banner":
      return <Banner info={item.info} />;
    case "user":
      return (
        <Box marginTop={1}>
          <Text dimColor>❯ </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      // ⏺ 占 2 列 gutter，内容折行后悬挂缩进对齐
      return (
        <Box marginTop={1}>
          <Box minWidth={2} flexShrink={0}>
            <Text>{DOT}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{renderMarkdown(item.text)}</Text>
          </Box>
        </Box>
      );
    case "tool":
      // 状态用圆点颜色表达（成功绿/失败红），工具名 bold、参数摘要在括号里
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Box minWidth={2} flexShrink={0}>
              <Text color={item.isError ? T.danger : T.success}>{DOT}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text bold>{item.name}</Text>
                {item.argSummary ? <Text>({item.argSummary})</Text> : null}
              </Text>
            </Box>
          </Box>
          {item.preview && (
            <ResultLine color={item.isError ? T.danger : undefined}>
              {item.preview}
            </ResultLine>
          )}
        </Box>
      );
    case "info": {
      const toneColor = { green: T.success, yellow: T.warn, red: T.danger }[
        item.tone as "green" | "yellow" | "red"
      ];
      return (
        <Box>
          <Text dimColor={item.tone === "dim"} color={toneColor}>
            {item.text}
          </Text>
        </Box>
      );
    }
  }
}
