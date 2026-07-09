import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Env = Record<string, string | undefined>;

export interface SetupOptions {
  env?: Env;
  envPath?: string;
  interactive?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
  prompt?: (question: string) => Promise<string>;
}

const DEFAULT_ENV_PATH = ".env";
const OPENAI_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const OPENAI_DEFAULT_MODEL = "deepseek-chat";
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-8";

const ORDER = [
  "PROVIDER",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
];

export function providerIsConfigured(env: Env = process.env): boolean {
  if (env.PROVIDER === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
  return Boolean(env.OPENAI_API_KEY);
}

export function missingProviderConfigMessage(env: Env = process.env): string {
  if (env.PROVIDER === "anthropic") return "缺少 ANTHROPIC_API_KEY";
  return "缺少 OPENAI_API_KEY";
}

export function buildEnvText(existing: string, values: Env): string {
  const pending = new Map(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ""),
  );
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const key = match[1];
    if (pending.has(key)) {
      out.push(`${key}=${formatEnvValue(pending.get(key)!)}`);
      pending.delete(key);
    } else {
      out.push(line);
    }
  }

  for (const key of ORDER) {
    if (!pending.has(key)) continue;
    out.push(`${key}=${formatEnvValue(pending.get(key)!)}`);
    pending.delete(key);
  }
  for (const [key, value] of pending) {
    out.push(`${key}=${formatEnvValue(value!)}`);
  }

  return out.join("\n").replace(/\n*$/, "") + "\n";
}

export async function ensureProviderConfigured(opts: SetupOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  if (providerIsConfigured(env)) return true;

  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
  const err = opts.err ?? ((s) => process.stderr.write(s));
  if (!interactive) {
    err(`${missingProviderConfigMessage(env)}。请运行交互式 transup 完成首次初始化，或手动创建 .env。\n`);
    return false;
  }

  const out = opts.out ?? ((s) => process.stdout.write(s));
  const terminalPrompt = opts.prompt ? null : createTerminalPrompt();
  const prompt = opts.prompt ?? terminalPrompt!.prompt;

  try {
    out("首次运行需要配置模型服务，配置会写入项目根目录 .env。\n");
    const providerAnswer = normalizeProvider(
      await ask(prompt, "Provider [openai/anthropic]", env.PROVIDER ?? "openai"),
    );

    const values =
      providerAnswer === "anthropic"
        ? await collectAnthropic(prompt, env, err)
        : await collectOpenAI(prompt, env, err);
    if (!values) return false;

    const envPath = opts.envPath ?? DEFAULT_ENV_PATH;
    let existing = "";
    try {
      existing = await readFile(envPath, "utf-8");
    } catch {
      existing = "";
    }
    await writeFile(envPath, buildEnvText(existing, values), { encoding: "utf-8", mode: 0o600 });
    Object.assign(env, values);
    out(`已写入 ${envPath}，继续启动 Transup。\n`);
    return true;
  } finally {
    terminalPrompt?.close();
  }
}

async function collectOpenAI(
  prompt: (question: string) => Promise<string>,
  env: Env,
  err: (s: string) => void,
): Promise<Env | null> {
  const baseURL = await ask(prompt, "OpenAI 兼容 Base URL", env.OPENAI_BASE_URL ?? OPENAI_DEFAULT_BASE_URL);
  const model = await ask(prompt, "Model", env.MODEL ?? OPENAI_DEFAULT_MODEL);
  const apiKey = (await prompt("OPENAI_API_KEY: ")).trim();
  if (!apiKey) {
    err("OPENAI_API_KEY 不能为空。\n");
    return null;
  }
  return {
    PROVIDER: "openai",
    OPENAI_BASE_URL: baseURL,
    OPENAI_API_KEY: apiKey,
    MODEL: model,
  };
}

async function collectAnthropic(
  prompt: (question: string) => Promise<string>,
  env: Env,
  err: (s: string) => void,
): Promise<Env | null> {
  const apiKey = (await prompt("ANTHROPIC_API_KEY: ")).trim();
  if (!apiKey) {
    err("ANTHROPIC_API_KEY 不能为空。\n");
    return null;
  }
  const model = await ask(prompt, "Anthropic model", env.ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL);
  const baseURL = (await prompt("ANTHROPIC_BASE_URL（可选，直接回车跳过）: ")).trim();
  return {
    PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ...(baseURL && { ANTHROPIC_BASE_URL: baseURL }),
  };
}

async function ask(
  prompt: (question: string) => Promise<string>,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await prompt(`${label} (${defaultValue}): `)).trim();
  return answer || defaultValue;
}

function normalizeProvider(answer: string): "openai" | "anthropic" {
  return answer.toLowerCase().startsWith("anthropic") ? "anthropic" : "openai";
}

function createTerminalPrompt(): {
  prompt: (question: string) => Promise<string>;
  close: () => void;
} {
  const rl = createInterface({ input, output });
  return {
    prompt: (question) => rl.question(question),
    close: () => rl.close(),
  };
}

function formatEnvValue(value: string): string {
  if (/^[^\s"'#]+$/.test(value)) return value;
  return JSON.stringify(value);
}
