/**
 * Anthropic 原生 Provider —— 吃到 prompt caching 的关键
 *
 * 为什么不直接用 OpenAI 兼容层接 Claude？因为原生协议有两样东西兼容层没有：
 *
 * 1. Prompt caching（本文件的核心价值）：
 *    缓存是"前缀匹配"——在内容块上打 cache_control 断点，断点之前的
 *    字节序列命中缓存时只收 0.1 倍价格（写入 1.25 倍）。agent 每轮都
 *    重发全部历史，所以长会话中 90%+ 的输入 token 都能走缓存。
 *    我们放两个断点：
 *      a) system 最后一块（缓存 system prompt + 工具声明）
 *      b) 最后一条消息的最后一块（缓存整个对话历史，逐轮递增命中）
 *
 * 2. 消息结构差异：
 *    - system 是独立参数，不在 messages 里
 *    - 工具结果是 user 消息里的 tool_result 内容块（不是独立 role）
 *    - 连续的 tool 结果必须合并进【一条】user 消息
 *    - tool_use 的 input 是解析后的对象（OpenAI 是 JSON 字符串）
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlockParam,
  Tool as AnthropicTool,
  ToolUnion,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import type { Message, Provider, ProviderEvent, ToolCall, ToolSpec } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
}

/** 中立消息 → Anthropic wire format。返回 system 文本与 messages 数组。（导出供测试） */
export function toAnthropic(messages: Message[]): { system: string; turns: MessageParam[] } {
  let system = "";
  const turns: MessageParam[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        system = m.content;
        break;

      case "user":
        turns.push({ role: "user", content: m.content });
        break;

      case "assistant": {
        const blocks: ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls ?? []) {
          let input: unknown = {};
          try { input = JSON.parse(tc.args || "{}"); } catch {}
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        turns.push({ role: "assistant", content: blocks });
        break;
      }

      case "tool": {
        const block: ContentBlockParam = {
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: m.content,
          is_error: m.content.startsWith("[错误]") || undefined,
        };
        // 关键约定：同一批工具的结果必须在一条 user 消息里 ——
        // 分开发会让模型学会不再并行调用工具
        const last = turns.at(-1);
        if (last?.role === "user" && Array.isArray(last.content)) {
          last.content.push(block);
        } else {
          turns.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }
  return { system, turns };
}

/** 在最后一条消息的最后一个内容块上打缓存断点（对话历史逐轮递增命中）（导出供测试） */
export function markCacheBreakpoint(turns: MessageParam[]): void {
  const last = turns.at(-1);
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    (last.content.at(-1) as { cache_control?: object }).cache_control = { type: "ephemeral" };
  }
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 16000;
    // maxRetries: SDK 内置了对 429/5xx 的指数退避重试
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 4 });
  }

  async *stream(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const { system, turns } = toAnthropic(messages);
    markCacheBreakpoint(turns);

    // system 用块数组形式，尾部打断点 → system + 工具声明一起被缓存。
    // 注意：工具集必须保持稳定（顺序、内容），任何变化都会击穿全部缓存。
    const systemBlocks: TextBlockParam[] = [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ];

    const apiTools: ToolUnion[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as AnthropicTool["input_schema"],
    }));

    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemBlocks,
        messages: turns,
        ...(apiTools.length > 0 && { tools: apiTools }),
      },
      { signal },
    );

    // 拼装状态：Anthropic 流按内容块组织，tool_use 的参数以
    // input_json_delta 分片流回，需要按块索引累积
    let content = "";
    const toolCalls: ToolCall[] = [];
    const pending = new Map<number, { id: string; name: string; args: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            pending.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: "",
            });
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            content += event.delta.text;
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const p = pending.get(event.index);
            if (p) p.args += event.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          const p = pending.get(event.index);
          if (p) {
            toolCalls.push({ id: p.id, name: p.name, args: p.args || "{}" });
            pending.delete(event.index);
          }
          break;
        }
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: "message_done",
      content,
      toolCalls,
      usage: {
        // cache_read 是省下的钱的直接体现 —— UI 里展示它，能看到缓存是否生效
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
