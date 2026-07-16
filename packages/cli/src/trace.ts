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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry) && entry.version === 1) {
        entries.push(entry as unknown as TraceEntry);
      }
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

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.args === "string"
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text_delta":
      return typeof value.text === "string";
    case "tool_start":
      return isToolCall(value.call) && isRecord(value.parsedArgs);
    case "tool_progress":
      return isToolCall(value.call) && typeof value.chunk === "string";
    case "tool_end":
      return (
        isToolCall(value.call) &&
        typeof value.content === "string" &&
        typeof value.isError === "boolean"
      );
    case "usage":
      return (
        isRecord(value.usage) &&
        isNumber(value.usage.inputTokens) &&
        isNumber(value.usage.outputTokens) &&
        (value.usage.cacheReadTokens === undefined ||
          isNumber(value.usage.cacheReadTokens)) &&
        (value.usage.cacheWriteTokens === undefined ||
          isNumber(value.usage.cacheWriteTokens))
      );
    case "compact_start":
      return isNumber(value.beforeChars);
    case "compact_end":
      return (
        isNumber(value.afterChars) &&
        typeof value.ok === "boolean" &&
        (value.summary === undefined || typeof value.summary === "string")
      );
    case "stream_retry":
      return (
        isNumber(value.attempt) &&
        isNumber(value.maxAttempts) &&
        typeof value.error === "string" &&
        isNumber(value.delayMs)
      );
    case "auto_continue":
      return value.reason === "truncated" || value.reason === "empty_response";
    case "turn_end":
      return (
        value.reason === "done" ||
        value.reason === "max_iterations" ||
        value.reason === "aborted" ||
        value.reason === "loop_detected"
      );
    default:
      return false;
  }
}

function formatEvent(event: unknown): string {
  if (!isAgentEvent(event)) {
    const type =
      isRecord(event) && typeof event.type === "string" && event.type.length > 0
        ? event.type
        : "unknown";
    return `invalid_event: ${traceField(type)}`;
  }
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
}

function oneLine(text: string): string {
  const line = traceField(text).replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 120) + "..." : line;
}
