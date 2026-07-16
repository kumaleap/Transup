import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "@transup/core";
import { sanitizeTerminalField, sanitizeTerminalText } from "./highlight.js";

const DEFAULT_DIR = ".transup/traces";

export interface TraceEntry {
  version: 1;
  timestamp: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd: string;
  turn: number;
  event: AgentEvent;
}

export interface TraceRecorderOptions {
  dir?: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd: string;
}

export class TraceRecorder {
  readonly path: string;
  private dir: string;
  private ready = false;
  private turn = 1;

  constructor(private opts: TraceRecorderOptions) {
    this.dir = opts.dir ?? DEFAULT_DIR;
    this.path = join(this.dir, `${opts.sessionId}.jsonl`);
  }

  async record(event: AgentEvent): Promise<void> {
    if (!this.ready) {
      await mkdir(this.dir, { recursive: true });
      this.ready = true;
    }
    const entry: TraceEntry = {
      version: 1,
      timestamp: new Date().toISOString(),
      sessionId: this.opts.sessionId,
      providerId: this.opts.providerId,
      model: this.opts.model,
      cwd: this.opts.cwd,
      turn: this.turn,
      event,
    };
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf-8");
    if (event.type === "turn_end") this.turn++;
  }

  async appendRaw(text: string): Promise<void> {
    if (!this.ready) {
      await mkdir(this.dir, { recursive: true });
      this.ready = true;
    }
    await appendFile(this.path, text + "\n", "utf-8");
  }
}

export async function readTrace(path: string): Promise<TraceEntry[]> {
  let text = "";
  try {
    text = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const entries: TraceEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TraceEntry;
      if (entry.version === 1 && entry.event?.type) entries.push(entry);
    } catch {
      // Trace files are append-only; skip a damaged tail line after crashes.
    }
  }
  return entries;
}

function traceField(value: unknown): string {
  if (typeof value === "string") return sanitizeTerminalField(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return sanitizeTerminalField(serialized);
  } catch {
    // Replay must remain readable even for values supplied by direct API callers.
  }
  return `[${typeof value}]`;
}

export function renderTrace(entries: TraceEntry[]): string {
  if (entries.length === 0) return "Trace is empty\n";
  const first = entries[0];
  const lines = [
    `Trace ${traceField(first.sessionId)} · ` +
      `${traceField(first.providerId)}/${traceField(first.model)} · ` +
      traceField(first.cwd),
  ];
  for (const entry of entries) {
    lines.push(`[${traceField(entry.turn)}] ${formatEvent(entry.event)}`);
  }
  return sanitizeTerminalText(lines.join("\n") + "\n");
}

export async function renderTraceFile(path: string): Promise<string> {
  return renderTrace(await readTrace(path));
}

function formatEvent(event: AgentEvent): string {
  try {
    switch (event.type) {
      case "text_delta":
        return `text: ${oneLine(event.text)}`;
      case "tool_start":
        return (
          `tool_start: ${traceField(event.call.name)}(` +
          `${traceField(event.parsedArgs)})`
        );
      case "tool_progress":
        return `tool_progress: ${traceField(event.call.name)} ${oneLine(event.chunk)}`;
      case "tool_end":
        return `tool_end: ${traceField(event.call.name)} ${event.isError ? "error" : "ok"} ${oneLine(event.content)}`;
      case "usage":
        return (
          `usage: input ${traceField(event.usage.inputTokens)} / ` +
          `output ${traceField(event.usage.outputTokens)}`
        );
      case "compact_start":
        return `compact_start: before ${traceField(event.beforeChars)}`;
      case "compact_end":
        return `compact_end: ${event.ok ? "ok" : "failed"} after ${traceField(event.afterChars)}`;
      case "stream_retry":
        return (
          `stream_retry: ${traceField(event.attempt)}/` +
          `${traceField(event.maxAttempts)} ${oneLine(event.error)}`
        );
      case "auto_continue":
        return `auto_continue: ${traceField(event.reason)}`;
      case "turn_end":
        return `turn_end: ${traceField(event.reason)}`;
    }
  } catch {
    // Persisted JSONL is an untyped boundary; one malformed row must not stop replay.
  }
  const type = (event as {type?: unknown} | null | undefined)?.type ?? "unknown";
  return `invalid_event: ${traceField(type)}`;
}

function oneLine(text: string): string {
  const line = traceField(text).replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 120) + "..." : line;
}
