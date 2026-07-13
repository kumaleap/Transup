import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {describe, expect, it} from "vitest";

const BRACKETED_PASTE_ENABLE = "\u001B[?2004h";
const BRACKETED_PASTE_DISABLE = "\u001B[?2004l";
const BRACKETED_PASTE_START = "\u001B[200~";
const BRACKETED_PASTE_END = "\u001B[201~";
const DECLARED_CURSOR_ESCAPE =
  /(?:\u001B\[\d+A)?\u001B\[\d*G\u001B\[\?25h/;
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SCRIPT_EXIT_MARKER = "__TRANSUP_PTY_SCRIPT_EXIT__:";
const SCRIPT_EXIT_PATTERN = /__TRANSUP_PTY_SCRIPT_EXIT__:(\d+)/;
const PROCESS_TIMEOUT_MS = 12_000;
const CLEANUP_GRACE_MS = 500;

type PtySupport =
  | {supported: true; platform: "darwin" | "linux"}
  | {supported: false; reason: string};

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ScriptInvocation {
  command: string;
  args: string[];
}

function detectPtySupport(): PtySupport {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      supported: false,
      reason: `system script PTY driver is unsupported on ${process.platform}`,
    };
  }

  const probeArgs = process.platform === "darwin"
    ? ["-q", "/dev/null", "/usr/bin/true"]
    : ["-qefc", "exit 0", "/dev/null"];
  const probe = spawnSync("script", probeArgs, {
    stdio: "ignore",
    timeout: 3_000,
  });

  if (probe.error) {
    return {
      supported: false,
      reason: probe.error.message,
    };
  }
  if (probe.status !== 0) {
    return {
      supported: false,
      reason: "system script does not support the required PTY invocation",
    };
  }

  return {supported: true, platform: process.platform};
}

function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function scriptInvocation(
  platform: "darwin" | "linux",
  tsxPath: string,
  fixturePath: string,
): ScriptInvocation {
  if (platform === "darwin") {
    const args = ["-q", "/dev/null", tsxPath, fixturePath]
      .map(shellQuote)
      .join(" ");
    // Darwin's script rejects Node's socket-backed stdin pipe. The marker lets
    // the parent release cat immediately if script exits before Node input.
    const bridge = [
      "exec /bin/cat | {",
      `  /usr/bin/script ${args}`,
      "  status=$?",
      `  printf '\n${SCRIPT_EXIT_MARKER}%s\n' "$status"`,
      '  exit "$status"',
      "}",
    ].join("\n");
    return {
      command: "/bin/sh",
      args: ["-c", bridge],
    };
  }
  const command = `${shellQuote(tsxPath)} ${shellQuote(fixturePath)}`;
  return {command: "script", args: ["-qefc", command, "/dev/null"]};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    timer.unref();
  });
}

function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<ChildExit>,
): Promise<void> {
  const closesWithinGrace = async (): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([
      closed.then(() => true),
      delay(CLEANUP_GRACE_MS).then(() => false),
    ]);
  };

  child.stdin.destroy();
  if (child.exitCode !== null || child.signalCode !== null) return;

  signalProcessGroup(child, "SIGTERM");
  if (await closesWithinGrace()) return;

  signalProcessGroup(child, "SIGKILL");
  if (await closesWithinGrace()) return;

  child.kill("SIGKILL");
  if (await closesWithinGrace()) return;
  throw new Error(`failed to terminate PTY fixture process ${child.pid ?? "unknown"}`);
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  getOutput: () => string,
  predicate: (output: string) => boolean,
): Promise<void> {
  return new Promise((resolveOutput, rejectOutput) => {
    const cleanup = () => {
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("close", onClose);
    };
    const check = () => {
      const output = getOutput();
      const scriptExit = SCRIPT_EXIT_PATTERN.exec(output);
      if (scriptExit) {
        cleanup();
        child.stdin.destroy();
        rejectOutput(
          new Error(
            `PTY fixture exited before it was ready (code=${scriptExit[1]}, signal=null); ` +
            `output=${diagnostic(output)}`,
          ),
        );
        return;
      }
      if (!predicate(output)) return;
      cleanup();
      resolveOutput();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectOutput(
        new Error(
          `PTY fixture exited before it was ready (code=${code}, signal=${signal}); ` +
          `output=${diagnostic(getOutput())}`,
        ),
      );
    };

    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("close", onClose);
    check();
  });
}

function diagnostic(output: string): string {
  return JSON.stringify(output.slice(-4_000));
}

const support = detectPtySupport();

describe("terminal input PTY smoke", () => {
  if (!support.supported) {
    it.skip(
      `requires a compatible system script PTY driver: ${support.reason}`,
      () => undefined,
    );
    return;
  }

  it(
    "submits expanded bracketed paste and emits paste-mode and cursor escapes",
    async () => {
      const testDirectory = mkdtempSync(join(tmpdir(), "transup-pty-input-"));
      const testFile = fileURLToPath(import.meta.url);
      const workspaceRoot = resolve(dirname(testFile), "../../../..");
      const tsxPath = join(workspaceRoot, "node_modules", ".bin", "tsx");
      const fixturePath = resolve(dirname(testFile), "../fixtures/pty-input-app.tsx");
      const invocation = scriptInvocation(support.platform, tsxPath, fixturePath);
      const child = spawn(
        invocation.command,
        invocation.args,
        {
          cwd: testDirectory,
          detached: true,
          env: {
            ...process.env,
            CI: "false",
            CONTINUOUS_INTEGRATION: "false",
            TERM: process.env.TERM ?? "xterm-256color",
            TRANSUP_PTY_HISTORY_PATH: join(testDirectory, "history.jsonl"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        output += chunk;
      });

      const closed = new Promise<ChildExit>((resolveClose) => {
        child.once("close", (code, signal) => resolveClose({code, signal}));
      });
      const spawnFailed = new Promise<never>((_resolve, rejectSpawn) => {
        child.once("error", rejectSpawn);
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, rejectTimeout) => {
        timeout = setTimeout(() => {
          rejectTimeout(
            new Error(`PTY fixture timed out; output=${diagnostic(output)}`),
          );
        }, PROCESS_TIMEOUT_MS);
        timeout.unref();
      });

      try {
        const ready = waitForOutput(
          child,
          () => output,
          (current) =>
            current.includes(BRACKETED_PASTE_ENABLE) &&
            DECLARED_CURSOR_ESCAPE.test(current),
        );
        await Promise.race([ready, spawnFailed, timedOut]);

        const pasted = "first line\n第二行\nthird line";
        child.stdin.write(
          `${BRACKETED_PASTE_START}${pasted}${BRACKETED_PASTE_END}`,
        );
        const pasteRendered = waitForOutput(
          child,
          () => output,
          (current) => current.includes("[Pasted text #1 +2 lines]"),
        );
        await Promise.race([pasteRendered, spawnFailed, timedOut]);
        child.stdin.end("\r");

        const result = await Promise.race([closed, spawnFailed, timedOut]);
        if (result.code !== 0) {
          throw new Error(
            `PTY fixture failed (code=${result.code}, signal=${result.signal}); ` +
              `output=${diagnostic(output)}`,
          );
        }

        const plainOutput = output
          .replace(ANSI_ESCAPE, "")
          .replace(/\r\n?/g, "\n");
        expect(plainOutput).toContain("[Pasted text #1 +2 lines]");
        expect(plainOutput).toContain(`SUBMITTED:${pasted}`);
        expect(output).toContain(BRACKETED_PASTE_ENABLE);
        expect(output).toContain(BRACKETED_PASTE_DISABLE);
        expect(output).toMatch(DECLARED_CURSOR_ESCAPE);
      } finally {
        if (timeout) clearTimeout(timeout);
        try {
          await terminateChild(child, closed);
        } finally {
          rmSync(testDirectory, {recursive: true, force: true});
        }
      }
    },
    15_000,
  );
});
