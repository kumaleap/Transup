/**
 * 会话记录条目 —— 已完成的内容进 <Static> 区（写进真实终端滚动缓冲，
 * 可以往上翻），正在进行的内容在动态区渲染。
 */
import React from "react";
import { Box, Text } from "ink";
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

/** 工具结果 → 预览字符串（最多 3 行 + 总行数） */
export function previewResult(content: string, streamed: boolean): string {
  const lines = content.split("\n");
  if (streamed) return `(已流式显示，共 ${lines.length} 行)`;
  const head = lines.slice(0, 3).join("\n");
  return lines.length > 3 ? `${head}\n… 共 ${lines.length} 行` : head;
}

export function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "banner":
      return <Banner info={item.info} />;
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={T.primary}>❯ </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>{renderMarkdown(item.text)}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={T.secondary}>◆ {item.name}</Text>
            <Text dimColor>({item.argSummary})</Text>
          </Text>
          {item.preview && (
            <Text>
              <Text color={item.isError ? T.danger : undefined} dimColor={!item.isError}>
                {"  ⎿ "}
              </Text>
              <Text dimColor color={item.isError ? T.danger : undefined}>
                {item.preview.replace(/\n/g, "\n    ")}
              </Text>
            </Text>
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
