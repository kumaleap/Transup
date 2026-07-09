import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTrace, renderTrace } from "./trace.js";

const DEFAULT_FIXTURES_DIR = "fixtures/dogfood";

export interface DogfoodOptions {
  fixturesDir?: string;
  out?: (s: string) => void;
}

interface FixtureResult {
  file: string;
  ok: boolean;
  detail: string;
}

export async function runDogfood(opts: DogfoodOptions = {}): Promise<number> {
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  const out = opts.out ?? ((s) => process.stdout.write(s));
  const files = await listTraceFixtures(fixturesDir);
  const results: FixtureResult[] = [];

  if (files.length === 0) {
    out(`Dogfood fixtures: ${fixturesDir}\n`);
    out("✗ no .jsonl fixtures found\n");
    out("\n0 fixture(s), 0 passed, 1 failed\n");
    return 1;
  }

  out(`Dogfood fixtures: ${fixturesDir}\n`);
  for (const file of files) {
    const result = await validateFixture(fixturesDir, file);
    results.push(result);
    out(`${result.ok ? "✓" : "✗"} ${result.file}: ${result.detail}\n`);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  out(`\n${results.length} fixture(s), ${passed} passed, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

async function listTraceFixtures(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}

async function validateFixture(dir: string, file: string): Promise<FixtureResult> {
  const entries = await readTrace(join(dir, file));
  if (entries.length === 0) return { file, ok: false, detail: "empty or unreadable trace" };
  const hasTurnEnd = entries.some((entry) => entry.event.type === "turn_end");
  if (!hasTurnEnd) return { file, ok: false, detail: "missing turn_end" };

  const rendered = renderTrace(entries);
  if (!rendered.includes("turn_end:")) {
    return { file, ok: false, detail: "replay output missing turn_end" };
  }
  return { file, ok: true, detail: `${entries.length} event(s)` };
}
