/**
 * diff 预览 —— 权限确认体验的关键
 *
 * 用户批准一次文件修改前，看到的应该是"改了什么"（红删绿增），
 * 而不是一坨 JSON 参数。这里不引入 diff 库：edit_file 的语义就是
 * old_string → new_string 的替换，直接把两段按行染色即可。
 */
import { existsSync, readFileSync } from "node:fs";
import { color } from "./ui.js";

const MAX_PREVIEW_LINES = 40;

function capLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    return [...lines.slice(0, MAX_PREVIEW_LINES), `… (共 ${lines.length} 行)`];
  }
  return lines;
}

/** edit_file 的预览：old 红 / new 绿 */
export function renderEditPreview(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");

  const out: string[] = [color.bold(`  修改 ${path}`)];
  for (const line of capLines(oldStr)) out.push(color.red(`  - ${line}`));
  for (const line of capLines(newStr)) out.push(color.green(`  + ${line}`));
  return out.join("\n");
}

/** write_file 的预览：新建显示内容头部，覆盖则明确警告 */
export function renderWritePreview(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const content = String(args.content ?? "");
  const lineCount = content.split("\n").length;

  const overwriting = existsSync(path);
  const header = overwriting
    ? color.red(color.bold(`  ⚠ 覆盖已有文件 ${path}`)) +
      color.dim(`（原文件 ${readFileSync(path, "utf-8").split("\n").length} 行 → 新 ${lineCount} 行）`)
    : color.bold(`  新建 ${path}`) + color.dim(`（${lineCount} 行）`);

  const preview = capLines(content).map((l) => color.green(`  + ${l}`));
  return [header, ...preview].join("\n");
}
