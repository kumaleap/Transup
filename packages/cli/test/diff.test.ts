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

  it("统计数字加粗", () => {
    const out = renderEditPreview(
      { path: "/n.ts", old_string: "a\nb", new_string: "x" },
      40,
    );
    // +1 行 / -2 行 —— 数字各自独立成 bold 段
    expect(out).toContain("\x1b[1m1\x1b[0m");
    expect(out).toContain("\x1b[1m2\x1b[0m");
    expect(stripAnsi(out)).toContain("（+1 行，-2 行）");
  });

  it("词级 diff：变化词刷亮一档背景，未变部分只有整行底色", () => {
    const out = renderEditPreview(
      {
        path: "/n.ts",
        old_string: "const alpha = 1;",
        new_string: "const beta = 1;",
      },
      60,
    );
    // 变化词：删除行的 alpha 刷 88、新增行的 beta 刷 28
    expect(out).toContain("\x1b[48;5;88malpha\x1b[0m");
    expect(out).toContain("\x1b[48;5;28mbeta\x1b[0m");
    // 未变部分仍是整行底色
    expect(out).toContain("\x1b[48;5;52m");
    expect(out).toContain("\x1b[48;5;22m");
  });

  it("词级 diff：变化比例 > 0.4 时回退整行高亮", () => {
    const out = renderEditPreview(
      { path: "/n.ts", old_string: "aaaa bbbb", new_string: "cccc dddd" },
      60,
    );
    expect(out).not.toContain("\x1b[48;5;28m");
    expect(out).not.toContain("\x1b[48;5;88m");
    expect(out).toContain("\x1b[48;5;22m");
    expect(out).toContain("\x1b[48;5;52m");
  });

  it("多 hunk 时 context 裁剪为上下各 3 行，中间显示省略行", () => {
    const mid = Array.from({ length: 8 }, (_, i) => `ctx${i + 1}`);
    const oldStr = ["first", ...mid, "last"].join("\n");
    const newStr = ["FIRST!", ...mid, "LAST!"].join("\n");
    const out = stripAnsi(renderEditPreview({ path: "/n.ts", old_string: oldStr, new_string: newStr }, 60));
    // 两个改动块之间 8 行 context：留 3+3，省略中间 2 行
    expect(out).toContain("… 2 行未变 …");
    expect(out).toContain("ctx3");
    expect(out).toContain("ctx6");
    expect(out).not.toContain("ctx4");
    expect(out).not.toContain("ctx5");
  });

  it("单 hunk 时 context 不裁剪、全显", () => {
    const lead = Array.from({ length: 8 }, (_, i) => `keep${i + 1}`);
    const oldStr = [...lead, "old"].join("\n");
    const newStr = [...lead, "new"].join("\n");
    const out = stripAnsi(renderEditPreview({ path: "/n.ts", old_string: oldStr, new_string: newStr }, 60));
    expect(out).not.toContain("行未变");
    for (const l of lead) expect(out).toContain(l);
  });

  it("超过 40 行的 diff 截断并给出剩余行数", () => {
    const oldStr = Array.from({ length: 60 }, (_, i) => `old${i}`).join("\n");
    const out = stripAnsi(
      renderEditPreview({ path: "/n.ts", old_string: oldStr, new_string: "new" }, 40),
    );
    expect(out).toMatch(/… \+\d+ 行/);
  });

  it("renders distinct control bytes as visible escapes instead of a false +0/-0 diff", () => {
    const out = renderEditPreview(
      { path: "/n.ts", old_string: "same\x00", new_string: "same\x01" },
      60,
    );
    const plain = stripAnsi(out);

    expect(plain).toContain("（+1 行，-1 行）");
    expect(plain).toContain("same\\x00");
    expect(plain).toContain("same\\x01");
    expect(plain).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
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

  it("existing non-file targets return a safe warning instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-diff-directory-"));
    const out = stripAnsi(renderWritePreview({ path: dir, content: "new" }, 40));

    expect(out).toContain("⚠ 目标不是普通文件");
    expect(out).toContain("新 1 行");
  });

  it("write content renders terminal controls as visible escapes", () => {
    const out = renderWritePreview(
      { path: "/definitely/not/exist-control.ts", content: "before\x1b]52;c;attack\x07after" },
      80,
    );
    const plain = stripAnsi(out);

    expect(plain).toContain("before\\x1b]52;c;attack\\x07after");
    expect(out).not.toContain("\x1b]52;");
    expect(out).not.toContain("\x07");
  });
});
