import { describe, expect, it } from "vitest";
import {
  OpenAIResponsesProvider,
  normalizeResponsesBaseURL,
  toResponsesInput,
  toResponsesTools,
} from "../src/provider/openai-responses.js";
import type { Message } from "../src/provider/types.js";

describe("OpenAI Responses 协议翻译", () => {
  it("裸域名 base URL 自动补 /v1，显式路径保持不变", () => {
    expect(normalizeResponsesBaseURL("https://sub2api.transup.ai")).toBe("https://sub2api.transup.ai/v1");
    expect(normalizeResponsesBaseURL("https://sub2api.transup.ai/")).toBe("https://sub2api.transup.ai/v1");
    expect(normalizeResponsesBaseURL("https://sub2api.transup.ai/v1")).toBe("https://sub2api.transup.ai/v1");
    expect(normalizeResponsesBaseURL("https://proxy.example/openai")).toBe("https://proxy.example/openai");
  });

  it("system 抽为 instructions，其余历史转为 Responses input items", () => {
    const messages: Message[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "我来查", toolCalls: [{ id: "call_1", name: "read_file", args: '{"path":"README.md"}' }] },
      { role: "tool", toolCallId: "call_1", content: "README content" },
    ];

    const { instructions, input } = toResponsesInput(messages);

    expect(instructions).toBe("你是助手");
    expect(input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "message",
        role: "assistant",
        content: "我来查",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "README content" },
    ]);
  });

  it("工具声明转为 Responses function tools", () => {
    expect(toResponsesTools([
      { name: "grep", description: "Search text", parameters: { type: "object", properties: {} } },
    ])).toEqual([
      {
        type: "function",
        name: "grep",
        description: "Search text",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  });

  it("流式事件拼装文本、工具调用、usage 和 stopReason", async () => {
    async function* fakeStream() {
      yield { type: "response.output_text.delta", delta: "hello" };
      yield { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 1, delta: '{"cmd":' };
      yield { type: "response.function_call_arguments.delta", item_id: "item_1", output_index: 1, delta: '"pwd"}' };
      yield {
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"pwd"}' },
      };
      yield {
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 5 },
          status: "completed",
          incomplete_details: null,
        },
      };
    }

    const provider = new OpenAIResponsesProvider({
      baseURL: "https://example.test",
      apiKey: "sk-test",
      model: "gpt-test",
      client: {
        responses: {
          create: async () => fakeStream(),
        },
      },
    });

    const events = [];
    for await (const event of provider.stream([{ role: "user", content: "hi" }], [{ name: "bash", description: "Run", parameters: {} }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "message_done",
        content: "hello",
        toolCalls: [{ id: "call_1", name: "bash", args: '{"cmd":"pwd"}' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
    ]);
  });
});
