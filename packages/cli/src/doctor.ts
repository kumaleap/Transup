import { normalizeResponsesBaseURL, type Settings } from "@transup/core";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  cwd?: string;
  stdinIsTTY?: boolean;
  settings?: Settings;
  out?: (s: string) => void;
}

export function collectDoctorDiagnostics(opts: DoctorOptions = {}): DoctorCheck[] {
  const env = opts.env ?? process.env;
  const nodeVersion = opts.nodeVersion ?? process.version;
  const cwd = opts.cwd ?? process.cwd();
  const stdinIsTTY = opts.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const settings = opts.settings ?? {};
  const checks: DoctorCheck[] = [];

  const major = Number(/^v?(\d+)/.exec(nodeVersion)?.[1] ?? 0);
  checks.push({
    name: "Node",
    status: major >= 26 ? "ok" : "fail",
    detail: major >= 26 ? `${nodeVersion} satisfies >=26` : `${nodeVersion} is below required >=26`,
  });

  const provider =
    env.PROVIDER === "anthropic" ? "anthropic"
    : env.PROVIDER === "openai-responses" || env.OPENAI_WIRE_API === "responses" ? "openai-responses"
    : "openai";
  if (provider === "anthropic") {
    checks.push({
      name: "Provider",
      status: env.ANTHROPIC_API_KEY ? "ok" : "fail",
      detail: env.ANTHROPIC_API_KEY
        ? `PROVIDER=anthropic model=${env.ANTHROPIC_MODEL ?? "claude-opus-4-8"}`
        : "PROVIDER=anthropic requires ANTHROPIC_API_KEY",
    });
  } else if (provider === "openai-responses") {
    const baseURL = env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const effectiveBaseURL = normalizeResponsesBaseURL(baseURL);
    checks.push({
      name: "Provider",
      status: env.OPENAI_API_KEY ? "ok" : "fail",
      detail: env.OPENAI_API_KEY
        ? `PROVIDER=openai-responses wire=responses model=${env.MODEL ?? "gpt-5.1"} base=${baseURL} effective=${effectiveBaseURL}`
        : "PROVIDER=openai-responses requires OPENAI_API_KEY",
    });
  } else {
    checks.push({
      name: "Provider",
      status: env.OPENAI_API_KEY ? "ok" : "fail",
      detail: env.OPENAI_API_KEY
        ? `PROVIDER=openai model=${env.MODEL ?? "gpt-4o"} base=${env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}`
        : "PROVIDER=openai requires OPENAI_API_KEY",
    });
  }

  const allow = settings.permissions?.allow?.length ?? 0;
  const mcp = Object.keys(settings.mcpServers ?? {}).length;
  checks.push({
    name: "Settings",
    status: "ok",
    detail: `${allow} persistent permission rule(s), ${mcp} MCP server(s) configured`,
  });

  checks.push({
    name: "Terminal",
    status: stdinIsTTY ? "ok" : "warn",
    detail: stdinIsTTY ? "interactive TUI is available" : "stdin is not a TTY; use headless -p for pipes/CI",
  });

  checks.push({
    name: "Workspace",
    status: cwd ? "ok" : "fail",
    detail: cwd || "current working directory is unavailable",
  });

  return checks;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const checks = collectDoctorDiagnostics(opts);
  out("Transup doctor\n");
  for (const check of checks) {
    out(`${icon(check.status)} ${check.name}: ${check.detail}\n`);
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  out(`\n${checks.length} checks, ${failures} failure(s), ${warnings} warning(s)\n`);
  return failures > 0 ? 1 : 0;
}

function icon(status: DoctorStatus): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  return "✗";
}
