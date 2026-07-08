/** @文件 引用展开测试 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandFileRefs } from "../src/input.js";

describe("expandFileRefs", () => {
  it("真实文件被展开为附件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mycode-input-"));
    const f = join(dir, "a.ts");
    await writeFile(f, "export const x = 1;");
    const out = expandFileRefs(`解释一下 @${f} 这个文件`);
    expect(out).toContain(`[附件 @${f}]`);
    expect(out).toContain("export const x = 1;");
    expect(out).toContain("解释一下"); // 原文保留
  });

  it("不存在的路径原样保留（邮箱等不误伤）", () => {
    const input = "发邮件给 steve@example.com 说一下";
    expect(expandFileRefs(input)).toBe(input);
  });

  it("目录不展开", () => {
    const input = "看看 @/tmp 里有什么";
    expect(expandFileRefs(input)).toBe(input);
  });

  it("超大文件被截断", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mycode-input-"));
    const f = join(dir, "big.txt");
    await writeFile(f, "x".repeat(50_000));
    const out = expandFileRefs(`@${f}`);
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(40_000);
  });
});
