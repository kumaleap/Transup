# 05 REPL 骨架、启动体验与终端集成

> 源码引用相对 `claude-code-analysis` 仓库根目录。

## 1. 屏幕层级与 REPL 主骨架

### 1.1 顶层结构：App 只是 Provider 壳

- `src/components/App.tsx`（仅 55 行）：不做任何 UI，只按 `FpsMetricsProvider > StatsProvider > AppStateProvider` 顺序包三层上下文（FPS 渲染度量、统计、全局 AppState 切片订阅仓库），children 即 REPL。
- 挂载入口 `src/replLauncher.tsx` 的 `launchRepl(root, appProps, replProps, renderAndRun)`：动态 import `App` 和 `REPL` 后 `root.render(<App><REPL/></App>)`。`src/main.tsx` 中多个分支（普通启动、resume、remote、teleport 等，约 6 处）都调用它。
- 组件主干（引自 `analysis/components/01-component-architecture-overview.md`）：
  `App -> REPL/FullscreenLayout -> Messages + PromptInput -> 能力弹层/面板 -> services/state/hooks`。双中枢是 `Messages.tsx`（展示已发生的）与 `PromptInput/PromptInput.tsx`（组织下一步）。

### 1.2 「屏幕」的真实含义：不是路由，是三层机制

1. **进程级 setup 屏**（进入 REPL 前）：`src/interactiveHelpers.tsx` 的 `showSetupScreens()` 用 `showSetupDialog(root, renderer)` 逐个整屏渲染并 await：Onboarding → TrustDialog（目录信任，已信任则跳过 import）→ dev channels 提示 → ClaudeInChromeOnboarding。每个 dialog 直接替换 Ink root 的内容。
2. **REPL 内部双屏**：`src/screens/REPL.tsx`（5005 行）内 `export type Screen = 'prompt' | 'transcript'`（:571），`const [screen, setScreen] = useState<Screen>('prompt')`（:703）。Ctrl+O 在 `src/hooks/useGlobalKeybindings.tsx`（keybinding id `app:toggleTranscript`）里双向切换。transcript 模式在 REPL.tsx:4392 处**早退 return** 一棵完全不同的树（全量消息 + 搜索栏 + TranscriptModeFooter），与 prompt 模式互斥、同一时刻只挂载一个 ScrollBox。
3. **`src/screens/` 的其他屏**：`Doctor.tsx`（`claude doctor` 安装健康检查）、`ResumeConversation.tsx`（`--resume` 会话选择器，选中后再 `launchRepl`）。真正的多屏切换靠 main.tsx 命令分支而不是运行时路由。

### 1.3 REPL 主屏布局（prompt 模式，REPL.tsx:4548-5004）

整体是一个 `mainReturn`，若 `isFullscreenEnvEnabled()` 则包 `<AlternateScreen mouseTracking={isMouseTrackingEnabled()}>`（:4999-5003），否则裸渲染（走终端原生 scrollback）。树内顺序：

- **零高度副作用/handler 组件**（都渲染 null）：`AnimatedTerminalTitle`、`GlobalKeybindingHandlers`、`VoiceKeybindingHandler`、`CommandKeybindingHandlers`、`ScrollKeybindingHandler`（必须排在 `CancelRequestHandler` 之前——有选区时 ctrl+c 是复制、否则 fall through 成取消任务）、`MessageActionsKeybindings`、`CancelRequestHandler`。
- **`<FullscreenLayout>`**（`src/components/FullscreenLayout.tsx`，636 行）承担真正版式，插槽：
  - `scrollable`：TeammateViewHeader + `<Messages>`（消息流）+ AwsAuthStatusBox + 提交占位回显（`❯ 用户输入`，modal 打开时隐藏）+ toolJSX（非 immediate 的 local-jsx 命令如 /diff /theme 渲染在这里，因为内容可能很高需要外层 ScrollBox）+ `<Box flexGrow={1}/>` 弹性撑开 + Spinner + BriefIdleStatus + 队列中的命令。
  - `bottom`（flexShrink=0，永不被滚动带走）：permission sticky footer、immediate local-jsx 命令（/btw /sandbox 等，避免流式消息 relayout 拖动它们）、TaskListV2、各权限/elicitation/cost/idle-return 等 focused dialog、`exitFlow`、FeedbackSurvey、**PromptInput**、SessionBackgroundHint、DevBar。右侧可并排 `CompanionSprite`（BUDDY 彩蛋，窄终端 `<MIN_COLS_FOR_FULL_SPRITE` 时改为纵向堆叠）。
  - `overlay`：工具权限请求 `PermissionRequest`（渲染在 ScrollBox 内末尾，可随消息滚动）。
  - `modal`：fullscreen 下**所有** local-jsx 斜杠命令（/model /config /theme…约 40 个）都浮到 absolute 定位、底部锚定的 pane（顶部一行 `▔` 分隔线、paddingX=2、`maxHeight = rows - MODAL_TRANSCRIPT_PEEK`，顶部留几行 transcript 可见），通过 `ModalContext` 让内部 Pane/Dialog 跳过自己的外框。
  - `bottomFloat`：绝对定位右下角（Companion 气泡）。
- **FullscreenLayout 内部结构**（fullscreen 分支）：
  `PromptOverlayProvider( Box[flexGrow=1, overflow=hidden]( StickyPromptHeader? + ScrollBox[flexGrow=1, stickyScroll] + NewMessagesPill? + bottomFloat? ) + Box[flexShrink=0, maxHeight="50%"]( SuggestionsOverlay + DialogOverlay + bottom ) + modal? )`。输入区上限为屏幕 50%。
- **非 fullscreen 分支**：简单顺序渲染 `<>{scrollable}{bottom}{overlay}{modal}</>`，依赖终端原生滚动回看。
- **"N new messages" pill**：Slack 式胶囊，绝对定位在滚动区底部。`useUnseenDivider`（FullscreenLayout.tsx:86）在用户滚离底部时快照 `scrollHeight` 作为分隔线 y 位置（存 ref 不触发 REPL 重渲），`pillVisible` 用 `useSyncExternalStore` 直接订阅 ScrollBox 滚动，逐帧滚动零 React 重渲。`countUnseenAssistantTurns` 只统计带可见文本的 assistant 轮次（tool_use-only 和 progress 不计）；一旦有任何新内容 count floor 为 1。count=0 显示 `Jump to bottom`。点击 pill 跳到分隔线。

### 1.4 transcript 屏（Ctrl+O，REPL.tsx:4392-4490）

- fullscreen + 虚拟滚动可用时：`<AlternateScreen>` 包 `FullscreenLayout(scrollable=全部消息, bottom=搜索栏或TranscriptModeFooter)`；`/` 打开 `TranscriptSearchBar`（自绘光标、右侧显示 `indexing…`/`indexed in Nms`/`current/count`/`no matches`），n/N 跳匹配，j/k/g/G/ctrl+u/d vim 式滚动，Esc 撤销搜索、Enter 提交。注释特意说明：alt buffer 的根 Box 类型/props 与 prompt 模式一致，让 React reconcile 时**不退出 alt screen**。
- 关闭虚拟滚动/非 fullscreen 时回退「legacy dump」：不进 alt screen，直接把消息倒进终端 scrollback，30 条上限（`MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30`，Messages.tsx:276）+ Ctrl+E 展开全部。

### 1.5 Static/动态区的划分（无 Ink `<Static>`，自研判定）

- 这套 fork **没有使用 Ink 官方 `<Static>` 组件**。取而代之：`Messages.tsx:779` 的 `shouldRenderStatically(message, …)` 逐条判定消息是否「已定型」（详见 02 篇 §5）。
- `MessageRow.tsx` 把结果作为 `isStatic` 传给 `Message`，memo 比较器里「Static message - safe to skip re-render」直接跳过重渲染。真正的「静态区落盘」由渲染层完成：非 fullscreen 模式下滚出视口的行自然进入终端 scrollback，`log-update.ts` 不再触碰；配合 `OffscreenFreeze`（见 §4）冻结滚出视口的子树。
- prompt 模式还有 `MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200` 上限（Messages.tsx:307），切片锚点用 UUID 而非 count，避免流式追加时整屏抖动。
- Logo 头也是静态化对象：`Messages.tsx:47-62` `LogoHeader = React.memo(...)`，注释明确「logo 是所有 MessageRow 之前的第一个兄弟节点，防止前导节点污染整屏 blit」。

## 2. 启动体验

### 2.1 Banner / Logo（`src/components/LogoV2/`）

- **每次启动的会话头** `LogoV2.tsx`（542 行）：
  - 默认走 **CondensedLogo**（紧凑模式）：条件是「没有未读 release notes && 不需要项目 onboarding && 未设 `CLAUDE_CODE_FORCE_FULL_LOGO`」。内容为 Clawd 小像素吉祥物 + 版本、cwd、model+billing、agent 名等一两行信息，外加 VoiceModeNotice / 调试模式警告（黄色 `Debug mode enabled` + 日志路径）/ tmux session 提示 / 公司公告（`Message from {org}:`，首次启动取第一条、之后随机）等可选行。
  - **完整模式**是双栏布局：`getLayoutMode(columns)`（`src/utils/logoV2Utils.ts:35`）——`columns >= 70` 用 `horizontal`（左栏 Clawd + `Welcome back {username}!`（用户名过长则只 `Welcome back!`）+ 截断的 cwd + model 行，左栏按内容自适应、上限 `LEFT_PANEL_MAX_WIDTH=50`；右栏 FeedColumn 轮播：最近活动 / What's New（release notes 最多 3 条）/ 项目 onboarding 步骤 / guest pass、overage credit 促销），`< 70` 折叠为 compact 纵排。整个 logo 包 `OffscreenFreeze` 防滚出视口后反复重绘。
  - **Clawd 吉祥物**（`LogoV2/Clawd.tsx`，240 行）：9 列宽、用半格块字符（`▛███▜` / `▝▜ ▛▘`）拼出的小机器人，有 `default / arms-up(跳跃举手) / look-left / look-right` 四种 pose，靠替换眼睛/手臂 segment 实现动画（`AnimatedClawd`）。
- **Onboarding 专用欢迎屏** `LogoV2/WelcomeV2.tsx`：固定 58 列宽的字符画横幅——`Welcome to Claude Code v{VERSION}` + 大幅 `░▒█` 组成的 Clawd 场景图；按主题（light 系 / dark / Apple_Terminal 专用变体）三套配色分支。

### 2.2 首次运行 Onboarding（`src/components/Onboarding.tsx`，243 行）

触发条件（interactiveHelpers.tsx:111）：`!config.theme || !config.hasCompletedOnboarding`。步骤数组按条件拼装，`StepId = 'preflight' | 'theme' | 'api-key' | 'oauth' | 'security' | 'terminal-setup'`：

1. **preflight**（仅 OAuth 可用时）：`PreflightStep` 环境预检，成功自动进下一步。
2. **theme**：`ThemePicker`（`showIntroText`，帮助文案 `To change this later, run /theme`），选中即 `setTheme` 并前进。主题为 dark/light/daltonized（色弱）/ansi 等 `ThemeSetting`。
3. **api-key**（检测到新的 `ANTHROPIC_API_KEY` 环境变量时）：`ApproveApiKey` 让用户确认使用该 key；同意则跳过 OAuth 步。
4. **oauth**：`ConsoleOAuthFlow`（见 2.3），包在 `SkippableStep` 里。
5. **security**：固定的 `Security notes` 屏——OrderedList 两条（`Claude can make mistakes`、`Due to prompt injection risks, only use it with code you trust` + docs 链接），`PressEnterToContinue`。
6. **terminal-setup**（`shouldOfferTerminalSetup()` 为真时）：询问是否写入推荐终端配置——Apple Terminal 是 `Option+Enter for newlines and visual bell`，其他是 `Shift+Enter for newlines`；Select 二选一，选 yes 执行 `setupTerminal(theme)`。

每步上方都常驻 `<WelcomeV2/>` 横幅；Ctrl+C/D 双击退出（`exitState.pending` 时显示 `Press {key} again to exit`）。完成后 `completeOnboarding()` 写 `hasCompletedOnboarding` + `lastOnboardingVersion`。onboarding 刚完成时若首条 prompt 是 `/login` 会被吞掉（main.tsx:2275）。

### 2.3 OAuth 登录流（`src/components/ConsoleOAuthFlow.tsx`，630 行）

- 状态机：`idle → ready_to_start →（startOAuthFlow 打开浏览器）→ waiting_for_login → success`；失败进 `error`（可带 `toRetry`，按键后 `about_to_retry` 重来）；另有 `platform_setup`（claude.ai 计划设置）和 `setup-token` 模式（token 直接显示给用户配 `CLAUDE_CODE_OAUTH_TOKEN`，不写 keychain）。
- 交互细节：等待浏览器几秒后出现 `showPastePrompt`——`Browser didn't open? Use the url below to sign in`，URL 以 OSC-8 `Link` 呈现；此时按 `c` 复制 URL 到剪贴板并显示绿色 `(Copied!)`；同屏提供手动粘贴授权码的 `TextInput`（`mask="*"` 星号遮罩，回车提交 `handleSubmitCode`）。登录成功还会发一条 OS 通知（:243 调 `sendNotification`）。错误屏列出 Bedrock/Foundry/Vertex 文档链接作为替代方案。

### 2.4 启动其余细节

- `--bare` 最小化模式跳过 hooks/LSP/keychain 等（main.tsx CLI 定义）；启动耗时打点提到「用户停在 trust/OAuth/onboarding/resume-picker 上 p99 约 70s」。
- LogoV2 首帧渲染时把 `lastReleaseNotesSeen` 写成当前版本、递增 project onboarding 计数（副作用都在 `useEffect`）。

## 3. 终端集成

### 3.1 窗口 resize（`src/ink/ink.tsx:303-346`）

- 监听 `stdout` 的 `'resize'` 事件，**故意不 debounce**（注释：debounce 会造成 stdout.columns 新、Yoga 旧的窗口期，spinner tick 触发 log-update 判定宽度变化清屏，然后 debounce 又清一次 → 双重 blank→paint 闪烁）。同尺寸事件去重（终端常为一次拖拽发 2+ 事件）。
- alt-screen 下的 resize：重置双帧缓冲（`prevFrameContaminated` → 下一帧全量重写并包在 BSU/ESU 里原子换帧，旧内容保持可见直至新帧就绪）；重新写 `ENABLE_MOUSE_TRACKING`（部分模拟器 resize 后重置鼠标模式）；**不重发 `ENTER_ALT_SCREEN`**（iTerm2 会把已在 alt 时的 `?1049h` 当清屏 → 空白闪烁）；**不预先 ERASE_SCREEN**（render 可能 80ms，先擦会白屏 80ms）。
- 然后直接 `this.render(currentNode)` 走完整 React commit → `onComputeLayout()`（Yoga 重排）→ `onRender()`，保证 viewport 与内容尺寸一致（不用 scheduleRender，那会在 layout 更新前渲染）。
- reflow 成本由 `useVirtualScroll` 的高度缩放兜底；组件层通过 `useTerminalSize()` hook / `TerminalSizeContext` 拿行列数并自动重渲。

### 3.2 Alt-screen / 全屏模式

- 门控：`src/utils/fullscreen.ts` `isFullscreenEnvEnabled()`——内部员工（ant）默认开、外部用户默认关，环境变量 `CLAUDE_CODE_NO_FLICKER=1/0` 覆盖；检测到 tmux -CC（iTerm2 集成模式）自动禁用。鼠标另有独立开关 `isMouseTrackingEnabled()` / `isMouseClicksDisabled()`。
- `src/ink/components/AlternateScreen.tsx`：`useInsertionEffect` 挂载时写 `ENTER_ALT_SCREEN(DEC 1049) + \x1b[2J\x1b[H + ENABLE_MOUSE_TRACKING`，通知 Ink 实例 `setAltScreenActive(true)`（让渲染器把光标限制在视口内 + signal-exit 时兜底退出 alt）；卸载时逆序恢复。子内容包在 `<Box height={rows} flexShrink={0}>` 里——溢出必须走 `overflow: scroll`/flexbox，没有原生 scrollback。REPL 的 prompt / transcript 两分支都在根部包它。
- 外部 TUI 接管（git editor 等）：ink.tsx `enterAlternateScreen()/exitAlternateScreen()`——pause + suspendStdin，非全屏时借道 alt screen、全屏时清屏让位。
- tmux + fullscreen + `mouse off` 时给一次性提示滚轮不可用（REPL.tsx:996 `maybeGetTmuxMouseHint`）。

### 3.3 鼠标支持

- 协议：`src/ink/termio/dec.ts`——`ENABLE_MOUSE_TRACKING = decset(1000)+decset(1002)+decset(1006)`（按键/滚轮 + 拖拽 + SGR 编码），仅在 `<AlternateScreen>` 内启用。
- 解析：`src/ink/parse-keypress.ts`——`SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/`；**滚轮（button bit 0x40）保持为 `ParsedKey`（`wheelup`/`wheeldown`）进 keybinding 系统**，点击/拖拽/释放成为 `ParsedMouse {kind:'mouse', col, row, 1-indexed}`；还处理分包截断的 mouse 序列重组。
- 点击派发：`src/ink/hit-test.ts` 命中最深节点，`src/ink/events/click-event.ts` 的 `ClickEvent` 沿 `parentNode` 冒泡，支持 `stopImmediatePropagation()`；每层 handler 前重算 `localCol/localRow`（相对该 Box）；`cellIsBlank`（屏幕缓冲两 packed word 均 0）让 handler 忽略文本右侧空白处的误点。组件层 Box 直接挂 `onClick`（pill 点击、StickyPromptHeader 点击、图片引用点击等）。`NoSelect.tsx` 标记不可选中区域。
- 滚轮/滚动：`src/components/ScrollKeybindingHandler.tsx`——wheel 带加速度（`computeWheelStep(wheelAccel…)`）、PgUp/PgDn、无默认键位的 halfPage/fullPage 动作、modal pager（j/k/ctrl+u/d/g/G）；拖拽选区存在时 ctrl+c 复制选中文本而非取消任务。选区本体在 `src/ink/selection.ts` + 渲染时 `applySelectionOverlay` 上色。
- 文本 OSC-8 超链接：`src/ink/supports-hyperlinks.ts` + `Link` 组件。

### 3.4 终端标题

- `src/ink/hooks/use-terminal-title.ts`：声明式 hook，写 `OSC 0`（title+icon），自动 stripAnsi；Windows 用 `process.title`；传 null 完全不碰标题。
- REPL.tsx:473-524 `AnimatedTerminalTitle`：标题 = `sessionTitle(/rename) ?? agentTitle ?? haikuTitle(用 Haiku 模型给会话起的标题) ?? 'Claude Code'`；运行中（`isLoading && 未等审批 && 无 dialog`）前缀在 `⠂`/`⠐` 两帧间以 960ms 轮换，空闲时静态 `✳`；**终端失焦时暂停动画**（`useTerminalFocus`，基于 DECSET 1004 focus events）。特意抽成返回 null 的叶子组件，让 960ms tick 不再拖着整个 REPL 每秒重渲。
- 另有 iTerm2 私有 `OSC 21337` tab-status 扩展（`src/ink/termio/osc.ts:248`，ant-only 门控），退出时清除防止残留状态点。
- 进度上报：`OSC 9;4`（ConEmu/Ghostty 1.2+/iTerm2 3.6.6+），`useTerminalNotification().progress(state, pct)` 支持 running/indeterminate/error/completed。

### 3.5 Bell / 桌面通知

- 底层 `src/ink/useTerminalNotification.ts`：`notifyITerm2`（OSC 9）、`notifyKitty`（OSC 99 三段式 title/body/focus）、`notifyGhostty`（OSC 777 notify）、`notifyBell`（裸 BEL——注释：tmux 内裸 BEL 才能触发 tmux bell-action 窗口标记，不能包 DCS）；所有 OSC 均 `wrapForMultiplexer`（tmux/screen 穿透）。
- 路由 `src/services/notifier.ts` `sendNotification()`：先执行用户 Notification hooks，再按 `config.preferredNotifChannel`（auto/iterm2/iterm2_with_bell/kitty/ghostty/terminal_bell/notifications_disabled）分发；`auto` 按 `env.terminal` 匹配，Apple_Terminal 特殊处理（系统 bell 被禁才发 BEL，否则 no_method_available）；发埋点记录 channel/method/term。
- **触发点**：
  1. 空闲提醒——REPL.tsx:3915-3941，回复完成后用户无任何交互超过 `messageIdleNotifThresholdMs` 发 `Claude is waiting for your input`（`idle_prompt`）
  2. 权限请求挂起超时——`PermissionRequest.tsx:190` `useNotifyAfterTimeout(msg,'permission_prompt')`（距最近一次用户输入超阈值才发）
  3. MCP elicitation 对话框（`Claude Code needs your input`）
  4. OAuth 登录成功
  5. inbox/teammate 消息（useInboxPoller）
  - 工具还能经 `sendOSNotification`（REPL.tsx:2475）主动发。

### 3.6 图片显示

**不做 sixel/iTerm 1337 inline 图片**。图片（粘贴/读取）存入 `src/utils/imageStore.ts`，UI 上渲染为 `[Image #N]` 文本 chip（`src/components/ClickableImageRef.tsx`）：终端支持 OSC-8 时是指向 `file://` 路径的超链接（点击用系统查看器打开），选中态 inverse+bold；不支持则退化为纯样式文本。粘贴链路在 `utils/imagePaste.ts / imageResizer.ts / imageValidation.ts`（缩放+校验后进 store）。

## 4. src/ink：对 Ink 的深度 fork / 定制

这不是「用 Ink」，而是整目录重写的私有渲染栈（`src/ink/`，40+ 文件）。关键定制：

1. **帧循环与节流**（`ink.tsx`，1722 行）：`scheduleRender = throttle(deferredRender, FRAME_INTERVAL_MS=16, …)`（constants.ts:2，约 60fps 上限）；测试环境走无节流的 `onImmediateRender`。`Date.now()` 每帧最多取一次。
2. **双缓冲 cell 屏幕模型**（`screen.ts`，1486 行）：`frontFrame/backFrame` + 全实例共享的 `CharPool/StylePool/HyperlinkPool` 字符串驻留池（ASCII 走 Int32Array fast-path），cell 用 packed int 存，diff 时按整数比较、blit 时直接拷 ID；damage rect 跟踪。
3. **最小 diff 写屏**（`log-update.ts`，773 行）：`diffEach(prev, next)` 逐 cell 比较生成 patch 流，样式用 `diffAnsiCodes` 只写增量；**DECSTBM 滚动区优化**——内容整体上移时用设置滚动边距 + 滚动代替整屏重写，且要求能用 **DEC 2026（BSU/ESU）同步更新**包裹保证原子性，否则回退全量 diff（防止撕裂）；viewport 缩短时的 scrollback 不可达行专门处理；慢帧告警日志（`Slow render: Xms…`）。
4. **diff 后处理**（`optimizer.ts`）：单遍合并 cursorMove、去空 patch、合并相邻 style、去重连续同 URI hyperlink、抵消 show/hide cursor 对。
5. **防闪烁细节**：resize 不 debounce（§3.1）；alt-screen resize/恢复走「污染帧 → BSU/ESU 原子全量重绘」；SIGCONT/睡眠唤醒检测自愈重进 alt screen；主屏恢复时清空帧缓冲防覆盖 shell 内容；`displayCursor` 追踪物理光标 park 位置，每帧 CSI H 复位（避免 iTerm2 cursor guide 跟着 diff 落点跳动闪烁）。
6. **选区/搜索高亮作为帧后覆盖层**：`applySelectionOverlay`/`applySearchHighlight`/`applyPositionedHighlight` 直接改 screen buffer 的 cell 样式（不进 React），配合 sibling-resize bleed 的整帧 damage 兜底。
7. **ScrollBox + 虚拟滚动**（`components/ScrollBox.tsx` + `hooks/useVirtualScroll`）：自研 handle（scrollTo/scrollBy/scrollToElement——渲染期才读 Yoga 位置以保证确定性、getFreshScrollHeight、isSticky、subscribe、setClampBounds 防止 burst 滚动越过已挂载内容看到空白 spacer）；`stickyScroll` 内容增长自动贴底。
8. **OffscreenFreeze**（`src/components/OffscreenFreeze.tsx`）：内容滚入 scrollback 后返回缓存的同一 ReactElement 引用，reconciler 直接 bail，spinner/计时器 tick 不再造成「视口上方变化 → log-update 全量 reset」。`'use no memo'` 显式关掉 React Compiler。
9. **终端能力探测**（`terminal-querier.ts`）：DECRQM/DA1/DA2/XTVERSION/OSC 10/11（前景背景色）/kitty keyboard 查询共享 stdin 流，用 **DA1 哨兵**终结每批查询（响应顺序判断支持与否，零超时等待）。
10. **其他**：`parse-keypress.ts`（kitty keyboard、bracketed paste、SGR mouse、分包重组）、`bidi.ts`、`wrapAnsi/line-width-cache/stringWidth`（CJK/emoji 宽度）、`tabstops.ts`、`clearTerminal.ts`、`measure-element.ts`、`terminal-focus-state.ts`（DECSET 1004）、`useTerminalNotification.ts`、`supports-hyperlinks.ts`。

## 5. 对 Transup 的可借鉴要点

1. **布局骨架**：`根 Provider 壳（零 UI）→ 单一巨型 REPL 屏 → 插槽化 Layout（scrollable/bottom/overlay/modal/bottomFloat）`，输入区 flexShrink=0 + maxHeight 50%，消息区 flexGrow=1；「屏幕」用 state 早退 return 两棵树而非路由。
2. **性能三板斧**：消息级 static 判定 + memo 跳渲、滚出视口子树引用冻结（OffscreenFreeze）、逐帧滚动状态走 ref/useSyncExternalStore 绕开 React。
3. **防闪烁**：alt-screen 双缓冲 + cell diff + DEC 2026 原子换帧 + resize 同步处理；已在 alt 时绝不重发 1049h。
4. **降级链路**：fullscreen(alt+虚拟滚动+鼠标) → 非 fullscreen（原生 scrollback + 30 条 cap + Ctrl+E）→ tmux -CC 自动禁用，全部 env 可控。
5. **终端集成清单**：OSC 0 标题（忙碌 ⠂/⠐ 动画、失焦暂停）、OSC 9/99/777/BEL 分终端通知 + auto 探测、OSC 9;4 进度、OSC 8 超链接（图片=可点击 `[Image #N]`）、DECSET 1004 焦点、SGR 1000/1002/1006 鼠标（滚轮进 keybinding、点击冒泡事件带 localCol/cellIsBlank）。
