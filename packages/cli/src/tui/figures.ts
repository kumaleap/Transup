/**
 * 终端符号常量 —— 全部收拢在此（规格 §1.1），组件从这里导入，
 * 禁止在组件里散落符号字面量。平台自适应：⏺/❯ 在旧 Windows
 * 控制台（conhost + 点阵字体）常缺字形，按环境回退。
 */

/**
 * 现代终端探测（Windows Terminal / VS Code / JetBrains / xterm 系）。
 * 只在 win32 上用于决定是否回退 ASCII —— Unix 终端默认全支持。
 */
const modernWindowsTerminal =
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.TERM_PROGRAM) ||
  Boolean(process.env.TERMINAL_EMULATOR) ||
  /^(xterm|alacritty)/.test(process.env.TERM ?? "");

/** 消息/工具行左侧圆点（⏺ 垂直居中更好，但 Win/Linux 终端常缺字形） */
export const DOT = process.platform === "darwin" ? "⏺" : "●";

/** 工具结果行前缀符（"  ⎿  " 共 5 列的核心字符） */
export const RESULT_MARK = "⎿";

/** 列表点 */
export const BULLET_OPERATOR = "∙";

/** 系统提示行标记（如 compact 提示） */
export const TEARDROP_ASTERISK = "✻";

/** away-summary 回顾标记 */
export const REFERENCE_MARK = "※";

/** Markdown 引用块左侧竖条 */
export const BLOCKQUOTE_BAR = "▎";

/** user 消息前缀（旧 Windows 控制台回退 >，规格 §1.4） */
export const POINTER =
  process.platform === "win32" && !modernWindowsTerminal ? ">" : "❯";
