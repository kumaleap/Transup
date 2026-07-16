/**
 * ANSI 上色工具。Ink 的 <Text> 原样透传 ANSI 码，
 * 所以纯字符串渲染器（diff 预览、语法高亮）继续用它。
 */

const codes = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  inverse: "\x1b[7m",
};

export const color = {
  dim: (s: string) => `${codes.dim}${s}${codes.reset}`,
  bold: (s: string) => `${codes.bold}${s}${codes.reset}`,
  italic: (s: string) => `${codes.italic}${s}${codes.reset}`,
  underline: (s: string) => `${codes.underline}${s}${codes.reset}`,
  cyan: (s: string) => `${codes.cyan}${s}${codes.reset}`,
  yellow: (s: string) => `${codes.yellow}${s}${codes.reset}`,
  green: (s: string) => `${codes.green}${s}${codes.reset}`,
  red: (s: string) => `${codes.red}${s}${codes.reset}`,
  magenta: (s: string) => `${codes.magenta}${s}${codes.reset}`,
  inverse: (s: string) => `${codes.inverse}${s}${codes.reset}`,
};
