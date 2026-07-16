/**
 * grep — 代码搜索
 *
 * 让模型先搜索定位，而不是逐个读文件。零依赖用系统 grep。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool } from "./types.js";

const exec = promisify(execFile);

const schema = z.object({
  pattern: z.string().describe("要搜索的正则表达式"),
  path: z.string().optional().describe("搜索范围（目录或文件），默认当前目录"),
});

export const grepTool: Tool<typeof schema> = {
  name: "grep",
  description:
    "在代码库中递归搜索正则表达式，返回 文件:行号:内容。修改代码前应先用它定位相关位置。",
  schema,
  readOnly: true,
  async execute({ pattern, path = "." }, _onProgress, signal) {
    try {
      const { stdout } = await exec("grep", [
        "-rn",
        "-I",
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "-E", pattern,
        path,
      ], { maxBuffer: 1024 * 1024, signal });
      const lines = stdout.trim().split("\n");
      if (lines.length > 100) {
        return lines.slice(0, 100).join("\n") + `\n… 共 ${lines.length} 条匹配，请缩小搜索范围`;
      }
      return stdout.trim();
    } catch (err: any) {
      if (err.code === 1) return "(无匹配)"; // grep 无匹配时退出码为 1，不是错误
      throw err;
    }
  },
};
