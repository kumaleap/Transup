/**
 * mycode CLI 入口
 *
 * 职责：读配置、组装 Provider 和引擎、实现权限回调（含 diff 预览）、
 * 斜杠命令、REPL 渲染。所有智能都在 @mycode/core。
 *
 * 用法：
 *   npm start                     # 新会话
 *   npm start -- --continue       # 恢复最近一次会话
 *   npm start -- --resume <id>    # 恢复指定会话
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import {
  AgentEngine,
  AnthropicProvider,
  OpenAICompatProvider,
  SessionStore,
  buildProjectContext,
  builtinTools,
  createTaskTool,
  connectAllMcpServers,
  loadSettings,
  isAllowed,
  persistAllow,
  type Provider,
  type Message,
  type Tool,
} from "@mycode/core";
import { color, printToolCall, printToolResult } from "./ui.js";
import { renderEditPreview, renderWritePreview } from "./diff.js";
import { expandFileRefs } from "./input.js";

// ── 配置与 Provider 选择 ────────────────────────────────────
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

const provider = createProvider();
const projectContext = await buildProjectContext(process.cwd());

// ── 设置：持久化权限 + MCP server 配置 ──────────────────────
const settings = await loadSettings();
const mcp = await connectAllMcpServers(settings.mcpServers ?? {}, (name, err) => {
  console.error(color.red(`MCP server "${name}" 连接失败：${err.message}（已跳过）`));
});
if (mcp.tools.length > 0) {
  console.log(color.dim(`已接入 ${mcp.tools.length} 个 MCP 工具`));
}

// 主引擎工具集：内建 + 子 agent（task）+ MCP
const allTools: Tool[] = [...builtinTools, createTaskTool(provider), ...mcp.tools];

// ── 权限回调：文件修改显示 diff，其余显示参数 ───────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const sessionAllowed = new Set<string>();

async function canUseTool(name: string, args: Record<string, unknown>): Promise<boolean> {
  if (sessionAllowed.has(name)) return true;
  if (isAllowed(settings, name)) return true; // .mycode/settings.json 里的持久规则

  console.log(color.yellow(`\n⚠ 模型请求执行 ${color.bold(name)}:`));
  if (name === "edit_file") {
    console.log(renderEditPreview(args));
  } else if (name === "write_file") {
    console.log(renderWritePreview(args));
  } else {
    console.log(color.dim(JSON.stringify(args, null, 2)));
  }

  const answer = await rl.question(
    color.yellow("允许吗? [y]是 / [n]否 / [a]本会话允许 / [A]永久允许(写入设置): "),
  );
  const a = answer.trim();
  if (a === "A") {
    await persistAllow(settings, name);
    return true;
  }
  if (a.toLowerCase() === "a") {
    sessionAllowed.add(name);
    return true;
  }
  return a.toLowerCase() === "y" || a.toLowerCase() === "yes";
}

// ── 引擎组装（/clear 需要重建，抽成函数）────────────────────
function newSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function createEngine(sessionId: string, history: Message[]): AgentEngine {
  return new AgentEngine({
    provider,
    canUseTool,
    session: new SessionStore(sessionId),
    history,
    projectContext,
    tools: allTools,
  });
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
  return { id: newSessionId(), history: [] };
}

let { id: sessionId, history } = await resolveSession();
let engine = createEngine(sessionId, history);

// 累计用量（/cost 用）
const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── 斜杠命令 ────────────────────────────────────────────────
const HELP = `
命令：
  /help          显示本帮助
  /clear         开始新会话（当前会话已持久化，可用 /sessions 找回）
  /compact       手动压缩上下文
  /cost          本次运行累计 token 用量
  /context       当前上下文水位
  /sessions      列出历史会话（用 --resume <id> 恢复）
  exit / quit    退出
输入技巧：
  @路径          引用文件，内容自动附加到消息（如 "解释 @src/index.ts"）
  Ctrl+C         任务运行中按一次中断任务，再按一次退出
`;

/** 返回 true 表示已处理（不进入 agent loop） */
async function handleSlashCommand(input: string): Promise<boolean> {
  const cmd = input.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      console.log(color.dim(HELP));
      return true;

    case "/clear":
      sessionId = newSessionId();
      engine = createEngine(sessionId, []);
      console.log(color.green(`已开始新会话 ${sessionId}`));
      return true;

    case "/compact": {
      for await (const ev of engine.compactNow()) {
        if (ev.type === "compact_end") {
          console.log(
            ev.ok
              ? color.green(`压缩完成（${Math.round(ev.afterChars / 1000)}k 字符）`)
              : color.red("压缩失败"),
          );
        }
      }
      return true;
    }

    case "/cost": {
      const cache =
        total.cacheRead > 0 || total.cacheWrite > 0
          ? `\n  缓存命中 ${total.cacheRead} / 写入 ${total.cacheWrite}`
          : "";
      console.log(color.dim(`累计 tokens：输入 ${total.input} / 输出 ${total.output}${cache}`));
      return true;
    }

    case "/context": {
      const { chars, percent } = engine.contextUsage();
      console.log(color.dim(`上下文：${Math.round(chars / 1000)}k 字符（预算的 ${percent}%）`));
      return true;
    }

    case "/sessions": {
      const ids = await SessionStore.list();
      if (ids.length === 0) {
        console.log(color.dim("暂无历史会话"));
      } else {
        for (const id of ids.slice(0, 10)) {
          console.log(color.dim(`  ${id === sessionId ? "▸" : " "} ${id}`));
        }
        console.log(color.dim(`恢复方式：npm start -- --resume <id>`));
      }
      return true;
    }

    default:
      if (cmd.startsWith("/")) {
        console.log(color.red(`未知命令 ${cmd}，输入 /help 查看可用命令`));
        return true;
      }
      return false;
  }
}

// ── REPL ────────────────────────────────────────────────────
console.log(
  color.bold(color.cyan("\n✻ mycode")) +
  color.dim(` — ${provider.id}:${provider.model} · 会话 ${sessionId}`),
);
if (history.length > 0) console.log(color.dim(`已恢复 ${history.length} 条历史消息`));
console.log(color.dim("输入你的任务，/help 查看命令\n"));

while (true) {
  const raw = (await rl.question(color.cyan("❯ "))).trim();
  if (!raw) continue;
  if (raw === "exit" || raw === "quit") break;
  if (await handleSlashCommand(raw)) continue;

  const input = expandFileRefs(raw);

  const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // 任务运行中按 Ctrl+C：第一次中断当前任务，第二次退出进程
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.log(color.yellow("\n⚠ 正在中断当前任务…（再按一次 Ctrl+C 退出）"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  let sawProgress = false;
  try {
    for await (const ev of engine.runTurn(input, controller.signal)) {
      switch (ev.type) {
        case "text_delta":
          process.stdout.write(ev.text);
          break;
        case "tool_start":
          process.stdout.write("\n");
          printToolCall(ev.call.name, ev.parsedArgs);
          sawProgress = false;
          break;
        case "tool_progress":
          // 长命令（bash）的实时输出，缩进变暗显示
          process.stdout.write(color.dim(ev.chunk.replace(/^/gm, "  │ ")));
          sawProgress = true;
          break;
        case "tool_end":
          // 已经流式显示过输出的，不再重复打印结果预览
          if (!sawProgress || ev.isError) printToolResult(ev.content, ev.isError);
          break;
        case "usage":
          turnUsage.input += ev.usage.inputTokens;
          turnUsage.output += ev.usage.outputTokens;
          turnUsage.cacheRead += ev.usage.cacheReadTokens ?? 0;
          turnUsage.cacheWrite += ev.usage.cacheWriteTokens ?? 0;
          break;
        case "compact_start":
          console.log(color.yellow(`\n⟳ 上下文接近上限，正在压缩…`));
          break;
        case "compact_end":
          console.log(
            ev.ok
              ? color.green(`⟳ 压缩完成（${Math.round(ev.afterChars / 1000)}k 字符）`)
              : color.red(`⟳ 压缩失败，已退回截断策略`),
          );
          break;
        case "turn_end":
          if (ev.reason === "max_iterations") {
            console.log(color.red("\n已达到单轮最大迭代次数，强制停止。"));
          } else if (ev.reason === "aborted") {
            console.log(color.yellow("\n任务已中断。"));
          }
          break;
      }
    }
    total.input += turnUsage.input;
    total.output += turnUsage.output;
    total.cacheRead += turnUsage.cacheRead;
    total.cacheWrite += turnUsage.cacheWrite;

    const cache =
      turnUsage.cacheRead > 0 || turnUsage.cacheWrite > 0
        ? ` · 缓存命中 ${turnUsage.cacheRead} / 写入 ${turnUsage.cacheWrite}`
        : "";
    console.log(color.dim(`\n(本轮 tokens: 输入 ${turnUsage.input} / 输出 ${turnUsage.output}${cache})`));
  } catch (err: any) {
    console.error(color.red(`\nAPI 错误: ${err.message}`));
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  console.log();
}

rl.close();
await mcp.close();
