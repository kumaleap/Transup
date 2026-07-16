/**
 * 上下文压缩 —— 从 engine.ts 拆出的纯函数模块
 *
 * 流程（借鉴 Claude Code 的 compact）：
 *  1. 把 system 之外的全部历史交给模型，用专项 prompt 生成结构化摘要
 *     （单任务协议：禁用工具、强制 TEXT ONLY）
 *  2. 引擎用摘要替换旧历史
 *  3. 重新注入最近读过的文件内容 —— 摘要救的是"记忆"，
 *     重注入救的是"工作台"，两者缺一不可
 *  4. 失败则由引擎退回最简截断（trimHistory），绝不让压缩挡住主流程
 *
 * 这里只放"计算"：生成摘要、拼注入文本、截断规则。
 * 消息数组的所有权在引擎手里，替换历史的动作也留在引擎。
 */
import { readFile } from "node:fs/promises";
import type { Message, Provider } from "../provider/types.js";

/** compact 后重新注入的"最近读过的文件"数量与单文件大小上限 */
export const REINJECT_FILES = 3;
export const REINJECT_MAX_CHARS = 8_000;

const COMPACT_PROMPT =
  "把上面的对话压缩成一份工作交接摘要，供接手的工程师继续任务。必须包含：\n" +
  "1. 用户的原始目标和当前任务\n" +
  "2. 已完成的工作（改了哪些文件、跑了什么命令、结果如何）\n" +
  "3. 进行中/未完成的工作和下一步计划\n" +
  "4. 重要的技术决策和踩过的坑\n" +
  "只输出摘要正文，不要客套话。";

/** 用专项 prompt 让模型生成摘要（无工具、单任务）。摘要为空视为失败。 */
export async function summarize(
  provider: Provider,
  messages: Message[],
  signal?: AbortSignal,
): Promise<string> {
  const request: Message[] = [...messages, { role: "user", content: COMPACT_PROMPT }];

  let summary = "";
  // 不传工具 —— 摘要任务禁止工具调用
  for await (const ev of provider.stream(request, [], signal)) {
    if (ev.type === "message_done") summary = ev.content;
  }
  if (!summary.trim()) throw new Error("摘要为空");
  return summary;
}

/** 重新注入最近读过的文件 —— 让模型"失忆但工作台还在" */
export async function reinjectFiles(recentFiles: string[]): Promise<string> {
  const files = recentFiles.slice(-REINJECT_FILES);
  if (files.length === 0) return "";

  const parts: string[] = [];
  for (const path of files) {
    try {
      let text = await readFile(path, "utf-8");
      if (text.length > REINJECT_MAX_CHARS) {
        text = text.slice(0, REINJECT_MAX_CHARS) + "\n… (已截断，需要时重新 read_file)";
      }
      parts.push(`\n\n[重新注入] 最近读过的文件 ${path} 当前内容：\n${text}`);
    } catch {
      // 文件可能已被删除，跳过
    }
  }
  return parts.join("");
}

/**
 * 兜底截断（compact 失败时用）：从最老的消息开始丢，直到进预算。
 * tool 消息必须与前面的 assistant 成对丢弃，否则 API 会拒绝孤儿 tool result。
 * 原地修改传入的数组（消息所有权在引擎，这里只执行规则）。
 */
export function trimHistory(messages: Message[], maxContextChars: number): void {
  while (JSON.stringify(messages).length > maxContextChars && messages.length > 3) {
    messages.splice(1, 1);
    while (messages[1]?.role === "tool") {
      messages.splice(1, 1);
    }
  }
}
