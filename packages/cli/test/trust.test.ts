import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("workspace trust CLI", () => {
  it("在帮助中提供显式 trust action", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        join(process.cwd(), "packages/cli/src/index.ts"),
        "--help",
      ],
      { encoding: "utf-8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("transup trust");
  });
});
