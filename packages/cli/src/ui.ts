/**
 * 终端渲染。刻意极简（ANSI 上色），升级 Ink TUI 时只动这一层。
 */

const codes = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

export const color = {
  dim: (s: string) => `${codes.dim}${s}${codes.reset}`,
  bold: (s: string) => `${codes.bold}${s}${codes.reset}`,
  cyan: (s: string) => `${codes.cyan}${s}${codes.reset}`,
  yellow: (s: string) => `${codes.yellow}${s}${codes.reset}`,
  green: (s: string) => `${codes.green}${s}${codes.reset}`,
  red: (s: string) => `${codes.red}${s}${codes.reset}`,
  magenta: (s: string) => `${codes.magenta}${s}${codes.reset}`,
};

export function printToolCall(name: string, args: Record<string, unknown>) {
  const argStr = Object.entries(args)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ")
    .slice(0, 120);
  console.log(color.magenta(`⏺ ${name}`) + color.dim(`(${argStr})`));
}

export function printToolResult(result: string, isError: boolean) {
  const lines = result.split("\n");
  const preview = lines.slice(0, 3).join("\n  ");
  const more = lines.length > 3 ? color.dim(`\n  … 共 ${lines.length} 行`) : "";
  const mark = isError ? color.red("  ⎿ ") : color.dim("  ⎿ ");
  console.log(mark + color.dim(preview) + more);
}
