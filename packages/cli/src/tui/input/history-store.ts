import * as fs from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import {pasteMarker, type PasteReference} from "./paste-registry.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_MEMORY_ENTRIES = 100;
const COMPACT_ENTRY_COUNT = 200;
const COMPACT_FILE_SIZE = 1024 * 1024;

export interface HistoryEntry {
  v: 1;
  display: string;
  pastes: readonly PasteReference[];
  timestamp: string;
}

export interface HistoryFileHandle {
  writeFile(data: string): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface HistoryIO {
  mkdir(
    directory: string,
    options: {recursive: true; mode: number},
  ): Promise<void>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  open(filePath: string, flags: string, mode?: number): Promise<HistoryFileHandle>;
  stat(filePath: string): Promise<{size: number}>;
  rename(from: string, to: string): Promise<void>;
  rm(filePath: string, options: {force: true}): Promise<void>;
  chmod(filePath: string, mode: number): Promise<void>;
}

export interface HistoryStoreOptions {
  projectRoot?: string;
  filePath?: string;
  io?: HistoryIO;
}

const nodeIO: HistoryIO = {
  mkdir: async (directory, options) => {
    await fs.mkdir(directory, options);
  },
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  open: async (filePath, flags, mode) => fs.open(filePath, flags, mode),
  stat: (filePath) => fs.stat(filePath),
  rename: (from, to) => fs.rename(from, to),
  rm: (filePath, options) => fs.rm(filePath, options),
  chmod: (filePath, mode) => fs.chmod(filePath, mode),
};

const historyFileQueues = new Map<string, Promise<void>>();

function historyQueueKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function enqueueHistoryFile<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = historyQueueKey(filePath);
  const previous = historyFileQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const continuation = result.then(() => undefined, () => undefined);
  historyFileQueues.set(key, continuation);
  void continuation.then(() => {
    if (historyFileQueues.get(key) === continuation) {
      historyFileQueues.delete(key);
    }
  });
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validTimestamp(timestamp: unknown): timestamp is string {
  if (typeof timestamp !== "string") return false;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === timestamp;
}

function validatePastes(
  display: string,
  value: unknown,
): readonly PasteReference[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const references: PasteReference[] = [];
  const ids = new Set<number>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["id", "content", "start", "end"])
    ) {
      return undefined;
    }

    const {id, content, start, end} = candidate;
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      ids.has(id) ||
      typeof content !== "string" ||
      typeof start !== "number" ||
      !Number.isSafeInteger(start) ||
      typeof end !== "number" ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > display.length ||
      display.slice(start, end) !== pasteMarker(id, content)
    ) {
      return undefined;
    }

    ids.add(id);
    references.push({id, content, start, end});
  }

  references.sort((left, right) =>
    left.start - right.start || left.id - right.id
  );
  for (let index = 1; index < references.length; index++) {
    if (references[index]!.start < references[index - 1]!.end) return undefined;
  }
  return references;
}

function validateEntry(value: unknown): HistoryEntry | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["v", "display", "pastes", "timestamp"]) ||
    value.v !== 1 ||
    typeof value.display !== "string" ||
    !validTimestamp(value.timestamp)
  ) {
    return undefined;
  }

  const pastes = validatePastes(value.display, value.pastes);
  if (!pastes) return undefined;
  return {
    v: 1,
    display: value.display,
    pastes,
    timestamp: value.timestamp,
  };
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  return {
    v: 1,
    display: entry.display,
    pastes: entry.pastes.map((reference) => ({...reference})),
    timestamp: entry.timestamp,
  };
}

function samePrompt(left: HistoryEntry, right: HistoryEntry): boolean {
  if (left.display !== right.display || left.pastes.length !== right.pastes.length) {
    return false;
  }
  return left.pastes.every((reference, index) => {
    const other = right.pastes[index];
    return other !== undefined &&
      reference.id === other.id &&
      reference.content === other.content &&
      reference.start === other.start &&
      reference.end === other.end;
  });
}

function parseHistory(content: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = validateEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // Damaged lines are independent; later valid prompts remain usable.
    }
  }
  return entries;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export class HistoryStore {
  readonly filePath: string;

  private readonly io: HistoryIO;
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;
  private entries: HistoryEntry[] = [];
  private validEntryCount = 0;
  private needsRecordSeparator = false;

  constructor(options: HistoryStoreOptions = {}) {
    const projectRoot = options.projectRoot ?? process.cwd();
    this.filePath = options.filePath ??
      path.join(projectRoot, ".transup", "history.jsonl");
    this.io = options.io ?? nodeIO;
  }

  load(): Promise<readonly HistoryEntry[]> {
    return this.enqueue(() =>
      enqueueHistoryFile(this.filePath, async () => {
        await this.ensureLoaded();
        return this.entries.map(cloneEntry);
      })
    );
  }

  append(entry: HistoryEntry): Promise<void> {
    return this.enqueue(() =>
      enqueueHistoryFile(this.filePath, async () => {
        const validated = validateEntry(entry);
        if (!validated) throw new TypeError("Invalid history entry");

        await this.ensureParentDirectory();
        await this.reloadFromDisk();
        const latest = this.entries[this.entries.length - 1];
        if (latest && samePrompt(latest, validated)) return;

        const closeError = await this.appendLine(validated);
        this.entries = [...this.entries, validated].slice(-MAX_MEMORY_ENTRIES);
        this.validEntryCount++;
        if (closeError !== undefined) throw closeError;

        const {size} = await this.io.stat(this.filePath);
        if (
          this.validEntryCount > COMPACT_ENTRY_COUNT ||
          size > COMPACT_FILE_SIZE
        ) {
          await this.compact();
        }
      })
    );
  }

  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    await this.reloadFromDisk();
  }

  private async reloadFromDisk(): Promise<void> {
    let content: string;
    try {
      content = await this.io.readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.loaded = true;
      this.entries = [];
      this.validEntryCount = 0;
      this.needsRecordSeparator = false;
      return;
    }

    const entries = parseHistory(content);
    this.loaded = true;
    this.validEntryCount = entries.length;
    this.entries = entries.slice(-MAX_MEMORY_ENTRIES);
    this.needsRecordSeparator = content.length > 0 && !content.endsWith("\n");
  }

  private async ensureParentDirectory(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await this.io.mkdir(directory, {recursive: true, mode: DIRECTORY_MODE});
    await this.io.chmod(directory, DIRECTORY_MODE);
  }

  private async appendLine(entry: HistoryEntry): Promise<unknown | undefined> {
    const handle = await this.io.open(this.filePath, "a", FILE_MODE);
    let primaryError: unknown;
    let closeError: unknown;
    try {
      await this.io.chmod(this.filePath, FILE_MODE);
      const separator = this.needsRecordSeparator ? "\n" : "";
      await handle.writeFile(`${separator}${JSON.stringify(entry)}\n`);
      this.needsRecordSeparator = false;
    } catch (error) {
      primaryError = error;
      this.needsRecordSeparator = true;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        if (primaryError === undefined) {
          closeError = error;
        }
      }
    }
    if (primaryError !== undefined) throw primaryError;
    return closeError;
  }

  private async compact(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const source = await this.io.readFile(this.filePath, "utf8");
    const compactedEntries = parseHistory(source).slice(-MAX_MEMORY_ENTRIES);
    const sourceSize = Buffer.byteLength(source);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const content = compactedEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    let handle: HistoryFileHandle | undefined;
    let created = false;
    let renamed = false;

    try {
      handle = await this.io.open(temporaryPath, "wx", FILE_MODE);
      created = true;
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;

      if ((await this.io.stat(this.filePath)).size !== sourceSize) {
        await this.io.rm(temporaryPath, {force: true});
        created = false;
        return;
      }

      await this.io.rename(temporaryPath, this.filePath);
      renamed = true;
      created = false;
      await this.syncDirectory(directory);
      this.entries = compactedEntries;
      this.validEntryCount = compactedEntries.length;
      this.needsRecordSeparator = false;
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the primary compaction error.
        }
      }
      if (created && !renamed) {
        try {
          await this.io.rm(temporaryPath, {force: true});
        } catch {
          // Cleanup is best effort and must not replace the primary error.
        }
      }
      throw error;
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    let handle: HistoryFileHandle | undefined;
    try {
      handle = await this.io.open(directory, "r");
      await handle.sync();
    } catch {
      // Directory fsync is unavailable on some supported platforms.
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Best effort only.
        }
      }
    }
  }
}
