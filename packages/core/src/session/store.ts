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
const COMPACTION_RECORD_TYPE = "transup.compaction.v1";

export interface SessionState {
  messages: Message[];
  recentFiles: string[];
}

interface CompactionRecord {
  type: typeof COMPACTION_RECORD_TYPE;
  messages: Message[];
  recentFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.args === "string"
  );
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value) || typeof value.content !== "string") return false;
  if (value.role === "system" || value.role === "user") return true;
  if (value.role === "assistant") {
    return value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall));
  }
  return value.role === "tool" && typeof value.toolCallId === "string";
}

function isCompactionRecord(value: unknown): value is CompactionRecord {
  if (!isRecord(value) || value.type !== COMPACTION_RECORD_TYPE) return false;
  if (!Array.isArray(value.messages) || value.messages.length !== 2) return false;
  if (!value.messages.every(isMessage)) return false;
  if (value.messages[0].role !== "user" || value.messages[1].role !== "assistant") return false;
  return Array.isArray(value.recentFiles) && value.recentFiles.every((path) => typeof path === "string");
}

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
    await this.appendRecords(messages);
  }

  /**
   * 追加一个完整的压缩检查点。恢复时只在整条记录可解析且结构有效时替换旧历史，
   * 因此崩溃留下的半条记录不会丢掉此前可恢复的消息。
   */
  async commitCompaction(messages: readonly Message[], recentFiles: readonly string[]): Promise<void> {
    if (
      messages.length !== 2 ||
      messages[0]?.role !== "user" ||
      messages[1]?.role !== "assistant"
    ) {
      throw new Error("compaction checkpoint requires a user summary and assistant acknowledgement");
    }
    const record: CompactionRecord = {
      type: COMPACTION_RECORD_TYPE,
      messages: [...messages],
      recentFiles: [...recentFiles],
    };
    await this.appendRecords([record]);
  }

  private async appendRecords(records: readonly unknown[]): Promise<void> {
    if (records.length === 0) return;
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    // The leading delimiter isolates this batch from a crash-torn final record.
    const batch = "\n" + records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await appendFile(this.path, batch, "utf-8");
  }

  /** 恢复消息的兼容入口。需要检查点元数据的宿主应使用 loadState()。 */
  async load(): Promise<Message[]> {
    return (await this.loadState()).messages;
  }

  /** 恢复路径：重放普通消息与最后一个完整压缩检查点，跳过损坏的行。 */
  async loadState(): Promise<SessionState> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch {
      return { messages: [], recentFiles: [] };
    }
    const messages: Message[] = [];
    let recentFiles: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isRecord(record) && record.type === COMPACTION_RECORD_TYPE) {
          if (isCompactionRecord(record)) {
            messages.splice(0, messages.length, ...record.messages);
            recentFiles = [...record.recentFiles];
          }
          continue;
        }
        // Legacy session rows are intentionally replayed exactly as before.
        messages.push(record as Message);
      } catch {
        // 损坏的行（如崩溃时写一半）直接跳过
      }
    }
    return { messages, recentFiles };
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
