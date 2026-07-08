/**
 * 输入预处理 —— @文件 引用展开
 *
 * 用户输入 "解释一下 @src/agent/engine.ts 里的循环" 时，把文件内容
 * 附加到消息尾部（保留原文，模型能同时看到指代和内容）。
 * 只展开真实存在的文件，@ 后面不是文件的（如邮箱）原样保留。
 */
import { existsSync, readFileSync, statSync } from "node:fs";

const MAX_FILE_CHARS = 30_000;

export function expandFileRefs(input: string): string {
  const refs = [...input.matchAll(/@([^\s"']+)/g)]
    .map((m) => m[1])
    .filter((p) => {
      try {
        return existsSync(p) && statSync(p).isFile();
      } catch {
        return false;
      }
    });

  if (refs.length === 0) return input;

  const attachments = refs.map((path) => {
    let text = readFileSync(path, "utf-8");
    if (text.length > MAX_FILE_CHARS) {
      text = text.slice(0, MAX_FILE_CHARS) + "\n… (已截断，完整内容请用 read_file 分页读取)";
    }
    return `\n\n[附件 @${path}]\n${text}`;
  });

  return input + attachments.join("");
}
