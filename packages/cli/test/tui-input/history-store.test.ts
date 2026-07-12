import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HistoryStore,
  type HistoryEntry,
  type HistoryFileHandle,
  type HistoryIO,
} from "../../src/tui/input/history-store.js";
import { pasteMarker } from "../../src/tui/input/paste-registry.js";

const temporaryDirectories: string[] = [];

function entry(index: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    v: 1,
    display: `command ${index}`,
    pastes: [],
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ...overrides,
  };
}

async function temporaryProject(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "transup-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function historyPath(projectRoot: string): Promise<string> {
  return path.join(projectRoot, ".transup", "history.jsonl");
}

async function writeHistory(projectRoot: string, lines: readonly string[]): Promise<string> {
  const filePath = await historyPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("HistoryStore", () => {
  it("loads an empty history when the file does not exist", async () => {
    const projectRoot = await temporaryProject();

    await expect(new HistoryStore({projectRoot}).load()).resolves.toEqual([]);
  });

  it("loads only schema-valid v1 records and returns the newest 100 in file order", async () => {
    const projectRoot = await temporaryProject();
    const marker = pasteMarker(1, "α\nβ");
    const validPaste = entry(0, {
      display: `🙂 ${marker} after`,
      pastes: [
        {
          id: 1,
          content: "α\nβ",
          start: 3,
          end: 3 + marker.length,
        },
      ],
    });
    const malformedRecords = [
      "",
      "not-json",
      JSON.stringify({ ...entry(0), v: 2 }),
      JSON.stringify({ ...entry(0), display: 7 }),
      JSON.stringify({ ...entry(0), timestamp: "yesterday" }),
      JSON.stringify({ ...entry(0), extra: true }),
      JSON.stringify({ ...validPaste, pastes: [{ ...validPaste.pastes[0], id: 0 }] }),
      JSON.stringify({ ...validPaste, pastes: [{ ...validPaste.pastes[0], end: 999 }] }),
      JSON.stringify({ ...validPaste, pastes: [{ ...validPaste.pastes[0], content: "wrong" }] }),
      JSON.stringify({
        ...validPaste,
        pastes: [validPaste.pastes[0], { ...validPaste.pastes[0], id: 2 }],
      }),
    ];
    const valid = [validPaste, ...Array.from({ length: 105 }, (_, index) => entry(index + 1))];

    await writeHistory(projectRoot, [
      ...malformedRecords,
      ...valid.map((record) => JSON.stringify(record)),
    ]);

    const loaded = await new HistoryStore({ projectRoot }).load();

    expect(loaded).toEqual(valid.slice(-100));
  });

  it("creates the history directory and file with owner-only permissions", async () => {
    const projectRoot = await temporaryProject();
    const store = new HistoryStore({ projectRoot });

    await store.append(entry(1));

    const filePath = await historyPath(projectRoot);
    await expect(fs.readFile(filePath, "utf8")).resolves.toContain("command 1");
    if (process.platform === "win32") return;

    const directoryMode = (await fs.stat(path.dirname(filePath))).mode & 0o777;
    const fileMode = (await fs.stat(filePath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("serializes concurrent appends in call order", async () => {
    const projectRoot = await temporaryProject();
    const store = new HistoryStore({ projectRoot });

    await Promise.all(Array.from({ length: 10 }, (_, index) => store.append(entry(index))));

    await expect(store.load()).resolves.toEqual(
      Array.from({ length: 10 }, (_, index) => entry(index)),
    );
  });

  it("starts a new record after a valid final line without a newline", async () => {
    const projectRoot = await temporaryProject();
    const filePath = await historyPath(projectRoot);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, JSON.stringify(entry(1)), "utf8");
    const store = new HistoryStore({projectRoot});

    await store.append(entry(2));

    await expect(new HistoryStore({projectRoot}).load()).resolves.toEqual([
      entry(1),
      entry(2),
    ]);
  });

  it("does not lose another store's append when stale state triggers compaction", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({length: 199}, (_, index) => entry(index));
    await writeHistory(
      projectRoot,
      initial.map((record) => JSON.stringify(record)),
    );
    const first = new HistoryStore({projectRoot});
    const second = new HistoryStore({projectRoot});
    await Promise.all([first.load(), second.load()]);
    const external = entry(199, {display: "from second store"});
    const compacting = entry(200, {display: "from first store"});

    await second.append(external);
    await first.append(compacting);

    const loaded = await new HistoryStore({projectRoot}).load();
    expect(loaded).toHaveLength(100);
    expect(loaded.slice(-2)).toEqual([external, compacting]);
  });

  it("serializes compaction with another store's append", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({length: 200}, (_, index) => entry(index));
    await writeHistory(
      projectRoot,
      initial.map((record) => JSON.stringify(record)),
    );
    const compactionStarted = deferred();
    const resumeCompaction = deferred();
    const firstNodeIO = createNodeIO();
    const secondNodeIO = createNodeIO();
    const secondMkdir = vi.fn(secondNodeIO.mkdir);
    let pauseNextTemporaryWrite = true;
    const firstIO: HistoryIO = {
      ...firstNodeIO,
      open: async (...args) => {
        const handle = await firstNodeIO.open(...args);
        if (args[1] !== "wx") return handle;
        return {
          writeFile: async (data) => {
            if (pauseNextTemporaryWrite) {
              pauseNextTemporaryWrite = false;
              compactionStarted.resolve();
              await resumeCompaction.promise;
            }
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const secondIO: HistoryIO = {
      ...secondNodeIO,
      mkdir: secondMkdir,
    };
    const first = new HistoryStore({projectRoot, io: firstIO});
    const second = new HistoryStore({projectRoot, io: secondIO});
    await Promise.all([first.load(), second.load()]);
    const compacting = entry(200, {display: "from first store"});
    const external = entry(201, {display: "from second store"});

    const firstAppend = first.append(compacting);
    await compactionStarted.promise;
    const secondAppend = second.append(external);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(secondMkdir).not.toHaveBeenCalled();
    resumeCompaction.resolve();
    await Promise.all([firstAppend, secondAppend]);
    expect(secondMkdir).toHaveBeenCalled();

    const loaded = await new HistoryStore({projectRoot}).load();
    expect(loaded).toHaveLength(100);
    expect(loaded.slice(-2)).toEqual([compacting, external]);
  });

  it("suppresses concurrent adjacent duplicates from separate loaded stores", async () => {
    const projectRoot = await temporaryProject();
    const first = new HistoryStore({projectRoot});
    const second = new HistoryStore({projectRoot});
    await Promise.all([first.load(), second.load()]);
    const original = entry(1);

    await Promise.all([
      first.append(original),
      second.append({...original, timestamp: entry(2).timestamp}),
    ]);

    const loaded = await new HistoryStore({projectRoot}).load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      display: original.display,
      pastes: original.pastes,
    });
  });

  it("refreshes the final-line separator after another writer changes the file", async () => {
    const projectRoot = await temporaryProject();
    const store = new HistoryStore({projectRoot});
    await store.load();
    const filePath = await historyPath(projectRoot);
    await fs.mkdir(path.dirname(filePath), {recursive: true});
    await fs.writeFile(filePath, JSON.stringify(entry(1)), "utf8");

    await store.append(entry(2));

    await expect(new HistoryStore({projectRoot}).load()).resolves.toEqual([
      entry(1),
      entry(2),
    ]);
  });

  it("drops adjacent display/paste duplicates while retaining non-adjacent duplicates", async () => {
    const projectRoot = await temporaryProject();
    const store = new HistoryStore({ projectRoot });
    const first = entry(1);
    const sameContentLater = { ...first, timestamp: entry(2).timestamp };

    await store.append(first);
    await store.append(sameContentLater);
    await store.append(entry(2));
    await store.append(sameContentLater);

    await expect(store.load()).resolves.toEqual([first, entry(2), sameContentLater]);
  });

  it("retains the same marker display when hidden paste content differs", async () => {
    const projectRoot = await temporaryProject();
    const marker = pasteMarker(1, "a\nb");
    const first = entry(1, {
      display: marker,
      pastes: [{id: 1, content: "a\nb", start: 0, end: marker.length}],
    });
    const second = entry(2, {
      display: marker,
      pastes: [{id: 1, content: "x\ny", start: 0, end: marker.length}],
    });
    const store = new HistoryStore({projectRoot});

    await store.append(first);
    await store.append(second);

    await expect(store.load()).resolves.toEqual([first, second]);
  });

  it("suppresses a duplicate of the newest entry already on disk", async () => {
    const projectRoot = await temporaryProject();
    const first = entry(1);
    const filePath = await writeHistory(projectRoot, [JSON.stringify(first)]);
    const store = new HistoryStore({projectRoot});

    await store.append({...first, timestamp: entry(2).timestamp});

    expect((await fs.readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(store.load()).resolves.toEqual([first]);
  });

  it("serializes an append requested while the initial load is pending", async () => {
    const projectRoot = await temporaryProject();
    await writeHistory(projectRoot, [JSON.stringify(entry(1))]);
    const readGate = deferred();
    const realIO = createNodeIO();
    const open = vi.fn(realIO.open);
    const io: HistoryIO = {
      ...realIO,
      readFile: async (...args) => {
        await readGate.promise;
        return realIO.readFile(...args);
      },
      open,
    };
    const store = new HistoryStore({projectRoot, io});

    const loading = store.load();
    const appending = store.append(entry(2));
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();

    readGate.resolve();
    await expect(loading).resolves.toEqual([entry(1)]);
    await expect(appending).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([entry(1), entry(2)]);
  });

  it("waits in flush while an append write is still pending", async () => {
    const projectRoot = await temporaryProject();
    const writeGate = deferred();
    const writeStarted = deferred();
    const realIO = createNodeIO();
    const io: HistoryIO = {
      ...realIO,
      open: async (...args) => {
        const handle = await realIO.open(...args);
        if (args[1] !== "a") return handle;
        return {
          writeFile: async (data) => {
            writeStarted.resolve();
            await writeGate.promise;
            await handle.writeFile(data);
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    };
    const store = new HistoryStore({projectRoot, io});

    const appending = store.append(entry(1));
    const flushing = store.flush();
    let flushed = false;
    void flushing.then(() => {
      flushed = true;
    });
    await writeStarted.promise;
    await Promise.resolve();
    expect(flushed).toBe(false);

    writeGate.resolve();
    await appending;
    await flushing;
    expect(flushed).toBe(true);
  });

  it("propagates non-missing load failures", async () => {
    const projectRoot = await temporaryProject();
    const realIO = createNodeIO();
    const store = new HistoryStore({
      projectRoot,
      io: {
        ...realIO,
        readFile: async () => {
          throw Object.assign(new Error("denied"), {code: "EACCES"});
        },
      },
    });

    await expect(store.load()).rejects.toThrow("denied");
    await expect(store.flush()).resolves.toBeUndefined();
  });

  it("uses an injected file path", async () => {
    const projectRoot = await temporaryProject();
    const filePath = path.join(projectRoot, "custom", "prompts.jsonl");
    const store = new HistoryStore({filePath});

    await store.append(entry(1));

    await expect(fs.readFile(filePath, "utf8")).resolves.toContain("command 1");
  });

  it("compacts to the newest 100 valid entries after exceeding 200 valid records", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({ length: 200 }, (_, index) => entry(index));
    await writeHistory(projectRoot, initial.map((record) => JSON.stringify(record)));
    const store = new HistoryStore({ projectRoot });

    await store.append(entry(200));

    const filePath = await historyPath(projectRoot);
    const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(100);
    expect(lines.map((line) => JSON.parse(line))).toEqual(
      Array.from({ length: 100 }, (_, index) => entry(index + 101)),
    );
    expect((await fs.readdir(path.dirname(filePath))).sort()).toEqual(["history.jsonl"]);
  });

  it("compacts after the file exceeds 1 MiB even with at most 200 valid records", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({length: 150}, (_, index) =>
      entry(index, {display: `${index}:${"x".repeat(8000)}`})
    );
    await writeHistory(
      projectRoot,
      initial.map((record) => JSON.stringify(record)),
    );
    const store = new HistoryStore({ projectRoot });

    await store.append(entry(150));

    await expect(store.load()).resolves.toEqual([
      ...initial.slice(-99),
      entry(150),
    ]);
    expect((await fs.stat(await historyPath(projectRoot))).size).toBeLessThan(1024 * 1024);
  });

  it("waits for queued work in flush and continues the queue after an append failure", async () => {
    const projectRoot = await temporaryProject();
    const realIO = createNodeIO();
    let failNextOpen = true;
    const io: HistoryIO = {
      ...realIO,
      open: vi.fn(async (...args: Parameters<HistoryIO["open"]>) => {
        if (failNextOpen && args[1] === "a") {
          failNextOpen = false;
          throw new Error("injected append failure");
        }
        return realIO.open(...args);
      }),
    };
    const store = new HistoryStore({ projectRoot, io });

    const failed = store.append(entry(1));
    const recovered = store.append(entry(2));
    await expect(failed).rejects.toThrow("injected append failure");
    await expect(recovered).resolves.toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([entry(2)]);
  });

  it("sets restrictive file permissions before writing and retries without duplication", async () => {
    const projectRoot = await temporaryProject();
    const filePath = await historyPath(projectRoot);
    const realIO = createNodeIO();
    let failFileChmod = true;
    const io: HistoryIO = {
      ...realIO,
      chmod: async (target, mode) => {
        if (target === filePath && failFileChmod) {
          failFileChmod = false;
          throw new Error("injected chmod failure");
        }
        await realIO.chmod(target, mode);
      },
    };
    const store = new HistoryStore({projectRoot, io});

    await expect(store.append(entry(1))).rejects.toThrow("injected chmod failure");
    await store.append(entry(1));

    await expect(new HistoryStore({projectRoot}).load()).resolves.toEqual([entry(1)]);
  });

  it("rejects a close error while keeping the committed append deduplicated", async () => {
    const projectRoot = await temporaryProject();
    const realIO = createNodeIO();
    const io: HistoryIO = {
      ...realIO,
      open: async (...args) => {
        const handle = await realIO.open(...args);
        if (args[1] !== "a") return handle;
        return {
          writeFile: (data) => handle.writeFile(data),
          sync: () => handle.sync(),
          close: async () => {
            await handle.close();
            throw new Error("injected close failure");
          },
        };
      },
    };
    const store = new HistoryStore({projectRoot, io});

    await expect(store.append(entry(1))).rejects.toThrow("injected close failure");
    await expect(
      store.append({...entry(1), timestamp: entry(2).timestamp}),
    ).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([entry(1)]);
    await expect(new HistoryStore({projectRoot}).load()).resolves.toEqual([entry(1)]);
  });

  it("removes only its temporary file when atomic compaction fails", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({ length: 200 }, (_, index) => entry(index));
    const filePath = await writeHistory(
      projectRoot,
      initial.map((record) => JSON.stringify(record)),
    );
    const realIO = createNodeIO();
    const io: HistoryIO = {
      ...realIO,
      rename: vi.fn(async () => {
        throw new Error("injected rename failure");
      }),
    };
    const store = new HistoryStore({ projectRoot, io });

    await expect(store.append(entry(200))).rejects.toThrow("injected rename failure");

    expect((await fs.readdir(path.dirname(filePath))).sort()).toEqual(["history.jsonl"]);
    const persisted = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(persisted).toHaveLength(201);
  });

  it("does not remove any file when exclusive temporary creation fails", async () => {
    const projectRoot = await temporaryProject();
    const initial = Array.from({length: 200}, (_, index) => entry(index));
    const filePath = await writeHistory(
      projectRoot,
      initial.map((record) => JSON.stringify(record)),
    );
    const sentinel = path.join(path.dirname(filePath), "unrelated.tmp");
    await fs.writeFile(sentinel, "keep", "utf8");
    const realIO = createNodeIO();
    const rm = vi.fn(realIO.rm);
    const io: HistoryIO = {
      ...realIO,
      open: async (...args) => {
        if (args[1] === "wx") {
          throw Object.assign(new Error("collision"), {code: "EEXIST"});
        }
        return realIO.open(...args);
      },
      rm,
    };
    const store = new HistoryStore({projectRoot, io});

    await expect(store.append(entry(200))).rejects.toThrow("collision");

    expect(rm).not.toHaveBeenCalled();
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
  });

  it.each(["write", "sync"] as const)(
    "preserves the appended history when temporary-file %s fails",
    async (failure) => {
      const projectRoot = await temporaryProject();
      const initial = Array.from({length: 200}, (_, index) => entry(index));
      const filePath = await writeHistory(
        projectRoot,
        initial.map((record) => JSON.stringify(record)),
      );
      const realIO = createNodeIO();
      const io: HistoryIO = {
        ...realIO,
        open: async (...args) => {
          const handle = await realIO.open(...args);
          if (args[1] !== "wx") return handle;
          return {
            writeFile: async (data) => {
              if (failure === "write") throw new Error("injected write failure");
              await handle.writeFile(data);
            },
            sync: async () => {
              if (failure === "sync") throw new Error("injected sync failure");
              await handle.sync();
            },
            close: () => handle.close(),
          };
        },
      };
      const store = new HistoryStore({projectRoot, io});

      await expect(store.append(entry(200))).rejects.toThrow(
        `injected ${failure} failure`,
      );

      expect((await fs.readdir(path.dirname(filePath))).sort()).toEqual([
        "history.jsonl",
      ]);
      const persisted = (await fs.readFile(filePath, "utf8")).trim().split("\n");
      expect(persisted).toHaveLength(201);
    },
  );
});

function createNodeIO(): HistoryIO {
  return {
    mkdir: (directory, options) => fs.mkdir(directory, options).then(() => undefined),
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    open: async (filePath, flags, mode) => {
      const handle = await fs.open(filePath, flags, mode);
      return handle as HistoryFileHandle;
    },
    stat: (filePath) => fs.stat(filePath),
    rename: (from, to) => fs.rename(from, to),
    rm: (filePath, options) => fs.rm(filePath, options),
    chmod: (filePath, mode) => fs.chmod(filePath, mode),
  };
}
