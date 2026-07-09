/**
 * transup CLI 入口 —— 只做组装：解析参数、读配置、建 Provider、连 MCP、
 * 解析会话，然后交给对应宿主。所有智能在 @transup/core。
 *
 * 两种宿主形态（同一个引擎的两个消费者）：
 *   交互模式（默认）  Ink TUI（tui/App.tsx），需要真实终端
 *   headless 模式     -p "任务" 非交互执行（headless.ts），适合管道/CI/脚本
 *
 * 用法：
 *   transup                          # 交互式新会话
 *   transup --continue               # 恢复最近一次会话
 *   transup --resume <id>            # 恢复指定会话
 *   transup -p "解释 src/index.ts"   # headless：跑完一轮就退出
 *   transup -p "修掉这个 bug" --allow-all   # headless 且放行写操作（可信环境）
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
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
import { runHeadless } from "./headless.js";

const HELP = `transup — AI coding agent（任何模型都是一等公民）

用法：
  transup                     交互式新会话（Ink TUI）
  transup --continue          恢复最近一次会话
  transup --resume <id>       恢复指定会话
  transup -p "任务"           headless 模式：非交互跑完一轮就退出
                              （stdout 只输出正文，过程信息在 stderr）
  transup -p "任务" --allow-all   headless 且跳过写操作确认（仅可信环境）

  --help      显示本帮助
  --version   显示版本

配置：项目根目录 .env（参考 .env.example），支持 OpenAI 兼容 API 与
Anthropic 原生协议。权限允许清单在 .transup/settings.json。`;

// ── 参数解析（就几个 flag，不值得引参数库） ──────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};

if (flag("--help") || flag("-h")) {
  console.log(HELP);
  process.exit(0);
}
const VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
).version;

if (flag("--version") || flag("-v")) {
  console.log(`transup ${VERSION}`);
  process.exit(0);
}

const headlessPrompt = value("-p") ?? value("--print");
if ((flag("-p") || flag("--print")) && !headlessPrompt) {
  console.error('-p 需要跟任务内容，例如：transup -p "解释这个项目的结构"');
  process.exit(1);
}

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

// 交互模式需要真实终端（raw mode）；headless 模式不需要
if (!headlessPrompt && !process.stdin.isTTY) {
  console.error('transup 交互模式需要终端运行。管道/CI 场景请用 headless 模式：transup -p "任务"');
  process.exit(1);
}

// 启动时的会话解析：--continue / --resume <id> / 新会话
async function resolveSession(): Promise<{ id: string; history: Message[] }> {
  let id: string | null = null;
  if (flag("--continue")) {
    id = await SessionStore.latestId();
    if (!id) {
      console.error("没有可恢复的会话");
      process.exit(1);
    }
  } else {
    id = value("--resume");
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

if (headlessPrompt) {
  // ── headless：跑一轮，退出码回传 ────────────────────────
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const code = await runHeadless({
    provider,
    tools,
    settings,
    projectContext,
    sessionId: id,
    history,
    prompt: headlessPrompt,
    allowAll: flag("--allow-all"),
    signal: controller.signal,
  });
  await mcp.close();
  process.exit(code);
}

// ── 交互：Ink TUI ───────────────────────────────────────────
const instance = render(
  createElement(App, {
    provider,
    projectContext,
    tools,
    settings,
    initialSessionId: id,
    initialHistory: history,
    mcpToolCount: mcp.tools.length,
    version: VERSION,
  }),
  { exitOnCtrlC: false },
);

await instance.waitUntilExit();
await mcp.close();
process.exit(0);
