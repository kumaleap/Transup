/**
 * OpenAI Responses Provider
 *
 * 覆盖需要 Responses wire API 的 OpenAI / 代理网关。它和 openai-compat
 * 并列存在：前者走 /responses，后者继续走 /chat/completions。
 */
import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseStreamEvent,
  Tool,
} from "openai/resources/responses/responses";
import type { Message, Provider, ProviderEvent, StopReason, ToolCall, ToolSpec, Usage } from "./types.js";

export interface OpenAIResponsesOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  store?: boolean;
  maxOutputTokens?: number;
  client?: ResponsesClient;
}

interface ResponsesClient {
  responses: {
    create(
      body: ResponseCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<ResponseStreamEventLike>>;
  };
}

type ResponseStreamEventLike = Partial<ResponseStreamEvent> & {
  type: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  name?: string;
  arguments?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: Partial<Response>;
};

export function toResponsesInput(messages: Message[]): { instructions?: string; input: ResponseInput } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const input: ResponseInput = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: message.content }],
        });
        break;
      case "assistant":
        if (message.content) {
          input.push({ type: "message", role: "assistant", content: message.content });
        }
        for (const toolCall of message.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.args,
          });
        }
        break;
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
        break;
    }
  }

  return {
    ...(system && { instructions: system }),
    input,
  };
}

export function toResponsesTools(tools: ToolSpec[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

export class OpenAIResponsesProvider implements Provider {
  readonly id = "openai-responses";
  readonly model: string;
  private readonly client: ResponsesClient;
  private readonly reasoningEffort?: ReasoningEffort;
  private readonly store?: boolean;
  private readonly maxOutputTokens?: number;

  constructor(opts: OpenAIResponsesOptions) {
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.store = opts.store;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.client = opts.client ?? (new OpenAI({
      baseURL: normalizeResponsesBaseURL(opts.baseURL),
      apiKey: opts.apiKey,
      maxRetries: 4,
    }) as unknown as ResponsesClient);
  }

  async *stream(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const { instructions, input } = toResponsesInput(messages);
    const apiTools = toResponsesTools(tools);
    const stream = await this.client.responses.create(
      {
        model: this.model,
        input,
        ...(instructions && { instructions }),
        ...(apiTools.length > 0 && { tools: apiTools as Tool[] }),
        ...(this.reasoningEffort && { reasoning: { effort: this.reasoningEffort } }),
        ...(this.store !== undefined && { store: this.store }),
        ...(this.maxOutputTokens !== undefined && { max_output_tokens: this.maxOutputTokens }),
        parallel_tool_calls: true,
        stream: true,
      },
      { signal },
    );

    let content = "";
    const calls = new Map<number | string, { id: string; name: string; args: string }>();
    let usage: Usage | undefined;
    let completedResponse: Partial<Response> | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) {
            content += event.delta;
            yield { type: "text_delta", text: event.delta };
          }
          break;
        case "response.function_call_arguments.delta":
          rememberCallDelta(calls, event);
          break;
        case "response.function_call_arguments.done":
          rememberCallDone(calls, event);
          break;
        case "response.output_item.done":
          rememberOutputItem(calls, event.item, event.output_index);
          break;
        case "response.completed":
        case "response.incomplete":
          completedResponse = event.response;
          usage = usageFromResponse(event.response);
          break;
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((call) => call.id && call.name)
      .map((call) => ({ id: call.id, name: call.name, args: call.args }));

    yield {
      type: "message_done",
      content,
      toolCalls,
      usage,
      stopReason: stopReasonFromResponse(completedResponse, toolCalls),
    };
  }
}

export function normalizeResponsesBaseURL(baseURL: string): string {
  try {
    const url = new URL(baseURL);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
    return baseURL.replace(/\/$/, "");
  } catch {
    return baseURL.replace(/\/$/, "");
  }
}

function rememberCallDelta(
  calls: Map<number | string, { id: string; name: string; args: string }>,
  event: ResponseStreamEventLike,
) {
  const key = callKey(event);
  const call = calls.get(key) ?? { id: "", name: "", args: "" };
  if (event.delta) call.args += event.delta;
  calls.set(key, call);
}

function rememberCallDone(
  calls: Map<number | string, { id: string; name: string; args: string }>,
  event: ResponseStreamEventLike,
) {
  const key = callKey(event);
  const call = calls.get(key) ?? { id: "", name: "", args: "" };
  if (typeof event.item_id === "string") call.id ||= event.item_id;
  if (typeof event.item?.name === "string") call.name = event.item.name;
  if (typeof event.name === "string") call.name = event.name;
  if (typeof event.arguments === "string") call.args = event.arguments;
  calls.set(key, call);
}

function rememberOutputItem(
  calls: Map<number | string, { id: string; name: string; args: string }>,
  item: ResponseStreamEventLike["item"],
  outputIndex?: number,
) {
  if (item?.type !== "function_call") return;
  const key = outputIndex ?? item.call_id ?? calls.size;
  const call = calls.get(key) ?? { id: "", name: "", args: "" };
  if (item.call_id) call.id = item.call_id;
  if (item.name) call.name = item.name;
  if (item.arguments) call.args = item.arguments;
  calls.set(key, call);
}

function callKey(event: ResponseStreamEventLike): number | string {
  return event.output_index ?? event.item_id ?? 0;
}

function usageFromResponse(response: Partial<Response> | undefined): Usage | undefined {
  if (!response?.usage) return undefined;
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.input_tokens_details?.cached_tokens,
  };
}

function stopReasonFromResponse(response: Partial<Response> | undefined, toolCalls: ToolCall[]): StopReason {
  if (toolCalls.length > 0) return "tool_use";
  if (response?.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") {
    return "max_tokens";
  }
  if (response?.status === "completed" || !response?.status) return "end_turn";
  return "other";
}
