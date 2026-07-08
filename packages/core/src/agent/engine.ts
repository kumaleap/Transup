/**
 * Agent 引擎 —— 整个产品的心脏
 *
 * 引擎不打印任何东西：runTurn() 是 AsyncGenerator，把发生的一切作为
 * 事件 yield 给宿主（终端 CLI / IDE 插件 / headless server）渲染。
 *
 * 本版本的三个进阶能力：
 * 1. 上下文压缩（compact）：接近预算时用 LLM 生成结构化摘要替代旧历史，
 *    并重新注入最近读过的文件 ——"模型失忆但工作台还在"。
 * 2. 并行工具执行：一批 tool_use 里的只读工具并发跑，写工具串行
 *    （权限确认本身就必须串行）。
 * 3. 项目上下文：AGENT.md 约定 + repo map 注入 system prompt。
 */
import { readFile } from "node:fs/promises";
import type { Message, Provider, ToolCall, Usage } from "../provider/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { PermissionFn, Tool, ToolResult } from "../tools/types.js";
import { SessionStore } from "../session/store.js";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall; parsedArgs: Record<string, unknown> }
  | { type: "tool_progress"; call: ToolCall; chunk: string }
  | { type: "tool_end"; call: ToolCall; content: string; isError: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "compact_start"; beforeChars: number }
  | { type: "compact_end"; afterChars: number; ok: boolean }
  | { type: "turn_end"; reason: "done" | "max_iterations" | "aborted" };

export interface EngineOptions {
  provider: Provider;
  canUseTool: PermissionFn;
  /** 不传则不持久化（子 agent 的探索过程不值得落盘） */
  session?: SessionStore;
  /** 工具集覆盖：默认内建全集；子 agent 传只读子集 */
  tools?: Tool[];
  /** 恢复会话时传入历史消息（不含 system prompt） */
  history?: Message[];
  /** 项目上下文（AGENT.md + repo map），用 buildProjectContext() 生成 */
  projectContext?: string;
  maxIterations?: number;
  /** 上下文字符预算，超出触发 compact */
  maxContextChars?: number;
}

/** compact 后重新注入的"最近读过的文件"数量与单文件大小上限 */
const REINJECT_FILES = 3;
const REINJECT_MAX_CHARS = 8_000;

export class AgentEngine {
  private messages: Message[];
  private provider: Provider;
  private registry: ToolRegistry;
  private canUseTool: PermissionFn;
  private session?: SessionStore;
  private maxIterations: number;
  private maxContextChars: number;
  /** 最近 read_file 过的路径（去重、保序），compact 后重注入用 */
  private recentFiles: string[] = [];

  constructor(opts: EngineOptions) {
    this.provider = opts.provider;
    this.canUseTool = opts.canUseTool;
    this.session = opts.session;
    this.registry = new ToolRegistry(opts.tools);
    this.maxIterations = opts.maxIterations ?? 40;
    this.maxContextChars = opts.maxContextChars ?? 300_000;
    this.messages = [
      { role: "system", content: systemPrompt(opts.projectContext) },
      ...(opts.history ?? []),
    ];
  }

  /** 消息进入系统的唯一入口：内存 + 持久化双写 */
  private async push(m: Message): Promise<void> {
    this.messages.push(m);
    await this.session?.append(m);
  }

  private contextSize(): number {
    return JSON.stringify(this.messages).length;
  }

  // ── 上下文压缩 ─────────────────────────────────────────────
  //
  // 流程（借鉴 Claude Code 的 compact）：
  //  1. 把 system 之外的全部历史交给模型，用专项 prompt 生成结构化摘要
  //     （单任务协议：禁用工具、强制 TEXT ONLY）
  //  2. 用摘要替换旧历史
  //  3. 重新注入最近读过的文件内容 —— 摘要救的是"记忆"，
  //     重注入救的是"工作台"，两者缺一不可
  //  4. 失败则退回最简截断，绝不让压缩挡住主流程

  private async *compact(): AsyncGenerator<AgentEvent> {
    const before = this.contextSize();
    yield { type: "compact_start", beforeChars: before };

    try {
      const summary = await this.summarize();

      const newMessages: Message[] = [
        this.messages[0], // system prompt 保留
        {
          role: "user",
          content:
            `[系统提示] 对话历史已被压缩。以下是此前对话的摘要，请基于它继续工作：\n\n${summary}` +
            (await this.reinjectFiles()),
        },
        { role: "assistant", content: "已了解此前的工作进展，继续。" },
      ];
      this.messages = newMessages;
      // 压缩是历史重写，在 transcript 里记录为一个事件（新会话段）
      await this.session?.append(newMessages[1]);
      await this.session?.append(newMessages[2] as Message);

      yield { type: "compact_end", afterChars: this.contextSize(), ok: true };
    } catch {
      // 熔断：压缩失败退回最简截断
      this.trimHistory();
      yield { type: "compact_end", afterChars: this.contextSize(), ok: false };
    }
  }

  /** 用专项 prompt 让模型生成摘要（无工具、单任务） */
  private async summarize(): Promise<string> {
    const COMPACT_PROMPT =
      "把上面的对话压缩成一份工作交接摘要，供接手的工程师继续任务。必须包含：\n" +
      "1. 用户的原始目标和当前任务\n" +
      "2. 已完成的工作（改了哪些文件、跑了什么命令、结果如何）\n" +
      "3. 进行中/未完成的工作和下一步计划\n" +
      "4. 重要的技术决策和踩过的坑\n" +
      "只输出摘要正文，不要客套话。";

    const request: Message[] = [
      ...this.messages,
      { role: "user", content: COMPACT_PROMPT },
    ];

    let summary = "";
    // 不传工具 —— 摘要任务禁止工具调用
    for await (const ev of this.provider.stream(request, [])) {
      if (ev.type === "message_done") summary = ev.content;
    }
    if (!summary.trim()) throw new Error("摘要为空");
    return summary;
  }

  /** 重新注入最近读过的文件 —— 让模型"失忆但工作台还在" */
  private async reinjectFiles(): Promise<string> {
    const files = this.recentFiles.slice(-REINJECT_FILES);
    if (files.length === 0) return "";

    const parts: string[] = [];
    for (const path of files) {
      try {
        let text = await readFile(path, "utf-8");
        if (text.length > REINJECT_MAX_CHARS) {
          text = text.slice(0, REINJECT_MAX_CHARS) + "\n… (已截断，需要时重新 read_file)";
        }
        parts.push(`\n\n[重新注入] 最近读过的文件 ${path} 当前内容：\n${text}`);
      } catch {
        // 文件可能已被删除，跳过
      }
    }
    return parts.join("");
  }

  /** 兜底截断（compact 失败时用）。tool 消息必须与 assistant 成对丢弃。 */
  private trimHistory(): void {
    while (this.contextSize() > this.maxContextChars && this.messages.length > 3) {
      this.messages.splice(1, 1);
      while (this.messages[1]?.role === "tool") {
        this.messages.splice(1, 1);
      }
    }
  }

  // ── 并行工具执行 ────────────────────────────────────────────
  //
  // 只读工具（read/grep/list）之间没有依赖，并发执行；
  // 写工具必须串行 —— 不仅因为写操作有顺序性，权限确认（终端问询）
  // 本身也只能一次问一个。
  // 实现：只读的先全部启动（fire），再按原顺序 await —— 事件顺序稳定，
  // 墙钟时间却是并行的。

  private async *executeToolBatch(toolCalls: ToolCall[], signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    // 先把只读工具全部启动
    const started = new Map<string, Promise<ToolResult>>();
    for (const call of toolCalls) {
      if (this.registry.isReadOnly(call.name)) {
        started.set(call.id, this.registry.execute(call.id, call.name, call.args, this.canUseTool));
      }
    }

    for (const call of toolCalls) {
      // 中断时不能直接 return —— 每个 tool_use 都必须有对应的 tool_result，
      // 否则下一轮请求 API 会报错。剩余的调用补"已中断"结果。
      if (signal?.aborted) {
        await this.push({ role: "tool", toolCallId: call.id, content: "[错误] 已被用户中断" });
        continue;
      }

      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(call.args || "{}"); } catch {}
      yield { type: "tool_start", call, parsedArgs };

      // 只读 → 取已启动的并发任务；写 → 现在才串行执行（权限门在里面）。
      // 串行执行时接上进度通道：回调发生在 await 期间，而事件必须从
      // generator yield 出去，所以用"队列 + 唤醒"桥接两个世界。
      let result: ToolResult;
      const startedPromise = started.get(call.id);
      if (startedPromise) {
        result = await startedPromise;
      } else {
        const queue: string[] = [];
        let wake: (() => void) | null = null;
        const resultPromise = this.registry.execute(
          call.id, call.name, call.args, this.canUseTool,
          (chunk) => { queue.push(chunk); wake?.(); },
        );
        let settled = false;
        resultPromise.finally(() => { settled = true; wake?.(); });

        while (!settled || queue.length > 0) {
          if (queue.length > 0) {
            yield { type: "tool_progress", call, chunk: queue.shift()! };
          } else {
            await new Promise<void>((r) => { wake = r; });
            wake = null;
          }
        }
        result = await resultPromise;
      }

      // 记录最近读过的文件，供 compact 重注入
      if (call.name === "read_file" && typeof parsedArgs.path === "string" && !result.isError) {
        this.recentFiles = this.recentFiles.filter((p) => p !== parsedArgs.path);
        this.recentFiles.push(parsedArgs.path);
      }

      yield { type: "tool_end", call, content: result.content, isError: result.isError };

      await this.push({
        role: "tool",
        toolCallId: result.toolCallId,
        content: result.isError ? `[错误] ${result.content}` : result.content,
      });
    }
  }

  /** 手动触发压缩（/compact 命令用）。历史太短时不动。 */
  async *compactNow(): AsyncGenerator<AgentEvent> {
    if (this.messages.length < 4) return;
    yield* this.compact();
  }

  /** 当前上下文占预算的百分比（状态展示用） */
  contextUsage(): { chars: number; percent: number } {
    const chars = this.contextSize();
    return { chars, percent: Math.round((chars / this.maxContextChars) * 100) };
  }

  // ── 主循环 ─────────────────────────────────────────────────

  async *runTurn(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.push({ role: "user", content: userInput });

    for (let i = 0; i < this.maxIterations; i++) {
      if (signal?.aborted) {
        yield { type: "turn_end", reason: "aborted" };
        return;
      }
      if (this.contextSize() > this.maxContextChars) {
        yield* this.compact();
      }

      // 1. 调用模型，转发文本增量，收集完整消息
      let content = "";
      let toolCalls: ToolCall[] = [];
      try {
        for await (const ev of this.provider.stream(this.messages, this.registry.specs(), signal)) {
          if (ev.type === "text_delta") {
            yield ev;
          } else {
            content = ev.content;
            toolCalls = ev.toolCalls;
            if (ev.usage) yield { type: "usage", usage: ev.usage };
          }
        }
      } catch (err: any) {
        // 用户中断：SDK 会抛 abort 错误。已流出的部分文本作为消息保留，
        // transcript 保持一致（user 消息必须有 assistant 回应）
        if (signal?.aborted) {
          await this.push({ role: "assistant", content: content || "(已被用户中断)" });
          yield { type: "turn_end", reason: "aborted" };
          return;
        }
        throw err;
      }

      await this.push({
        role: "assistant",
        content,
        ...(toolCalls.length > 0 && { toolCalls }),
      });

      // 2. 没有工具调用 → 模型说完了
      if (toolCalls.length === 0) {
        yield { type: "turn_end", reason: "done" };
        return;
      }

      // 3. 执行工具（只读并发、写串行），结果回流
      yield* this.executeToolBatch(toolCalls, signal);
      if (signal?.aborted) {
        yield { type: "turn_end", reason: "aborted" };
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
  const base = `你是 mycode，一个在终端中运行的 AI 编程助手。

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
