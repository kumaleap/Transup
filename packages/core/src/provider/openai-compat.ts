/**
 * OpenAI 兼容 Provider
 *
 * 覆盖 DeepSeek / Kimi / OpenRouter / vLLM 本地部署等一切
 * 提供 OpenAI Chat Completions 协议的服务。
 *
 * 两个职责：
 *  1. 中立消息 → OpenAI wire format（toOpenAI）
 *  2. 流式碎片 → 归一化事件（tool call 参数分片在这里拼装完再交给引擎）
 */
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Message, Provider, ProviderEvent, StopReason, ToolCall, ToolSpec } from "./types.js";

export interface OpenAICompatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
}

function toOpenAI(messages: Message[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content || null,
          ...(m.toolCalls?.length && {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.args },
            })),
          }),
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

export class OpenAICompatProvider implements Provider {
  readonly id = "openai-compat";
  readonly model: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatOptions) {
    this.model = opts.model;
    // maxRetries: SDK 内置了对 429/5xx 的指数退避重试，调高次数即可，
    // 不要自己重写重试逻辑
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, maxRetries: 4 });
  }

  async *stream(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const apiTools: ChatCompletionTool[] = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: toOpenAI(messages),
        ...(apiTools.length > 0 && { tools: apiTools }),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let content = "";
    const calls: { id: string; name: string; args: string }[] = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let finish: string | null = null;

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      }
      if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      // tool call 参数是逐字符流回来的碎片，按 index 归位拼装
      for (const tc of delta.tool_calls ?? []) {
        calls[tc.index] ??= { id: "", name: "", args: "" };
        if (tc.id) calls[tc.index].id = tc.id;
        if (tc.function?.name) calls[tc.index].name += tc.function.name;
        if (tc.function?.arguments) calls[tc.index].args += tc.function.arguments;
      }
    }

    const toolCalls: ToolCall[] = calls.filter(Boolean).map((c) => ({ ...c }));
    const stopReason: StopReason =
      finish === "length" ? "max_tokens"
      : finish === "tool_calls" ? "tool_use"
      : finish === "stop" ? "end_turn"
      : "other";
    yield { type: "message_done", content, toolCalls, usage, stopReason };
  }
}
