/**
 * 消息视觉格式测试 —— 对齐交互规格（docs/claude-code-interactions/03）：
 * ⏺ 圆点 2 列 gutter、⎿ 结果行 5 列前缀 + 续行悬挂缩进、
 * 状态用圆点颜色表达、截断话术统一为 dim 的 "… +N 行"、
 * 工具参数/结果摘要按工具定制（数字 bold）、错误结构化。
 */
import React from "react";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  TranscriptItemView,
  previewResult,
  summarizeToolCall,
  summarizeToolResult,
  formatToolError,
  formatApiError,
  truncateUserText,
  inline,
  DOT,
  POINTER,
} from "../src/tui/Transcript.js";

const view = (item: Parameters<typeof TranscriptItemView>[0]["item"]) => {
  const r = render(<TranscriptItemView item={item} />);
  const frame = r.lastFrame() ?? "";
  r.unmount();
  return frame;
};

describe("previewResult", () => {
  it("3 行以内原样返回", () => {
    expect(previewResult("a\nb\nc", false)).toBe("a\nb\nc");
  });

  it("恰好 4 行直接显示，避免『… +1 行』", () => {
    expect(previewResult("a\nb\nc\nd", false)).toBe("a\nb\nc\nd");
  });

  it("超过 4 行截到 3 行 + dim 的剩余行数", () => {
    expect(previewResult("a\nb\nc\nd\ne\nf", false)).toBe(
      `a\nb\nc\n${inline.dim("… +3 行")}`,
    );
  });

  it("流式显示过的只留统计", () => {
    expect(previewResult("a\nb", true)).toBe("(已流式显示，共 2 行)");
  });
});

describe("truncateUserText（user 超长输入，规格 §1.4）", () => {
  it("10000 字符以内不截断", () => {
    expect(truncateUserText("x".repeat(10_000))).toEqual({ truncated: false });
  });

  it("超长时保留头尾各 2500 字符并统计省略行数", () => {
    // 120 行 × 100 字符（含换行 101/行）≈ 12120 字符
    const line = "x".repeat(100);
    const text = Array.from({ length: 120 }, () => line).join("\n");
    const t = truncateUserText(text);
    if (!t.truncated) throw new Error("应当触发截断");
    expect(t.head).toBe(text.slice(0, 2500));
    expect(t.tail).toBe(text.slice(-2500));
    expect(t.omittedLines).toBe(text.slice(2500, -2500).split("\n").length);
    expect(t.head.length + t.tail.length).toBe(5000);
  });
});

describe("summarizeToolCall（参数摘要按工具定制，规格 §2.2）", () => {
  it("bash 显示命令原文", () => {
    expect(summarizeToolCall("bash", { command: "npm test" })).toEqual({
      displayName: "bash",
      argSummary: "npm test",
    });
  });

  it("bash 命令超 160 字符截断加 …", () => {
    const cmd = "x".repeat(200);
    const { argSummary } = summarizeToolCall("bash", { command: cmd });
    expect(argSummary).toBe("x".repeat(160) + "…");
  });

  it("bash 命令超 2 行截断加 …", () => {
    const { argSummary } = summarizeToolCall("bash", { command: "a\nb\nc\nd" });
    expect(argSummary).toBe("a\nb…");
  });

  it("read_file 显示相对路径", () => {
    const abs = join(process.cwd(), "src", "a.ts");
    expect(summarizeToolCall("read_file", { path: abs })).toEqual({
      displayName: "Read",
      argSummary: join("src", "a.ts"),
    });
  });

  it("工作区之外的路径保持原样", () => {
    const outside = join(process.cwd(), "..", "elsewhere", "b.ts");
    const { argSummary } = summarizeToolCall("read_file", { path: outside });
    expect(argSummary).toBe(outside);
  });

  it("edit_file → Update(路径)、write_file → Create(路径)", () => {
    expect(summarizeToolCall("edit_file", { path: "a.ts", old_string: "x", new_string: "y" }))
      .toEqual({ displayName: "Update", argSummary: "a.ts" });
    expect(summarizeToolCall("write_file", { path: "b.ts", content: "hi" }))
      .toEqual({ displayName: "Create", argSummary: "b.ts" });
  });

  it('grep → pattern: "x", path: "y"', () => {
    expect(summarizeToolCall("grep", { pattern: "TODO", path: "src" })).toEqual({
      displayName: "grep",
      argSummary: 'pattern: "TODO", path: "src"',
    });
    // 省略 path 时不渲染空 path
    expect(summarizeToolCall("grep", { pattern: "TODO" }).argSummary).toBe('pattern: "TODO"');
  });

  it("其余工具保留通用 key: value 格式", () => {
    expect(summarizeToolCall("list_dir", { path: "src" }).argSummary).toBe('path: "src"');
  });
});

describe("summarizeToolResult（语义摘要，数字 bold，规格 §2.3）", () => {
  it("read_file → 读取 N 行（N bold）", () => {
    expect(summarizeToolResult("read_file", "    1→a\n    2→b\n    3→c", false)).toBe(
      `读取 ${inline.bold("3")} 行`,
    );
  });

  it("read_file 末尾分页提示不计入行数", () => {
    const content = "    1→a\n    2→b\n… 文件共 900 行，可用 offset=3 继续读取";
    expect(summarizeToolResult("read_file", content, false)).toBe(
      `读取 ${inline.bold("2")} 行`,
    );
  });

  it("grep → 找到 N 个匹配；无匹配为 0", () => {
    expect(summarizeToolResult("grep", "a.ts:1:x\nb.ts:2:y", false)).toBe(
      `找到 ${inline.bold("2")} 个匹配`,
    );
    expect(summarizeToolResult("grep", "(无匹配)", false)).toBe(
      `找到 ${inline.bold("0")} 个匹配`,
    );
  });

  it("grep 超量时以工具报告的总数为准", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `a.ts:${i}:x`).join("\n");
    expect(summarizeToolResult("grep", `${lines}\n… 共 240 条匹配，请缩小搜索范围`, false)).toBe(
      `找到 ${inline.bold("240")} 个匹配`,
    );
  });

  it("list_dir → 找到 N 个文件", () => {
    expect(summarizeToolResult("list_dir", "a.ts\nsrc/", false)).toBe(
      `找到 ${inline.bold("2")} 个文件`,
    );
  });

  it("bash 空输出 → dim (无输出)", () => {
    expect(summarizeToolResult("bash", "(命令执行成功，无输出)", false)).toBe(
      inline.dim("(无输出)"),
    );
  });

  it("bash stderr 块逐行标红", () => {
    const out = summarizeToolResult("bash", "ok\n[stderr]\nboom", false);
    expect(out).toBe(`ok\n${inline.red("[stderr]")}\n${inline.red("boom")}`);
  });

  it("流式显示过的输出只留统计", () => {
    expect(summarizeToolResult("bash", "a\nb", true)).toBe("(已流式显示，共 2 行)");
  });
});

describe("formatToolError / formatApiError（规格 §1.5）", () => {
  it("剥掉 <tool_use_error>/<error> 标签并补 Error: 前缀", () => {
    expect(formatToolError("<tool_use_error>boom</tool_use_error>")).toBe("Error: boom");
    expect(formatToolError("<error>bad</error>")).toBe("Error: bad");
  });

  it("已有 Error 前缀不重复补", () => {
    expect(formatToolError("Error: already")).toBe("Error: already");
  });

  it("超过 10 行截断，余下 dim … +N 行", () => {
    const content = Array.from({ length: 14 }, (_, i) => `L${i + 1}`).join("\n");
    const out = formatToolError(content);
    const lines = out.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe("Error: L1");
    expect(lines[10]).toBe(inline.dim("… +4 行"));
  });

  it("API 错误截到 1000 字符加 …", () => {
    const out = formatApiError("x".repeat(1500));
    expect(out).toBe("x".repeat(1000) + "…");
    expect(formatApiError("short")).toBe("short");
  });
});

describe("TranscriptItemView", () => {
  it("user 消息：❯ 前缀", () => {
    const frame = view({ id: 1, kind: "user", text: "hello" });
    expect(frame).toContain(`${POINTER} hello`);
  });

  it("user 超长输入渲染头尾 + dim 省略标记", () => {
    const line = "x".repeat(60);
    const text = Array.from({ length: 200 }, () => line).join("\n");
    const frame = view({ id: 1, kind: "user", text });
    const omitted = text.slice(2500, -2500).split("\n").length;
    expect(frame).toContain(`… +${omitted} 行 …`);
  });

  it("bash-input：品红 ! 前缀行", () => {
    const frame = view({ id: 1, kind: "bash-input", text: "echo hi" });
    expect(frame).toContain("! echo hi");
  });

  it("assistant 消息：⏺ 占 2 列 gutter", () => {
    const frame = view({ id: 1, kind: "assistant", text: "world" });
    expect(frame).toContain(`${DOT} world`);
  });

  it("工具行：⏺ + 工具名(参数摘要)", () => {
    const frame = view({
      id: 1,
      kind: "tool",
      name: "read_file",
      argSummary: "a.ts",
      preview: "",
      isError: false,
    });
    expect(frame).toContain(`${DOT} read_file(a.ts)`);
  });

  it("结果行：⎿ 前缀 5 列，续行缩进对齐到第 6 列", () => {
    const frame = view({
      id: 1,
      kind: "tool",
      name: "grep",
      argSummary: "",
      preview: "first\nsecond",
      isError: false,
    });
    const lines = frame.split("\n");
    const first = lines.find((l) => l.includes("⎿"))!;
    expect(first).toBeDefined();
    expect(first.indexOf("⎿")).toBe(2); // 2 空格 + ⎿
    expect(first).toContain("⎿  first");
    const cont = lines[lines.indexOf(first) + 1];
    expect(cont).toBe("     second"); // 悬挂缩进 5 列
  });

  it("语义摘要里的数字 bold 原样透传到渲染", () => {
    const frame = view({
      id: 1,
      kind: "tool",
      name: "read_file",
      argSummary: "a.ts",
      preview: `读取 ${inline.bold("8")} 行`,
      isError: false,
    });
    expect(frame).toContain(inline.bold("8"));
    expect(frame).toContain("读取");
  });

  it("error 条目：⎿ 缩进的红色行", () => {
    const frame = view({ id: 1, kind: "error", text: "Error: boom" });
    const line = frame.split("\n").find((l) => l.includes("⎿"))!;
    expect(line).toBeDefined();
    expect(line.indexOf("⎿")).toBe(2);
    expect(frame).toContain("Error: boom");
  });

  it("无参数摘要时不渲染空括号", () => {
    const frame = view({
      id: 1,
      kind: "tool",
      name: "bash",
      argSummary: "",
      preview: "",
      isError: false,
    });
    expect(frame).toContain(`${DOT} bash`);
    expect(frame).not.toContain("()");
  });
});
