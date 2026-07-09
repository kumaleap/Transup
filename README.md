# Transup

An open-source AI coding agent for your terminal — built for one thing: **a polished, top-tier agent experience, whatever model you run**.

Transup speaks OpenAI-compatible Chat Completions (DeepSeek, Kimi, OpenRouter, vLLM, …), OpenAI Responses API, and the native Anthropic protocol (with prompt caching that cuts long-session input cost by ~90%), on top of a provider-agnostic engine.

[中文说明](#中文) · [Roadmap](./ROADMAP.md)

## Features

- **Full agent loop** — file read/write with diff-preview confirmation, code search, streaming bash execution, parallel read-only tool calls, sub-agents for context-isolated exploration
- **Runtime resilience** — stream retry with backoff, auto-continue on `max_tokens` truncation, empty-reply nudging, loop detection with circuit breaker: long tasks don't stall
- **Context engineering** — `AGENT.md` project conventions + repo map injection, LLM-summarized context compaction that re-injects your recent working files
- **Two hosts, one engine** — interactive Ink TUI and headless mode (`-p`) for pipes, CI, and scripting; the zero-UI core is embeddable anywhere
- **MCP ecosystem** — connect any MCP server over stdio; tools are namespaced `mcp__server__tool`
- **Sessions** — append-only JSONL persistence, `--continue` / `--resume <id>`, clean Ctrl+C interruption
- **Permission system** — read-only tools run without confirmation; writes are confirmed one by one, with persistable allow rules (`.transup/settings.json`)
- **Dogfooding diagnostics** — local `doctor` checks plus append-only event traces under `.transup/traces`, replayable as a human-readable timeline

## Quick start

```bash
npx transup            # once published to npm (v0.1.0 pending)
```

From source:

```bash
npm install
npm start              # interactive TUI; first run guides you through .env setup
```

Inside a session, type `/help` for commands; reference files with `@path/to/file`.

### Headless mode

```bash
npm run build
node packages/cli/dist/index.js -p "explain the structure of this project"
```

Model prose goes to **stdout**, tool activity to **stderr** — pipe-friendly. Writes are denied by default (fail-closed); allow them via `.transup/settings.json` or `--allow-all` in trusted environments. Exit code is `0` on clean completion, `1` on interruption/stall.

### Diagnostics and replay

```bash
npm run build
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js replay .transup/traces/<session-id>.jsonl
npm run dogfood
```

Every interactive/headless turn records normalized agent events to `.transup/traces/<session-id>.jsonl`. `doctor` checks local runtime/configuration basics without requiring a successful model call, `replay` renders a trace as a deterministic timeline, and `npm run dogfood` validates committed trace fixtures under `fixtures/dogfood`.

### Configuration

Interactive first run writes `.env` for you. You can also create it manually:

```bash
# .env — OpenAI-compatible (default)
PROVIDER=openai
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_API_KEY=sk-...
MODEL=deepseek-chat

# OpenAI Responses API / proxy gateways that require wire_api=responses
PROVIDER=openai-responses
OPENAI_WIRE_API=responses
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
MODEL=gpt-5.1
MODEL_REASONING_EFFORT=xhigh
DISABLE_RESPONSE_STORAGE=true

# or native Anthropic (recommended: prompt caching)
PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-8
```

## Architecture

```
packages/
├── core/   engine: agent loop, provider abstraction, tool pipeline,
│           compaction, loop guard, sessions — zero UI dependencies
└── cli/    hosts: Ink TUI + headless runner, permission prompts, rendering
```

The engine is an `AsyncGenerator` of events; hosts (TUI, headless, future IDE/server) are just consumers. See [ROADMAP.md](./ROADMAP.md) for milestones.

## Development

```bash
npm test            # vitest suite (incl. resilience regression tests)
npm run typecheck   # tsc --noEmit
npm run build       # tsup → packages/cli/dist
```

## License

[MIT](./LICENSE)

---

## 中文

开源 AI coding agent CLI —— 目标只有一个：**做极致体验的编程 agent**，任何模型上都好用。

- **多协议**：OpenAI Chat Completions 兼容 API（DeepSeek/Kimi/OpenRouter…）+ OpenAI Responses API + Anthropic 原生协议（prompt caching 省 ~90% 长会话输入成本）
- **运行时韧性**：断流重试、截断续跑、空回复催跑、循环熔断 —— 长任务不断档
- **双宿主**：交互式 Ink TUI + headless 模式（`-p`，管道/CI/脚本友好）
- **自举诊断**：`doctor` 本地配置检查 + `.transup/traces` 事件追踪 + `replay` 时间线复盘
- **完整能力**：diff 预览确认、流式 bash、子 agent、MCP、compact、会话恢复、权限持久化

```bash
npm install && npm start
```
