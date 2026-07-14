# TUI 核心机制交互体验实现记录（交互规格 07）

**Goal:** 按 `docs/claude-code-interactions/07-核心机制交互体验.md` §8 的核心启示，补全 compact / resume / subagent 三大机制的用户可见体验。至此交互规格 01-07 全部有落地。

**Branch:** `feature/tui-core-mechanics`（堆叠在 06 分支 `4e9f5fa` 之上）。

**Execution status:** 完成。394 tests 通过（1 个 PTY 冒烟按设计自跳过），typecheck 干净。

## 前情
07 含金量最高的"压缩语义完整性"（§1.4：摘要替换 + recentFiles 重注入）M4.5 已在 core 落地；resume 基础（--continue/--resume + /sessions 面板）也已有。本次补的是**用户可见层**的缺口。

## 落地内容

### 压缩 UX 三段式（§1.2 / §8.1）
- **事前**：上下文水位 ≥80% 时输入框下方警告行 `⚠ 上下文已用 {n}%，满 100% 自动压缩 · /compact 可手动压缩`（≥95% 转红）。engine 的 `contextUsage().percent` 本身就是相对触发点的百分比，警告纯 cli 计算，core 零改动。
- **事中**：spinner 状态词新增 `Compacting`（压缩优先于 Running/Responding/Thinking）。
- **事后**：`compact_end` 事件带出 `summary` 正文（core 一行改动）；transcript 新增 `compact` 条目 —— 主屏一行边界卡 `✻ 对话已压缩（298k → 12k 字符）· Ctrl+O 查看完整摘要`，**摘要正文只在全文屏展开**（复用 05 的 Ctrl+O 双屏，不再刷屏）。runTurn 自动压缩与 /compact 手动共用同一个事件处理器；压缩失败仍红行提示"退回截断策略"。
- App 新增 `maxContextChars` prop 透传 engine（测试用小值驱动整条链路，也留给用户按模型窗口调）。

### resume 体验（§2 / §8.3）
- **/sessions 列表标题**：`SessionStore.firstPrompt(id, dir)` —— lite read 只读文件头 64KB（规格 §2.1"列表页秒开"的关键），提取首条真实用户输入（跳过 `[系统提示]` 注入），首行截断 60 字符。面板 label=标题、description=会话 id（当前会话标注）。
- **中断续跑提示**：core 新增 `wasInterrupted(history)` —— 三种可靠的中断痕迹（尾部 user 无回应 / 尾部 tool 结果模型未接话 / assistant 带中断标记）。启动恢复（--continue/--resume）与 /sessions 切换后命中时提示"上次任务在执行中途被打断；直接下达指令，模型会带着已有进度继续"。
- **刻意不做自动注入**：规格里 resume 会自动注入 "Continue from where you left off" 让模型直接续跑；我们只提示不注入 —— 自动发起一轮会烧 token 且用户可能只是回来看看。

### subagent 实时进度（§3.2 / §8.4）
- **tool-runner 进度通道统一**：原先只有串行（写）工具有"队列+唤醒"进度桥接；重构为每个调用一条 `ProgressChannel`，**只读工具启动即开始缓冲**，轮到它时先排空积压再实时转发 —— 并行任务的进度不丢、事件顺序仍稳定（tool_start → progress* → tool_end）。
- **task 工具接 onProgress**：子 agent 的每次工具调用透出为进度行 `→ read_file src/index.ts`（参数摘要截 60 字符），复用 App 现成的运行尾巴展示（bash 同款）。长探索不再像卡死；正文仍只回流最终结论，不污染主上下文。
- 权限回流（§3.2 workerBadge）不适用：Transup 子 agent 是只读工具集，权限层直接放行，无需回流弹窗。

## 显式跳过（及原因）
| 规格内容 | 原因 |
|---|---|
| 隐藏功能 / 彩蛋系统（§4） | 产品彩蛋无移植价值；/buddy 这类等有闲情再说 |
| 挫败感信号检测（§5） | 前提是 telemetry 埋点体系，Transup 没有也暂不打算收集 |
| 会话选择器树形分组 / Fuse 模糊搜索（§2.3） | 会话量级还用不上；面板已够用，等真实使用反馈 |
| microcompact（§1.3） | 需要 token 级预算与工具结果白名单机制，属 core 的 M6+ 工作 |
| useMinDisplayTime / useBlink 等叶子 hooks（§7） | 当前无对应视觉场景，等用到再抄 |

## 测试
- core：只读工具进度事件顺序（tool_start → progress×2 → tool_end）、`compact_end.summary` 透出、`wasInterrupted` 四类判定、`firstPrompt`（跳过注入/首行截断/不存在返回 null）。
- cli e2e：压缩三段式全链路（警告行出现 → 触发压缩 → ✻ 边界卡且主屏不摊开正文 → Ctrl+O 全文屏见摘要）、恢复中断会话的启动提示、/sessions 标题显示、只读工具进度行在运行中实时可见。
