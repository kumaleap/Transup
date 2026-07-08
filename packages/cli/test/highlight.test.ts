import { describe, it, expect } from "vitest";
import { renderMarkdown, highlightDiffLine } from "../src/highlight.js";

const ANSI = /\x1b\[\d+m/g;
const strip = (s: string) => s.replace(ANSI, "");

describe("renderMarkdown", () => {
  it("普通文本原样保留（无 ANSI 码）", () => {
    expect(renderMarkdown("hello world")).toBe("hello world");
  });

  it("剥离 ANSI 后内容不变（高亮不破坏文本）", () => {
    const src = '# 标题\n```ts\nconst x = "a"; // note\n```\n正文 `code` 和 **粗体**';
    // inline 渲染会去掉 ` 和 **，fence 内内容必须逐字保留
    expect(strip(renderMarkdown(src))).toContain('const x = "a"; // note');
  });

  it("代码块内关键字上色", () => {
    const out = renderMarkdown("```ts\nconst x = 1\n```");
    expect(out).toContain("\x1b[35mconst\x1b[0m"); // magenta
  });

  it("代码块内字符串上色，且字符串里的关键字不染色", () => {
    const out = renderMarkdown('```js\nlet s = "return home"\n```');
    expect(out).toContain('\x1b[33m"return home"\x1b[0m'); // 整段黄色
    expect(out).not.toContain('\x1b[35mreturn\x1b[0m'); // 字符串内不染关键字
  });

  it("注释变暗，URL 中的 // 不误判为注释", () => {
    const out = renderMarkdown('```ts\nconst u = "http://x.com" // real comment\n```');
    expect(out).toContain("\x1b[2m// real comment\x1b[0m");
    expect(strip(out)).toContain('"http://x.com"');
  });

  it("diff 代码块红删绿增", () => {
    const out = renderMarkdown("```diff\n+ added\n- removed\n@@ -1 +1 @@\n```");
    expect(out).toContain("\x1b[32m+ added\x1b[0m");
    expect(out).toContain("\x1b[31m- removed\x1b[0m");
  });

  it("未知语言的代码块原样输出", () => {
    const out = renderMarkdown("```brainfuck\n+++[->+<]\n```");
    expect(out).toContain("+++[->+<]");
  });

  it("未闭合 fence（流式中途）按代码块渲染，不吞内容", () => {
    const out = renderMarkdown("```ts\nconst partial = 1");
    expect(strip(out)).toContain("const partial = 1");
    expect(out).toContain("\x1b[35mconst\x1b[0m");
  });

  it("inline code 青色、bold 加粗、标题加粗", () => {
    const out = renderMarkdown("# Title\nuse `npm test` and **must**");
    expect(out).toContain("\x1b[36mnpm test\x1b[0m");
    expect(out).toContain("\x1b[1mmust\x1b[0m");
    expect(out).toContain("\x1b[1m");
  });

  it("正文里的 markdown 语法不影响代码块内的同类字符", () => {
    const out = renderMarkdown("```py\nx = a ** b  # `not inline`\n```");
    expect(strip(out)).toContain("x = a ** b  # `not inline`");
  });
});

describe("highlightDiffLine", () => {
  it("+++/--- 文件头不染色", () => {
    expect(highlightDiffLine("+++ b/file.ts")).toBe("+++ b/file.ts");
    expect(highlightDiffLine("--- a/file.ts")).toBe("--- a/file.ts");
  });
});
