/**
 * transcript 屏（Ctrl+O）—— 规格 05 §1.4 的 "legacy dump" 分支
 *
 * 主屏为了不刷屏，工具结果只留 3 行预览。这里把完整输出摊开，
 * 用来回看"模型到底看到了什么"（调 prompt 时最需要的东西）。
 *
 * Ink 适配上的关键决定：不像规格那样早退 return 一棵全新的树 ——
 * 那会卸载 <Static>，而 Ink 的 Static 一旦重新挂载会把所有条目重新
 * 吐进 scrollback（历史凭空翻倍）。所以主屏骨架保持挂载，只把动态区
 * 换成本屏。
 *
 * 动态区每帧都要重排，摊开整个会话会拖垮渲染：默认只渲染最近
 * MAX_ITEMS 条、每条工具输出截到 MAX_TOOL_LINES 行，Ctrl+E 展开全部。
 */
import React from "react";
import { Box, Text } from "./runtime/index.js";
import { T } from "../theme.js";
import { renderMarkdown, sanitizeTerminalText } from "../highlight.js";
import { DOT, type TranscriptItem } from "./Transcript.js";

export const MAX_ITEMS = 30;
export const MAX_TOOL_LINES = 100;

function clampLines(text: string, max: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  if (lines.length <= max) return { text, hidden: 0 };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max };
}

function FullItem({ item, expanded }: { item: TranscriptItem; expanded: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text dimColor>❯ </Text>
          <Text>{sanitizeTerminalText(item.text)}</Text>
        </Box>
      );
    case "assistant":
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
    case "tool": {
      // full 是未截断的原始工具输出；老条目没有就退回预览
      const raw = sanitizeTerminalText(item.full ?? item.preview);
      const { text, hidden } = expanded ? { text: raw, hidden: 0 } : clampLines(raw, MAX_TOOL_LINES);
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Box minWidth={2} flexShrink={0}>
              <Text color={item.isError ? T.danger : T.success}>{DOT}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>
                <Text bold>
                  {sanitizeTerminalText(item.name, {
                    preserveNewlines: false,
                    preserveTabs: false,
                  })}
                </Text>
                {item.argSummary ? (
                  <Text>
                    ({sanitizeTerminalText(item.argSummary)})
                  </Text>
                ) : null}
              </Text>
            </Box>
          </Box>
          {text && (
            <Box marginLeft={2} flexDirection="column">
              <Text dimColor={!item.isError} color={item.isError ? T.danger : undefined}>
                {text}
              </Text>
              {hidden > 0 && <Text dimColor>… 还有 {hidden} 行（Ctrl+E 展开全部）</Text>}
            </Box>
          )}
        </Box>
      );
    }
    case "compact":
      // 全文屏是唯一能看到压缩摘要正文的地方（主屏只有一行边界卡）
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={T.primary}>✻ 对话已在此处压缩，摘要如下：</Text>
          <Box marginLeft={2}>
            <Text dimColor>{sanitizeTerminalText(item.summary)}</Text>
          </Box>
        </Box>
      );
    case "info":
    case "banner":
      return null; // 启动横幅与过程提示不是会话内容，全文里省掉
  }
}

export function TranscriptScreen({
  items,
  expanded,
}: {
  items: TranscriptItem[];
  expanded: boolean;
}) {
  const content = items.filter((i) => i.kind !== "banner" && i.kind !== "info");
  const visible = expanded ? content : content.slice(-MAX_ITEMS);
  const hidden = content.length - visible.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={T.primary} bold>
        ─ 会话全文（{content.length} 条{expanded ? "，已展开" : ""}）
      </Text>
      {hidden > 0 && <Text dimColor>… 上面还有 {hidden} 条，Ctrl+E 展开全部</Text>}
      {visible.map((item) => (
        <FullItem key={item.id} item={item} expanded={expanded} />
      ))}
      <Box marginTop={1}>
        <Text dimColor>
          Ctrl+O / Esc 返回 · Ctrl+E {expanded ? "收起" : "展开全部"}
        </Text>
      </Box>
    </Box>
  );
}
