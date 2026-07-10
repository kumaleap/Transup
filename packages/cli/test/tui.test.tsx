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
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, ProviderEvent, ToolCall } from "@transup/core";
import { builtinTools } from "@transup/core";
import { App } from "../src/tui/App.js";
import {TextInput} from "../src/tui/TextInput.js";
import {
  normalizeKeystroke,
  type InputKey,
  type Keystroke,
} from "../src/tui/input/keybinding-router.js";
import {
  useInputController,
  type InputController,
} from "../src/tui/input/use-input-controller.js";

/** 每轮回一段文本；可选带工具调用。usage 挂在 message_done 上。 */
class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "test-model";
  private step = 0;
  streamCalls = 0;
  /** 最近一次请求里的 user 消息内容（验证占位符已还原成全文） */
  lastUserContent = "";
  constructor(private replies: { content: string; toolCalls?: ToolCall[] }[]) {}
  async *stream(messages?: Message[]): AsyncIterable<ProviderEvent> {
    this.streamCalls++;
    const u = [...(messages ?? [])].reverse().find((m) => m.role === "user");
    if (u) this.lastUserContent = u.content;
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

/** 先报 usage 再挂起一会才结束，便于在运行中途抓到活动行 */
class SlowProvider implements Provider {
  readonly id = "mock";
  readonly model = "test-model";
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: "usage", usage: { inputTokens: 1200, outputTokens: 340 } };
    await new Promise((r) => setTimeout(r, 500));
    yield { type: "message_done", content: "ok", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
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

const inputKey = (patch: Partial<InputKey> = {}): InputKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...patch,
});

const stroke = (input: string, patch: Partial<InputKey> = {}): Keystroke =>
  normalizeKeystroke(input, inputKey(patch));

interface ControllerHarnessProps {
  expose: (controller: InputController) => void;
  now: () => number;
  onSubmit: (display: string, expanded: string) => void;
  onExit: () => void;
  onHistoryEntry: (draft: string) => void;
}

function ControllerHarness(props: ControllerHarnessProps) {
  const controller = useInputController({
    active: true,
    now: props.now,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onHistoryEntry: props.onHistoryEntry,
  });
  props.expose(controller);

  return (
    <TextInput
      rootWidth={40}
      view={controller.view}
      onContentWidthChange={controller.setContentWidth}
    />
  );
}

function renderController(now: () => number) {
  let controller: InputController | undefined;
  const onSubmit = vi.fn();
  const onExit = vi.fn();
  const onHistoryEntry = vi.fn();
  const instance = render(
    <ControllerHarness
      expose={(next) => {
        controller = next;
      }}
      now={now}
      onSubmit={onSubmit}
      onExit={onExit}
      onHistoryEntry={onHistoryEntry}
    />,
  );

  return {
    ...instance,
    get controller() {
      if (!controller) throw new Error("controller did not render");
      return controller;
    },
    onSubmit,
    onExit,
    onHistoryEntry,
  };
}

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
    expect(/[╭╮╰╯]/.test(frame)).toBe(true); // 输入框圆角边框
    unmount();
  });

  it("多行粘贴折叠成占位符：输入框不刷屏、记录区显示占位符、模型收到全文", async () => {
    const provider = new MockProvider([{ content: "收到" }]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    // Ink 把整段粘贴作为单次 input 传入
    stdin.write("行1\n行2\n行3");
    await flush();
    const framed = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(framed).toContain("[粘贴 #1 · 3 行]");
    expect(framed).not.toContain("行2"); // 原文不刷进输入框
    stdin.write("\r");
    await flush(400);
    const done = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(done).toContain("[粘贴 #1 · 3 行]"); // 记录区也是占位符
    expect(provider.lastUserContent).toContain("行1\n行2\n行3"); // 模型收到还原后的全文
    unmount();
  });

  it("按字素移动并删除中日韩字符和带肤色 emoji", async () => {
    const provider = new MockProvider([{content: "收到"}]);
    const {stdin, unmount} = render(makeApp(provider));
    await flush();

    stdin.write("a你👍🏽b");
    stdin.write("\x1b[D");
    stdin.write("\x1b[D");
    stdin.write("\x1b[C");
    stdin.write("\x7f");
    stdin.write("\x7f");
    stdin.write("\r");

    await vi.waitFor(() => expect(provider.lastUserContent).toBe("ab"), {timeout: 2000});
    unmount();
  });

  it("Delete performs forward deletion through the App input route", async () => {
    const provider = new MockProvider([{content: "收到"}]);
    const {stdin, unmount} = render(makeApp(provider));
    await flush();

    stdin.write("a你b");
    stdin.write("\x1b[D");
    stdin.write("\x1b[D");
    stdin.write("\x1b[3~");
    stdin.write("\r");

    await vi.waitFor(() => expect(provider.lastUserContent).toBe("ab"), {timeout: 2000});
    unmount();
  });

  it("routes newline chords, backslash Enter, and fused SSH Enter without losing text", async () => {
    const now = () => 10;
    const shift = renderController(now);
    shift.controller.handleEditorKey(stroke("one"));
    shift.controller.handleEditorKey(stroke("\r", {return: true, shift: true}));
    shift.controller.handleEditorKey(stroke("two"));
    shift.controller.handleEditorKey(stroke("\r", {return: true}));
    expect(shift.onSubmit).toHaveBeenCalledWith("one\ntwo", "one\ntwo");
    shift.unmount();

    const meta = renderController(now);
    meta.controller.handleEditorKey(stroke("one"));
    meta.controller.handleEditorKey(stroke("\r", {return: true, meta: true}));
    meta.controller.handleEditorKey(stroke("two"));
    meta.controller.handleEditorKey(stroke("\r", {return: true}));
    expect(meta.onSubmit).toHaveBeenCalledWith("one\ntwo", "one\ntwo");
    meta.unmount();

    const backslash = renderController(now);
    backslash.controller.handleEditorKey(stroke("one\\"));
    backslash.controller.handleEditorKey(stroke("\r", {return: true}));
    backslash.controller.handleEditorKey(stroke("two"));
    backslash.controller.handleEditorKey(stroke("\r", {return: true}));
    expect(backslash.onSubmit).toHaveBeenCalledWith("one\ntwo", "one\ntwo");
    backslash.unmount();

    const fusedSubmit = renderController(now);
    fusedSubmit.controller.handleEditorKey(stroke("hello\r"));
    expect(fusedSubmit.onSubmit).toHaveBeenCalledWith("hello", "hello");
    fusedSubmit.unmount();

    const fusedNewline = renderController(now);
    fusedNewline.controller.handleEditorKey(stroke("hello\\\r"));
    await flush();
    expect(fusedNewline.onSubmit).not.toHaveBeenCalled();
    expect(fusedNewline.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "")).toContain("hello");
    expect(fusedNewline.controller.view.value).toBe("hello\n");
    fusedNewline.unmount();
  });

  it("idle Ctrl+C clears the draft, arms a footer, and exits on a matching second press", async () => {
    let currentNow = 100;
    const harness = renderController(() => currentNow);
    harness.controller.handleEditorKey(stroke("draft"));
    await flush();

    expect(harness.controller.handleGlobalKey(stroke("c", {ctrl: true}))).toBe(true);
    await flush();
    expect(harness.controller.view.value).toBe("");
    expect(harness.lastFrame()).toContain("Press Ctrl-C again to exit");
    expect(harness.onExit).not.toHaveBeenCalled();

    currentNow = 899;
    harness.controller.handleGlobalKey(stroke("c", {ctrl: true}));
    expect(harness.onExit).toHaveBeenCalledOnce();
    harness.unmount();
  });

  it("empty Ctrl+D shares the 800ms exit primitive and expiry rearms it", async () => {
    let currentNow = 0;
    const harness = renderController(() => currentNow);

    harness.controller.handleEditorKey(stroke("d", {ctrl: true}));
    await flush();
    expect(harness.lastFrame()).toContain("Press Ctrl-D again to exit");

    currentNow = 801;
    harness.controller.handleEditorKey(stroke("d", {ctrl: true}));
    expect(harness.onExit).not.toHaveBeenCalled();

    currentNow = 1600;
    harness.controller.handleEditorKey(stroke("d", {ctrl: true}));
    expect(harness.onExit).toHaveBeenCalledOnce();
    harness.unmount();
  });

  it("Escape saves the exact draft to history only on the matching second press", async () => {
    let currentNow = 10;
    const harness = renderController(() => currentNow);
    harness.controller.handleEditorKey(stroke("  draft  "));
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    await flush();
    expect(harness.lastFrame()).toContain("Esc again to clear");
    expect(harness.controller.view.value).toBe("  draft  ");
    expect(harness.onHistoryEntry).not.toHaveBeenCalled();

    currentNow = 809;
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    await flush();
    expect(harness.onHistoryEntry).toHaveBeenCalledWith("  draft  ");
    expect(harness.controller.view.value).toBe("");

    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("  draft  ");
    harness.unmount();
  });

  it("Escape preserves a whitespace-only draft before clearing it", () => {
    const harness = renderController(() => 10);
    harness.controller.handleEditorKey(stroke("   "));
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    harness.controller.handleEditorKey(stroke("", {escape: true}));

    expect(harness.onHistoryEntry).toHaveBeenCalledWith("   ");
    expect(harness.controller.view.value).toBe("");
    harness.unmount();
  });

  it("unrelated editing clears pending feedback and unmount clears its timer", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      let currentNow = 0;
      const harness = renderController(() => currentNow);
      harness.controller.handleEditorKey(stroke("draft"));
      harness.controller.handleEditorKey(stroke("", {escape: true}));
      expect(vi.getTimerCount()).toBe(1);

      currentNow = 1;
      harness.controller.handleEditorKey(stroke("x"));
      expect(harness.controller.view.footer).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);

      harness.controller.handleEditorKey(stroke("", {escape: true}));
      expect(vi.getTimerCount()).toBe(1);
      harness.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("App routes the first idle Ctrl+C to the input footer instead of exiting", async () => {
    const {stdin, lastFrame, unmount} = render(makeApp(new MockProvider([])));
    await flush();
    stdin.write("draft");
    stdin.write("\x03");
    await flush();

    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("Press Ctrl-C again to exit");
    expect(frame).not.toContain("draft");
    unmount();
  });

  it("按测量宽度换行且不拆分 ZWJ emoji", async () => {
    const family = "👨‍👩‍👧‍👦";
    const {lastFrame, unmount} = render(
      <TextInput
        rootWidth={5}
        view={{value: `a${family}b`, cursor: 1, active: true}}
      />,
    );
    await flush();

    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame.split("\n")).toEqual([`❯ a`, `  ${family}`, "  b"]);
    unmount();
  });

  it("根宽度不足五格时只显示省略号", async () => {
    const {lastFrame, unmount} = render(
      <TextInput rootWidth={4} view={{value: "保留原模型", cursor: 5, active: true}} />,
    );
    await flush();

    expect(lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "")).toBe("…");
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

  it("权限对话框保留输入历史和粘贴引用，且放行键不会写入输入框", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-router-"));
    const target = join(dir, "preserved.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "t1",
            name: "write_file",
            args: JSON.stringify({path: target, content: "kept"}),
          },
        ],
      },
      {content: "权限处理完成"},
      {content: "历史输入已重放"},
    ]);
    const {stdin, lastFrame, unmount} = render(makeApp(provider));
    const pastedDraft = "保留\n这个\n草稿";
    await flush();

    stdin.write(pastedDraft);
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("允许吗?"), {timeout: 2000});

    stdin.write("y");
    await vi.waitFor(() => expect(lastFrame()).toContain("权限处理完成"), {timeout: 2000});
    const callsAfterPermission = provider.streamCalls;

    // If the permission key leaked into the newly visible editor, Enter would submit "y".
    stdin.write("\r");
    await flush();
    expect(provider.streamCalls).toBe(callsAfterPermission);

    stdin.write("\x1b[A");
    stdin.write("\r");
    await vi.waitFor(
      () => expect(provider.streamCalls).toBeGreaterThan(callsAfterPermission),
      {timeout: 2000},
    );
    expect(provider.lastUserContent).toBe(pastedDraft);
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

  it("运行期活动行：英文状态词 + 执行时长 + 实时 tokens", async () => {
    const { stdin, lastFrame, unmount } = render(makeApp(new SlowProvider()));
    await flush();
    stdin.write("hi");
    stdin.write("\r");
    await flush(250); // 此刻引擎还挂在 SlowProvider 里
    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toMatch(/Thinking|Responding/); // 英文状态词
    expect(frame).toMatch(/\d+s ·/); // 执行时长
    expect(frame).toContain("↑1.2k"); // 实时 input tokens
    expect(frame).toContain("↓340"); // 实时 output tokens
    expect(frame).toContain("working…"); // 输入框运行态英文占位
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
