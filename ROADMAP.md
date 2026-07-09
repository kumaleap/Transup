# Transup 开发计划

> 目标：开源 AI coding agent CLI，对标 Claude Code / Codex CLI 的行业顶尖水平。
> 差异化定位：**任何模型都是一等公民** —— provider 无关的架构下做到与官方工具同级的体验。

## 里程碑总览

| 阶段 | 主题 | 状态 |
|---|---|---|
| M0 | 产品级架构骨架 | ✅ 完成 |
| M1 | 健壮性与测试 | ✅ 完成 |
| M2 | 交互体验 | ✅ 代码完成（待实测验收） |
| M3 | 多 agent 与生态（MCP） | ✅ 代码完成（待实测验收） |
| M4 | TUI 升级（Ink） | ✅ 代码完成（待实测验收） |
| M4.5 | 运行时韧性与回归护栏 | ✅ 完成 |
| M5 | 打包发布与 CI | 🔶 代码完成（迁独立仓库待定） |
| M6 | 安全与高级上下文 | ⬜ |

---

## M0 架构骨架 ✅

- [x] monorepo 分包：`@transup/core`（引擎，零 UI 依赖）+ `@transup/cli`（渲染层）
- [x] Provider 抽象：中立消息类型；OpenAI 兼容 + Anthropic 原生（prompt caching 双断点）
- [x] 事件化 agent loop（AsyncGenerator，支撑未来 IDE/headless/server 形态）
- [x] 工具协议（zod schema + readOnly 声明 + fail-closed）与执行管线（校验→权限→执行→错误回流）
- [x] 6 个内建工具：read_file / list_dir / grep / write_file / edit_file / bash
- [x] 会话持久化（append-only JSONL）+ `--continue` 恢复
- [x] 上下文压缩 compact（LLM 摘要 + 最近文件重注入，失败退回截断）
- [x] 并行工具执行（只读并发、写串行）
- [x] AGENT.md/CLAUDE.md 项目约定 + repo map 注入

## M1 健壮性与测试 ✅

- [x] vitest 测试套件（当前 59 用例：引擎循环 / 工具管线 / 协议翻译 / 持久化 / TUI / 高亮，随功能持续增长）
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
- [x] 权限策略配置文件：`.transup/settings.json` 持久化 allow 规则（`[A]永久允许` + `mcp__x__*` 通配）

## M4 TUI 升级 ✅（代码完成，待真实终端实测）

- [x] Ink（React for CLI）替换 readline：输入框常驻底部（`tui/TextInput`，含输入历史 ↑/↓）、流式输出滚动区（`<Static>` transcript + 动态区）、工具运行实时尾巴；旧 readline REPL 已移除，`index.ts` 只做组装
- [x] 语法高亮（`highlight.ts`：markdown 代码块 + diff 染色）
- [x] 状态栏：模型 / token 用量 / 缓存命中 / 上下文水位（`tui/StatusBar`）
- [x] 权限对话框组件化（`tui/PermissionDialog`：y/n/会话内/永久 四档）
- [x] TUI 冒烟测试（ink-testing-library + mock provider；修复 TextInput 同 tick 连续按键读到旧 state 吞提交的 bug）

## M4.5 运行时韧性与回归护栏 ✅（源自 docs/TODO-功能补齐.md）

长任务不断档是现代 harness 的分水岭，优先级高于打包发布。

- [x] 前置重构：engine.ts 拆分为 `compact.ts`（压缩计算）/ `tool-runner.ts`（批执行调度）/ `guard.ts`（循环保护），引擎只剩主循环编排
- [x] 协议补 `stopReason`：中立事件归一化 end_turn / tool_use / max_tokens / other，两个 provider 各自映射（截断续跑的判定依据）
- [x] 流式重试：模型调用中途断流/瞬时错误 → 指数退避重试（SDK maxRetries 只覆盖请求建立阶段，流开始后断开由引擎兜底）；4xx 不重试、退避可被 Ctrl+C 打断、重试不消耗迭代预算
- [x] 截断续跑：输出被 max_tokens 拦腰砍断 → 自动催模型"从断处继续"
- [x] 空回复催跑：模型交白卷 → 推一把而不是无声结束（与截断续跑共享每轮 3 次上限，杜绝失控自我对话）
- [x] 循环熔断：以【工具名+参数+结果】为签名检测空转，第 3 次起在结果里警告模型，第 5 次强制停轮（`turn_end: loop_detected`）；结果参与签名，"改代码后重跑测试"类正常重复不误伤
- [x] 中断恢复质量：`--resume` 恢复会话时从历史重建"最近读过的文件"清单，恢复后首次 compact 依然能重注入工作台
- [x] 回归套件：`test/resilience.test.ts` 11 个用例固化断流重试 / 4xx 快速失败 / 退避中中断 / 截断续跑 / 催跑上限 / 熔断与不误伤 / 恢复后重注入
- [ ] 意图级断档检测（模型说"接下来我会…"却不调工具）：启发式风险高，推迟到有真实 API 使用数据后再做

## M5 打包发布与 CI 🔶（代码完成，迁独立仓库待定）

- [x] tsup 构建产物：`packages/cli/dist/index.js`（ESM + shebang），bin 指向 dist；core 以源码内联打进 bundle（独立发包等迁仓库时再拆），`--help` / `--version` 齐备
- [x] headless 模式入口：`transup -p "任务"` 非交互执行 —— stdout 只有正文、stderr 只有过程信息（管道友好）；权限 fail-closed（settings 允许清单或 `--allow-all` 才放行写操作）；退出码 0/1；core 多宿主承诺的第一个非终端消费者
- [x] GitHub Actions：push/PR 跑 typecheck + test + build + 产物冒烟
- [x] README（英文为主，附中文摘要）、CONTRIBUTING.md、LICENSE（MIT）
- [ ] npm 发布流水线（publish workflow）—— 等迁独立仓库后一起做
- [ ] 迁出到独立开源仓库（需要决定时机与仓库名）

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
