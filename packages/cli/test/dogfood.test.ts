import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDogfood } from "../src/dogfood.js";
import type { TraceEntry } from "../src/trace.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "transup-dogfood-"));
}

function entry(event: TraceEntry["event"]): TraceEntry {
  return {
    version: 1,
    timestamp: "2026-07-09T00:00:00.000Z",
    sessionId: "dogfood-session",
    providerId: "mock",
    model: "mock-1",
    cwd: "/repo",
    turn: 1,
    event,
  };
}

async function writeTrace(path: string, events: TraceEntry["event"][]) {
  await writeFile(path, events.map((event) => JSON.stringify(entry(event))).join("\n") + "\n", "utf-8");
}

describe("dogfood fixture runner", () => {
  it("passes readable trace fixtures that finish with turn_end", async () => {
    const dir = await tempDir();
    await writeTrace(join(dir, "basic.jsonl"), [
      { type: "text_delta", text: "hello" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "turn_end", reason: "done" },
    ]);

    let out = "";
    const code = await runDogfood({ fixturesDir: dir, out: (s) => (out += s) });

    expect(code).toBe(0);
    expect(out).toContain("✓ basic.jsonl");
    expect(out).toContain("1 fixture(s), 1 passed, 0 failed");
  });

  it("fails fixtures that never reach turn_end", async () => {
    const dir = await tempDir();
    await writeTrace(join(dir, "stalled.jsonl"), [{ type: "text_delta", text: "still running" }]);

    let out = "";
    const code = await runDogfood({ fixturesDir: dir, out: (s) => (out += s) });

    expect(code).toBe(1);
    expect(out).toContain("✗ stalled.jsonl: missing turn_end");
    expect(out).toContain("1 fixture(s), 0 passed, 1 failed");
  });

  it("validates the repository dogfood fixtures", async () => {
    const fixturesDir = resolve("fixtures/dogfood");
    await mkdir(fixturesDir, { recursive: true });

    let out = "";
    const code = await runDogfood({ fixturesDir, out: (s) => (out += s) });

    expect(code).toBe(0);
    expect(out).toContain("fixture(s)");
    expect(out).toContain("0 failed");
  });
});
