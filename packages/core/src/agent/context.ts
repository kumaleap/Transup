/**
 * 项目上下文 —— 启动时给模型的"地图"
 *
 * 两部分：
 * 1. AGENT.md（或 CLAUDE.md）：项目约定 —— 用户手写的"这个项目怎么干活"。
 *    这是 coding agent 生态的事实标准：构建命令、代码风格、架构说明。
 * 2. Repo map：目录树。让模型不用先 list_dir 摸索就知道代码大概在哪，
 *    第一次工具调用就能直奔目标。（aider 的 repo map 用 tree-sitter 提取
 *    函数签名，那是进阶版；目录树是性价比最高的第一步。）
 *
 * 注入位置：system prompt 尾部、cache 断点之前 —— 它在会话期间不变，
 * 所以整块都能被缓存。
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const IGNORED = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", "target", ".idea", ".vscode",
]);
const MAX_ENTRIES = 200; // 树太大反而污染上下文，超出就截断
const MAX_DEPTH = 4;

/** 读取项目约定文件，按优先级找第一个存在的 */
async function readProjectMemory(cwd: string): Promise<string | null> {
  for (const name of ["AGENT.md", "AGENTS.md", "CLAUDE.md"]) {
    try {
      return await readFile(join(cwd, name), "utf-8");
    } catch {
      // 不存在，试下一个
    }
  }
  return null;
}

/** 生成缩进式目录树 */
async function buildRepoMap(cwd: string): Promise<string> {
  const lines: string[] = [];
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || lines.length >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const visible = entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const e of visible) {
      if (lines.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      lines.push("  ".repeat(depth) + (e.isDirectory() ? `${e.name}/` : e.name));
      if (e.isDirectory()) await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(cwd, 0);
  return lines.join("\n") + (truncated ? "\n… (已截断)" : "");
}

/** 组装完整项目上下文段落，拼进 system prompt */
export async function buildProjectContext(cwd: string): Promise<string> {
  const parts: string[] = [];

  const memory = await readProjectMemory(cwd);
  if (memory) {
    parts.push(`# 项目约定（来自项目根目录的 AGENT.md/CLAUDE.md，必须遵守）\n${memory.trim()}`);
  }

  const map = await buildRepoMap(cwd);
  if (map) {
    parts.push(`# 项目结构\n${map}`);
  }

  return parts.join("\n\n");
}
