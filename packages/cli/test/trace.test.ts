import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@transup/core";
import { TraceRecorder, readTrace, renderTrace, renderTraceFile } from "../src/trace.js";

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

  it("replays valid JSONL with non-string metadata without crashing", async () => {
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
      cwd: { toString: null, path: "/repo" },
      turn: null,
      event: {type: "turn_end", reason: "done"},
    }));

    const text = renderTrace(await readTrace(recorder.path));

    expect(text).toContain('Trace null · 42/false · {"toString":null,"path":"/repo"}');
    expect(text).toContain("[null] turn_end: done");
  });

  it("renders every malformed recognized event as invalid and continues replay", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "malformed-shapes",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });
    const validCall = {id: "t1", name: "read_file", args: "{}"};
    const malformedEvents: Record<string, unknown>[] = [
      {type: "text_delta"},
      {type: "text_delta", text: 1},
      {type: "tool_start", call: {}, parsedArgs: {}},
      {type: "tool_start", call: {...validCall, id: 1}, parsedArgs: {}},
      {type: "tool_start", call: validCall, parsedArgs: []},
      {type: "tool_progress", call: {...validCall, name: null}, chunk: "chunk"},
      {type: "tool_progress", call: validCall, chunk: null},
      {type: "tool_end", call: {...validCall, args: {}}, content: "result", isError: false},
      {type: "tool_end", call: validCall, content: null, isError: false},
      {type: "tool_end", call: validCall, content: "result", isError: "false"},
      {type: "usage", usage: {}},
      {type: "usage", usage: {inputTokens: 1, outputTokens: "2"}},
      {type: "usage", usage: {inputTokens: 1, outputTokens: 2, cacheReadTokens: "3"}},
      {type: "usage", usage: {inputTokens: 1, outputTokens: 2, cacheWriteTokens: null}},
      {type: "compact_start"},
      {type: "compact_start", beforeChars: "1"},
      {type: "compact_end", afterChars: "1", ok: true},
      {type: "compact_end", afterChars: 1, ok: "true"},
      {type: "compact_end", afterChars: 1, ok: true, summary: {}},
      {type: "stream_retry", attempt: "1", maxAttempts: 3, error: "retry", delayMs: 100},
      {type: "stream_retry", attempt: 1, maxAttempts: null, error: "retry", delayMs: 100},
      {type: "stream_retry", attempt: 1, maxAttempts: 3, error: {}, delayMs: 100},
      {type: "stream_retry", attempt: 1, maxAttempts: 3, error: "retry", delayMs: "100"},
      {type: "auto_continue"},
      {type: "auto_continue", reason: "other"},
      {type: "turn_end"},
      {type: "turn_end", reason: "other"},
      {type: "unknown\n\x1b[2J"},
    ];
    const base = {
      version: 1,
      timestamp: "2026-07-09T00:00:00.000Z",
      sessionId: "malformed-shapes",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    };
    for (const [index, event] of malformedEvents.entries()) {
      await recorder.appendRaw(JSON.stringify({...base, turn: index + 1, event}));
    }
    await recorder.appendRaw(JSON.stringify({
      ...base,
      turn: malformedEvents.length + 1,
      event: {type: "turn_end", reason: "done"},
    }));

    const lines = (await renderTraceFile(recorder.path)).trimEnd().split("\n");
    const invalidRows = malformedEvents.map((event, index) => {
      const type = index === malformedEvents.length - 1 ? "unknown[2J" : event.type;
      return `[${index + 1}] invalid_event: ${type}`;
    });

    expect(lines).toEqual([
      "Trace malformed-shapes · mock/mock-1 · /repo",
      ...invalidRows,
      `[${malformedEvents.length + 1}] turn_end: done`,
    ]);
  });

  it("retains version-1 records with absent event types while skipping invalid envelopes", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "malformed-admission",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });
    const base = {
      version: 1,
      timestamp: "2026-07-09T00:00:00.000Z",
      sessionId: "malformed-admission",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    };
    const malformedEvents: unknown[] = [{}, {type: ""}, {type: 0}, {type: null}, null, undefined];
    for (const [index, event] of malformedEvents.entries()) {
      await recorder.appendRaw(JSON.stringify({
        ...base,
        turn: index + 1,
        ...(event === undefined ? {} : {event}),
      }));
    }
    await recorder.appendRaw(JSON.stringify({
      ...base,
      version: 2,
      turn: 90,
      event: {type: "turn_end", reason: "done"},
    }));
    await recorder.appendRaw("null");
    await recorder.appendRaw("[]");
    await recorder.appendRaw(JSON.stringify({
      ...base,
      turn: malformedEvents.length + 1,
      event: {type: "turn_end", reason: "done"},
    }));
    await recorder.appendRaw("{broken");

    const lines = (await renderTraceFile(recorder.path)).trimEnd().split("\n");

    expect(lines).toEqual([
      "Trace malformed-admission · mock/mock-1 · /repo",
      ...malformedEvents.map((_, index) => `[${index + 1}] invalid_event: unknown`),
      `[${malformedEvents.length + 1}] turn_end: done`,
    ]);
  });

  it("renders malformed recognized events and preserves later valid trace entries", async () => {
    const dir = await tempDir();
    const recorder = new TraceRecorder({
      dir,
      sessionId: "malformed-event",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
    });
    const base = {
      version: 1,
      timestamp: "2026-07-09T00:00:00.000Z",
      sessionId: "malformed-event",
      providerId: "mock",
      model: "mock-1",
      cwd: "/repo",
      turn: 1,
    };
    await recorder.appendRaw(JSON.stringify({
      ...base,
      event: {type: "tool_start", call: null, parsedArgs: {}},
    }));
    await recorder.appendRaw(JSON.stringify({
      ...base,
      event: {type: "turn_end", reason: "done"},
    }));

    const text = await renderTraceFile(recorder.path);

    expect(text).toContain("[1] invalid_event: tool_start");
    expect(text).toContain("[1] turn_end: done");
  });
});
