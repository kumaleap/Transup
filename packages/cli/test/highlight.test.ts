import { describe, it, expect } from "vitest";
import { renderMarkdown, highlightDiffLine } from "../src/highlight.js";

const ANSI = /\x1b\[\d+m/g;
const OSC8 = /\x1b\]8;;[^\x1b]*\x1b\\/g;
const strip = (s: string) => s.replace(OSC8, "").replace(ANSI, "");

/** OSC 8 超链接期望值 */
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

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

  it("标题去掉 # 号：H1 粗体+斜体+下划线，H2 只粗体", () => {
    const h1 = renderMarkdown("# Title");
    expect(strip(h1)).toBe("Title");
    expect(h1).toContain("\x1b[1m");
    expect(h1).toContain("\x1b[3m");
    expect(h1).toContain("\x1b[4m");

    const h2 = renderMarkdown("## Sub");
    expect(strip(h2)).toBe("Sub");
    expect(h2).toContain("\x1b[1m");
    expect(h2).not.toContain("\x1b[3m");
  });

  it("引用块：dim ▎ 竖条 + 斜体正文", () => {
    const out = renderMarkdown("> quoted words");
    expect(strip(out)).toBe("▎ quoted words");
    expect(out).toContain("\x1b[2m▎ \x1b[0m");
    expect(out).toContain("\x1b[3m");
  });

  it("代码块内以 # 或 > 开头的行不当标题/引用处理", () => {
    const out = renderMarkdown("```py\n# comment\n```\n```\n> not quote\n```");
    expect(strip(out)).toContain("# comment");
    expect(strip(out)).toContain("> not quote");
  });

  // ── em 斜体 ──────────────────────────────────────────────
  it("*em* 和 _em_ 斜体", () => {
    expect(renderMarkdown("an *important* word")).toContain("\x1b[3mimportant\x1b[0m");
    expect(renderMarkdown("an _important_ word")).toContain("\x1b[3mimportant\x1b[0m");
  });

  it("***both*** 同时加粗和斜体", () => {
    const out = renderMarkdown("***both***");
    expect(strip(out)).toBe("both");
    expect(out).toContain("\x1b[1m");
    expect(out).toContain("\x1b[3m");
  });

  it("数学/通配符里的裸星号不误判为 em", () => {
    expect(renderMarkdown("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24");
    expect(renderMarkdown("a ** b")).toBe("a ** b");
    expect(renderMarkdown("match *.ts and *.js files")).toBe("match *.ts and *.js files");
  });

  it("snake_case 里的下划线不误判为 em", () => {
    expect(renderMarkdown("use snake_case_name here")).toBe("use snake_case_name here");
  });

  // ── 列表 ─────────────────────────────────────────────────
  it("无序列表统一渲染为 - ，嵌套每层缩进 2 空格", () => {
    const out = strip(renderMarkdown("- one\n* two\n  + nested\n    - deep"));
    expect(out).toBe("- one\n- two\n  - nested\n    - deep");
  });

  it("有序列表分层标号：数字 → 数字 → 字母 → 罗马", () => {
    const src = [
      "1. one",
      "2. two",
      "   1. sub",
      "   2. sub2",
      "      1. letter",
      "         1. roman",
      "         2. roman2",
    ].join("\n");
    const out = strip(renderMarkdown(src));
    expect(out).toBe(
      [
        "1. one",
        "2. two",
        "  1. sub",
        "  2. sub2",
        "    a. letter",
        "      i. roman",
        "      ii. roman2",
      ].join("\n"),
    );
  });

  it("回到浅层后深层计数重置", () => {
    const src = "1. a\n   1. a1\n2. b\n   1. b1";
    expect(strip(renderMarkdown(src))).toBe("1. a\n  1. a1\n2. b\n  1. b1");
  });

  it("列表项之间的空行不断开列表（宽松列表），项间不插空行", () => {
    const out = strip(renderMarkdown("- a\n\n- b"));
    expect(out).toBe("- a\n- b");
  });

  // ── 块间距 ───────────────────────────────────────────────
  it("块级元素之间空一行，多个空行折叠为一个", () => {
    const out = strip(renderMarkdown("# Head\npara one\n\n\n\npara two\n- item"));
    expect(out).toBe("Head\n\npara one\n\npara two\n\n- item");
  });

  it("段落内的相邻行保持原样，不插空行", () => {
    expect(renderMarkdown("line one\nline two")).toBe("line one\nline two");
  });

  it("输出首尾不带多余空行", () => {
    const out = renderMarkdown("\n\nhello\n\n");
    expect(out).toBe("hello");
  });

  // ── 链接 ─────────────────────────────────────────────────
  it("[text](url) → OSC 8 超链接包住 text", () => {
    const out = renderMarkdown("see [Claude](https://claude.ai) now");
    expect(out).toContain(link("https://claude.ai", "Claude"));
    expect(strip(out)).toBe("see Claude now");
  });

  it("裸 URL 直接超链接，句尾标点不算 URL", () => {
    const out = renderMarkdown("visit https://example.com.");
    expect(out).toContain(link("https://example.com", "https://example.com"));
    expect(strip(out)).toBe("visit https://example.com.");
  });

  it("mailto 剥成纯邮箱文本", () => {
    const out = renderMarkdown("write to [me](mailto:a@b.com)");
    expect(out).toBe("write to a@b.com");
  });

  it("owner/repo#123 自动转 GitHub issue 超链接", () => {
    const out = renderMarkdown("fix anthropics/claude-code#123 first");
    expect(out).toContain(
      link("https://github.com/anthropics/claude-code/issues/123", "anthropics/claude-code#123"),
    );
    expect(strip(out)).toBe("fix anthropics/claude-code#123 first");
  });

  it("链接文本里的 URL 下划线不误判为 em", () => {
    const out = renderMarkdown("[doc](https://x.com/a_b_c)");
    expect(out).toContain(link("https://x.com/a_b_c", "doc"));
    expect(out).not.toContain("\x1b[3m");
  });

  it("普通 Markdown prose 剥离 C0/C1、OSC、CSI、BEL、ST 和 DEL", () => {
    const attacks = [
      "\x1b]52;c;YXR0YWNr\x07",
      "\x1b]8;;https://evil.example\x1b\\label\x1b]8;;\x1b\\",
      "\x1b[31m",
      "\x07",
      "\x9b31m",
      "\x9d52;c;YXR0YWNr\x9c",
      "\x1b\\",
      "\x7f",
    ];

    for (const attack of attacks) {
      const out = renderMarkdown(`before${attack}after`);
      expect(out, JSON.stringify(attack)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(out, JSON.stringify(attack)).toContain("before");
      expect(out, JSON.stringify(attack)).toContain("after");
    }
    expect(renderMarkdown("a\tb\nc")).toBe("a\tb\nc");
  });

  it("链接标签与 OSC URI 独立净化，控制字符目的地保持 inert", () => {
    const labelAttack = "bad\x1b]52;c;YXR0YWNr\x07label";
    const safeLabelLink = renderMarkdown(`[${labelAttack}](https://safe.example/path)`);
    expect(safeLabelLink).toContain(link("https://safe.example/path", "bad]52;c;YXR0YWNrlabel"));
    expect(safeLabelLink).not.toContain("\x1b]52;");

    for (const destination of [
      "javascript:alert",
      "file:///etc/passwd",
      "./relative",
      "https://",
      "https://safe.example/\x1b]8;;https://evil.example\x07",
      "https://safe.example/\x9d52;c;evil\x9c",
    ]) {
      const out = renderMarkdown(`[click](${destination})`);
      expect(out, destination).not.toContain("\x1b]8;;");
      expect(out, destination).toContain("click");
    }
  });

  it("带控制字节的裸 URL 不生成 OSC，安全链接仍保留 Transup 的 OSC/ANSI", () => {
    const poisoned = renderMarkdown("visit https://safe.example/\x1b]52;c;evil\x07 now");
    expect(poisoned).not.toContain("\x1b]8;;");
    expect(poisoned).not.toContain("\x1b]52;");

    const safe = renderMarkdown("**bold** [safe](https://safe.example/a b)");
    expect(safe).toContain("\x1b[1mbold\x1b[0m");
    expect(safe).not.toContain("\x1b]8;;"); // 空格使 Markdown 目的地 malformed/inert
    const linked = renderMarkdown("[safe](https://safe.example/path)");
    expect(linked).toContain(link("https://safe.example/path", "safe"));
  });

  // ── hr / 删除线 ──────────────────────────────────────────
  it("--- / *** / ___ 单独成行 → dim 的字面 ---", () => {
    for (const hr of ["---", "*****", "___"]) {
      const out = renderMarkdown(`above\n\n${hr}\n\nbelow`);
      expect(out).toContain("\x1b[2m---\x1b[0m");
      expect(strip(out)).toBe("above\n\n---\n\nbelow");
    }
  });

  it("删除线 ~~ 不处理，原样输出（模型常用 ~ 表约数）", () => {
    expect(renderMarkdown("took ~~about~~ ~3s")).toBe("took ~~about~~ ~3s");
  });

  // ── 表格 ─────────────────────────────────────────────────
  it("表格：盒线全边框、表头居中、对齐标记生效、CJK 宽度正确", () => {
    const src = ["| Name | Age |", "| --- | ---: |", "| 张三 | 30 |", "| Bob | 5 |"].join("\n");
    const out = strip(renderMarkdown(src));
    expect(out).toBe(
      [
        "┌──────┬─────┐",
        "│ Name │ Age │",
        "├──────┼─────┤",
        "│ 张三 │  30 │",
        "├──────┼─────┤",
        "│ Bob  │   5 │",
        "└──────┴─────┘",
      ].join("\n"),
    );
  });

  it("表格单元格里的 inline 样式生效且不破坏对齐", () => {
    const src = "| A | B |\n| --- | --- |\n| **bold** | `code` |";
    const out = renderMarkdown(src);
    expect(out).toContain("\x1b[1mbold\x1b[0m");
    expect(out).toContain("\x1b[36mcode\x1b[0m");
    // 剥掉控制序列后每行等宽
    const lines = strip(out).split("\n");
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it("超宽表格按比例截断加 …", () => {
    const long = "x".repeat(120);
    const out = strip(renderMarkdown(`| H |\n| --- |\n| ${long} |`));
    expect(out).toContain("…");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
  });

  it("高度不对称的三列表格不超过 80 列", () => {
    const long = "x".repeat(120);
    const out = strip(
      renderMarkdown(`| A | B | C |\n| --- | --- | --- |\n| ${long} | y | z |`),
    );
    expect(out).toContain("…");
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it("14 列表格降低最小列宽后仍不超过 80 列", () => {
    const headers = Array.from({ length: 14 }, (_, i) => `H${i + 1}`);
    const separator = headers.map(() => "---");
    const values = ["x".repeat(120), ...Array.from({ length: 13 }, () => "y")];
    const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const out = strip(renderMarkdown([row(headers), row(separator), row(values)].join("\n")));
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(out).toContain("…");
  });

  it("超过最大可见列数时省略尾部列且不超过 80 列", () => {
    const headers = Array.from({ length: 20 }, (_, i) => String.fromCharCode(65 + i));
    const separator = headers.map(() => "---");
    const values = headers.map((header) => header.toLowerCase());
    const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const out = strip(renderMarkdown([row(headers), row(separator), row(values)].join("\n")));
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
    expect(out).toContain("…");
  });

  it("没有分隔行的 | 行按普通段落处理", () => {
    const out = strip(renderMarkdown("a | b | c"));
    expect(out).toBe("a | b | c");
  });
});

describe("highlightDiffLine", () => {
  it("+++/--- 文件头不染色", () => {
    expect(highlightDiffLine("+++ b/file.ts")).toBe("+++ b/file.ts");
    expect(highlightDiffLine("--- a/file.ts")).toBe("--- a/file.ts");
  });
});
