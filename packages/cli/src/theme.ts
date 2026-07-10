/**
 * 主题 —— transup 的设计语言（极简精致：品牌绿 + 中性灰）
 *
 * 所有组件的颜色从这里取，禁止散落的硬编码颜色：
 *   - Ink 组件用 T.*（hex，chalk 会按终端能力自动降级）
 *   - 纯字符串渲染（banner/diff）用 paint.*（256 色 ANSI，现代终端全兼容）
 *
 * 语义约定：
 *   primary   品牌绿 —— logo、交互焦点（输入提示符、模型名、spinner）
 *   secondary 中性灰 —— 次级标题、辅助信息（不与正文抢焦点）
 *   success/warn/danger —— 结果语义（绿/琥珀/红）
 *
 * 设计原则：一屏之内只有品牌绿一种彩色是常驻的，其余彩色只在
 * 结果语义出现时短暂登场；大面积元素（边框/分隔线）一律中性灰。
 */

/** Ink 组件用的 hex（<Text color={T.primary}>） */
export const T = {
  primary: "#00d787", // 品牌绿（≈ 256 色 42，与 paint 一致）
  secondary: "#949494", // 中性灰（≈ 246）
  success: "#5fd787", // 柔和绿（≈ 78）—— 比品牌绿低一档饱和，结果行不刺眼
  warn: "#d7af5f", // 琥珀（≈ 179）
  danger: "#ff5f5f", // 红（≈ 203）
  border: "#4e4e4e", // 低调灰 —— 输入框边框，跟记录区分隔又不抢眼（≈ 239）
} as const;

const fg =
  (n: number) =>
  (s: string): string =>
    `\x1b[38;5;${n}m${s}\x1b[0m`;

const bg =
  (n: number) =>
  (s: string): string =>
    `\x1b[48;5;${n}m${s}\x1b[0m`;

/** 纯字符串渲染用的 256 色画笔 */
export const paint = {
  primary: fg(42),
  secondary: fg(246),
  success: fg(78),
  warn: fg(179),
  danger: fg(203),
  /** 深灰 —— 边框等大面积低调元素 */
  frame: fg(239),
  /** diff 整行背景 —— 深绿增 / 深红删，前景保持代码原文 */
  diffAddBg: bg(22),
  diffRemoveBg: bg(52),
};
