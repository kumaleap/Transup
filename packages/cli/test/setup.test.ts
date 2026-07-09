import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEnvText,
  ensureProviderConfigured,
  providerIsConfigured,
} from "../src/setup.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "transup-setup-"));
}

describe("first-run provider setup", () => {
  it("detects configured OpenAI-compatible and Anthropic providers", () => {
    expect(providerIsConfigured({ PROVIDER: "openai", OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(providerIsConfigured({ PROVIDER: "openai", OPENAI_WIRE_API: "responses", OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(providerIsConfigured({ PROVIDER: "openai-responses", OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(providerIsConfigured({ PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant" })).toBe(true);
    expect(providerIsConfigured({ PROVIDER: "openai" })).toBe(false);
    expect(providerIsConfigured({ PROVIDER: "openai-responses" })).toBe(false);
    expect(providerIsConfigured({ PROVIDER: "anthropic" })).toBe(false);
  });

  it("upserts OpenAI-compatible values while preserving unrelated .env lines", () => {
    const text = buildEnvText("CUSTOM=keep\nMODEL=old-model\n", {
      PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_API_KEY: "sk-new",
      MODEL: "deepseek-chat",
    });

    expect(text).toContain("CUSTOM=keep\n");
    expect(text).toContain("PROVIDER=openai\n");
    expect(text).toContain("OPENAI_BASE_URL=https://api.deepseek.com/v1\n");
    expect(text).toContain("OPENAI_API_KEY=sk-new\n");
    expect(text).toContain("MODEL=deepseek-chat\n");
    expect(text).not.toContain("MODEL=old-model");
  });

  it("writes .env from interactive answers and mutates env for the current process", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    const env: Record<string, string | undefined> = {};
    const answers = ["openai", "https://api.deepseek.com/v1", "deepseek-chat", "sk-live"];
    let out = "";

    const ok = await ensureProviderConfigured({
      env,
      envPath,
      interactive: true,
      out: (s) => (out += s),
      prompt: async () => answers.shift() ?? "",
    });

    expect(ok).toBe(true);
    expect(env).toMatchObject({
      PROVIDER: "openai",
      OPENAI_BASE_URL: "https://api.deepseek.com/v1",
      OPENAI_API_KEY: "sk-live",
      MODEL: "deepseek-chat",
    });
    expect(await readFile(envPath, "utf-8")).toContain("OPENAI_API_KEY=sk-live\n");
    expect(out).toContain("首次运行需要配置模型服务");
  });

  it("writes OpenAI Responses values from first-run answers", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    const env: Record<string, string | undefined> = {};
    const answers = ["responses", "https://sub2api.transup.ai", "gpt-5.5", "sk-live", "xhigh", "true"];

    const ok = await ensureProviderConfigured({
      env,
      envPath,
      interactive: true,
      out: () => {},
      prompt: async () => answers.shift() ?? "",
    });

    expect(ok).toBe(true);
    expect(env).toMatchObject({
      PROVIDER: "openai-responses",
      OPENAI_WIRE_API: "responses",
      OPENAI_BASE_URL: "https://sub2api.transup.ai",
      OPENAI_API_KEY: "sk-live",
      MODEL: "gpt-5.5",
      MODEL_REASONING_EFFORT: "xhigh",
      DISABLE_RESPONSE_STORAGE: "true",
    });
    const text = await readFile(envPath, "utf-8");
    expect(text).toContain("OPENAI_WIRE_API=responses\n");
    expect(text).toContain("MODEL_REASONING_EFFORT=xhigh\n");
    expect(text).toContain("DISABLE_RESPONSE_STORAGE=true\n");
  });

  it("preserves existing comments when updating a partial .env", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "# local notes\nCUSTOM=keep\n", "utf-8");
    const answers = ["anthropic", "sk-ant-live", "claude-opus-4-8", ""];

    const ok = await ensureProviderConfigured({
      env: {},
      envPath,
      interactive: true,
      out: () => {},
      prompt: async () => answers.shift() ?? "",
    });

    const text = await readFile(envPath, "utf-8");
    expect(ok).toBe(true);
    expect(text).toContain("# local notes\n");
    expect(text).toContain("CUSTOM=keep\n");
    expect(text).toContain("PROVIDER=anthropic\n");
    expect(text).toContain("ANTHROPIC_API_KEY=sk-ant-live\n");
    expect(text).toContain("ANTHROPIC_MODEL=claude-opus-4-8\n");
  });

  it("does not prompt or write when running non-interactively", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    let prompted = false;
    let err = "";

    const ok = await ensureProviderConfigured({
      env: { PROVIDER: "openai" },
      envPath,
      interactive: false,
      err: (s) => (err += s),
      prompt: async () => {
        prompted = true;
        return "";
      },
    });

    expect(ok).toBe(false);
    expect(prompted).toBe(false);
    expect(err).toContain("缺少 OPENAI_API_KEY");
  });
});
