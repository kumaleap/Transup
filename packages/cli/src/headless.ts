/**
 * Headless 模式 —— `transup -p "任务"` 非交互执行
 *
 * 这是 core"零 UI 依赖"承诺的第一个非终端宿主：不渲染 Ink，
 * 纯事件流消费。适合管道、CI、定时任务、被其它程序调用。
 *
 * 输出约定（方便脚本处理）：
 *   stdout —— 只有模型的正文文本（可直接管道给下游）
 *   stderr —— 工具活动、重试/续跑/压缩等过程信息
 *
 * 权限模型（无人可问，必须 fail-closed）：
 *   只读工具照常免确认；写操作只有两条路放行 ——
 *   settings 允许清单（.transup/settings.json），或显式 --allow-all。
 *   其余一律拒绝并告知模型原因，模型可以带着结论收尾。
 *
 * 函数不直接碰 process：输出走注入的 writer，中断走 AbortSignal，
 * 退出码作为返回值 —— 这样测试可以用 mock provider 完整驱动。
 */
import {
  AgentEngine,
  SessionStore,
  isAllowed,
  type AgentEvent,
  type Message,
  type Provider,
  type Settings,
  type Tool,
} from "@transup/core";
import { formatArgs } from "./tui/Transcript.js";

export interface HeadlessOptions {
  provider: Provider;
  tools: Tool[];
  settings: Settings;
  projectContext: string;
  sessionId: string;
  history: Message[];
  prompt: string;
  /** 跳过所有权限确认。只应在可信环境（CI/沙箱）使用。 */
  allowAll?: boolean;
  /** 会话持久化目录覆盖（测试用） */
  sessionDir?: string;
  signal?: AbortSignal;
  out?: (s: string) => void;
  err?: (s: string) => void;
  trace?: {
    record: (event: AgentEvent) => Promise<void>;
  };
}

/** 返回进程退出码：0 = 正常收尾，1 = 中断/熔断/迭代耗尽/API 失败 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const err = opts.err ?? ((s) => process.stderr.write(s));

  const engine = new AgentEngine({
    provider: opts.provider,
    canUseTool: async (name) => {
      if (opts.allowAll || isAllowed(opts.settings, name)) return true;
      err(`⊘ 已拒绝写操作 ${name}（headless 模式需要 settings 允许清单或 --allow-all）\n`);
      return false;
    },
    session: new SessionStore(opts.sessionId, opts.sessionDir),
    history: opts.history,
    projectContext: opts.projectContext,
    tools: opts.tools,
  });

  let exitCode = 0;
  try {
    for await (const ev of engine.runTurn(opts.prompt, opts.signal)) {
      await opts.trace?.record(ev);
      switch (ev.type) {
        case "text_delta":
          out(ev.text);
          break;
        case "tool_start":
          err(`⏺ ${ev.call.name}(${formatArgs(ev.parsedArgs)})\n`);
          break;
        case "tool_end":
          if (ev.isError) err(`  ✗ ${firstLine(ev.content)}\n`);
          break;
        case "stream_retry":
          err(`⚠ 模型调用失败（${ev.error}），${Math.round(ev.delayMs / 1000)}s 后重试 ${ev.attempt}/${ev.maxAttempts}\n`);
          break;
        case "auto_continue":
          err(ev.reason === "truncated" ? "⟳ 输出被截断，自动续跑\n" : "⟳ 空回复，自动催跑\n");
          break;
        case "compact_start":
          err("⟳ 上下文接近上限，压缩中\n");
          break;
        case "turn_end":
          if (ev.reason !== "done") {
            err(`✗ 任务未正常完成：${ev.reason}\n`);
            exitCode = 1;
          }
          break;
      }
    }
  } catch (e) {
    err(`✗ API 错误: ${e instanceof Error ? e.message : String(e)}\n`);
    exitCode = 1;
  }
  out("\n");
  return exitCode;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0];
  return line.length > 120 ? line.slice(0, 120) + "…" : line;
}
