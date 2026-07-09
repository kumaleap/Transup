/**
 * 工具批执行 —— 从 engine.ts 拆出的调度模块
 *
 * 只读工具（read/grep/list）之间没有依赖，并发执行；
 * 写工具必须串行 —— 不仅因为写操作有顺序性，权限确认（终端问询）
 * 本身也只能一次问一个。
 * 实现：只读的先全部启动（fire），再按原顺序 await —— 事件顺序稳定，
 * 墙钟时间却是并行的。
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

export async function* executeToolBatch(
  ctx: ToolRunContext,
  toolCalls: ToolCall[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  // 先把只读工具全部启动
  const started = new Map<string, Promise<ToolResult>>();
  for (const call of toolCalls) {
    if (ctx.registry.isReadOnly(call.name)) {
      started.set(call.id, ctx.registry.execute(call.id, call.name, call.args, ctx.canUseTool));
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
      const resultPromise = ctx.registry.execute(
        call.id, call.name, call.args, ctx.canUseTool,
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
