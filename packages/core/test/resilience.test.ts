/**
 * 运行时韧性回归套件（M4.5）
 *
 * 把"长任务断档"的真实失败场景固化为用例：
 *   - 流式调用中途断开 → 引擎级退避重试
 *   - 不可重试错误（4xx）→ 立即失败，不空耗
 *   - 输出被 max_tokens 截断 → 自动续跑
 *   - 空回复 → 自动催跑（且有次数上限，不会无限自我对话）
 *   - 相同调用+相同结果反复出现 → 先警告后熔断
 *   - 恢复会话后 compact 依然能重注入最近读过的文件
 *   - 重试退避期间用户中断 → 干净收尾
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine, type AgentEvent } from "../src/agent/engine.js";
import { SessionStore } from "../src/session/store.js";
import type { Message, Provider, ProviderEvent, StopReason, ToolCall } from "../src/provider/types.js";

/**
 * 可编程故障 Provider：脚本步骤可以是正常回复，也可以是一次抛错。
 * partialBeforeError 模拟"流出半截文本后断开"——最真实的断流形态。
 */
type Step =
  | { content: string; toolCalls?: ToolCall[]; stopReason?: StopReason }
  | { error: Error & { status?: number }; partialBeforeError?: string };

class FlakyProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-1";
  calls: Message[][] = [];

  constructor(private script: Step[]) {}

  async *stream(messages: Message[]): AsyncIterable<ProviderEvent> {
    this.calls.push(structuredClone(messages));
    const step = this.script.shift() ?? { content: "(脚本用尽)" };
    if ("error" in step) {
      if (step.partialBeforeError) yield { type: "text_delta", text: step.partialBeforeError };
      throw step.error;
    }
    if (step.content) yield { type: "text_delta", text: step.content };
    yield {
      type: "message_done",
      content: step.content,
      toolCalls: step.toolCalls ?? [],
      stopReason: step.stopReason,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function makeEngine(provider: Provider, opts: Partial<ConstructorParameters<typeof AgentEngine>[0]> = {}) {
  return new AgentEngine({
    provider,
    canUseTool: async () => ({ behavior: "allow" as const }),
    retryBaseMs: 1, // 测试不等真实退避
    ...opts,
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const netError = () => Object.assign(new Error("connection reset"), {});

describe("流式重试", () => {
  it("流中途断开 → 退避重试 → 成功完成，重试请求与原请求一致", async () => {
    const provider = new FlakyProvider([
      { error: netError(), partialBeforeError: "我先说半" },
      { content: "完整的回复" },
    ]);
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("hi"));

    const retry = events.find((e) => e.type === "stream_retry") as any;
    expect(retry).toBeDefined();
    expect(retry.attempt).toBe(1);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
    // 失败那次什么都没 push，重发的消息必须与第一次完全一致
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toEqual(provider.calls[0]);
  });

  it("4xx 错误不重试，立即抛出", async () => {
    const provider = new FlakyProvider([
      { error: Object.assign(new Error("invalid api key"), { status: 401 }) },
    ]);
    const engine = makeEngine(provider);
    await expect(collect(engine.runTurn("hi"))).rejects.toThrow("invalid api key");
    expect(provider.calls).toHaveLength(1);
  });

  it("重试次数用尽后抛出", async () => {
    const provider = new FlakyProvider([
      { error: netError() },
      { error: netError() },
      { error: netError() },
    ]);
    const engine = makeEngine(provider, { maxStreamRetries: 2 });
    await expect(collect(engine.runTurn("hi"))).rejects.toThrow("connection reset");
    expect(provider.calls).toHaveLength(3); // 首发 + 2 次重试
  });

  it("host disposal during retry backoff suppresses the interruption record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-retry-host-dispose-"));
    const session = new SessionStore("retry-host-dispose", dir);
    const provider = new FlakyProvider([{ error: netError() }, { content: "不应到达" }]);
    let active = true;
    const engine = makeEngine(provider, {
      retryBaseMs: 60_000,
      canPersist: () => active,
      session,
    });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const ev of engine.runTurn("hi", controller.signal)) {
      events.push(ev);
      if (ev.type === "stream_retry") {
        active = false;
        controller.abort();
      }
    }

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1); // 没有发起重试请求
    expect(await session.load()).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("自动续跑", () => {
  it("max_tokens 截断 → 催模型从断处继续", async () => {
    const provider = new FlakyProvider([
      { content: "前半段被截", stopReason: "max_tokens" },
      { content: "后半段说完了", stopReason: "end_turn" },
    ]);
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("写个长文档"));

    const ac = events.find((e) => e.type === "auto_continue") as any;
    expect(ac?.reason).toBe("truncated");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
    // 第二次请求必须带上续跑提示，且保留了截断的前半段
    const second = provider.calls[1];
    const text = JSON.stringify(second);
    expect(text).toContain("截断");
    expect(text).toContain("前半段被截");
  });

  it("空回复 → 催跑一次后模型恢复正常", async () => {
    const provider = new FlakyProvider([
      { content: "" },
      { content: "抱歉，这是正式回复" },
    ]);
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("hi"));

    const ac = events.find((e) => e.type === "auto_continue") as any;
    expect(ac?.reason).toBe("empty_response");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
  });

  it("催跑有次数上限，不会无限自我对话", async () => {
    // 模型永远交白卷
    const provider = new FlakyProvider(Array.from({ length: 10 }, () => ({ content: "" })));
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("hi"));

    const nudges = events.filter((e) => e.type === "auto_continue");
    expect(nudges.length).toBe(3); // AUTO_CONTINUE_LIMIT
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" }); // 到上限后放弃，正常收尾
  });
});

describe("循环熔断", () => {
  /** 模型反复读同一个不存在的文件 —— 每次的调用和错误结果都完全相同 */
  const loopStep = (n: number): Step => ({
    content: "",
    toolCalls: [{ id: `t${n}`, name: "read_file", args: '{"path":"/不存在的文件"}' }],
  });

  it("相同调用+相同结果：第 3 次起在结果里警告模型", async () => {
    const provider = new FlakyProvider([
      loopStep(1), loopStep(2), loopStep(3),
      { content: "好，我改用别的办法。" },
    ]);
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("go"));

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
    // 第 4 次请求里，第 3 个 tool result 应带循环警告；前两个不带
    const last = provider.calls[3];
    const toolMsgs = last.filter((m) => m.role === "tool") as Extract<Message, { role: "tool" }>[];
    expect(toolMsgs[0].content).not.toContain("循环警告");
    expect(toolMsgs[1].content).not.toContain("循环警告");
    expect(toolMsgs[2].content).toContain("循环警告");
  });

  it("警告无效持续空转 → 第 5 次熔断停轮", async () => {
    const provider = new FlakyProvider(Array.from({ length: 10 }, (_, i) => loopStep(i)));
    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("go"));

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "loop_detected" });
    expect(provider.calls).toHaveLength(5); // 第 5 次执行后熔断，不再发起第 6 次请求
  });

  it("相同命令不同结果（正常工作流）不触发熔断", async () => {
    // "改代码后重跑测试"式的工作流：调用完全相同但每次结果不同。
    // 结果参与循环签名，所以这不算空转 —— 6 次重复也不该熔断。
    const dir = await mkdtemp(join(tmpdir(), "transup-loop-"));
    const provider = new FlakyProvider([
      ...Array.from({ length: 6 }, (_, i) => ({
        content: "",
        toolCalls: [{ id: `t${i}`, name: "list_dir", args: JSON.stringify({ path: dir }) }] as ToolCall[],
      })),
      { content: "观察完毕" },
    ]);
    // 每轮往目录里加一个文件，保证 list_dir 结果每次都不同
    let round = 0;
    const origStream = provider.stream.bind(provider);
    provider.stream = async function* (messages, tools, signal) {
      await writeFile(join(dir, `f${round++}.txt`), "x");
      yield* origStream(messages, tools, signal);
    };

    const engine = makeEngine(provider);
    const events = await collect(engine.runTurn("go"));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
  });
});

describe("中断恢复质量", () => {
  it("恢复会话后 compact 依然重注入最近读过的文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-resume-"));
    const file = join(dir, "work.ts");
    await writeFile(file, "const 秘密工作台内容 = 42;");

    // 恢复的历史：上一个会话里读过 work.ts，且历史体积已接近预算
    const history: Message[] = [
      { role: "user", content: "帮我改 work.ts " + "x".repeat(600) },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read_file", args: JSON.stringify({ path: file }) }],
      },
      { role: "tool", toolCallId: "t1", content: "const 秘密工作台内容 = 42;" },
      { role: "assistant", content: "看完了。" },
    ];

    const provider = new FlakyProvider([
      { content: "摘要：用户在改 work.ts。" }, // compact 的 summarize 调用
      { content: "继续工作。" }, // 压缩后的正常回复
    ]);
    const engine = makeEngine(provider, { history, maxContextChars: 700 });
    const events = await collect(engine.runTurn("继续"));

    expect(events.some((e) => e.type === "compact_start")).toBe(true);
    // 压缩后的请求里必须有重注入的文件内容 —— recentFiles 是从历史重建的
    const lastCall = JSON.stringify(provider.calls.at(-1));
    expect(lastCall).toContain("重新注入");
    expect(lastCall).toContain("秘密工作台内容");
  });

  it("压缩检查点恢复后下一次 compact 仍重注入最近读过的文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-checkpoint-resume-"));
    const file = join(dir, "checkpoint-work.ts");
    await writeFile(file, "const 检查点工作台内容 = 84;");
    const session = new SessionStore("checkpoint-resume", dir);
    const history: Message[] = [
      { role: "user", content: "旧任务 " + "x".repeat(600) },
      { role: "assistant", content: "旧回复" },
      { role: "user", content: "旧追问" },
    ];
    for (const message of history) await session.append(message);

    const firstProvider = new FlakyProvider([{ content: "第一次持久化摘要" }]);
    const firstEngine = makeEngine(firstProvider, {
      history,
      recentFiles: [file],
      session,
    });
    await collect(firstEngine.compactNow());

    const state = await new SessionStore("checkpoint-resume", dir).loadState();
    expect(state.recentFiles).toEqual([file]);

    const resumedProvider = new FlakyProvider([
      { content: "第二次摘要" },
      { content: "恢复后继续" },
    ]);
    const resumedEngine = makeEngine(resumedProvider, {
      history: state.messages,
      recentFiles: state.recentFiles,
      maxContextChars: 700,
    });
    await collect(resumedEngine.runTurn("继续"));

    const postCompactRequest = JSON.stringify(resumedProvider.calls.at(-1));
    expect(postCompactRequest).toContain("重新注入");
    expect(postCompactRequest).toContain("检查点工作台内容");
  });
});
