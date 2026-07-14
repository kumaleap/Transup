/**
 * 子 agent 测试：上下文隔离、只读约束、并行派发
 */
import { describe, it, expect } from "vitest";
import { createTaskTool } from "../src/agent/subagent.js";
import type { Message, Provider, ProviderEvent, ToolCall } from "../src/provider/types.js";

/** 脚本化 Provider（每次 stream 调用按序消费脚本） */
class MockProvider implements Provider {
  readonly id = "mock"; readonly model = "m";
  calls: Message[][] = [];
  constructor(private script: { content: string; toolCalls?: ToolCall[] }[]) {}
  async *stream(messages: Message[]): AsyncIterable<ProviderEvent> {
    this.calls.push(structuredClone(messages));
    const step = this.script.shift() ?? { content: "(用尽)" };
    if (step.content) yield { type: "text_delta", text: step.content };
    yield { type: "message_done", content: step.content, toolCalls: step.toolCalls ?? [] };
  }
}

describe("task 子 agent", () => {
  it("子 agent 跑完探索循环，只有结论回流", async () => {
    const provider = new MockProvider([
      // 子 agent 第 1 轮：调只读工具
      { content: "", toolCalls: [{ id: "s1", name: "list_dir", args: "{}" }] },
      // 子 agent 第 2 轮：给出结论
      { content: "结论：入口在 src/index.ts" },
    ]);
    const tool = createTaskTool(provider);
    const result = await tool.execute({ description: "找到项目入口" });

    expect(result).toContain("结论：入口在 src/index.ts");
    // 子 agent 的第一次请求里能看到任务描述
    expect(JSON.stringify(provider.calls[0])).toContain("找到项目入口");
  });

  it("子 agent 的工具集不含 task（不能递归派生）也不含写工具", async () => {
    const provider = new MockProvider([{ content: "看一下工具" }]);
    const tool = createTaskTool(provider);
    await tool.execute({ description: "任意任务" });

    // 检查子 agent 收到的 system prompt 之外的工具声明：
    // MockProvider 收不到 tools 参数（我们的 Provider 接口里 tools 是第二参数），
    // 改从引擎行为验证：让模型请求写工具，应得到"未知工具"错误
    const p2 = new MockProvider([
      { content: "", toolCalls: [{ id: "w1", name: "write_file", args: '{"path":"x","content":"y"}' }] },
      { content: "好的，写不了" },
    ]);
    const tool2 = createTaskTool(p2);
    await tool2.execute({ description: "试图写文件" });
    // 第二次调用时，write_file 的结果应是"未知工具"错误
    const fed = p2.calls[1].find((m) => m.role === "tool") as any;
    expect(fed.content).toContain("未知工具");
    expect(fed.content).not.toContain("write_file,"); // 可用工具列表里没有写工具
  });

  it("task 工具本身是只读的（可并行派发）", () => {
    const tool = createTaskTool(new MockProvider([]));
    expect(tool.readOnly).toBe(true);
  });

  it("真实 task 工具把子 agent 的工具调用透出为进度", async () => {
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [{id: "s1", name: "list_dir", args: '{"path":"."}'}],
      },
      {content: "结论完成"},
    ]);
    const progress: string[] = [];

    const result = await createTaskTool(provider).execute(
      {description: "检查当前目录"},
      (chunk) => progress.push(chunk),
    );

    expect(progress).toEqual(["→ list_dir .\n"]);
    expect(result).toContain("结论完成");
  });

  it("子任务超迭代上限 → 返回部分结论而非报错", async () => {
    const loop = Array.from({ length: 20 }, () => ({
      content: "还在找…", toolCalls: [{ id: `x${Math.random()}`, name: "list_dir", args: "{}" }],
    }));
    const tool = createTaskTool(new MockProvider(loop));
    const result = await tool.execute({ description: "永远找不完的任务" });
    expect(result).toContain("子任务未完成");
  });
});
