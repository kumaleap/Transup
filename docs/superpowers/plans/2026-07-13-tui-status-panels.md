# TUI 状态展示与命令面板实现记录（交互规格 06）

**Goal:** 按 `docs/claude-code-interactions/06-状态展示与命令面板.md` §6 的可借鉴要点，落地状态展示的扩展机制与面板范式。

**Branch:** `feature/tui-status-panels`（堆叠在 05 分支 `2d9e177` 之上）。

**Execution status:** 完成。385 tests 通过（1 个 PTY 冒烟按设计自跳过），typecheck 干净。

## 落地内容

### statusline 即 hook（§1.1，完整语义）
- `settings.statusLine.command`：用户配一条 shell 命令，会话状态以 JSON 经 **stdin** 传入（字段名对齐 Claude Code，脚本可迁移：`model{id,display_name}` / `workspace{current_dir}` / `version` / `permission_mode` / `cost{total_input_tokens,total_output_tokens,total_duration_ms}` / `context_window{used_percentage}`）。
- 约定：**5s 超时**（kill 进程树）、**exit≠0 / 空输出静默丢弃**（状态行是装饰，用户脚本坏了不打扰主流程）、**300ms debounce + AbortController 取消 in-flight**（`use-status-line.ts`）、**ANSI 透传**（`<Text wrap="truncate">` 直接渲染）。
- 刷新触发：一轮落定（running 翻转）/ 权限模式切换 / 上下文水位变化。
- 位置：状态栏上方一行。

### /cost 明细 + 退出汇总（§1.3）
- `cost-summary.ts` 单一来源：会话时长（wall）+ 输入/输出 tokens（千分位）+ 缓存命中/写入（为零时省略）。**不内置模型价格表**——"任何模型都是一等公民"，价格表维护不过来，只报 tokens。
- 退出链路：App 卸载时把汇总交给 `onExitStats` 回调，`index.ts` 在 `waitUntilExit()` 之后（TUI 已把 stdout 归还）用 `console.log` 打印——与规格"统计打印挂在 process exit 钩子，不在 ExitFlow 中"同构。

### /context 方块网格（§1.2 简化版）
- `context-grid.ts` 纯函数：已用 `⛁` / 空闲 `⛶`，5 行 × 宽度自适应（`min(40, columns-4)`，下限 10）；颜色随水位绿→琥珀→红（与状态栏仪表条同一语义）。
- 汇总行 `{model} · {used}k/{budget}k 字符（{percent}%）`，预算总量从 chars/percent 反推。
- Claude Code 按消息类别分色统计；我们的 engine 只暴露 chars/percent，做水位版。类别化统计等 engine 暴露分类数据后再升级。

### 通用选择面板 + /sessions 会话切换（§2 面板范式）
- `tui/panel/`：`use-panel-controller`（↑↓ 不回绕 / 数字 1-9 直选 / Enter / Esc，ref 权威状态——同 tick 连续按键闭包过期是 04 踩过的坑）+ `Panel` 视图（品牌绿圆角边框：面板是用户主动召唤的工具，不是需要警觉的询问；焦点滚动窗口最多 10 条，上下有 "还有 N 条" 指示）。
- 新增 `panel` 输入上下文（优先级 permission > panel > transcript > history-search > editor），面板期间可打印字符全部吞掉。
- `/sessions` 从文本列表升级为选择面板：列出历史会话（当前标"当前"），**选中即加载 history 并切换引擎**（更新状态栏 sessionId 与上下文水位）。这补上了 ROADMAP"会话恢复选择体验"的待办。
- 顺手修的 bug：`SessionStore.list()` 未传 `props.sessionDir`，宿主覆盖会话目录时 /sessions 列错目录。

## 显式暂缓（及原因）
| 规格内容 | 原因 |
|---|---|
| 后台任务 pill / /tasks 对话框 / Ctrl+B（§3） | core 没有后台任务抽象（任务七种类型的统一 `BackgroundTaskState`），属 M6+ 的 core 先行工作 |
| Todo 面板 / TaskListV2（§2.6/§5） | core 没有 todo 工具（TodoWrite）；先有工具再有 UI |
| /model 面板（§2.2） | provider 与模型来自 .env 启动定死，session 内切换需要 provider 层支持 |
| /config 设置面板（§2.3） | 当前 settings 只有 permissions/mcpServers/statusLine 三项，配置面板价值不及直接编辑 JSON；面板范式已由 /sessions 落地 |
| 自动更新（§4.1） | 未上 npm 发布通道（v0.1.0 tag 还没打） |

## 测试
- `cli/test/statusline.test.ts`：JSON stdin 字段可取、非 0 静默、空输出 null、超时 kill、ANSI 透传、多行 trim；网格 0/50/100% 格子数、宽度下限；cost 格式（含缓存省略）。
- `cli/test/tui.test.tsx` e2e：/sessions 面板（打开/Esc 吞键/数字直选切换并加载历史）、statusline 显示在状态栏上方（真实 node 子进程读 stdin）、退出回调汇总、/cost 新格式、/context 网格。
