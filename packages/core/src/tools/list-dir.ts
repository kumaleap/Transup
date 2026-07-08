/**
 * list_dir — 列目录
 *
 * 过滤 node_modules/.git 等噪音，保护模型的上下文（最宝贵的资源）。
 */
import { readdir } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "./types.js";

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

const schema = z.object({
  path: z.string().optional().describe("目录路径，默认当前目录"),
});

export const listDirTool: Tool<typeof schema> = {
  name: "list_dir",
  description: "列出目录下的文件和子目录（自动忽略 node_modules、.git 等）。",
  schema,
  readOnly: true,
  async execute({ path = "." }) {
    const entries = await readdir(path, { withFileTypes: true });
    const visible = entries.filter((e) => !IGNORED.has(e.name) && !e.name.startsWith("."));
    if (visible.length === 0) return "(空目录)";
    return visible
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join("\n");
  },
};
