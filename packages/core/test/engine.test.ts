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
import { z } from "zod";
import { AgentEngine, wasInterrupted, type AgentEvent } from "../src/agent/engine.js";
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

/** The first compact request waits even after abort, reproducing a provider that ignores cancellation. */
class LateCompactProvider implements Provider {
  readonly id = "late-compact";
  readonly model = "late-compact-1";
  readonly calls: Message[][] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  private compactCalls = 0;
  private resolveFirstCompact!: () => void;
  private firstCompactGate = new Promise<void>((resolve) => {
    this.resolveFirstCompact = resolve;
  });
  private markFirstCompactStarted!: () => void;
  readonly firstCompactStarted = new Promise<void>((resolve) => {
    this.markFirstCompactStarted = resolve;
  });

  releaseFirstCompact(): void {
    this.resolveFirstCompact();
  }

  async *stream(
    messages: Message[],
    tools: Parameters<Provider["stream"]>[1],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.calls.push(structuredClone(messages));
    this.signals.push(signal);
    const isCompact = tools.length === 0;
    if (isCompact) {
      this.compactCalls++;
      if (this.compactCalls === 1) {
        this.markFirstCompactStarted();
        await this.firstCompactGate;
      }
    }

    const content = isCompact ? `summary-${this.compactCalls}` : "normal completion";
    yield { type: "text_delta", text: content };
    yield {
      type: "message_done",
      content,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

/** Rejects on demand so the broken no-signal path still settles and exercises fallback trimming. */
class RejectingCompactProvider implements Provider {
  readonly id = "rejecting-compact";
  readonly model = "rejecting-compact-1";
  readonly signals: (AbortSignal | undefined)[] = [];
  private rejectCompact!: (error: Error) => void;
  private compactGate = new Promise<never>((_, reject) => {
    this.rejectCompact = reject;
  });
  private markCompactStarted!: () => void;
  readonly compactStarted = new Promise<void>((resolve) => {
    this.markCompactStarted = resolve;
  });

  rejectAfterAbort(): void {
    this.rejectCompact(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }

  async *stream(
    _messages: Message[],
    _tools: Parameters<Provider["stream"]>[1],
    signal?: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.signals.push(signal);
    this.markCompactStarted();
    await this.compactGate;
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
    // 摘要正文随事件透出 —— 宿主用它渲染"一行摘要卡 + 展开查看"
    expect(end.summary).toContain("已完成 A");

    // 压缩后的请求里必须带着摘要，且不再包含第一轮的原始内容
    const lastCall = provider.calls.at(-1)!;
    const text = JSON.stringify(lastCall);
    expect(text).toContain("摘要");
    expect(text).not.toContain("x".repeat(100));
  });

  it("automatic compact aborts atomically when a provider returns a late summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-compact-abort-"));
    const session = new SessionStore("automatic", dir);
    const provider = new LateCompactProvider();
    const originalMarker = `original-history-${"x".repeat(800)}`;
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
      history: [
        { role: "user", content: originalMarker },
        { role: "assistant", content: "original response" },
        { role: "user", content: "original follow-up" },
      ],
      maxContextChars: 400,
    });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("trigger automatic compact", controller.signal));
    await provider.firstCompactStarted;
    controller.abort();
    provider.releaseFirstCompact();
    const events = await turn;

    expect(provider.signals[0]).toBe(controller.signal);
    expect(events.some((event) => event.type === "compact_end")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(await session.load()).toEqual([
      { role: "user", content: "trigger automatic compact" },
    ]);

    await collect(engine.compactNow());
    const compactRequests = provider.calls.filter((request) =>
      request.at(-1)?.content.includes("把上面的对话压缩成一份工作交接摘要"),
    );
    expect(compactRequests).toHaveLength(2);
    expect(JSON.stringify(compactRequests[1])).toContain(originalMarker);
    expect(JSON.stringify(compactRequests[1])).not.toContain("summary-1");
  });

  it("manual compact abort does not fall back to trimming or append compact records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-manual-compact-abort-"));
    const session = new SessionStore("manual", dir);
    const history: Message[] = [
      { role: "user", content: `must-survive-${"x".repeat(800)}` },
      { role: "assistant", content: "original response" },
      { role: "user", content: "original follow-up" },
    ];
    for (const message of history) await session.append(message);
    const provider = new RejectingCompactProvider();
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
      history,
      maxContextChars: 400,
    });
    const before = engine.contextUsage();
    const controller = new AbortController();

    const compact = collect(engine.compactNow(controller.signal));
    await provider.compactStarted;
    controller.abort();
    provider.rejectAfterAbort();
    const events = await compact;

    expect(engine.contextUsage()).toEqual(before);
    expect(provider.signals).toEqual([controller.signal]);
    expect(events.some((event) => event.type === "compact_end")).toBe(false);
    expect(await session.load()).toEqual(history);
  });

  it("只读工具的进度也走 tool_progress（并行启动，轮到时转发）", async () => {
    // 自定义只读工具：执行期间吐两段进度
    const probe = {
      name: "probe",
      description: "test",
      schema: z.object({}),
      readOnly: true,
      async execute(_args: object, onProgress?: (chunk: string) => void) {
        onProgress?.("第一步\n");
        await new Promise((r) => setTimeout(r, 10));
        onProgress?.("第二步\n");
        return "完成";
      },
    };
    const provider = new MockProvider([
      { content: "", toolCalls: [{ id: "t1", name: "probe", args: "{}" }] },
      { content: "收到。" },
    ]);
    const engine = await makeEngine(provider, { tools: [probe] });
    const events = await collect(engine.runTurn("跑探针"));

    const types = events.map((e) => e.type);
    const progress = events.filter((e) => e.type === "tool_progress") as any[];
    expect(progress.map((p) => p.chunk)).toEqual(["第一步\n", "第二步\n"]);
    // 顺序：tool_start → progress → tool_end
    expect(types.indexOf("tool_start")).toBeLessThan(types.indexOf("tool_progress"));
    expect(types.lastIndexOf("tool_progress")).toBeLessThan(types.indexOf("tool_end"));
  });
});

describe("wasInterrupted", () => {
  const user = (content: string): Message => ({ role: "user", content });
  const assistant = (content: string): Message => ({ role: "assistant", content });
  const tool = (content: string): Message => ({ role: "tool", toolCallId: "t1", content });

  it("正常收尾（assistant 结尾）→ 未中断；空历史 → 未中断", () => {
    expect(wasInterrupted([])).toBe(false);
    expect(wasInterrupted([user("做任务"), assistant("做完了")])).toBe(false);
  });

  it("尾部是 user → 提问后没有回应，中断", () => {
    expect(wasInterrupted([user("做任务")])).toBe(true);
    // 但引擎注入的系统提示不算用户提问
    expect(wasInterrupted([user("[系统提示] 对话历史已被压缩。")])).toBe(false);
  });

  it("尾部是 tool 结果 → 模型还没接话，中断", () => {
    expect(wasInterrupted([user("做"), assistant(""), tool("[错误] 已被用户中断")])).toBe(true);
  });

  it("流式中断标记 → 中断", () => {
    expect(wasInterrupted([user("做"), assistant("(已被用户中断)")])).toBe(true);
  });
});
