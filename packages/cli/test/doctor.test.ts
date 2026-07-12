import { describe, expect, it } from "vitest";
import { collectDoctorDiagnostics, runDoctor } from "../src/doctor.js";

describe("doctor diagnostics", () => {
  it("fails fast when the default OpenAI-compatible provider lacks an API key", async () => {
    const checks = collectDoctorDiagnostics({
      env: { PROVIDER: "openai", MODEL: "deepseek-chat" },
      nodeVersion: "v26.0.0",
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
      nodeVersion: "v26.0.0",
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

  it("reports OpenAI Responses wire API configuration", () => {
    const checks = collectDoctorDiagnostics({
      env: {
        PROVIDER: "openai",
        OPENAI_WIRE_API: "responses",
        OPENAI_BASE_URL: "https://sub2api.transup.ai",
        OPENAI_API_KEY: "sk-test",
        MODEL: "gpt-5.5",
      },
      nodeVersion: "v26.0.0",
      cwd: "/repo",
      stdinIsTTY: true,
      settings: {},
    });

    expect(checks).toContainEqual({
      name: "Provider",
      status: "ok",
      detail: "PROVIDER=openai-responses wire=responses model=gpt-5.5 base=https://sub2api.transup.ai effective=https://sub2api.transup.ai/v1",
    });
  });

  it("rejects Node versions below 26", () => {
    const node = collectDoctorDiagnostics({
      env: { OPENAI_API_KEY: "test" },
      nodeVersion: "v25.9.0",
      cwd: "/repo",
      stdinIsTTY: true,
      settings: {},
    }).find((check) => check.name === "Node");

    expect(node).toEqual({
      name: "Node",
      status: "fail",
      detail: "v25.9.0 is below required >=26",
    });
  });

  it("accepts Node 26", () => {
    const node = collectDoctorDiagnostics({
      env: { OPENAI_API_KEY: "test" },
      nodeVersion: "v26.5.0",
      cwd: "/repo",
      stdinIsTTY: true,
      settings: {},
    }).find((check) => check.name === "Node");

    expect(node).toEqual({
      name: "Node",
      status: "ok",
      detail: "v26.5.0 satisfies >=26",
    });
  });
});
