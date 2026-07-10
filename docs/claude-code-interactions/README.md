# Claude Code 交互细节研究文档

> 来源：对同级仓库 `../claude-code-analysis`（Claude Code 泄露源码 + 静态分析文档，1902 个源文件 / 51 万行）的深度调研。
> 用途：作为 Transup TUI 交互开发的**实现参考规格**。每篇文档细化到符号、颜色 RGB、毫秒参数、状态机流转，可直接照着实现。
> 引用路径均相对于 `claude-code-analysis` 仓库根目录（如 `src/components/Spinner.tsx`）。
> 注意：该仓库 `src/` 下 `.tsx` 是 React Compiler 编译产物，但文件尾部 sourcemap 的 `sourcesContent` 内嵌了原始源码。

## 文档目录

| 文档 | 主题 | 关键内容 |
|---|---|---|
| [01-输入系统](./01-输入系统.md) | PromptInput 五层输入栈 | 编辑内核、`!` 模式、粘贴折叠、历史、补全、快捷键、vim |
| [02-流式输出与活动行](./02-流式输出与活动行.md) | Spinner 与流式渲染 | 帧动画、glimmer、停滞变红、token 计数、按行上屏、中断 |
| [03-消息视觉格式](./03-消息视觉格式.md) | 每类消息的精确外观 | ⏺/⎿ 符号、diff 渲染、Markdown、todo 列表、折叠展开 |
| [04-权限系统与对话框](./04-权限系统与对话框.md) | 权限链路与全部 Dialog | 判定优先级、每工具对话框、plan 审批、持久化目的地 |
| [05-REPL骨架与终端集成](./05-REPL骨架与终端集成.md) | App/布局/自研 Ink | 插槽化 Layout、双缓冲 diff、alt-screen、鼠标、OSC 通知 |
| [06-状态展示与命令面板](./06-状态展示与命令面板.md) | statusline/面板/后台任务 | statusline hook、/model /config 等面板、任务 pill 与详情 |
| [07-核心机制交互体验](./07-核心机制交互体验.md) | 机制层 UX | auto-compact 三段式、resume、subagent 呈现、隐藏功能、交互 hooks |

## 总体架构速览

```
App(纯 Provider 壳) → REPL(单一巨型屏, 5005 行)
  ├─ FullscreenLayout 插槽: scrollable / bottom / overlay / modal / bottomFloat
  ├─ Messages(消息流, static 判定 + memo 跳渲)
  ├─ PromptInput(输入编排器, 2338 行)
  │    └─ TextInput/VimTextInput → useTextInput/useVimInput → Cursor+MeasuredText
  ├─ Spinner(50ms 共享时钟, 叶子隔离)
  └─ 自研 ink fork(双缓冲 cell diff + DEC 2026 原子换帧)
```

## Transup 实现优先级建议（综合各篇）

1. **编辑地基**：不可变 Cursor + MeasuredText（grapheme/宽字符/折行/视口）
2. **双击原语**：useDoublePress（800ms）→ Ctrl-C/D 退出、Esc 清空
3. **粘贴**：bracketed paste + 100ms 聚合 + pendingRef 同步镜像 + `[Pasted text #N +M lines]` 折叠
4. **keybinding 解析器**：上下文栈（Global/Chat/Autocomplete/…）、last-wins、alt/meta 合并、保留键
5. **模式系统**：`!` 前缀"单字符插入即模式" + 边框/提示符换色；Shift+Tab 权限模式循环
6. **权限弹窗**：单一 ToolUseConfirm 队列 + 按工具路由 + 三段式选项模板（Yes / Yes-scoped / No，Tab 附言）
7. **流式**：delta 直接 setState 靠渲染层 16ms 节流、按整行上屏、StreamingMarkdown 稳定前缀增量解析
8. **消息定型**：tool_use 全 resolve 即 static，memo 永久跳渲 + OffscreenFreeze
9. **状态行**：spinner 动词表 + todo activeForm 联动 + 30s 后显示计时/token
10. **压缩 UX 三段式**：倒计时警告 → spinner → 一行摘要卡 + ctrl+o 展开
