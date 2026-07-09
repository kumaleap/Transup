/**
 * TUI 冒烟测试 —— ink-testing-library + mock provider
 *
 * 验证核心链路而不碰真实 API：
 * 1. 首屏横幅与输入框渲染
 * 2. 输入 → 引擎跑 mock 回复 → 流式文本落进 transcript
 * 3. 工具调用（写操作）→ 权限对话框弹出 → 按 y 放行 / 按 n 拒绝
 * 4. 斜杠命令 /help /cost
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderEvent, ToolCall } from "@transup/core";
import { builtinTools } from "@transup/core";
import { App } from "../src/tui/App.js";

/** 每轮回一段文本；可选带工具调用。usage 挂在 message_done 上。 */
class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "test-model";
  private step = 0;
  constructor(private replies: { content: string; toolCalls?: ToolCall[] }[]) {}
  async *stream(): AsyncIterable<ProviderEvent> {
    const r = this.replies[Math.min(this.step++, this.replies.length - 1)] ?? {
      content: "(空)",
    };
    if (r.content) yield { type: "text_delta", text: r.content };
    yield {
      type: "message_done",
      content: r.content,
      toolCalls: r.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

const sessionDir = mkdtempSync(join(tmpdir(), "transup-tui-sessions-"));

function makeApp(provider: Provider) {
  return (
    <App
      provider={provider}
      projectContext=""
      tools={builtinTools}
      settings={{}}
      initialSessionId={`tui-test-${Math.random().toString(36).slice(2)}`}
      initialHistory={[]}
      mcpToolCount={0}
      sessionDir={sessionDir}
    />
  );
}

const flush = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe("TUI", () => {
  it("首屏渲染横幅（logo/版本/模型/目录）、输入框和状态栏", async () => {
    const { lastFrame, unmount } = render(makeApp(new MockProvider([])));
    await flush();
    // tagline 逐字符渐变，字符间夹着色码 —— 剥掉 ANSI 再断言原文
    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("transup vdev"); // 边框标题（未传 version 时兜底 dev）
    expect(frame).toContain("做极致体验的编程 agent"); // tagline
    expect(frame).toContain("test-model"); // 横幅：模型行
    expect(frame).toContain("会话");
    expect(frame).toContain("◆ test-model"); // 底部状态栏（模型 + 主题标记）
    expect(frame).toContain("❯");
    expect(frame).toContain("上下文");
    expect(frame).toContain("▱"); // 上下文水位仪表条
    unmount();
  });

  it("输入任务 → mock 回复渲染进记录，状态栏累计 tokens", async () => {
    const { stdin, lastFrame, unmount } = render(
      makeApp(new MockProvider([{ content: "你好，这是回复" }])),
    );
    await flush();
    stdin.write("测试一下");
    await flush();
    stdin.write("\r");
    await flush(400);
    const frame = lastFrame()!;
    expect(frame).toContain("测试一下");
    expect(frame).toContain("你好，这是回复");
    expect(frame).toContain("↑10"); // 状态栏 tokens
    unmount();
  });

  it("写操作触发权限对话框，按 y 放行后执行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const target = join(dir, "hello.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "write_file",
            args: JSON.stringify({ path: target, content: "hi" }),
          },
        ],
      },
      { content: "写完了" },
    ]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    stdin.write("写个文件");
    stdin.write("\r");
    await flush(400);
    expect(lastFrame()).toContain("write_file");
    expect(lastFrame()).toContain("允许吗?");
    stdin.write("y");
    await flush(600);
    expect(lastFrame()).toContain("写完了");
    expect(readFileSync(target, "utf-8")).toBe("hi");
    unmount();
  });

  it("权限对话框按 n 拒绝：文件不写入，模型收到拒绝反馈", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const target = join(dir, "deny.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "write_file",
            args: JSON.stringify({ path: target, content: "no" }),
          },
        ],
      },
      { content: "好的，不写了" },
    ]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    stdin.write("写个文件");
    stdin.write("\r");
    await flush(400);
    stdin.write("n");
    await flush(600);
    expect(lastFrame()).toContain("好的，不写了");
    expect(existsSync(target)).toBe(false);
    unmount();
  });

  it("/help 显示命令列表，/cost 显示用量", async () => {
    const { stdin, lastFrame, unmount } = render(makeApp(new MockProvider([])));
    await flush();
    stdin.write("/help");
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("/compact");
    stdin.write("/cost");
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("累计 tokens");
    unmount();
  });
});
