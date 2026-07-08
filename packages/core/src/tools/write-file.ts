/**
 * write_file — 创建/覆盖整个文件。修改已有文件应优先用 edit_file。
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("文件路径"),
  content: z.string().describe("完整的文件内容"),
});

export const writeFileTool: Tool<typeof schema> = {
  name: "write_file",
  description: "创建新文件或完整覆盖已有文件。修改已有文件请优先用 edit_file。",
  schema,
  readOnly: false,
  async execute({ path, content }) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return `已写入 ${path}（${content.split("\n").length} 行）`;
  },
};
