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
import { appendFile, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "../provider/types.js";

const DEFAULT_DIR = ".transup/sessions";

/** lite read 的读取窗口：会话列表标题只需要文件头，不值得全量 parse */
const HEAD_BYTES = 65536;
const TITLE_MAX = 60;

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
    await this.appendBatch([message]);
  }

  /** 把一组消息序列化后通过一次 append 写入，保证批内顺序与连续性。 */
  async appendBatch(messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const batch = messages.map((message) => JSON.stringify(message)).join("\n") + "\n";
    await appendFile(this.path, batch, "utf-8");
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

  /**
   * 提取首条真实用户输入做会话列表标题（规格 07 §2.1 的 lite read：
   * 只读文件头 64KB，长会话不全量 parse —— 列表页秒开的关键）。
   * 跳过系统注入（[系统提示]…）；取首行、截断到 60 字符。
   */
  static async firstPrompt(id: string, dir: string = DEFAULT_DIR): Promise<string | null> {
    let handle;
    try {
      handle = await open(join(dir, `${id}.jsonl`), "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split("\n")) {
        if (!line.trim()) continue;
        let message: Message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // 窗口边界截断的行 / 损坏行
        }
        if (message.role !== "user" || typeof message.content !== "string") continue;
        const text = message.content.trim();
        if (!text || text.startsWith("[系统提示]")) continue;
        const first = text.split("\n")[0];
        return first.length > TITLE_MAX ? first.slice(0, TITLE_MAX) + "…" : first;
      }
      return null;
    } finally {
      await handle.close();
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
