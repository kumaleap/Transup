/**
 * Agent 引擎测试 —— 用脚本化的 mock Provider 驱动完整循环
 *
 * 这是整个测试套件里最有价值的部分：不依赖任何真实 API，
 * 验证引擎的核心行为（循环终止、工具结果回流、compact、中断、
 * transcript 一致性）。
 */
import { describe, it, expect } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AgentEngine, wasInterrupted, type AgentEvent } from "../src/agent/engine.js";
import { createTaskTool } from "../src/agent/subagent.js";
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

class DeferredAbortProvider implements Provider {
  readonly id = "deferred-abort";
  readonly model = "deferred-abort-1";
  private rejectStream!: (error: Error) => void;
  private readonly streamGate = new Promise<never>((_, reject) => {
    this.rejectStream = reject;
  });
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  rejectAfterAbort(): void {
    this.rejectStream(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }

  async *stream(): AsyncIterable<ProviderEvent> {
    this.markStarted();
    await this.streamGate;
  }
}

class GatedCompactSessionStore extends SessionStore {
  readonly compactBatches: Message[][] = [];
  private compactObserved = false;
  private releaseCommit!: () => void;
  private readonly commitGate = new Promise<void>((resolve) => {
    this.releaseCommit = resolve;
  });
  private markCompactStarted!: () => void;
  readonly compactStarted = new Promise<void>((resolve) => {
    this.markCompactStarted = resolve;
  });

  releaseCompact(): void {
    this.releaseCommit();
  }

  override async commitCompaction(
    messages: readonly Message[],
    recentFiles: readonly string[],
  ): Promise<void> {
    this.compactBatches.push(structuredClone([...messages]));
    if (!this.compactObserved) {
      this.compactObserved = true;
      this.markCompactStarted();
      await this.commitGate;
    }
    await super.commitCompaction(messages, recentFiles);
  }
}

class RejectingCompactSessionStore extends SessionStore {
  readonly compactBatches: Message[][] = [];

  override async commitCompaction(
    messages: readonly Message[],
    _recentFiles: readonly string[],
  ): Promise<void> {
    this.compactBatches.push(structuredClone([...messages]));
    throw new Error("compact persistence failed");
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

  it("host disposal suppresses the late assistant interruption record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-host-dispose-"));
    const session = new SessionStore("host-dispose", dir);
    const provider = new DeferredAbortProvider();
    let active = true;
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      canPersist: () => active,
      session,
    });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("keep the submitted input", controller.signal));
    await provider.started;
    active = false;
    controller.abort();
    provider.rejectAfterAbort();
    const events = await turn;

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(await session.load()).toEqual([
      { role: "user", content: "keep the submitted input" },
    ]);
  });

  it("host disposal suppresses a tool result that finishes after unmount", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-tool-dispose-"));
    const session = new SessionStore("tool-dispose", dir);
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const lateTool = {
      name: "late_tool",
      description: "test host disposal during tool execution",
      schema: z.object({}),
      readOnly: true,
      async execute() {
        markToolStarted();
        await toolGate;
        return "late tool result";
      },
    };
    const call = { id: "late-1", name: lateTool.name, args: "{}" };
    const provider = new MockProvider([
      { content: "", toolCalls: [call] },
      { content: "must not run" },
    ]);
    let active = true;
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      canPersist: () => active,
      session,
      tools: [lateTool],
    });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("run the late tool", controller.signal));
    await toolStarted;
    active = false;
    controller.abort();
    releaseTool();
    const events = await turn;

    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1);
    expect(await session.load()).toEqual([
      { role: "user", content: "run the late tool" },
      expect.objectContaining({ role: "assistant", content: "", toolCalls: [call] }),
    ]);
  });

  it.each([
    { label: "read-only prestarted", readOnly: true },
    { label: "serial", readOnly: false },
  ])("$label tool receives the exact turn signal and settles on abort", async ({ readOnly }) => {
    let seenSignal: AbortSignal | undefined;
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const abortAwareTool = {
      name: readOnly ? "abort_read_tool" : "abort_write_tool",
      description: "observes turn cancellation",
      schema: z.object({}),
      readOnly,
      async execute(
        _args: object,
        _onProgress?: (chunk: string) => void,
        signal?: AbortSignal,
      ) {
        seenSignal = signal;
        markToolStarted();
        if (!signal) return "missing signal";
        await new Promise<never>((_, reject) => {
          const rejectAbort = () => reject(
            Object.assign(new Error("tool aborted"), { name: "AbortError" }),
          );
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
        return "unreachable";
      },
    };
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [{ id: "abort-1", name: abortAwareTool.name, args: "{}" }],
      },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, { tools: [abortAwareTool] });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("run abort-aware tool", controller.signal));
    await toolStarted;
    controller.abort();
    const events = await turn;

    expect(seenSignal).toBe(controller.signal);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1);
  });

  it("abort does not wait forever for a running legacy tool that ignores the signal", async () => {
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const neverSettles = new Promise<never>(() => {});
    const legacyTool = {
      name: "legacy_hanging_tool",
      description: "ignores cancellation",
      schema: z.object({}),
      readOnly: true,
      async execute() {
        markToolStarted();
        return neverSettles;
      },
    };
    const call = { id: "legacy-hang-1", name: legacyTool.name, args: "{}" };
    const provider = new MockProvider([
      { content: "", toolCalls: [call] },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, { tools: [legacyTool] });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("run legacy tool", controller.signal));
    await toolStarted;
    controller.abort();
    const outcome = await Promise.race([
      turn,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);

    expect(outcome).not.toBeNull();
    expect(outcome?.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(outcome).toContainEqual(expect.objectContaining({
      type: "tool_end",
      call,
      isError: true,
      content: expect.stringContaining("中断"),
    }));
    expect(provider.calls).toHaveLength(1);
  });

  it("abort does not wait for write_file while its permission decision is pending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-permission-abort-"));
    const target = join(dir, "must-not-write.txt");
    let markPermissionStarted!: () => void;
    const permissionStarted = new Promise<void>((resolve) => {
      markPermissionStarted = resolve;
    });
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    const call = {
      id: "pending-write-permission",
      name: "write_file",
      args: JSON.stringify({ path: target, content: "must not be written" }),
    };
    const provider = new MockProvider([
      { content: "", toolCalls: [call] },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, {
      canUseTool: async () => {
        markPermissionStarted();
        await permissionGate;
        return { behavior: "allow" as const };
      },
    });
    const controller = new AbortController();
    const turn = collect(engine.runTurn("request a write", controller.signal));

    await permissionStarted;
    controller.abort();
    try {
      const outcome = await Promise.race([
        turn,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);

      expect(outcome).not.toBeNull();
      expect(outcome?.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
      expect(outcome).toContainEqual(expect.objectContaining({
        type: "tool_end",
        call,
        isError: true,
        content: expect.stringContaining("中断"),
      }));
      expect(provider.calls).toHaveLength(1);
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releasePermission();
      await turn;
    }
  });

  it("abort wins atomically when a tool attempts beginCommit during the grace turn", async () => {
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let releaseCommitAttempt!: () => void;
    const commitAttemptGate = new Promise<void>((resolve) => {
      releaseCommitAttempt = resolve;
    });
    let boundaryFailure: unknown;
    let mutationStarted = false;
    const lateCommitTool = {
      name: "late_commit_tool",
      description: "attempts commit after abort wins",
      schema: z.object({}),
      readOnly: false,
      async execute(
        _args: object,
        _onProgress?: (chunk: string) => void,
        signal?: AbortSignal,
        beginCommit?: () => void,
      ) {
        signal?.addEventListener("abort", () => {
          setImmediate(releaseCommitAttempt);
        }, { once: true });
        markToolStarted();
        await commitAttemptGate;
        try {
          beginCommit?.();
          mutationStarted = true;
          return "late mutation completed";
        } catch (error) {
          boundaryFailure = error;
          throw error;
        }
      },
    };
    const call = { id: "late-commit-1", name: lateCommitTool.name, args: "{}" };
    const provider = new MockProvider([
      { content: "", toolCalls: [call] },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, { tools: [lateCommitTool] });
    const controller = new AbortController();
    const abortReason = new Error("abort won before commit");

    const turn = collect(engine.runTurn("run late commit", controller.signal));
    await toolStarted;
    controller.abort(abortReason);
    const events = await turn;

    expect.soft(boundaryFailure).toBe(abortReason);
    expect.soft(mutationStarted).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      call,
      content: expect.stringContaining("中断"),
      isError: true,
    }));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1);
  });

  it("abort waits for a tool that has entered a commit-wins operation", async () => {
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitTool = {
      name: "commit_wins_tool",
      description: "must finish an in-flight commit",
      schema: z.object({}),
      readOnly: false,
      async execute(
        _args: object,
        _onProgress?: (chunk: string) => void,
        signal?: AbortSignal,
        beginCommit?: () => void,
      ) {
        signal?.throwIfAborted();
        beginCommit?.();
        markToolStarted();
        await commitGate;
        beginCommit?.();
        return "commit completed";
      },
    };
    const call = { id: "commit-1", name: commitTool.name, args: "{}" };
    const provider = new MockProvider([
      { content: "", toolCalls: [call] },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, { tools: [commitTool] });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("run commit", controller.signal));
    let turnSettled = false;
    void turn.then(() => {
      turnSettled = true;
    });
    await toolStarted;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(turnSettled).toBe(false);

    releaseCommit();
    const events = await turn;
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_end",
      call,
      content: "commit completed",
      isError: false,
    }));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
  });

  it("preserves partial outcomes from every settled parallel task after abort", async () => {
    let startedCount = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    const subProvider: Provider = {
      id: "parallel-abort-aware",
      model: "parallel-abort-aware-1",
      async *stream(messages, _tools, signal): AsyncIterable<ProviderEvent> {
        const description = messages.findLast((message) => message.role === "user")?.content ?? "";
        yield { type: "text_delta", text: `partial:${description}` };
        startedCount++;
        if (startedCount === 2) markBothStarted();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw Object.assign(new Error("provider aborted"), { name: "AbortError" });
      },
    };
    const task = createTaskTool(subProvider);
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "task-1", name: "task", args: '{"description":"one"}' },
          { id: "task-2", name: "task", args: '{"description":"two"}' },
        ],
      },
      { content: "must not run" },
    ]);
    const engine = await makeEngine(provider, { tools: [task] });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("run both tasks", controller.signal));
    await bothStarted;
    controller.abort();
    const events = await turn;

    expect(
      events
        .filter((event): event is Extract<AgentEvent, { type: "tool_end" }> =>
          event.type === "tool_end",
        )
        .map((event) => `${event.call.id}:${event.content}`),
    ).toEqual([
      expect.stringContaining("task-1:[子任务未完成: aborted]"),
      expect.stringContaining("task-2:[子任务未完成: aborted]"),
    ]);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_end", content: expect.stringContaining("partial:one") }),
      expect.objectContaining({ type: "tool_end", content: expect.stringContaining("partial:two") }),
    ]));
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
  });

  it("omitting canPersist keeps ordinary engine persistence enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-default-persist-"));
    const session = new SessionStore("default-persist", dir);
    const engine = new AgentEngine({
      provider: new MockProvider([{ content: "ordinary completion" }]),
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
    });

    await collect(engine.runTurn("ordinary input"));

    expect(await session.load()).toEqual([
      { role: "user", content: "ordinary input" },
      { role: "assistant", content: "ordinary completion" },
    ]);
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

  it("successful compact restores only the committed checkpoint after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-compact-resume-"));
    const sessionId = "compact-resume";
    const session = new SessionStore(sessionId, dir);
    const originalMarker = `pre-compact-history-${"x".repeat(500)}`;
    const history: Message[] = [
      { role: "user", content: originalMarker },
      { role: "assistant", content: "old response" },
      { role: "user", content: "old follow-up" },
    ];
    for (const message of history) await session.append(message);

    const compactProvider = new MockProvider([{ content: "durable compact summary" }]);
    const engine = new AgentEngine({
      provider: compactProvider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
      history,
    });
    await collect(engine.compactNow());

    const resumedHistory = await new SessionStore(sessionId, dir).load();
    expect(JSON.stringify(resumedHistory)).not.toContain(originalMarker);
    expect(resumedHistory).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("durable compact summary"),
      }),
      { role: "assistant", content: "已了解此前的工作进展，继续。" },
    ]);

    const resumedProvider = new MockProvider([{ content: "continued after restart" }]);
    const resumedEngine = new AgentEngine({
      provider: resumedProvider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      history: resumedHistory,
    });
    await collect(resumedEngine.runTurn("continue"));
    expect(JSON.stringify(resumedProvider.calls[0])).not.toContain(originalMarker);
    expect(JSON.stringify(resumedProvider.calls[0])).toContain("durable compact summary");
  });

  it("automatic compact commits one batch when abort arrives during persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-compact-commit-"));
    const session = new GatedCompactSessionStore("commit-wins", dir);
    const provider = new MockProvider([
      { content: "committed compact summary" },
      { content: "post-commit probe" },
    ]);
    const originalMarker = `original-history-${"x".repeat(2_000)}`;
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
      history: [
        { role: "user", content: originalMarker },
        { role: "assistant", content: "original response" },
        { role: "user", content: "original follow-up" },
      ],
      maxContextChars: 1_000,
    });
    const controller = new AbortController();

    const turn = collect(engine.runTurn("trigger automatic compact", controller.signal));
    await session.compactStarted;
    let settled = false;
    void turn.then(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    session.releaseCompact();
    const events = await turn;

    const compactEnd = events.find((event) => event.type === "compact_end");
    expect(compactEnd).toMatchObject({ type: "compact_end", ok: true });
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "aborted" });
    expect(provider.calls).toHaveLength(1);
    expect(session.compactBatches).toEqual([
      [
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("committed compact summary"),
        }),
        { role: "assistant", content: "已了解此前的工作进展，继续。" },
      ],
    ]);
    expect(await session.load()).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("committed compact summary"),
      }),
      { role: "assistant", content: "已了解此前的工作进展，继续。" },
    ]);

    await collect(engine.runTurn("probe committed history"));
    expect(JSON.stringify(provider.calls[1])).toContain("committed compact summary");
    expect(JSON.stringify(provider.calls[1])).not.toContain(originalMarker);
  });

  it("compact batch failure keeps the old in-memory history before fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-engine-compact-persist-fail-"));
    const session = new RejectingCompactSessionStore("persist-fail", dir);
    const history: Message[] = [
      { role: "user", content: `old-history-${"x".repeat(500)}` },
      { role: "assistant", content: "old response" },
      { role: "user", content: "old follow-up" },
    ];
    for (const message of history) await session.append(message);
    const provider = new MockProvider([{ content: "must not replace old history" }]);
    const engine = new AgentEngine({
      provider,
      canUseTool: async () => ({ behavior: "allow" as const }),
      session,
      history,
      maxContextChars: 100_000,
    });
    const before = engine.contextUsage();

    const events = await collect(engine.compactNow());

    expect(events.at(-1)).toMatchObject({ type: "compact_end", ok: false });
    expect(engine.contextUsage()).toEqual(before);
    expect(session.compactBatches).toEqual([
      [
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("must not replace old history"),
        }),
        { role: "assistant", content: "已了解此前的工作进展，继续。" },
      ],
    ]);
    expect(await session.load()).toEqual(history);
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
