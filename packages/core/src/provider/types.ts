/**
 * Provider 抽象层
 *
 * 产品级架构的第一根柱子：引擎内部使用【中立的消息格式】，
 * 每个 Provider 负责把它翻译成自家的 wire format。
 *
 * 为什么不直接用 OpenAI 的类型？因为各家协议有实质差异：
 *   - Anthropic 原生协议的 prompt caching（cache_control 断点）能省 90% 成本，
 *     OpenAI 兼容层吃不到；
 *   - 各家的 tool call 格式、system prompt 位置、流式事件都不同。
 * 想做到"任何模型都是一等公民"，翻译层必须存在。
 *
 * 流式事件的归一化约定：
 *   - text_delta       文本增量，边到边渲染
 *   - message_done     一条 assistant 消息收完，附带装配好的 toolCalls
 * tool call 参数分片的拼装是各家协议的脏活，封装在 Provider 内部，
 * 引擎只见到完整的 ToolCall。
 */

/** 引擎内部的中立消息类型 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolCall {
  id: string;
  name: string;
  /** 未解析的 JSON 字符串 —— 解析和校验是工具管线的职责 */
  args: string;
}

/** 发给 Provider 的工具声明（已经是 JSON Schema，与 zod 解耦） */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 归一化的停止原因 —— 引擎韧性能力的判定依据：
 *   max_tokens 表示输出被长度限制截断（引擎会自动续跑），
 *   其余情况引擎按"模型主动结束"处理。不识别的厂商值归入 other。
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "message_done"; content: string; toolCalls: ToolCall[]; usage?: Usage; stopReason?: StopReason };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic 原生协议专属：缓存命中/写入的 token 数（省钱的直接体现） */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface Provider {
  /** 用于显示和日志 */
  readonly id: string;
  readonly model: string;
  /** 一次模型调用：输入完整对话，流式返回归一化事件。signal 用于用户中断。 */
  stream(messages: Message[], tools: ToolSpec[], signal?: AbortSignal): AsyncIterable<ProviderEvent>;
}
