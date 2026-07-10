/**
 * 消息视觉格式测试 —— 对齐交互规格（docs/claude-code-interactions/03）：
 * ⏺ 圆点 2 列 gutter、⎿ 结果行 5 列前缀 + 续行悬挂缩进、
 * 状态用圆点颜色表达、截断话术统一为 "… +N 行"。
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { TranscriptItemView, previewResult, DOT } from "../src/tui/Transcript.js";

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

  it("超过 4 行截到 3 行 + 剩余行数", () => {
    expect(previewResult("a\nb\nc\nd\ne\nf", false)).toBe("a\nb\nc\n… +3 行");
  });

  it("流式显示过的只留统计", () => {
    expect(previewResult("a\nb", true)).toBe("(已流式显示，共 2 行)");
  });
});

describe("TranscriptItemView", () => {
  it("user 消息：❯ 前缀", () => {
    const frame = view({ id: 1, kind: "user", text: "hello" });
    expect(frame).toContain("❯ hello");
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
      argSummary: 'path: "a.ts"',
      preview: "",
      isError: false,
    });
    expect(frame).toContain(`${DOT} read_file(path: "a.ts")`);
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
