# TUI REPL 骨架与终端集成实现记录（交互规格 05）

**Goal:** 按 `docs/claude-code-interactions/05-REPL骨架与终端集成.md` §5 的可借鉴要点，把 TUI 从"一坨 App.tsx"整理成插槽化骨架 + 双屏，并接上终端带外通道（标题 / 进度 / 桌面通知）。

**Branch:** `feature/tui-repl-shell`（堆叠在 `feature/tui-permission-dialogs` @ `f630e23` 之上 —— 04 改过 App.tsx，同分支演进避免二次冲突）。

**Execution status:** 完成。372 tests 通过（1 个 PTY 冒烟按设计自跳过），typecheck 干净。

## 落地内容

### 骨架（规格 §1）
- `tui/Layout.tsx`：插槽化布局 —— `scrollable`（Static 记录 + 动态区）/ `overlay`（权限对话框）/ `bottom`（输入框 + 模式指示 + 状态栏，`flexShrink=0` 永不被滚走）。App 的 render 收敛成填插槽。
  - `rootRef`/`bottomRef` 透传：输入框光标声明靠 `useBoxMetrics` 量祖先几何，重构不能弄丢这两个测量锚点（改完 286 个既有用例仍全绿，光标定位未回归）。
- `tui/TranscriptScreen.tsx` + screen state（`prompt` | `transcript`，Ctrl+O 切换）：主屏工具结果只有 3 行预览，全文屏摊开**未截断**的原始输出（`TranscriptItem.full`），这是调 prompt 时最需要的东西。默认渲染最近 30 条、每条工具输出截 100 行，**Ctrl+E 展开全部**，Esc/Ctrl+O 返回。
  - 新增 `transcript` 输入上下文：全文屏吞掉一切普通按键，不会漏进底下的编辑器。
  - 全文屏期间冒出权限询问 → 自动切回主屏（否则用户看不到弹窗也答不了）。

### 终端集成（规格 §3）
- `tui/terminal/osc.ts`（纯函数）：OSC 0 标题、OSC 9;4 进度、OSC 9/99/777 三家通知协议、`wrapForMultiplexer`（tmux DCS 包裹 + ESC 加倍；screen 原样透传）、`sanitize`（剥控制字符，否则文本里的 BEL/ESC 会截断序列本身）。
- `tui/terminal/notify.ts`：频道探测（iTerm2 / kitty / Ghostty / 兜底 BEL / off），`TRANSUP_NOTIF_CHANNEL` 可覆盖。**BEL 不过 DCS 包裹** —— tmux 只有收到裸 BEL 才触发 bell-action。
- `tui/terminal/use-terminal-status.ts`：忙碌时标题前缀 ⠂/⠐ 960ms 轮换、空闲静态 ✳；同步用 OSC 9;4 让标签页显示任务进行中；退出时清进度 + 复位标题。Windows 走 `process.title`。
- `tui/terminal/use-terminal-notifications.ts`：①一轮结束后用户长时间无操作 → "已完成，等待你的下一步"；②权限弹窗挂起超阈值 → "需要你的授权：{tool}"。两者到点都会看最近一次按键时间戳——**人还在敲键盘就不打扰**。阈值 `TRANSUP_NOTIF_IDLE_MS`（默认 30s）/ `TRANSUP_NOTIF_PERMISSION_MS`（默认 5s）。
- `tui/terminal/writer.ts`：带外序列直写 `process.stdout` 且 **TTY 门控**。

### resize（规格 §3.1）
Ink 7.1 自带 `useWindowSize`（resize 时重渲）且 `resized()` 已处理"缩宽先清屏防重影"——规格里那套自研 resize 处理**不需要**。接线：终端列数喂给权限对话框的 diff 预览（`buildPermissionView(confirm, width)`），窄终端不再溢出、宽终端能铺满。

## 两个 Ink 特有的坑（踩过，记下来）
1. **Static 不能卸载**：规格里 transcript 屏是"早退 return 一棵全新的树"。在 Ink 里这样做会卸载 `<Static>`，而 Static 重新挂载会把所有条目**重新吐进 scrollback**（历史凭空翻倍）。所以主屏骨架保持挂载，只把动态区换成全文屏。
2. **标题动画不能进 React**：960ms 的 tick 如果走 setState，就是整棵树重渲（我们用官方 Ink，没有 Claude Code 那套叶子隔离 + OffscreenFreeze 的自研渲染器）。改成 `setInterval` 直接写 stdout —— 零重渲。同理，通知/进度也都是纯副作用，不进渲染树。

## 显式不做（及原因）
| 规格内容 | 决定 | 原因 |
|---|---|---|
| alt-screen 全屏 + 虚拟滚动 + 鼠标（§3.2/§3.3） | 不做 | 前提是自研渲染器（双缓冲 cell diff + DEC 2026 原子换帧）。用官方 Ink 硬做只会得到一个会闪的半成品；终端原生 scrollback 已经够用 |
| 自研 ink fork（§4 整节） | 不做 | 同上。这是 Claude Code 投入最大的一块，跟"开源可维护"的目标冲突 |
| transcript 搜索栏（`/` + n/N + vim 滚动） | 暂缓 | 依赖虚拟滚动才有意义；当前全文屏靠终端原生滚动 |
| 图片 `[Image #N]` chip（§3.6） | 暂缓 | 我们还没有图片输入链路 |
| Onboarding / OAuth 登录流（§2.2/§2.3） | 暂缓 | 我们是 API key 模式，已有 `setup.ts` 引导生成 .env |
| DECSET 1004 焦点跟踪（标题失焦暂停） | 不做 | 焦点事件会作为 `\x1b[I`/`\x1b[O` 混进 stdin，有污染输入路由（Esc 被误触发）的风险；而我们的标题动画本来就零重渲，失焦暂停省不下什么 |

## 测试
- `cli/test/terminal.test.ts`：OSC 各序列字节级断言、tmux/screen 包裹、频道探测矩阵（含 off 与非法值静默）、BEL 不被包裹、标题帧回环。
- `cli/test/tui.test.tsx` e2e：Ctrl+O 全文屏显示未截断输出 / Ctrl+E 展开 / Esc 返回、全文屏吞键不漏进输入框、标题与进度序列（空闲 ✳ + 清零 → 运行 ⠂ + 转圈）、权限挂起超阈值发通知、空闲发通知。
