/**
 * read_file — 读文件
 *
 * 1. 带行号返回：模型做精确编辑时需要引用行内容定位。
 * 2. offset/limit 分页：大文件一次全读会撑爆上下文。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("要读取的文件路径（相对或绝对）"),
  offset: z.number().optional().describe("起始行号（从 1 开始），默认 1"),
  limit: z.number().optional().describe("最多读取的行数，默认 500"),
});

export const readFileTool: Tool<typeof schema> = {
  name: "read_file",
  description:
    "读取文本文件内容，返回带行号的文本。大文件请用 offset/limit 分页读取。",
  schema,
  readOnly: true,
  async execute({ path, offset = 1, limit = 500 }, _onProgress, signal) {
    const text = await readFile(path, { encoding: "utf-8", signal });
    const lines = text.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(5)}→${line}`)
      .join("\n");
    const footer =
      offset - 1 + limit < lines.length
        ? `\n… 文件共 ${lines.length} 行，可用 offset=${offset + limit} 继续读取`
        : "";
    return numbered + footer;
  },
};
