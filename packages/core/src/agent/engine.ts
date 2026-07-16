/**
 * Agent 引擎 —— 整个产品的心脏
 *
 * 引擎不打印任何东西：runTurn() 是 AsyncGenerator，把发生的一切作为
 * 事件 yield 给宿主（终端 CLI / IDE 插件 / headless server）渲染。
 *
 * 职责边界（M4.5 拆分后）：本文件只做主循环编排与消息所有权管理，
 * 具体能力在同目录模块里 —— compact.ts（上下文压缩）、
 * tool-runner.ts（工具批执行）、guard.ts（循环保护）。
 *
 * 运行时韧性（现代 harness 的分水岭 —— 长任务不断档）：
 * 1. 流式重试：模型调用中途断流/瞬时错误时指数退避重试。SDK 的
 *    maxRetries 只覆盖"请求未成功建立"，流开始后断开必须引擎自己兜。
 * 2. 截断续跑：输出因 max_tokens 被截断时自动催模型"从断处继续"。
 * 3. 空回复催跑：模型交白卷时推一把，而不是无声结束回合。
 * 4. 循环熔断：完全相同的调用+结果反复出现 → 先警告模型，再强制停轮。
 * 所有自动干预都有次数上限 —— 韧性不能变成失控的自我对话。
 */
import type { Message, Provider, StopReason, ToolCall, Usage } from "../provider/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { PermissionFn, Tool } from "../tools/types.js";
import { SessionStore } from "../session/store.js";
import { REINJECT_FILES, summarize, reinjectFiles, trimHistory } from "./compact.js";
import { executeToolBatch } from "./tool-runner.js";
import { TurnGuard } from "./guard.js";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall; parsedArgs: Record<string, unknown> }
  | { type: "tool_progress"; call: ToolCall; chunk: string }
  | { type: "tool_end"; call: ToolCall; content: string; isError: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "compact_start"; beforeChars: number }
  /** ok 时带摘要正文 —— 宿主可做"一行摘要卡 + 展开查看"（规格 07 §1.2） */
  | { type: "compact_end"; afterChars: number; ok: boolean; summary?: string }
  /** 模型调用失败，引擎将在 delayMs 后重试（宿主应提示并清掉已流出的半截文本） */
  | { type: "stream_retry"; attempt: number; maxAttempts: number; error: string; delayMs: number }
  /** 引擎自动催模型继续（截断续跑 / 空回复催跑） */
  | { type: "auto_continue"; reason: "truncated" | "empty_response" }
  | { type: "turn_end"; reason: "done" | "max_iterations" | "aborted" | "loop_detected" };

export interface EngineOptions {
  provider: Provider;
  canUseTool: PermissionFn;
  /** 宿主仍可接收持久化副作用；默认常驻（headless / 子 agent）。 */
  canPersist?: () => boolean;
  /** 不传则不持久化（子 agent 的探索过程不值得落盘） */
  session?: SessionStore;
  /** 工具集覆盖：默认内建全集；子 agent 传只读子集 */
  tools?: Tool[];
  /** 恢复会话时传入历史消息（不含 system prompt） */
  history?: Message[];
  /** 最近读过的文件检查点；恢复压缩后的会话时由 SessionStore.loadState() 提供。 */
  recentFiles?: string[];
  /** 项目上下文（AGENT.md + repo map），用 buildProjectContext() 生成 */
  projectContext?: string;
  maxIterations?: number;
  /** 上下文字符预算，超出触发 compact */
  maxContextChars?: number;
  /** 流式调用失败的引擎级重试次数（SDK 重试之外的兜底） */
  maxStreamRetries?: number;
  /** 重试退避基数（毫秒），测试时调小加速 */
  retryBaseMs?: number;
}

/** 每轮自动干预（截断续跑 + 空回复催跑）的总次数上限 */
const AUTO_CONTINUE_LIMIT = 3;

/**
 * 判断一段会话历史是否终止在"半截 turn"上（恢复会话时提示用户可续跑）。
 * 三种可靠的中断痕迹：
 *   - 尾部是 user 消息 → 提问后没得到任何回应（请求期间崩溃/被杀）
 *   - 尾部是 tool 结果 → 模型还没接话（工具阶段被中断，或熔断停轮）
 *   - 尾部 assistant 带中断标记 → 流式阶段被 Ctrl+C（引擎写入的固定文案）
 */
export function wasInterrupted(history: Message[]): boolean {
  const last = history.at(-1);
  if (!last) return false;
  if (last.role === "user") return !last.content.startsWith("[系统提示]");
  if (last.role === "tool") return true;
  return last.role === "assistant" && last.content.includes("已被用户中断");
}

/** 判断模型调用错误是否值得重试：4xx（限流/超时除外）是请求本身的问题，重试无意义 */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }
  return true; // 网络层错误（断流、DNS、连接重置）没有 status，一律可重试
}

/** 可被 abort 打断的 sleep（打断时立即返回，由调用方检查 signal） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

export class AgentEngine {
  private messages: Message[];
  private provider: Provider;
  private registry: ToolRegistry;
  private canUseTool: PermissionFn;
  private canPersist: () => boolean;
  private session?: SessionStore;
  private maxIterations: number;
  private maxContextChars: number;
  private maxStreamRetries: number;
  private retryBaseMs: number;
  /** 最近 read_file 过的路径（去重、保序），compact 后重注入用 */
  private recentFiles: string[] = [];

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.canUseTool = opts.canUseTool;
    this.canPersist = opts.canPersist ?? (() => true);
    this.session = opts.session;
    this.registry = new ToolRegistry(opts.tools);
    this.maxIterations = opts.maxIterations ?? 40;
    this.maxContextChars = opts.maxContextChars ?? 300_000;
    this.maxStreamRetries = opts.maxStreamRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 1000;
    this.messages = [
      { role: "system", content: systemPrompt(opts.projectContext) },
      ...(opts.history ?? []),
    ];
    for (const path of opts.recentFiles ?? []) this.trackFile(path);
    // 中断恢复质量：从历史里重建"最近读过的文件"清单，
    // 恢复会话后第一次 compact 依然能重注入工作台
    for (const m of opts.history ?? []) {
      if (m.role !== "assistant") continue;
      for (const tc of m.toolCalls ?? []) {
        if (tc.name !== "read_file") continue;
        try {
          const path = (JSON.parse(tc.args || "{}") as { path?: unknown }).path;
          if (typeof path === "string") this.trackFile(path);
        } catch {}
      }
    }
  }

  /** 消息进入系统的唯一入口：内存 + 持久化双写 */
  private async push(m: Message): Promise<void> {
    if (!this.canPersist()) return;
    this.messages.push(m);
    await this.session?.append(m);
  }

  private trackFile(path: string): void {
    this.recentFiles = this.recentFiles.filter((p) => p !== path);
    this.recentFiles.push(path);
  }

  private contextSize(): number {
    return JSON.stringify(this.messages).length;
  }

  // ── 上下文压缩（计算在 compact.ts，历史替换在这里） ─────────

  private async *compact(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { type: "compact_start", beforeChars: this.contextSize() };

    try {
      const summary = await summarize(this.provider, this.messages, signal);
      if (signal?.aborted) return;

      const reinjected = await reinjectFiles(this.recentFiles);
      if (signal?.aborted) return;

      const newMessages: Message[] = [
        this.messages[0], // system prompt 保留
        {
          role: "user",
          content:
            `[系统提示] 对话历史已被压缩。以下是此前对话的摘要，请基于它继续工作：\n\n${summary}` +
            reinjected,
        },
        { role: "assistant", content: "已了解此前的工作进展，继续。" },
      ];
      if (signal?.aborted || !this.canPersist()) return;

      // 从批量落盘到内存替换是不可取消的逻辑提交；开始后采用 commit-wins。
      await this.session?.commitCompaction(
        [newMessages[1], newMessages[2]],
        this.recentFiles.slice(-REINJECT_FILES),
      );
      this.messages = newMessages;

      yield { type: "compact_end", afterChars: this.contextSize(), ok: true, summary };
    } catch {
      if (signal?.aborted || !this.canPersist()) return;
      // 熔断：压缩失败退回最简截断
      trimHistory(this.messages, this.maxContextChars);
      yield { type: "compact_end", afterChars: this.contextSize(), ok: false };
    }
  }

  /** 手动触发压缩（/compact 命令用）。历史太短时不动。 */
  async *compactNow(signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (this.messages.length < 4) return;
    yield* this.compact(signal);
  }

  /** 当前上下文占预算的百分比（状态展示用） */
  contextUsage(): { chars: number; percent: number } {
    const chars = this.contextSize();
    return { chars, percent: Math.round((chars / this.maxContextChars) * 100) };
  }

  // ── 主循环 ─────────────────────────────────────────────────

  async *runTurn(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.push({ role: "user", content: userInput });

    const guard = new TurnGuard(); // 循环保护以 turn 为生命周期
    let retries = 0; // 连续流式失败次数（成功即清零）
    let autoContinues = 0; // 本轮自动干预次数（截断续跑 + 空回复催跑共享上限）

    for (let i = 0; i < this.maxIterations; i++) {
      if (signal?.aborted) {
        yield { type: "turn_end", reason: "aborted" };
        return;
      }
      if (this.contextSize() > this.maxContextChars) {
        yield* this.compact(signal);
        if (signal?.aborted) {
          yield { type: "turn_end", reason: "aborted" };
          return;
        }
      }

      // 1. 调用模型，转发文本增量，收集完整消息
      let content = "";
      let toolCalls: ToolCall[] = [];
      let stopReason: StopReason | undefined;
      try {
        for await (const ev of this.provider.stream(this.messages, this.registry.specs(), signal)) {
          if (ev.type === "text_delta") {
            yield ev;
          } else {
            content = ev.content;
            toolCalls = ev.toolCalls;
            stopReason = ev.stopReason;
            if (ev.usage) yield { type: "usage", usage: ev.usage };
          }
        }
      } catch (err) {
        // 用户中断：SDK 会抛 abort 错误。已流出的部分文本作为消息保留，
        // transcript 保持一致（user 消息必须有 assistant 回应）
        if (signal?.aborted) {
          await this.push({ role: "assistant", content: content || "(已被用户中断)" });
          yield { type: "turn_end", reason: "aborted" };
          return;
        }
        // 引擎级重试：什么都还没 push，退避后原样重发即可。
        // 已经 yield 出去的半截 text_delta 由宿主收到 stream_retry 时清理。
        if (retries < this.maxStreamRetries && isRetryable(err)) {
          retries++;
          const delayMs = this.retryBaseMs * 2 ** (retries - 1);
          yield {
            type: "stream_retry",
            attempt: retries,
            maxAttempts: this.maxStreamRetries,
            error: err instanceof Error ? err.message : String(err),
            delayMs,
          };
          await sleep(delayMs, signal);
          if (signal?.aborted) {
            await this.push({ role: "assistant", content: "(已被用户中断)" });
            yield { type: "turn_end", reason: "aborted" };
            return;
          }
          i--; // 重试不消耗迭代预算（迭代预算是留给真实工作的）
          continue;
        }
        throw err;
      }
      retries = 0;

      await this.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 && { toolCalls }),
      });

      // 2. 没有工具调用 → 先判断是"说完了"还是"断档了"
      if (toolCalls.length === 0) {
        // 截断续跑：输出被 max_tokens 拦腰砍断，催模型从断处继续
        if (stopReason === "max_tokens" && autoContinues < AUTO_CONTINUE_LIMIT) {
          autoContinues++;
          yield { type: "auto_continue", reason: "truncated" };
          await this.push({
            role: "user",
            content: "[系统提示] 你的上一条输出因长度限制被截断。请从截断处继续，不要重复已输出的内容。",
          });
          continue;
        }
        // 空回复催跑：模型交了白卷，推一把而不是无声结束
        if (!content.trim() && autoContinues < AUTO_CONTINUE_LIMIT) {
          autoContinues++;
          yield { type: "auto_continue", reason: "empty_response" };
          await this.push({
            role: "user",
            content: "[系统提示] 你的上一条回复是空的。任务未完成请继续执行；已完成请简要总结结果。",
          });
          continue;
        }
        yield { type: "turn_end", reason: "done" };
        return;
      }

      // 3. 执行工具（只读并发、写串行），结果回流
      yield* executeToolBatch(
        {
          registry: this.registry,
          canUseTool: this.canUseTool,
          push: (m) => this.push(m),
          onFileRead: (path) => this.trackFile(path),
          guard,
        },
        toolCalls,
        signal,
      );
      if (signal?.aborted) {
        yield { type: "turn_end", reason: "aborted" };
        return;
      }
      // 循环熔断：警告后模型仍在原地打转，强制停轮止损。
      // 此时所有 tool_use 都已有配对的 tool result，transcript 是一致的。
      if (guard.tripped) {
        yield { type: "turn_end", reason: "loop_detected" };
        return;
      }
    }

    yield { type: "turn_end", reason: "max_iterations" };
  }
}

/**
 * System prompt 分段结构（为 prompt cache 设计）：
 *   [静态主干：身份 + 行为准则] → [项目上下文：会话内不变] → [环境信息]
 * 整个 system prompt 在会话期间保持字节稳定，配合 Anthropic provider
 * 在其尾部打的 cache 断点，每轮都能命中缓存。
 * 注意：日期只到"天"，不能放时间戳 —— 任何每次请求都变的字节都会击穿缓存。
 */
function systemPrompt(projectContext?: string): string {
  const base = `你是 Transup，一个在终端中运行的 AI 编程助手。

# 行为准则
- 回答保持简洁，面向终端显示，避免冗长的客套话。
- 修改代码前必须先用 read_file 或 grep 了解现有代码，禁止凭空猜测文件内容。
- 修改已有文件用 edit_file（精确替换）；只有新建文件才用 write_file。
- 完成代码修改后，主动运行相关的测试或类型检查验证改动。
- 遇到工具报错时，阅读错误信息并调整做法，不要原样重试。
- 不确定用户意图时先提问，不要擅自做大范围改动。
- 可以在一条回复中同时调用多个只读工具（read_file/grep/list_dir），它们会并行执行。`;

  const env = `# 环境
- 工作目录: ${process.cwd()}
- 平台: ${process.platform}
- 今天日期: ${new Date().toISOString().slice(0, 10)}`;

  return [base, projectContext, env].filter(Boolean).join("\n\n");
}
