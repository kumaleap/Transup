# TUI 权限系统与对话框实现记录（交互规格 04）

**Goal:** 把 M4 时代的单键 y/n/a/A 权限确认升级为对齐 `docs/claude-code-interactions/04-权限系统与对话框.md` §12 最小可行集的完整权限链路。

**Branch:** `feature/tui-permission-dialogs`（自 `origin/main` @ `1b8c767` 切出，含输入地基）。

**Execution status:** 全部完成。357 tests 通过（1 个 PTY 冒烟在无可用 PTY 驱动的环境按设计自跳过），core/cli 全量 typecheck 通过。

## 落地内容

### core（UI 无关的判定层）
- `packages/core/src/permissions.ts`（新增）：
  - 规则语法：`bash`（工具级）/ `mcp__github__*`（前缀通配）/ `bash(git status)`（内容精确）/ `bash(npm run:*)`（内容前缀）；bash 匹配命令、文件工具匹配路径。
  - `evaluatePermission` 优先级链：**deny 规则 > ask 规则 > safetyCheck（.git/.transup/shell 配置，bypass 免疫）> plan 模式拒写 > 模式放行（bypass 全放 / acceptEdits 放文件编辑）> allow 规则 > readOnly 放行 > 默认 ask**。
  - `nextPermissionMode`：default → acceptEdits → plan →（bypass 若可用）→ default。
  - `commandPrefix` / `bashPrefixRule`："不再询问"前缀启发（两词子命令；复合命令退回整条精确）。
  - `PermissionUpdate`：对话框决策的持久化动作（addRule / setMode × session / localSettings / projectSettings）。
- `settings.ts`：`settings.json` + `settings.local.json` 两层合并加载（列表拼接、defaultMode local 优先）；`persistPermissionRule` 只写单层原文（防止合并结果落盘）；permissions 增加 `deny/ask/defaultMode`。
- `tools/types.ts`：`PermissionFn` 升级为结构化 `PermissionDecision`（allow 可带 `updatedInput`/`feedback`，deny 可带 `message`），新增 `meta.readOnly` 参数。
- `tools/registry.ts`：**所有**工具（含只读）过权限回调（deny 规则才能管到只读工具）；`updatedInput` 重过 schema 校验；`feedback` 以 `[用户附言]` 追加进工具结果。
- `subagent.ts`：子 agent 回调改为"只读放行、写拒绝"（配合 registry 新契约）。
- `headless.ts`：复用同一判定链；ask 降级 deny（fail-closed），`--allow-all` 等价 bypass 但 deny 规则仍生效。

### cli（对话框族与 App 集成）
- `tui/permission/types.ts`：`ToolUseConfirm`（挂起的待确认调用）/ `PermissionOutcome` / 选项与视图模型。
- `tui/permission/options.ts`：按工具路由生成三段式选项：
  - edit_file / write_file：diff 预览 + "是，本会话内允许所有编辑"（setMode acceptEdits, session）；write 按目标存在与否区分 创建/覆盖。
  - bash：命令展示 + "是，且不再询问：`<可编辑前缀>`"（写 localSettings）。
  - fallback（MCP 等）："是，本项目不再询问 {tool}"。
  - safety 询问裁掉一切持久化选项，只留 是/否 + 黄字警告。
  - 是/否均可 Tab 附言（accept → 随工具结果回流；reject → 进拒绝文案）。
- `tui/permission/use-permission-controller.ts`：选择状态机（↑↓ 不回绕、数字 1-9 直选、Enter 确认、Esc=否、Tab 附言/编辑、Shift+Tab 会话级直选）。状态以 ref 为权威、useState 只作渲染镜像 —— 同一 tick 连续按键（快速输入+回车）下闭包 state 会过期。
- `tui/PermissionDialog.tsx`：重写为纯视图（标题/副标题/预览/解释行/警告/选项/键位提示，琥珀边框）。
- `App.tsx`：
  - 单请求 state → **ToolUseConfirm 队列**（并发只读 ask 不再互相覆盖，标题显示"还有 N 个待确认"）。
  - `canUseTool`：evaluate 快速通道（allow/deny 不弹窗）→ ask 入队挂起。
  - 权限模式 state + Shift+Tab 循环（运行中也可切）+ footer 指示 `{symbol} {mode} on (shift+tab 循环)`。
  - 模式/规则变化后 recheck 队列，变 allow 的挂起弹窗自动放行。
  - updates 应用：session 规则进内存镜像；local/project 落盘同时进内存立即生效。
  - Ctrl+C 中断先拒绝全部挂起确认再 abort。

## 测试
- `core/test/permissions.test.ts`：规则匹配、优先级链（deny 盖过 bypass+allow、ask/safety bypass 免疫、plan 拒写、acceptEdits 只放编辑）、模式循环、前缀启发。
- `core/test/settings.test.ts`：两层合并、持久化目的地不串层、isAllowed 兼容内容规则。
- `cli/test/permission-options.test.ts`：各工具选项构造、safety 裁剪、bash buildUpdates 规则形态。
- `cli/test/tui.test.tsx` e2e：数字直选放行、Esc 拒绝、会话级选项后第二次编辑免弹窗 + footer、Tab 附言回流拒绝文案、plan 模式直接拒写、并发只读 ask 队列逐个确认。

## 顺手修复（遗留问题，与本特性无关）
- `pty-input-app.tsx` 在 tsconfig include 之外，tsx 退回 classic JSX 转换 → 显式 `import React` 兜底。
- `pty-smoke.test.ts` 探针用 `stdio:"ignore"` 而真实调用用 pipe：macOS BSD `script` 对 socketpair stdin 的 `tcgetattr` 报错，探针误判"支持"→ 探针改为与真实调用同形，让不支持的环境按设计自跳过。

## 已知边界（后续任务的接口）
- plan 模式目前只有权限层语义（只读放行、写拒绝并引导先给计划）；ExitPlanMode 审批对话框（规格 §7）待 plan 工作流落地后补。
- 对话框内附言输入不支持粘贴/光标移动（单行末尾追加式）；与规格 §2.4 的完整输入框差距记录在案。
- bypass 模式仅当 settings `defaultMode: "bypassPermissions"` 声明时进入循环（等价"启动时声明才可用"）。
