/**
 * 横幅渲染测试 —— 核心是对齐不变量：
 * 盒子里每一行的【显示宽度】必须完全一致（CJK 双宽最容易把边框顶歪）。
 */
import { describe, it, expect, vi } from "vitest";
import { renderBanner, displayWidth, type BannerInfo } from "../src/tui/banner-render.js";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => "/Users/someone",
  };
});

const info: BannerInfo = {
  version: "0.1.0",
  model: "deepseek-chat",
  cwd: "/Users/someone/workspace/demo",
  mcpToolCount: 3,
};

/** 去掉 ANSI 色码后算显示宽度 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const lineWidths = (out: string) => out.split("\n").map((l) => displayWidth(stripAnsi(l)));

describe("banner 渲染", () => {
  it("宽度贴合内容而非撑满终端，每行显示宽度一致", () => {
    const out = renderBanner(info, 100);
    const widths = lineWidths(out);
    expect(new Set(widths).size).toBe(1);
    // 最长行是目录行："目录" 标签列（4+2）+ "~/workspace/demo"（16）+ 边框（4）
    expect(widths[0]).toBe(26);
    // 终端更宽也不再变宽
    expect(lineWidths(renderBanner(info, 200))[0]).toBe(26);
    expect(
      stripAnsi(out)
        .split("\n")
        .slice(1, -1)
        .every((line) => [...line].filter((char) => char === "│").length === 2),
    ).toBe(true);
  });

  it("窄终端收缩到可用宽度并保持等宽", () => {
    const out = renderBanner(info, 20);
    const widths = lineWidths(out);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(19);
    expect(stripAnsi(out)).toContain("…");
  });

  it("终端窄到无法容纳标签列时不渲染横幅", () => {
    expect(renderBanner(info, 13)).toBe("");
    expect(renderBanner(info, 7)).toBe("");
  });

  it("Codex 风格：标题进盒内首行，去掉 logo/问候/tagline", () => {
    const rendered = renderBanner(info, 100);
    const lines = stripAnsi(rendered).split("\n");
    expect(lines[0]).toMatch(/^╭─+╮$/); // 顶边框不再嵌标题
    expect(lines[1]).toMatch(/^│ >_ transup v0\.1\.0\s+│$/);
    const out = lines.join("\n");
    expect(out).not.toContain("█"); // 像素吉祥物已移除
    expect(out).not.toContain("欢迎");
    expect(out).not.toContain("做极致体验的编程 agent");
    // 标题是一屏唯一的常驻品牌绿
    expect(rendered).toMatch(/\x1b\[38;5;42m>_ transup v0\.1\.0/);
  });

  it("信息行带对齐标签：模型、目录和 MCP", () => {
    const out = stripAnsi(renderBanner(info, 100));
    expect(out).toContain("模型  deepseek-chat");
    expect(out).toContain("目录  ~/workspace/demo");
    expect(out).toContain("MCP   已接入 3 个工具");
    expect(out).not.toContain("openai-compat");
    expect(out).not.toContain("会话");
  });

  it("没有 MCP 工具时省略 MCP 行", () => {
    const out = stripAnsi(renderBanner({ ...info, mcpToolCount: 0 }, 100));
    expect(out).not.toContain("MCP");
    expect(new Set(lineWidths(renderBanner({ ...info, mcpToolCount: 0 }, 100))).size).toBe(1);
  });

  it("超长内容被截断而不是顶破边框，宽度封顶 72", () => {
    const long: BannerInfo = {
      ...info,
      model: "very-long-model-name-that-never-ends-" + "x".repeat(60),
      cwd: "/deep/".repeat(30),
    };
    const widths = lineWidths(renderBanner(long, 90));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(72);
  });

  it("超长版本号在标题行内截断", () => {
    const out = renderBanner({...info, version: "v".repeat(80)}, 72);
    const widths = lineWidths(out);
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(71);
    expect(stripAnsi(out.split("\n")[1])).toContain("…");
  });

  it("净化所有结构元数据后再计算横幅布局", () => {
    const hostile: BannerInfo = {
      ...info,
      version: "1\x1b]52;c;dmVy\x07ok",
      model: "m\x1b[2Jok",
      cwd: "/tmp/bad\npath",
    };

    const out = renderBanner(hostile, 100);
    const plain = stripAnsi(out);
    expect(plain.replace(/\n/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(plain).toContain("m[2Jok");
    expect(plain).toContain("/tmp/badpath");
    expect(plain).not.toContain("会话");
    expect(new Set(lineWidths(out)).size).toBe(1);
  });

  it("displayWidth：CJK 双宽、box-drawing 单宽", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("╭─╮▟█▙")).toBe(6);
    expect(displayWidth("（全角括号）")).toBe(12);
  });
});
