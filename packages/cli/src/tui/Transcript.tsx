/**
 * 会话记录条目 —— 已完成的内容进 <Static> 区（写进真实终端滚动缓冲，
 * 可以往上翻），正在进行的内容在动态区渲染。
 *
 * 视觉规格对齐 docs/claude-code-interactions/03-消息视觉格式.md：
 *   §1 左列 gutter 恒 2 列（⏺ ），结果行恒 5 列（"  ⎿  "，dim）
 *   §2 工具行 = bold 工具名(参数摘要)，结果摘要中的数字 bold
 *   §7 截断话术统一 dim 的 "… +N 行"
 */
import React from "react";
import { relative, isAbsolute } from "node:path";
import {Box, Text} from "./runtime/index.js";
import { renderMarkdown } from "../highlight.js";
import { T } from "../theme.js";
import { Banner, type BannerInfo } from "./Banner.js";
import { DOT, POINTER, RESULT_MARK } from "./figures.js";

export { DOT, POINTER } from "./figures.js";

export type TranscriptItem =
  | { id: number; kind: "banner"; info: BannerInfo }
  | { id: number; kind: "user"; text: string }
  /** "!" 前缀直执行的 bash 命令输入行（规格 §1.4） */
  | { id: number; kind: "bash-input"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | {
      id: number;
      kind: "tool";
      name: string;
      argSummary: string;
      /** 结果预览行（已截断，可含局部 ANSI 样式）；流式显示过的长输出这里只留统计 */
      preview: string;
      isError: boolean;
    }
  /** 结构化错误（API/系统/命令错误）：⎿ 缩进 + 红色（规格 §1.5） */
  | { id: number; kind: "error"; text: string }
  | { id: number; kind: "info"; text: string; tone: "dim" | "green" | "yellow" | "red" };

/**
 * 局部内联样式 —— 闭合码用 22/39 而非 0：嵌在外层 dim/颜色里不会把
 * 外层样式一并重置（chalk 复用 \x1b[22m 的老坑，规格 §1.2 专门提醒）。
 */
export const inline = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
};

/** 截断话术统一（规格 §7）：dim 的 "… +N 行" */
const moreLines = (n: number) => inline.dim(`… +${n} 行`);

export function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 120);
}

/** 绝对路径尽量相对化（规格 §2.2 非 verbose 用 getDisplayPath 相对路径） */
function displayPath(p: unknown): string {
  const raw = String(p ?? "");
  if (!raw) return raw;
  try {
    const rel = relative(process.cwd(), raw);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  } catch {
    /* 非法路径原样返回 */
  }
  return raw;
}

/** bash 命令摘要截断：最多 2 行 / 160 字符 + …（规格 §2.2） */
const CMD_MAX_LINES = 2;
const CMD_MAX_CHARS = 160;
function truncateCommand(cmd: string): string {
  const lines = cmd.split("\n");
  let out = lines.slice(0, CMD_MAX_LINES).join("\n");
  if (out.length > CMD_MAX_CHARS) out = out.slice(0, CMD_MAX_CHARS);
  return out.length < cmd.length ? out + "…" : out;
}

/**
 * 工具标题行摘要按工具定制（规格 §2.2）。工具名以 core/src/tools 的
 * 真实注册名为准；edit/write 换成动词化标题 Update/Create。
 */
export function summarizeToolCall(
  name: string,
  args: Record<string, unknown>,
): { displayName: string; argSummary: string } {
  switch (name) {
    case "bash":
      // 直接显示命令原文（比 key: value 更一眼看懂要跑什么）
      return { displayName: name, argSummary: truncateCommand(String(args.command ?? "")) };
    case "read_file":
      return { displayName: name, argSummary: displayPath(args.path) };
    case "edit_file":
      return { displayName: "Update", argSummary: displayPath(args.path) };
    case "write_file":
      return { displayName: "Create", argSummary: displayPath(args.path) };
    case "grep": {
      const parts = [`pattern: ${JSON.stringify(String(args.pattern ?? ""))}`];
      if (args.path != null) parts.push(`path: ${JSON.stringify(displayPath(args.path))}`);
      return { displayName: name, argSummary: parts.join(", ") };
    }
    default:
      return { displayName: name, argSummary: formatArgs(args) };
  }
}

/** 工具结果 → 预览字符串（最多 3 行 + dim 的剩余行数） */
export function previewResult(content: string, streamed: boolean): string {
  const lines = content.split("\n");
  if (streamed) return `(已流式显示，共 ${lines.length} 行)`;
  // 只剩 1 行时直接显示，避免"… +1 行"的尴尬
  if (lines.length <= 4) return content;
  return `${lines.slice(0, 3).join("\n")}\n${moreLines(lines.length - 3)}`;
}

/** bash 输出里 [stderr] 起的块逐行标红（规格 §2.3：stderr 用 error 色） */
function colorBashStderr(content: string): string {
  const lines = content.split("\n");
  const start = lines.indexOf("[stderr]");
  if (start === -1) return content;
  // 逐行包色而不是整块包 —— 后续按行截断时不会截掉闭合码导致红色外溢
  return lines.map((l, i) => (i >= start ? inline.red(l) : l)).join("\n");
}

/**
 * 结果语义摘要（规格 §2.3）：按工具给一句"人话"，数字 bold。
 * 拿不准的工具退回通用 3 行预览。
 */
export function summarizeToolResult(name: string, content: string, streamed: boolean): string {
  if (streamed) return previewResult(content, true);
  switch (name) {
    case "read_file": {
      // read_file 每行带行号返回；末尾可能挂一行分页提示，不计入行数
      const lines = content.split("\n");
      const n = lines.length - (lines[lines.length - 1]?.startsWith("… 文件共") ? 1 : 0);
      return `读取 ${inline.bold(String(n))} 行`;
    }
    case "grep": {
      if (content === "(无匹配)") return `找到 ${inline.bold("0")} 个匹配`;
      const lines = content.split("\n");
      // 超过 100 条时工具自己在末行报了总数，以它为准
      const trailer = lines[lines.length - 1]?.match(/^… 共 (\d+) 条匹配/);
      const n = trailer ? Number(trailer[1]) : lines.filter(Boolean).length;
      return `找到 ${inline.bold(String(n))} 个匹配`;
    }
    case "list_dir": {
      if (content === "(空目录)") return `找到 ${inline.bold("0")} 个文件`;
      const n = content.split("\n").filter(Boolean).length;
      return `找到 ${inline.bold(String(n))} 个文件`;
    }
    case "bash":
      if (content === "(命令执行成功，无输出)") return inline.dim("(无输出)");
      return previewResult(colorBashStderr(content), false);
    default:
      return previewResult(content, false);
  }
}

/**
 * 工具错误规范化（规格 §1.5 FallbackToolUseErrorMessage）：
 * 剥掉 <tool_use_error>/<error> 标签，没有 Error: 前缀则补上，
 * 非 verbose 只显示前 10 行，余下 dim "… +N 行"。
 */
const TOOL_ERROR_MAX_LINES = 10;
export function formatToolError(content: string): string {
  let text = content.replace(/<\/?(?:tool_use_error|error)>/g, "").trim();
  if (!/^error\b/i.test(text)) text = `Error: ${text}`;
  const lines = text.split("\n");
  if (lines.length <= TOOL_ERROR_MAX_LINES) return text;
  return (
    lines.slice(0, TOOL_ERROR_MAX_LINES).join("\n") +
    "\n" +
    moreLines(lines.length - TOOL_ERROR_MAX_LINES)
  );
}

/** API/系统错误截断（规格 §1.5）：非 verbose 截到 1000 字符加 … */
const API_ERROR_MAX_CHARS = 1000;
export function formatApiError(text: string): string {
  return text.length > API_ERROR_MAX_CHARS ? text.slice(0, API_ERROR_MAX_CHARS) + "…" : text;
}

/** user 超长输入截断（规格 §1.4）：>10000 字符 → 头 2500 + 省略行数 + 尾 2500 */
const USER_TRUNCATE_THRESHOLD = 10_000;
const USER_KEEP_CHARS = 2500;
export function truncateUserText(
  text: string,
):
  | { truncated: false }
  | { truncated: true; head: string; omittedLines: number; tail: string } {
  if (text.length <= USER_TRUNCATE_THRESHOLD) return { truncated: false };
  const omitted = text.slice(USER_KEEP_CHARS, text.length - USER_KEEP_CHARS);
  return {
    truncated: true,
    head: text.slice(0, USER_KEEP_CHARS),
    omittedLines: omitted.split("\n").length,
    tail: text.slice(-USER_KEEP_CHARS),
  };
}

/** ⎿ 结果行前缀："  ⎿  " 共 5 列 */
const RESULT_GUTTER = `  ${RESULT_MARK}  `;

/**
 * ⎿ 结果行：前缀恒 5 列（dim），内容列自动折行，续行对齐到第 6 列。
 * 所有工具子行/错误行统一走这里（含 App 动态区的实时输出尾巴）。
 */
export function ResultLine({ children, color }: { children: string; color?: string }) {
  // 语义摘要自带局部样式（bold 数字/红 stderr）时不再整体 dim；
  // 纯 dim 截断标记（\x1b[2m/22m）不算"自带样式"——它出现在行尾，
  // 与外层 dim 叠加无副作用。
  const styled = /\x1b\[/.test(children.replace(/\x1b\[(?:2|22)m/g, ""));
  return (
    <Box>
      <Box minWidth={5} flexShrink={0}>
        <Text dimColor>{RESULT_GUTTER}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor={!color && !styled} color={color}>
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
    case "user": {
      // 灰底整条 + subtle 的 ❯ 前缀（规格 §1.4）；前缀独立成列，正文折行悬挂对齐
      const t = truncateUserText(item.text);
      return (
        <Box marginTop={1} paddingRight={1} backgroundColor={T.userMessageBg}>
          <Box flexShrink={0}>
            <Text color={T.subtle}>{POINTER} </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {t.truncated ? (
              <Text>
                {t.head}
                <Text dimColor>{`\n… +${t.omittedLines} 行 …\n`}</Text>
                {t.tail}
              </Text>
            ) : (
              <Text>{item.text}</Text>
            )}
          </Box>
        </Box>
      );
    }
    case "bash-input":
      // "!" bash 直执行输入：品红前缀 + 微紫灰背景（规格 §1.4）
      return (
        <Box marginTop={1} paddingRight={1} backgroundColor={T.bashMessageBg}>
          <Box flexShrink={0}>
            <Text color={T.bashAccent}>! </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text>{item.text}</Text>
          </Box>
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
    case "error":
      // 结构化错误：⎿ 缩进 + 红色（文案已由 formatToolError/formatApiError 规范化）
      return <ResultLine color={T.danger}>{item.text}</ResultLine>;
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
