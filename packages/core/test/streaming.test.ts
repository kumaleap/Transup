/**
 * bash 流式输出测试：
 * 1. 工具层：onProgress 在执行中收到增量输出
 * 2. 引擎层：tool_progress 事件在 tool_start 和 tool_end 之间流出
 */
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";
import { AgentEngine, type AgentEvent } from "../src/agent/engine.js";
import { SessionStore } from "../src/session/store.js";
import type { Message, Provider, ProviderEvent, ToolCall } from "../src/provider/types.js";

const allow = async () => true;

describe("bash 流式输出", () => {
  it("工具层：onProgress 收到增量 chunk，最终结果仍完整", async () => {
    const reg = new ToolRegistry();
    const chunks: string[] = [];
    const r = await reg.execute(
      "1", "bash",
      JSON.stringify({ command: "echo first; sleep 0.05; echo second" }),
      allow,
      (c) => chunks.push(c),
    );
    expect(r.isError).toBe(false);
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("second");
    expect(r.content).toContain("first");
    expect(r.content).toContain("second");
  });

  it("命令失败：exit code 和输出都喂回模型", async () => {
    const reg = new ToolRegistry();
    const r = await reg.execute(
      "1", "bash",
      JSON.stringify({ command: "echo oops >&2; exit 3" }),
      allow,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit code 3");
    expect(r.content).toContain("oops");
  });

  it("超时：命令被终止并报告", async () => {
    const reg = new ToolRegistry();
    const r = await reg.execute(
      "1", "bash",
      JSON.stringify({ command: "sleep 60", timeout_seconds: 0.2 }),
      allow,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("超时");
  }, 15_000);

  it("引擎层：tool_progress 事件夹在 tool_start 与 tool_end 之间", async () => {
    // mock provider：先要求跑一条会产生输出的 bash，再收尾
    class P implements Provider {
      readonly id = "mock"; readonly model = "m";
      private step = 0;
      async *stream(): AsyncIterable<ProviderEvent> {
        const replies: { content: string; toolCalls: ToolCall[] }[] = [
          { content: "", toolCalls: [{ id: "t1", name: "bash", args: '{"command":"echo streamed-line"}' }] },
          { content: "完成", toolCalls: [] },
        ];
        const r = replies[this.step++];
        yield { type: "message_done", ...r };
      }
    }
    const dir = await mkdtemp(join(tmpdir(), "transup-stream-"));
    const engine = new AgentEngine({
      provider: new P(),
      canUseTool: allow,
      session: new SessionStore("t", dir),
    });

    const types: string[] = [];
    let progressText = "";
    for await (const ev of engine.runTurn("跑一下")) {
      types.push(ev.type);
      if (ev.type === "tool_progress") progressText += ev.chunk;
    }

    expect(progressText).toContain("streamed-line");
    const start = types.indexOf("tool_start");
    const progress = types.indexOf("tool_progress");
    const end = types.indexOf("tool_end");
    expect(start).toBeLessThan(progress);
    expect(progress).toBeLessThan(end);
  });
});
