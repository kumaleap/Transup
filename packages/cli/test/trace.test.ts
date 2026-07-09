import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@transup/core";
import { TraceRecorder, readTrace, renderTrace } from "../src/trace.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "transup-trace-"));
}

describe("trace recorder", () => {
  it("writes agent events as append-only JSONL with stable run metadata", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "s1",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });

    await recorder.record({ type: "text_delta", text: "hello" });
    await recorder.record({ type: "turn_end", reason: "done" });

    const text = await readFile(recorder.path, "utf-8");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      version: 1,
      sessionId: "s1",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
      turn: 1,
      event: { type: "text_delta", text: "hello" },
    });
    expect(lines[1].event).toEqual({ type: "turn_end", reason: "done" });
    expect(typeof lines[0].timestamp).toBe("string");
  });

  it("reads traces while skipping damaged JSONL lines", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "s1",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });

    await recorder.record({ type: "text_delta", text: "ok" });
    await recorder.appendRaw("{broken");
    await recorder.record({ type: "turn_end", reason: "done" });

    const entries = await readTrace(recorder.path);

    expect(entries.map((entry) => entry.event.type)).toEqual(["text_delta", "turn_end"]);
  });
});

describe("trace replay renderer", () => {
  it("renders a deterministic, human-readable event timeline", () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "hello" },
      {
        type: "tool_start",
        call: { id: "t1", name: "list_dir", args: "{\"path\":\".\"}" },
        parsedArgs: { path: "." },
      },
      { type: "tool_end", call: { id: "t1", name: "list_dir", args: "{}" }, content: "README.md", isError: false },
      { type: "turn_end", reason: "done" },
    ];

    const text = renderTrace(
      events.map((event, index) => ({
        version: 1,
        timestamp: `2026-07-09T00:00:0${index}.000Z`,
        sessionId: "s1",
        providerId: "mock",
        model: "mock-1",
        cwd: "/repo",
        turn: 1,
        event,
      })),
    );

    expect(text).toContain("Trace s1 · mock/mock-1 · /repo");
    expect(text).toContain("[1] text: hello");
    expect(text).toContain("[1] tool_start: list_dir({\"path\":\".\"})");
    expect(text).toContain("[1] tool_end: list_dir ok README.md");
    expect(text).toContain("[1] turn_end: done");
  });
});
