/**
 * 自定义状态行（规格 06 §1.1）—— "statusline 即 hook"
 *
 * 用户在 settings.statusLine.command 配一条 shell 命令，我们把会话状态
 * 打包成 JSON 从 stdin 喂给它，stdout 原样（含 ANSI 颜色）显示在状态栏
 * 上方。低成本高扩展：想显示 git 分支？天气？加班时长？写脚本就行。
 *
 * 约定（照抄 Claude Code 的合理设计）：
 *   - 超时 5 秒，超时/非 0 退出/空输出一律静默丢弃 —— 状态行是装饰，
 *     不能因为用户脚本坏了打扰主流程
 *   - 触发方 300ms debounce + 取消 in-flight（见 use-status-line.ts）
 */
import { spawn, spawnSync } from "node:child_process";

/** 喂给用户命令的会话状态快照（字段名对齐 Claude Code，脚本可迁移） */
export interface StatusLineInput {
  model: { id: string; display_name: string };
  workspace: { current_dir: string };
  version: string;
  permission_mode: string;
  cost: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_duration_ms: number;
  };
  context_window: {
    used_percentage: number;
  };
}

export interface StatusLineCommand {
  command: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 64 * 1024;

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    if (result.status === 0) return;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct-process fallback.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* Process already exited. */
  }
}

function spawnStatusLine(command: string) {
  return spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "ignore"] as const,
    detached: process.platform !== "win32",
  });
}

/**
 * 跑一次用户命令。任何失败（超时/非 0/信号/spawn 报错）都返回 null。
 * stdout 按行 trim 后重新拼接（去掉尾部空行，保留中间的多行输出）。
 */
export function runStatusLineCommand(
  config: StatusLineCommand,
  input: StatusLineInput,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);

    let child: ReturnType<typeof spawnStatusLine>;
    try {
      child = spawnStatusLine(config.command);
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    let outBytes = 0;
    let settled = false;
    let terminating = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      resolve(value);
    };

    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      killTree(child.pid);
      settle(null);
    };
    const onAbort = () => {
      terminate();
    };
    signal?.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      terminate();
    }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk);
      if (outBytes + chunkBytes > MAX_STDOUT_BYTES) {
        terminate();
        return;
      }
      outBytes += chunkBytes;
      out += chunk;
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => {
      if (terminating || code !== 0) return settle(null);
      const text = out
        .split("\n")
        .map((l) => l.trimEnd())
        .join("\n")
        .trim();
      settle(text || null);
    });

    child.stdin.on("error", () => {
      /* 用户命令不读 stdin 就退出会触发 EPIPE —— 无害 */
    });
    try {
      child.stdin.end(JSON.stringify(input));
    } catch {
      terminate();
    }
  });
}
