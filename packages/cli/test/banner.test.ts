/**
 * 横幅渲染测试 —— 核心是对齐不变量：
 * 盒子里每一行的【显示宽度】必须完全一致（CJK 双宽最容易把边框顶歪）。
 */
import { describe, it, expect } from "vitest";
import { renderBanner, displayWidth, type BannerInfo } from "../src/tui/banner-render.js";

const info: BannerInfo = {
  version: "0.1.0",
  providerId: "openai-compat",
  model: "deepseek-chat",
  sessionId: "2026-07-08T20-30-00",
  resumedMessages: 2,
  cwd: "/Users/someone/workspace/demo",
  mcpToolCount: 3,
};

/** 去掉 ANSI 色码后算显示宽度 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const lineWidths = (out: string) => out.split("\n").map((l) => displayWidth(stripAnsi(l)));

describe("banner 渲染", () => {
  it("双栏布局：每行显示宽度一致，边框不歪", () => {
    const out = renderBanner(info, 100);
    const widths = lineWidths(out);
    expect(new Set(widths).size).toBe(1); // 全部等宽
    expect(widths[0]).toBe(99); // columns - 1
  });

  it("窄终端退化为单栏，同样等宽", () => {
    const out = renderBanner(info, 60);
    const widths = lineWidths(out);
    expect(new Set(widths).size).toBe(1);
    expect(out).not.toContain("上手提示"); // 单栏没有右栏
  });

  it("内容齐全：标题版本、tagline、模型、会话、MCP、提示", () => {
    const out = stripAnsi(renderBanner(info, 100));
    expect(out).toContain("transup v0.1.0");
    expect(out).toContain("做极致体验的编程 agent");
    expect(out).toContain("deepseek-chat · openai-compat");
    expect(out).toContain("续 2 条");
    expect(out).toContain("3 个 MCP 工具");
    expect(out).toContain("上手提示");
    expect(out).toContain("最近更新");
  });

  it("超长内容被截断而不是顶破边框", () => {
    const long: BannerInfo = {
      ...info,
      model: "very-long-model-name-that-never-ends-" + "x".repeat(60),
      cwd: "/deep/".repeat(30),
    };
    const widths = lineWidths(renderBanner(long, 90));
    expect(new Set(widths).size).toBe(1);
  });

  it("displayWidth：CJK 双宽、box-drawing 单宽", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("╭─╮▟█▙")).toBe(6);
    expect(displayWidth("（全角括号）")).toBe(12);
  });
});
