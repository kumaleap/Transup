/**
 * 会话持久化 — append-only JSONL
 *
 * 借鉴 Claude Code 的设计哲学：写入路径极简（每条消息 append 一行，
 * 永不改写已有内容），复杂性全部压到恢复路径。
 *
 * 好处：
 *  - 崩溃安全：进程随时被杀，最多丢最后一行
 *  - 可审计：会话文件就是完整的事件历史，人和工具都能读
 *
 * 存储位置：<项目>/.transup/sessions/<sessionId>.jsonl
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../provider/types.js";

const DEFAULT_DIR = ".transup/sessions";

export class SessionStore {
  readonly id: string;
  private dir: string;
  private path: string;
  private dirReady = false;

  constructor(id: string, dir: string = DEFAULT_DIR) {
    this.id = id;
    this.dir = dir;
    this.path = join(dir, `${id}.jsonl`);
  }

  async append(message: Message): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.path, JSON.stringify(message) + "\n", "utf-8");
  }

  /** 恢复路径：读回所有行，跳过损坏的行（最后一行可能写了一半） */
  async load(): Promise<Message[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch {
      return [];
    }
    const messages: Message[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // 损坏的行（如崩溃时写一半）直接跳过
      }
    }
    return messages;
  }

  /** 列出全部会话 id（新的在前） */
  static async list(dir: string = DEFAULT_DIR): Promise<string[]> {
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** 找到最近的会话 id（按文件名排序，id 用时间戳生成所以有序） */
  static async latestId(dir: string = DEFAULT_DIR): Promise<string | null> {
    try {
      const files = await readdir(dir);
      const ids = files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.replace(/\.jsonl$/, ""))
        .sort();
      return ids.at(-1) ?? null;
    } catch {
      return null;
    }
  }
}
