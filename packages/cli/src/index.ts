/**
 * transup CLI 入口 —— 只做组装：读配置、建 Provider、连 MCP、解析会话，
 * 然后把一切交给 Ink TUI（tui/App.tsx）。所有智能在 @transup/core。
 *
 * 用法：
 *   npm start                     # 新会话
 *   npm start -- --continue      # 恢复最近一次会话
 *   npm start -- --resume <id>   # 恢复指定会话
 */
import "dotenv/config";
import { createElement } from "react";
import { render } from "ink";
import {
  AnthropicProvider,
  OpenAICompatProvider,
  SessionStore,
  buildProjectContext,
  builtinTools,
  createTaskTool,
  connectAllMcpServers,
  loadSettings,
  type Provider,
  type Message,
  type Tool,
} from "@transup/core";
import { color } from "./ui.js";
import { App } from "./tui/App.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}，请在项目根目录创建 .env（参考 .env.example）`);
    process.exit(1);
  }
  return v;
}

function createProvider(): Provider {
  if (process.env.PROVIDER === "anthropic") {
    return new AnthropicProvider({
      apiKey: required("ANTHROPIC_API_KEY"),
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8",
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }
  return new OpenAICompatProvider({
    baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: required("OPENAI_API_KEY"),
    model: process.env.MODEL ?? "gpt-4o",
  });
}

// TUI 需要真实终端（raw mode）；管道/CI 场景明确报错，不要静默错乱
if (!process.stdin.isTTY) {
  console.error("transup 需要交互式终端运行（stdin 不是 TTY）。");
  process.exit(1);
}

// 启动时的会话解析：--continue / --resume <id> / 新会话
async function resolveSession(): Promise<{ id: string; history: Message[] }> {
  const argv = process.argv;
  let id: string | null = null;
  if (argv.includes("--continue")) {
    id = await SessionStore.latestId();
    if (!id) {
      console.error("没有可恢复的会话");
      process.exit(1);
    }
  } else {
    const i = argv.indexOf("--resume");
    if (i !== -1 && argv[i + 1]) id = argv[i + 1];
  }
  if (id) return { id, history: await new SessionStore(id).load() };
  return { id: new Date().toISOString().replace(/[:.]/g, "-"), history: [] };
}

const provider = createProvider();
const projectContext = await buildProjectContext(process.cwd());
const settings = await loadSettings();
const mcp = await connectAllMcpServers(settings.mcpServers ?? {}, (name, err) => {
  console.error(color.red(`MCP server "${name}" 连接失败：${err.message}（已跳过）`));
});
const tools: Tool[] = [...builtinTools, createTaskTool(provider), ...mcp.tools];
const { id, history } = await resolveSession();

const instance = render(
  createElement(App, {
    provider,
    projectContext,
    tools,
    settings,
    initialSessionId: id,
    initialHistory: history,
    mcpToolCount: mcp.tools.length,
  }),
  { exitOnCtrlC: false },
);

await instance.waitUntilExit();
await mcp.close();
process.exit(0);
