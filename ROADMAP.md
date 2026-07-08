# mycode 开发计划

> 目标：开源 AI coding agent CLI，对标 Claude Code / Codex CLI 的行业顶尖水平。
> 差异化定位：**任何模型都是一等公民** —— provider 无关的架构下做到与官方工具同级的体验。

## 里程碑总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | 产品级架构骨架 | ✅ 完成 |
| M1 | 健壮性与测试 | ✅ 完成 |
| M2 | 交互体验 | ✅ 代码完成（待实测验收） |
| M3 | 多 agent 与生态（MCP） | ✅ 代码完成（待实测验收） |
| M4 | TUI 升级（Ink） | ⬜ |
| M5 | 打包发布与 CI | ⬜ |
| M6 | 安全与高级上下文 | ⬜ |

---

## M0 架构骨架 ✅

- [x] monorepo 分包：`@mycode/core`（引擎，零 UI 依赖）+ `@mycode/cli`（渲染层）
- [x] Provider 抽象：中立消息类型；OpenAI 兼容 + Anthropic 原生（prompt caching 双断点）
- [x] 事件化 agent loop（AsyncGenerator，支撑未来 IDE/headless/server 形态）
- [x] 工具协议（zod schema + readOnly 声明 + fail-closed）与执行管线（校验→权限→执行→错误回流）
- [x] 6 个内建工具：read_file / list_dir / grep / write_file / edit_file / bash
- [x] 会话持久化（append-only JSONL）+ `--continue` 恢复
- [x] 上下文压缩 compact（LLM 摘要 + 最近文件重注入，失败退回截断）
- [x] 并行工具执行（只读并发、写串行）
- [x] AGENT.md/CLAUDE.md 项目约定 + repo map 注入

## M1 健壮性与测试 ✅

- [x] vitest 测试套件（24 用例：引擎循环 / 工具管线 / 协议翻译 / 持久化）
- [x] API 重试退避（SDK maxRetries=4）
- [x] 任务中断（Ctrl+C → AbortSignal，transcript 一致性保证）
- [ ] **真实 API 端到端实测**（⚠ 需要用户的 key，M2 结束前必须完成）

## M2 交互体验 ✅（代码完成，待真实 API 实测验收）

日常使用顺不顺手的分水岭。

- [x] 斜杠命令：`/help` `/clear`（新会话）`/compact`（手动压缩）`/cost`（累计用量）`/context`
- [x] `@文件` 引用：输入里的 `@path/to/file` 自动展开为文件内容（不误伤邮箱、目录不展开、超大截断）
- [x] diff 预览确认：edit_file 显示红删绿增，write_file 区分新建/覆盖并警告
- [x] bash 输出实时流式显示（spawn + onProgress 通道 + 引擎队列桥接）
- [x] 会话列表与选择恢复：`--resume <id>` / `/sessions`

## M3 多 agent 与生态 ✅（代码完成，待实测验收）

- [x] 子 agent（task 工具）：复用 AgentEngine 派生只读探索型子任务，上下文隔离、禁递归、可并行
- [x] MCP 客户端：stdio 传输接入外部 MCP server，工具以 `mcp__server__tool` 命名合入注册表（含真实 server 集成测试）
- [x] 权限策略配置文件：`.mycode/settings.json` 持久化 allow 规则（`[A]永久允许` + `mcp__x__*` 通配）

## M4 TUI 升级

- [ ] Ink（React for CLI）替换 readline：输入框常驻底部、流式输出滚动区、工具调用折叠展示
- [ ] 语法高亮（代码块、diff）
- [ ] 状态栏：模型 / token 用量 / 上下文水位

## M5 打包发布与 CI

- [ ] tsup 构建产物，`npx mycode` 可直接运行；bin 入口与版本管理
- [ ] GitHub Actions：typecheck + test + 发布流水线
- [ ] README（英文为主）、贡献指南、许可证（MIT）
- [ ] 迁出到独立开源仓库

## M6 安全与高级上下文

- [ ] bash 沙箱：macOS Seatbelt / Linux Landlock，网络与文件系统隔离
- [ ] repo map 升级：tree-sitter 提取符号签名（aider 式代码地图）
- [ ] 会话内记忆：模型可写入项目笔记，跨会话复用
- [ ] compact 熔断与质量优化：连续失败停发、复用主对话 prompt cache

---

## 工作约定

- 每个功能：实现 → `npm test` + `npm run typecheck` 通过 → 更新本文件勾选
- 破坏性架构变更需先在本文件记录理由
- M2 结束 = 第一个"自己天天用"的版本（dogfooding 开始）
