import { describe, expect, it } from "vitest";
import { collectDoctorDiagnostics, runDoctor } from "../src/doctor.js";

describe("doctor diagnostics", () => {
  it("fails fast when the default OpenAI-compatible provider lacks an API key", async () => {
    const checks = collectDoctorDiagnostics({
      env: { PROVIDER: "openai", MODEL: "deepseek-chat" },
      nodeVersion: "v22.0.0",
      cwd: "/repo",
      stdinIsTTY: true,
      settings: {},
    });

    expect(checks).toContainEqual({
      name: "Provider",
      status: "fail",
      detail: "PROVIDER=openai requires OPENAI_API_KEY",
    });
  });

  it("passes when Anthropic provider configuration and runtime basics are present", async () => {
    let out = "";
    const code = await runDoctor({
      env: { PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_MODEL: "claude-test" },
      nodeVersion: "v22.0.0",
      cwd: "/repo",
      stdinIsTTY: true,
      settings: { permissions: { allow: ["write_file"] } },
      out: (s) => (out += s),
    });

    expect(code).toBe(0);
    expect(out).toContain("✓ Node");
    expect(out).toContain("✓ Provider");
    expect(out).toContain("✓ Settings");
  });
});
