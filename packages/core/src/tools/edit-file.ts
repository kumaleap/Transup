/**
 * edit_file — 精确字符串替换（diff 式编辑）
 *
 * 不让模型重写整个文件：省 token、不丢内容。
 * old_string 必须唯一；两种失败的报错都是设计"写给模型看"的，
 * 引导它自我纠正 —— agent 自愈能力的来源。
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("要修改的文件路径"),
  old_string: z.string().describe("要被替换的原文（必须与文件内容完全一致且唯一，包含缩进）"),
  new_string: z.string().describe("替换后的新内容"),
});

export const editFileTool: Tool<typeof schema> = {
  name: "edit_file",
  description:
    "对已有文件做精确替换。old_string 必须逐字符匹配文件内容且在文件中唯一出现；" +
    "若不唯一，请在 old_string 中包含更多上下文行。修改前必须先 read_file 确认内容。",
  schema,
  readOnly: false,
  async execute({ path, old_string, new_string }, _onProgress, signal, beginCommit) {
    const text = await readFile(path, { encoding: "utf-8", signal });

    const count = text.split(old_string).length - 1;
    if (count === 0) {
      throw new Error(
        `old_string 在 ${path} 中未找到。文件内容可能与你的记忆不一致，请先 read_file 重新确认。`,
      );
    }
    if (count > 1) {
      throw new Error(
        `old_string 在 ${path} 中出现了 ${count} 次，无法确定替换哪一处。请包含更多上下文行使其唯一。`,
      );
    }

    signal?.throwIfAborted();
    // writeFile cancellation can leave a truncated partial file; once started, let the write commit.
    beginCommit?.();
    await writeFile(path, text.replace(old_string, new_string), "utf-8");
    return `已修改 ${path}`;
  },
};
