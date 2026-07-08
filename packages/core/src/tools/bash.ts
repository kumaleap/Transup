/**
 * bash — 执行 shell 命令
 *
 * 最强大也最危险：readOnly:false 走权限门 + 超时保护 + 输出截断。
 * 用 spawn 而非 exec —— stdout/stderr 边产生边通过 onProgress 流给 UI
 * （npm install、测试这类长命令不用干等）。模型最终看到的仍是完整输出。
 * 沙箱（Seatbelt/Landlock）在 roadmap M6。
 */
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "./types.js";

const MAX_OUTPUT = 10_000;

const schema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  timeout_seconds: z.number().optional().describe("超时秒数，默认 60"),
});

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n… (输出已截断)" : s;
}

export const bashTool: Tool<typeof schema> = {
  name: "bash",
  description:
    "执行 shell 命令并返回 stdout/stderr。用于运行测试、git 操作、安装依赖等。" +
    "禁止执行交互式命令（如 vim、git rebase -i）。",
  schema,
  readOnly: false,
  execute({ command, timeout_seconds = 60 }, onProgress) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, { shell: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout_seconds * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        onProgress?.(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        onProgress?.(text);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`命令启动失败: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const out = [stdout && truncate(stdout), stderr && `[stderr]\n${truncate(stderr)}`]
          .filter(Boolean)
          .join("\n");

        if (timedOut) {
          reject(new Error(`命令超时（${timeout_seconds}s）被终止\n${out}`));
        } else if (code !== 0) {
          // 失败信息完整交给模型 —— 它需要看到报错才能修复
          reject(new Error(`命令失败 (exit code ${code})\n${out}`));
        } else {
          resolve(out || "(命令执行成功，无输出)");
        }
      });
    });
  },
};
