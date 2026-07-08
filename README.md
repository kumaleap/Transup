# Transup

一个开源的 AI coding agent CLI —— provider 无关的架构，任何模型都是一等公民。

## 特性

- **双协议支持**：任何 OpenAI 兼容 API（DeepSeek/Kimi/OpenRouter…）+ Anthropic 原生协议（prompt caching，长会话输入成本降约 90%）
- **完整的 agent 能力**：文件读写（diff 预览确认）、代码搜索、bash 执行（实时流式输出）、子 agent 并行探索
- **上下文工程**：AGENT.md 项目约定 + repo map 注入、LLM 摘要式上下文压缩（compact）
- **MCP 生态**：stdio 传输接入任意 MCP server
- **会话管理**：append-only JSONL 持久化、`--continue`/`--resume` 恢复、Ctrl+C 干净中断
- **权限系统**：只读工具免确认并行执行，写操作逐个确认，规则可持久化

## 快速开始

```bash
npm install
cp .env.example .env   # 填入你的 API key
npm start
```

会话内输入 `/help` 查看命令；`@路径` 可引用文件。

## 架构

```
packages/
├── core/   引擎：agent loop、Provider 抽象、工具系统、compact、会话持久化（零 UI 依赖）
└── cli/    终端界面：REPL、权限确认、渲染
```

开发计划见 [ROADMAP.md](./ROADMAP.md)。

## 开发

```bash
npm test            # vitest 测试套件
npm run typecheck   # tsc --noEmit
```
