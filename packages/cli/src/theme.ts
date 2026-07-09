/**
 * 主题 —— transup 的设计语言（未来感：电光青 → 霓虹紫）
 *
 * 所有组件的颜色从这里取，禁止散落的硬编码颜色：
 *   - Ink 组件用 T.*（hex，chalk 会按终端能力自动降级）
 *   - 纯字符串渲染（banner/diff）用 paint.*（256 色 ANSI，现代终端全兼容）
 *   - 渐变（logo/tagline）用 gradientText / gradientLines
 *
 * 语义约定：
 *   primary   电光青 —— 品牌主色：交互焦点（输入提示符、模型名、spinner）
 *   secondary 霓虹紫 —— 工具活动、次级标题
 *   success/warn/danger —— 结果语义（绿/琥珀/霓虹粉）
 */

/** Ink 组件用的 hex（<Text color={T.primary}>） */
export const T = {
  primary: "#00d7ff", // 电光青（≈ 256 色 45，与 paint 一致）
  secondary: "#af87ff", // 霓虹紫（≈ 256 色 141）
  success: "#5fff87", // 荧光绿（≈ 84）
  warn: "#ffaf5f", // 琥珀（≈ 215）
  danger: "#ff5f87", // 霓虹粉（≈ 204）
} as const;

/** 电光青 → 霓虹紫 的 256 色渐变坡道（logo、tagline 用） */
const RAMP = [51, 45, 39, 63, 99, 135, 141];

const fg =
  (n: number) =>
  (s: string): string =>
    `\x1b[38;5;${n}m${s}\x1b[0m`;

/** 纯字符串渲染用的 256 色画笔 */
export const paint = {
  primary: fg(45),
  secondary: fg(141),
  success: fg(84),
  warn: fg(215),
  danger: fg(204),
  /** 深蓝紫 —— 边框等大面积低调元素 */
  frame: fg(60),
};

/** 按行做垂直渐变（CLI logo） */
export function gradientLines(lines: string[]): string[] {
  return lines.map((line, i) => rampAt(i, lines.length)(line));
}

/** 渐变坡道上第 i/total 档的画笔（逐行上色时用） */
export function rampAt(i: number, total: number): (s: string) => string {
  const idx = Math.round((i / Math.max(total - 1, 1)) * (RAMP.length - 1));
  return fg(RAMP[idx]);
}

/** 按字符做水平渐变（tagline）。bold 时用单次尾部 reset，避免逐字重置打断粗体。 */
export function gradientText(s: string, opts: { bold?: boolean } = {}): string {
  const chars = [...s];
  const last = Math.max(chars.length - 1, 1);
  let out = "";
  chars.forEach((ch, i) => {
    const idx = Math.round((i / last) * (RAMP.length - 1));
    out += `\x1b[${opts.bold ? "1;" : ""}38;5;${RAMP[idx]}m${ch}`;
  });
  return out + "\x1b[0m";
}
