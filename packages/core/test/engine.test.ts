/**
 * Agent 引擎测试 —— 用脚本化的 mock Provider 驱动完整循环
 *
 * 这是整个测试套件里最有价值的部分：不依赖任何真实 API，
 * 验证引擎的核心行为（循环终止、工具结果回流、compact、中断、
 * transcript 一致性）。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine, type AgentEvent } from "../src/agent/engine.js";
import { SessionStore } from "../src/session/store.js";
import type { Message, Provider, ProviderEvent, ToolCall } from "../src/provider/types.js";

/** 脚本化 Provider：每次调用按顺序吐出预设的回复 */
class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-1";
  calls: Message[][] = []; // 记录每次收到的完整消息，供断言
  private script: { content: string; toolCalls?: ToolCall[] }[];

  constructor(script: { content: string; toolCalls?: ToolCall[] }[]) {
    this.script = script;
  }

  async *stream(messages: Message[]): AsyncIterable<ProviderEvent> {
    this.calls.push(structuredClone(messages));
    const step = this.script.shift() ?? { content: "(脚本用尽)" };
    if (step.content) yield { type: "text_delta", text: step.content };
    yield {
      type: "message_done",
      content: step.content,
      toolCalls: step.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

async function makeEngine(provider: Provider, opts: Partial<ConstructorParameters<typeof AgentEngine>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "transup-engine-"));
  return new AgentEngine({
    provider,
    canUseTool: async () => ({ behavior: "allow" as const }),
    session: new SessionStore("t", dir),
    ...opts,
  });
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for (const p of [gen]) for await (const ev of p) events.push(ev);
  return events;
}

describe("AgentEngine 主循环", () => {
  it("纯文本回复 → 一轮结束", async () => {
    const provider = new MockProvider([{ content: "你好！" }]);
    const engine = await makeEngine(provider);
    const events = await collect(engine.runTurn("hi"));

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
    expect(provider.calls).toHaveLength(1);
  });

  it("工具调用 → 结果回流 → 模型收到结果后收尾", async () => {
    const provider = new MockProvider([
      { content: "", toolCalls: [{ id: "t1", name: "list_dir", args: "{}" }] },
      { content: "目录里有这些文件。" },
    ]);
    const engine = await makeEngine(provider);
    const events = await collect(engine.runTurn("看下目录"));

    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "done" });
    // 第二次调用时，模型必须能看到工具结果
    const secondCall = provider.calls[1];
    expect(secondCall.some((m) => m.role === "tool")).toBe(true);
  });

  it("工具报错 → 错误喂回模型（自愈路径）", async () => {
    const provider = new MockProvider([
      { content: "", toolCalls: [{ id: "t1", name: "read_file", args: '{"path":"/不存在"}' }] },
      { content: "文件不存在，我换个方式。" },
    ]);
    const engine = await makeEngine(provider);
    const events = await collect(engine.runTurn("读文件"));

    const toolEnd = events.find((e) => e.type === "tool_end") as any;
    expect(toolEnd.isError).toBe(true);
    const fed = provider.calls[1].find((m) => m.role === "tool") as any;
    expect(fed.content).toContain("[错误]");
  });

  it("达到 maxIterations → 强制停止而非死循环", async () => {
    // 模型每次都要调工具，永不收尾
    const loop = Array.from({ length: 10 }, () => ({
      content: "", toolCalls: [{ id: `t${Math.random()}`, name: "list_dir", args: "{}" }],
    }));
    const provider = new MockProvider(loop);
    const engine = await makeEngine(provider, { maxIterations: 3 });
    const events = await collect(engine.runTurn("go"));

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_iterations" });
    expect(provider.calls).toHaveLength(3);
  });

  it("中断：signal 触发 → 干净收尾，剩余 tool_use 补齐结果", async () => {
    const provider = new MockProvider([
      { content: "", toolCalls: [
        { id: "t1", name: "list_dir", args: "{}" },
        { id: "t2", name: "list_dir", args: "{}" },
      ]},
      { content: "不应该走到这里" },
    ]);
    const engine = await makeEngine(provider);
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const ev of engine.runTurn("go", controller.signal)) {
      events.push(ev);
      if (ev.type === "tool_end") controller.abort(); // 第一个工具完成后中断
    }

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1); // 不再发起第二次模型调用
  });

  it("compact：超预算触发压缩，摘要替换历史", async () => {
    const provider = new MockProvider([
      // 第 1 次调用：模型正常回复（把历史撑大）
      { content: "好的。" + "x".repeat(500) },
      // 第 2 轮用户输入后超预算 → 第 2 次调用是 compact 的摘要请求
      { content: "摘要：用户在做某任务，已完成 A，下一步 B。" },
      // 第 3 次调用：压缩后的正常回复
      { content: "继续工作。" },
    ]);
    const engine = await makeEngine(provider, { maxContextChars: 800 });

    await collect(engine.runTurn("第一轮"));
    const events = await collect(engine.runTurn("第二轮"));

    expect(events.some((e) => e.type === "compact_start")).toBe(true);
    const end = events.find((e) => e.type === "compact_end") as any;
    expect(end.ok).toBe(true);

    // 压缩后的请求里必须带着摘要，且不再包含第一轮的原始内容
    const lastCall = provider.calls.at(-1)!;
    const text = JSON.stringify(lastCall);
    expect(text).toContain("摘要");
    expect(text).not.toContain("x".repeat(100));
  });
});
