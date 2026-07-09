/**
 * @transup/core 公开 API
 *
 * 宿主（CLI / IDE / server）只依赖这里导出的东西。
 */
export { AgentEngine, type AgentEvent, type EngineOptions } from "./agent/engine.js";
export { OpenAICompatProvider, type OpenAICompatOptions } from "./provider/openai-compat.js";
export {
  OpenAIResponsesProvider,
  normalizeResponsesBaseURL,
  type OpenAIResponsesOptions,
} from "./provider/openai-responses.js";
export { AnthropicProvider, type AnthropicOptions } from "./provider/anthropic.js";
export { buildProjectContext } from "./agent/context.js";
export { createTaskTool } from "./agent/subagent.js";
export { connectMcpServer, connectAllMcpServers, type McpServerConfig, type McpConnection } from "./tools/mcp.js";
export { loadSettings, saveSettings, isAllowed, persistAllow, type Settings } from "./settings.js";
export type { Provider, ProviderEvent, Message, StopReason, ToolCall, ToolSpec, Usage } from "./provider/types.js";
export { ToolRegistry, builtinTools } from "./tools/registry.js";
export type { Tool, ToolResult, PermissionFn } from "./tools/types.js";
export { SessionStore } from "./session/store.js";
