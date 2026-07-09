/**
 * bash — 执行 shell 命令
 *
 * 最强大也最危险：readOnly:false 走权限门 + 超时保护 + 输出截断。
 * 用 spawn 而非 exec —— stdout/stderr 边产生边通过 onProgress 流给 UI
 * （npm install、测试这类长命令不用干等）。模型最终看到的仍是完整输出。
 * 沙箱（Seatbelt/Landlock）在 roadmap M6。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Tool } from "./types.js";

const MAX_OUTPUT = 10_000;

/**
 * Windows 上 shell:true 走 cmd.exe，而模型（和我们的 prompt）说的都是
 * POSIX shell —— `;`、`>&2`、`sleep` 在 cmd 里全是另一套语义。
 * 所以优先找 Git Bash；找不到才退回 cmd（并在工具描述里如实声明）。
 */
function findWindowsBash(): string | null {
  if (process.env.TRANSUP_SHELL) return process.env.TRANSUP_SHELL;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  // PATH 里的 bash（排除 System32 的 WSL 包装器 —— 那会跑进另一个系统）
  const r = spawnSync("where.exe", ["bash"], { encoding: "utf-8" });
  const found = (r.stdout ?? "")
    .split(/\r?\n/)
    .find((l) => l.trim() && !/System32/i.test(l));
  return found?.trim() ?? null;
}

const shellPath: string | true =
  process.platform === "win32" ? findWindowsBash() ?? true : true;

/**
 * 超时必须杀整棵进程树，否则孤儿进程拖住 stdio，close 永不触发。
 * POSIX 上只杀 shell 的 pid 是不够的：Linux 的 /bin/sh(dash) 会 fork 出
 * 真正的命令，shell 死了命令还活着并占着输出管道（macOS 的 shell 常直接
 * exec，侥幸杀得掉 —— CI 上第一次暴露）。配合 spawn 的 detached:true
 * 让子进程自成进程组，kill(-pid) 一次杀全组。
 */
function killTree(pid: number | undefined) {
  if (pid == null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // 负 pid = 整个进程组
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
}

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
      // detached: POSIX 上自成进程组，超时才能连孙进程一起杀（见 killTree）
      const child = spawn(command, {
        shell: shellPath,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
        // 兜底：就算还有漏网进程占着管道，主动断流让 close 能触发
        child.stdout.destroy();
        child.stderr.destroy();
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
