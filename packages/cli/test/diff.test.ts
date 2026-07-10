/**
 * diff 预览测试 —— 行级 LCS 对齐、行号 gutter、整行背景色、宽度截断。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffRows, renderEditPreview, renderWritePreview } from "../src/diff.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("diffRows", () => {
  it("未变化行是上下文，改动行一删一增，共享同段行号", () => {
    const rows = diffRows("a\nb\nc", "a\nx\nc", 10);
    expect(rows).toEqual([
      { kind: "ctx", no: 10, text: "a" },
      { kind: "del", no: 11, text: "b" },
      { kind: "add", no: 11, text: "x" },
      { kind: "ctx", no: 12, text: "c" },
    ]);
  });

  it("纯新增/纯删除", () => {
    expect(diffRows("a", "a\nb", 1)).toEqual([
      { kind: "ctx", no: 1, text: "a" },
      { kind: "add", no: 2, text: "b" },
    ]);
    expect(diffRows("a\nb", "a", 1)).toEqual([
      { kind: "ctx", no: 1, text: "a" },
      { kind: "del", no: 2, text: "b" },
    ]);
  });
});

describe("renderEditPreview", () => {
  it("行号 + 符号 + 代码，增删行铺整行背景", () => {
    const out = renderEditPreview(
      { path: "/nonexistent.ts", old_string: "a\nb\nc", new_string: "a\nx\nc" },
      40,
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("修改 /nonexistent.ts");
    expect(plain).toContain("（+1 行，-1 行）");
    expect(plain).toMatch(/2 - b/);
    expect(plain).toMatch(/2 \+ x/);
    expect(out).toContain("\x1b[48;5;22m"); // 深绿背景（增）
    expect(out).toContain("\x1b[48;5;52m"); // 深红背景（删）
  });

  it("old_string 能在文件里定位时，行号从真实位置起", () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-diff-"));
    const file = join(dir, "f.ts");
    writeFileSync(file, "l1\nl2\nl3\ntarget\nl5\n");
    const out = stripAnsi(
      renderEditPreview({ path: file, old_string: "target", new_string: "changed" }, 40),
    );
    expect(out).toMatch(/4 - target/);
    expect(out).toMatch(/4 \+ changed/);
  });

  it("超宽行截断收 …，背景行不折行撕裂", () => {
    const long = "x".repeat(100);
    const out = renderEditPreview(
      { path: "/nonexistent.ts", old_string: "a", new_string: long },
      40,
    );
    const bgLine = stripAnsi(out)
      .split("\n")
      .find((l) => l.includes("xxx"))!;
    expect(bgLine.length).toBeLessThanOrEqual(42); // width + 缩进
    expect(bgLine).toContain("…");
  });

  it("超过 40 行的 diff 截断并给出剩余行数", () => {
    const oldStr = Array.from({ length: 60 }, (_, i) => `old${i}`).join("\n");
    const out = stripAnsi(
      renderEditPreview({ path: "/n.ts", old_string: oldStr, new_string: "new" }, 40),
    );
    expect(out).toMatch(/… \+\d+ 行/);
  });
});

describe("renderWritePreview", () => {
  it("新建文件：行号 + 全增背景", () => {
    const out = renderWritePreview(
      { path: "/definitely/not/exist.ts", content: "line1\nline2" },
      40,
    );
    const plain = stripAnsi(out);
    expect(plain).toContain("新建 /definitely/not/exist.ts");
    expect(plain).toContain("（2 行）");
    expect(plain).toMatch(/1 \+ line1/);
    expect(plain).toMatch(/2 \+ line2/);
    expect(out).toContain("\x1b[48;5;22m");
  });

  it("覆盖已有文件时明确警告", () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-diff-"));
    const file = join(dir, "exists.ts");
    writeFileSync(file, "old\n");
    const out = stripAnsi(renderWritePreview({ path: file, content: "new" }, 40));
    expect(out).toContain("⚠ 覆盖已有文件");
  });
});
