/**
 * 工具批执行 —— 从 engine.ts 拆出的调度模块
 *
 * 只读工具（read/grep/list/task）之间没有依赖，并发执行；
 * 写工具必须串行 —— 不仅因为写操作有顺序性，权限确认（终端问询）
 * 本身也只能一次问一个。
 * 实现：只读的先全部启动（fire），再按原顺序 await —— 事件顺序稳定，
 * 墙钟时间却是并行的。
 *
 * 进度通道：每个调用一条"队列 + 唤醒"通道，把执行期间的 onProgress
 * 回调桥接成 generator 的 tool_progress 事件。只读工具启动即开始
 * 缓冲（子 agent 这类长任务的活动不丢），轮到它时先排空积压再实时转发；
 * 串行工具则是创建即实时。
 *
 * 引擎通过 ctx 注入依赖（注册表、权限回调、消息落盘、循环保护），
 * 本模块不持有任何状态 —— 方便单测，也方便未来换调度策略。
 */
import type { ToolCall } from "../provider/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionFn, ToolResult } from "../tools/types.js";
import type { Message } from "../provider/types.js";
import type { AgentEvent } from "./engine.js";
import type { TurnGuard } from "./guard.js";

export interface ToolRunContext {
  registry: ToolRegistry;
  canUseTool: PermissionFn;
  /** 消息进入系统的唯一入口（内存 + 持久化双写），由引擎提供 */
  push: (m: Message) => Promise<void>;
  /** read_file 成功后回调，引擎用它维护 compact 重注入的文件清单 */
  onFileRead: (path: string) => void;
  /** 本轮的循环保护（重复调用检测），生命周期由引擎管理 */
  guard: TurnGuard;
}

/** 进度通道：onProgress 回调发生在 await 期间，事件必须从 generator
 *  yield 出去 —— 用"队列 + 唤醒"桥接两个世界 */
interface ProgressChannel {
  queue: string[];
  wake: (() => void) | null;
  settled: boolean;
}

function openChannel(result: Promise<ToolResult>): ProgressChannel {
  const channel: ProgressChannel = { queue: [], wake: null, settled: false };
  void result.finally(() => {
    channel.settled = true;
    channel.wake?.();
  });
  return channel;
}

async function* drainChannel(call: ToolCall, channel: ProgressChannel): AsyncGenerator<AgentEvent> {
  while (!channel.settled || channel.queue.length > 0) {
    if (channel.queue.length > 0) {
      yield { type: "tool_progress", call, chunk: channel.queue.shift()! };
    } else {
      await new Promise<void>((resolve) => {
        channel.wake = resolve;
      });
      channel.wake = null;
    }
  }
}

export async function* executeToolBatch(
  ctx: ToolRunContext,
  toolCalls: ToolCall[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  // 先把只读工具全部启动；进度从启动那一刻就进通道缓冲
  const started = new Map<string, { result: Promise<ToolResult>; channel: ProgressChannel }>();
  for (const call of toolCalls) {
    if (ctx.registry.isReadOnly(call.name)) {
      let channel: ProgressChannel | null = null;
      const result = ctx.registry.execute(call.id, call.name, call.args, ctx.canUseTool, (chunk) => {
        channel?.queue.push(chunk);
        channel?.wake?.();
      });
      channel = openChannel(result);
      started.set(call.id, { result, channel });
    }
  }

  for (const call of toolCalls) {
    // 中断时不能直接 return —— 每个 tool_use 都必须有对应的 tool_result，
    // 否则下一轮请求 API 会报错。剩余的调用补"已中断"结果。
    if (signal?.aborted) {
      await ctx.push({ role: "tool", toolCallId: call.id, content: "[错误] 已被用户中断" });
      continue;
    }

    let parsedArgs: Record<string, unknown> = {};
    try { parsedArgs = JSON.parse(call.args || "{}"); } catch {}
    yield { type: "tool_start", call, parsedArgs };

    // 只读 → 取已启动的并发任务（先排空积压的进度再实时转发）；
    // 写 → 现在才串行执行（权限门在里面），进度全程实时。
    let running = started.get(call.id);
    if (!running) {
      let channel: ProgressChannel | null = null;
      const result = ctx.registry.execute(call.id, call.name, call.args, ctx.canUseTool, (chunk) => {
        channel?.queue.push(chunk);
        channel?.wake?.();
      });
      channel = openChannel(result);
      running = { result, channel };
    }
    yield* drainChannel(call, running.channel);
    const result = await running.result;

    // 记录最近读过的文件，供 compact 重注入
    if (call.name === "read_file" && typeof parsedArgs.path === "string" && !result.isError) {
      ctx.onFileRead(parsedArgs.path);
    }

    yield { type: "tool_end", call, content: result.content, isError: result.isError };

    // 循环保护：完全相同的【调用+结果】重复出现时，把警告一并喂回模型；
    // 警告只进模型上下文，不改变 UI 看到的 tool_end 内容
    const repeats = ctx.guard.noteToolResult(call.name, call.args, result.content);
    const warning = ctx.guard.warningFor(repeats);

    await ctx.push({
      role: "tool",
      toolCallId: result.toolCallId,
      content: (result.isError ? `[错误] ${result.content}` : result.content) + warning,
    });
  }
}
