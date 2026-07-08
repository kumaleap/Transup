/**
 * Anthropic 协议翻译测试
 *
 * 两个最容易错也最要命的约定：
 * 1. 同一批工具结果必须合并进【一条】user 消息（分开发会让模型不再并行调工具）
 * 2. 缓存断点必须落在最后一条消息的最后一个内容块上
 */
import { describe, it, expect } from "vitest";
import { toAnthropic, markCacheBreakpoint } from "../src/provider/anthropic.js";
import type { Message } from "../src/provider/types.js";

describe("toAnthropic 消息翻译", () => {
  it("system 抽为独立参数，不进 messages", () => {
    const { system, turns } = toAnthropic([
      { role: "system", content: "你是助手" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("你是助手");
    expect(turns).toHaveLength(1);
  });

  it("assistant 的 toolCalls → tool_use 块，args 解析为对象", () => {
    const { turns } = toAnthropic([
      { role: "assistant", content: "我来看看", toolCalls: [{ id: "t1", name: "grep", args: '{"pattern":"x"}' }] },
    ]);
    const blocks = turns[0].content as any[];
    expect(blocks[0]).toMatchObject({ type: "text", text: "我来看看" });
    expect(blocks[1]).toMatchObject({ type: "tool_use", id: "t1", input: { pattern: "x" } });
  });

  it("连续的 tool 结果合并进一条 user 消息", () => {
    const messages: Message[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "t1", name: "grep", args: "{}" },
        { id: "t2", name: "read_file", args: "{}" },
      ]},
      { role: "tool", toolCallId: "t1", content: "结果1" },
      { role: "tool", toolCallId: "t2", content: "结果2" },
    ];
    const { turns } = toAnthropic(messages);
    expect(turns).toHaveLength(2); // assistant + 一条合并的 user
    const results = turns[1].content as any[];
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
  });

  it("错误的工具结果带 is_error 标记", () => {
    const { turns } = toAnthropic([
      { role: "tool", toolCallId: "t1", content: "[错误] 文件不存在" },
    ]);
    expect((turns[0].content as any[])[0].is_error).toBe(true);
  });
});

describe("markCacheBreakpoint 缓存断点", () => {
  it("字符串内容 → 转成块数组并打断点", () => {
    const turns: any[] = [{ role: "user", content: "hello" }];
    markCacheBreakpoint(turns);
    expect(turns[0].content[0]).toMatchObject({
      type: "text", text: "hello", cache_control: { type: "ephemeral" },
    });
  });

  it("块数组 → 断点落在最后一块", () => {
    const turns: any[] = [{
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "a" }, { type: "tool_result", tool_use_id: "b" }],
    }];
    markCacheBreakpoint(turns);
    expect(turns[0].content[0].cache_control).toBeUndefined();
    expect(turns[0].content[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
