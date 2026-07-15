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

  it("strips terminal controls from replayed provider events and metadata", () => {
    const poison = "before\x1b]52;c;YXR0YWNr\x07\x1b[31m\x9b31m\x9d8;;evil\x9c\x7fafter";
    const text = renderTrace([
      {
        version: 1,
        timestamp: "2026-07-09T00:00:00.000Z",
        sessionId: poison,
        providerId: poison,
        model: poison,
        cwd: poison,
        turn: 1,
        event: { type: "text_delta", text: poison },
      },
    ]);

    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  it("keeps metadata, tool names, and errors inside their trace rows", () => {
    const inject = (value: string) => `${value}\n[99] forged\trow`;
    const base = {
      version: 1 as const,
      timestamp: "2026-07-09T00:00:00.000Z",
      sessionId: inject("session"),
      providerId: inject("provider"),
      model: inject("model"),
      cwd: inject("/repo"),
      turn: 1,
    };
    const text = renderTrace([
      {
        ...base,
        event: {
          type: "tool_start",
          call: { id: "t1", name: inject("tool"), args: "{}" },
          parsedArgs: { value: inject("argument") },
        },
      },
      {
        ...base,
        event: {
          type: "tool_end",
          call: { id: "t1", name: inject("tool"), args: "{}" },
          content: inject("failed"),
          isError: true,
        },
      },
      {
        ...base,
        event: {
          type: "stream_retry",
          attempt: 1,
          maxAttempts: 3,
          error: inject("retry"),
          delayMs: 100,
        },
      },
    ]);
    const lines = text.trimEnd().split("\n");

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => !line.includes("\t"))).toBe(true);
    expect(lines[0]).toContain("Trace session[99] forgedrow");
    expect(lines[1]).toContain("tool_start: tool[99] forgedrow");
    expect(lines[2]).toContain("tool_end: tool[99] forgedrow error failed[99] forgedrow");
    expect(lines[3]).toContain("stream_retry: 1/3 retry[99] forgedrow");
  });

  it("replays valid JSONL with non-string display fields without crashing", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "seed",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });
    await recorder.appendRaw(JSON.stringify({
      version: 1,
      timestamp: "2026-07-09T00:00:00.000Z",
      sessionId: null,
      providerId: 42,
      model: false,
      cwd: { path: "/repo" },
      turn: null,
      event: {
        type: "tool_start",
        call: { id: "t1", name: null, args: "{}" },
        parsedArgs: null,
      },
    }));

    const text = renderTrace(await readTrace(recorder.path));

    expect(text).toContain("Trace null · 42/false · [object Object]");
    expect(text).toContain("[null] tool_start: null(null)");
  });
});
