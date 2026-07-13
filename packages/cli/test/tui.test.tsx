/**
 * TUI 冒烟测试 —— ink-testing-library + mock provider
 *
 * 验证核心链路而不碰真实 API：
 * 1. 首屏横幅与输入框渲染
 * 2. 输入 → 引擎跑 mock 回复 → 流式文本落进 transcript
 * 3. 工具调用（写操作）→ 权限对话框弹出 → 数字直选放行 / Esc 拒绝 /
 *    会话级选项 / Tab 附言 / Shift+Tab 模式循环 / 队列
 * 4. 斜杠命令 /help /cost
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, ProviderEvent, ToolCall } from "@transup/core";
import { builtinTools } from "@transup/core";
import { App } from "../src/tui/App.js";
import {RowText, TextInput} from "../src/tui/TextInput.js";
import {T} from "../src/theme.js";
import {Box} from "../src/tui/runtime/index.js";
import {
  normalizeKeystroke,
  type InputKey,
  type Keystroke,
} from "../src/tui/input/keybinding-router.js";
import {
  useInputController,
  type InputController,
} from "../src/tui/input/use-input-controller.js";
import {
  HistoryStore,
  type HistoryEntry,
} from "../src/tui/input/history-store.js";
import {pasteMarker} from "../src/tui/input/paste-registry.js";
import {TextBuffer} from "../src/tui/input/text-buffer.js";

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
  streamCalls = 0;
  async *stream(): AsyncIterable<ProviderEvent> {
    this.streamCalls++;
    yield { type: "usage", usage: { inputTokens: 1200, outputTokens: 340 } };
    await new Promise((r) => setTimeout(r, 500));
    yield { type: "message_done", content: "ok", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const sessionDir = mkdtempSync(join(tmpdir(), "transup-tui-sessions-"));
const promptHistoryDir = mkdtempSync(join(tmpdir(), "transup-tui-history-"));

function newHistoryPath(): string {
  return join(
    promptHistoryDir,
    `${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function pendingPromise(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

class ControlledHistoryStore extends HistoryStore {
  constructor(private readonly flushResult: Promise<void>) {
    super({filePath: newHistoryPath()});
  }

  override async load() {
    return [];
  }

  override async append() {}

  override flush() {
    return this.flushResult;
  }
}

class PendingLoadHistoryStore extends HistoryStore {
  private readonly loaded: Promise<readonly HistoryEntry[]>;
  private resolveLoaded!: (entries: readonly HistoryEntry[]) => void;

  constructor() {
    super({filePath: newHistoryPath()});
    this.loaded = new Promise((resolve) => {
      this.resolveLoaded = resolve;
    });
  }

  completeLoad(entries: readonly HistoryEntry[]) {
    this.resolveLoaded(entries);
  }

  override load() {
    return this.loaded;
  }

  override async append() {}
}

function makeApp(provider: Provider, historyPath = newHistoryPath()) {
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
      historyPath={historyPath}
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
  onHistoryError: (error: unknown) => void;
  historyPath: string;
  historyStore?: HistoryStore;
}

function ControllerHarness(props: ControllerHarnessProps) {
  const controller = useInputController({
    active: true,
    now: props.now,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onHistoryEntry: props.onHistoryEntry,
    onHistoryError: props.onHistoryError,
    historyPath: props.historyPath,
    historyStore: props.historyStore,
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

function renderController(
  now: () => number,
  options: {historyPath?: string; historyStore?: HistoryStore} = {},
) {
  let controller: InputController | undefined;
  const onSubmit = vi.fn();
  const onExit = vi.fn();
  const onHistoryEntry = vi.fn();
  const onHistoryError = vi.fn();
  const instance = render(
    <ControllerHarness
      expose={(next) => {
        controller = next;
      }}
      now={now}
      onSubmit={onSubmit}
      onExit={onExit}
      onHistoryEntry={onHistoryEntry}
      onHistoryError={onHistoryError}
      historyPath={options.historyPath ?? newHistoryPath()}
      historyStore={options.historyStore}
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
    onHistoryError,
  };
}

function routeControllerKey(
  controller: InputController,
  input: string,
  patch: Partial<InputKey> = {},
): boolean {
  const key = stroke(input, patch);
  if (controller.handleGlobalKey(key)) return true;
  return controller.isHistorySearchActive()
    ? controller.handleHistorySearchKey(key)
    : controller.handleEditorKey(key);
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

  it("folds official bracketed paste and submits its expanded content synchronously", async () => {
    const provider = new MockProvider([{ content: "收到" }]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();

    stdin.write("\x1b[200~e\u0301\n行2\n行3\x1b[201~");
    stdin.write("\r");

    await vi.waitFor(
      () => expect(provider.lastUserContent).toBe("é\n行2\n行3"),
      {timeout: 2000},
    );
    const done = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(done).toContain("[Pasted text #1 +2 lines]");
    expect(done).not.toContain("行2");
    unmount();
  });

  it("keeps a plain multi-character single-line chunk inline", async () => {
    const provider = new MockProvider([{content: "收到"}]);
    const {stdin, lastFrame, unmount} = render(makeApp(provider));
    await flush();

    stdin.write("单行批量");
    stdin.write("\r");

    await vi.waitFor(
      () => expect(provider.lastUserContent).toBe("单行批量"),
      {timeout: 2000},
    );
    const done = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(done).toContain("单行批量");
    expect(done).not.toContain("[Pasted text");
    unmount();
  });

  it("folds an oversized single-line fallback chunk in the controller", async () => {
    const harness = renderController(() => 10);
    const content = "x".repeat(801);

    harness.controller.handleEditorKey(stroke(content));
    await vi.waitFor(
      () =>
        expect(harness.controller.view.value).toBe(
          "[Pasted text #1 +0 lines]",
        ),
      {timeout: 2000},
    );

    harness.controller.handleEditorKey(stroke("", {return: true}));
    expect(harness.onSubmit).toHaveBeenCalledWith(
      "[Pasted text #1 +0 lines]",
      content,
    );
    harness.unmount();
  });

  it("restores a folded paste from project history after remount", async () => {
    const historyPath = newHistoryPath();
    const content = "first\nsecond\nthird";
    const firstProvider = new MockProvider([{content: "stored"}]);
    const first = render(makeApp(firstProvider, historyPath));
    await flush();
    first.stdin.write(`\x1b[200~${content}\x1b[201~`);
    first.stdin.write("\r");
    await vi.waitFor(
      () => expect(firstProvider.lastUserContent).toBe(content),
      {timeout: 3000},
    );
    await vi.waitFor(
      () => expect(readFileSync(historyPath, "utf8")).toContain("Pasted text #1"),
      {timeout: 3000},
    );
    first.unmount();

    const secondProvider = new MockProvider([{content: "recalled"}]);
    const second = render(makeApp(secondProvider, historyPath));
    await vi.waitFor(
      () => {
        second.stdin.write("\x1b[A");
        expect(second.lastFrame()).toContain("[Pasted text #1 +2 lines]");
      },
      {timeout: 3000},
    );
    second.stdin.write("\r");
    await vi.waitFor(
      () => expect(secondProvider.lastUserContent).toBe(content),
      {timeout: 3000},
    );
    second.unmount();
  });

  it("submits despite history I/O failure and reports it only once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "transup-history-error-"));
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "block");
    const provider = new MockProvider([{content: "ok"}]);
    const instance = render(
      makeApp(provider, join(blockingFile, "history.jsonl")),
    );
    await flush();

    instance.stdin.write("still runs");
    instance.stdin.write("\r");
    await vi.waitFor(
      () => expect(provider.lastUserContent).toBe("still runs"),
      {timeout: 3000},
    );
    await vi.waitFor(
      () => expect(instance.lastFrame()).toContain("Prompt history unavailable:"),
      {timeout: 3000},
    );

    const frame = instance.lastFrame()!;
    expect(frame.match(/Prompt history unavailable:/g)).toHaveLength(1);
    instance.unmount();
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

  it("routes the legacy terminal Ctrl+_ byte to undo", async () => {
    const harness = renderController(() => 10);
    harness.controller.handleEditorKey(stroke("draft"));
    harness.controller.handleEditorKey(stroke("\x1f"));
    await flush();

    expect(harness.controller.view.value).toBe("");
    harness.unmount();
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
    await vi.waitFor(() => expect(harness.onExit).toHaveBeenCalledOnce());
    harness.unmount();
  });

  it("idle Ctrl+C resets history navigation after clearing a recalled value", async () => {
    const harness = renderController(() => 100);
    harness.controller.handleEditorKey(stroke("first"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("latest"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("draft"));
    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("latest");

    harness.controller.handleGlobalKey(stroke("c", {ctrl: true}));
    harness.controller.handleEditorKey(stroke("", {downArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("");

    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("latest");
    harness.unmount();
  });

  it("waits for history flush before completing a requested exit", async () => {
    const pending = pendingPromise();
    const harness = renderController(
      () => 10,
      {historyStore: new ControlledHistoryStore(pending.promise)},
    );

    harness.controller.requestExit();
    expect(harness.onExit).not.toHaveBeenCalled();
    harness.controller.handleEditorKey(stroke("ignored"));
    expect(harness.controller.view.value).toBe("");
    pending.resolve();

    await vi.waitFor(() => expect(harness.onExit).toHaveBeenCalledOnce());
    harness.controller.requestExit();
    expect(harness.onExit).toHaveBeenCalledOnce();
    harness.unmount();
  });

  it("bounds a hung history flush to 500ms", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      const harness = renderController(
        () => 10,
        {historyStore: new ControlledHistoryStore(new Promise(() => undefined))},
      );

      harness.controller.requestExit();
      await vi.advanceTimersByTimeAsync(499);
      expect(harness.onExit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.onExit).toHaveBeenCalledOnce();
      harness.controller.requestExit();
      expect(harness.onExit).toHaveBeenCalledOnce();
      harness.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending exit timer when the controller unmounts", async () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    try {
      const harness = renderController(
        () => 10,
        {historyStore: new ControlledHistoryStore(new Promise(() => undefined))},
      );

      harness.controller.requestExit();
      expect(vi.getTimerCount()).toBe(1);
      harness.unmount();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(harness.onExit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rejected history flush and still exits", async () => {
    const failure = new Error("flush failed");
    const harness = renderController(
      () => 10,
      {historyStore: new ControlledHistoryStore(Promise.reject(failure))},
    );

    harness.controller.requestExit();

    await vi.waitFor(() => expect(harness.onExit).toHaveBeenCalledOnce());
    expect(harness.onHistoryError).toHaveBeenCalledWith(failure);
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
    await vi.waitFor(() => expect(harness.onExit).toHaveBeenCalledOnce());
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

  it("persists an Escape-cleared folded paste with its structured reference", async () => {
    const historyPath = newHistoryPath();
    const harness = renderController(() => 10, {historyPath});
    harness.controller.handlePaste("draft\ncontent");
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    harness.controller.handleEditorKey(stroke("", {escape: true}));

    await vi.waitFor(
      () => expect(readFileSync(historyPath, "utf8")).toContain("draft\\ncontent"),
      {timeout: 3000},
    );
    const persisted = JSON.parse(readFileSync(historyPath, "utf8").trim());
    expect(persisted.display).toBe("[Pasted text #1 +1 lines]");
    expect(persisted.pastes).toEqual([
      {
        id: 1,
        content: "draft\ncontent",
        start: 0,
        end: persisted.display.length,
      },
    ]);
    harness.unmount();
  });

  it("Escape clears a whitespace-only draft and resets history navigation", async () => {
    const harness = renderController(() => 10);

    harness.controller.handleEditorKey(stroke("first"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("latest"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("latest");

    harness.controller.handleEditorKey(stroke("k", {ctrl: true}));
    harness.controller.handleEditorKey(stroke("   "));
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    harness.controller.handleEditorKey(stroke("", {escape: true}));
    await flush();

    expect(harness.onHistoryEntry).not.toHaveBeenCalled();
    expect(harness.controller.view.value).toBe("");
    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("latest");
    harness.unmount();
  });

  it("restores the exact draft and paste data after history navigation", async () => {
    const harness = renderController(() => 10);
    harness.controller.handleEditorKey(stroke("saved"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handlePaste("draft\ncontent");
    harness.controller.handleEditorKey(stroke("", {leftArrow: true}));
    await flush();
    const draftCursor = harness.controller.view.cursor;

    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("saved");
    expect(harness.controller.view.cursor).toBe(0);

    harness.controller.handleEditorKey(stroke("", {downArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("[Pasted text #1 +1 lines]");
    expect(harness.controller.view.cursor).toBe(draftCursor);

    harness.controller.handleEditorKey(stroke("", {return: true}));
    expect(harness.onSubmit).toHaveBeenLastCalledWith(
      "[Pasted text #1 +1 lines]",
      "draft\ncontent",
    );
    harness.unmount();
  });

  it.each([
    ["Escape", {escape: true}],
    ["Tab", {tab: true}],
  ] as const)(
    "%s accepts an incremental history match without submitting it",
    async (_label, acceptKey) => {
      const harness = renderController(() => 10);
      for (const prompt of [
        "target old",
        "target duplicate",
        "unrelated",
        "target duplicate",
      ]) {
        routeControllerKey(harness.controller, prompt);
        routeControllerKey(harness.controller, "", {return: true});
      }
      const submissionsBeforeSearch = harness.onSubmit.mock.calls.length;

      routeControllerKey(harness.controller, "r", {ctrl: true});
      routeControllerKey(harness.controller, "target");
      await flush();
      expect(harness.controller.view.value).toBe("target duplicate");
      expect(harness.lastFrame()).toContain("search prompts: target");

      routeControllerKey(harness.controller, "z");
      await flush();
      expect(harness.controller.view.value).toBe("target duplicate");
      expect(harness.lastFrame()).toContain("no matching prompt: targetz");

      routeControllerKey(harness.controller, "", {backspace: true});
      routeControllerKey(harness.controller, "r", {ctrl: true});
      await flush();
      expect(harness.controller.view.value).toBe("target old");

      routeControllerKey(harness.controller, "", acceptKey);
      await flush();
      expect(harness.controller.isHistorySearchActive()).toBe(false);
      expect(harness.controller.view.value).toBe("target old");
      expect(harness.lastFrame()).not.toContain("search prompts:");
      expect(harness.onSubmit).toHaveBeenCalledTimes(submissionsBeforeSearch);

      routeControllerKey(harness.controller, "", {return: true});
      expect(harness.onSubmit).toHaveBeenLastCalledWith("target old", "target old");
      harness.unmount();
    },
  );

  it.each([
    ["Ctrl+C", "c", {ctrl: true}],
    ["Backspace on an empty query", "", {backspace: true}],
  ] as const)(
    "%s cancels search and restores the exact editor snapshot",
    async (_label, input, cancelKey) => {
      const harness = renderController(() => 10);
      routeControllerKey(harness.controller, "saved prompt");
      routeControllerKey(harness.controller, "", {return: true});
      harness.controller.handlePaste("draft\ncontent");
      routeControllerKey(harness.controller, "", {leftArrow: true});
      await flush();
      const originalValue = harness.controller.view.value;
      const originalCursor = harness.controller.view.cursor;

      routeControllerKey(harness.controller, "r", {ctrl: true});
      expect(harness.controller.isHistorySearchActive()).toBe(true);
      routeControllerKey(harness.controller, input, cancelKey);
      await flush();

      expect(harness.controller.isHistorySearchActive()).toBe(false);
      expect(harness.controller.view.value).toBe(originalValue);
      expect(harness.controller.view.cursor).toBe(originalCursor);
      expect(harness.lastFrame()).not.toContain("Press Ctrl-C again to exit");
      expect(harness.onExit).not.toHaveBeenCalled();

      routeControllerKey(harness.controller, "", {return: true});
      expect(harness.onSubmit).toHaveBeenLastCalledWith(
        "[Pasted text #1 +1 lines]",
        "draft\ncontent",
      );
      harness.unmount();
    },
  );

  it("keeps an active search stable across a late history load and uses it on the next query", async () => {
    const store = new PendingLoadHistoryStore();
    const harness = renderController(() => 10, {historyStore: store});
    routeControllerKey(harness.controller, "draft");
    routeControllerKey(harness.controller, "", {leftArrow: true});
    await flush();
    const originalCursor = harness.controller.view.cursor;

    routeControllerKey(harness.controller, "r", {ctrl: true});
    await flush();
    expect(harness.controller.view.value).toBe("draft");
    expect(harness.controller.view.cursor).toBe(originalCursor);
    expect(harness.lastFrame()).toContain("no matching prompt:");

    store.completeLoad([
      {
        v: 1,
        display: "loaded target",
        pastes: [],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await flush();
    expect(harness.controller.view.value).toBe("draft");
    expect(harness.controller.view.cursor).toBe(originalCursor);

    routeControllerKey(harness.controller, "r", {ctrl: true});
    await flush();
    expect(harness.controller.view.value).toBe("loaded target");
    expect(harness.lastFrame()).toContain("search prompts:");
    harness.unmount();
  });

  it("merges a late disk load without disturbing active session navigation", async () => {
    const store = new PendingLoadHistoryStore();
    const harness = renderController(() => 10, {historyStore: store});
    harness.controller.handleEditorKey(stroke("session"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("draft"));
    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("session");
    expect(harness.controller.view.cursor).toBe(0);

    store.completeLoad([
      {
        v: 1,
        display: "disk",
        pastes: [],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await flush();
    expect(harness.controller.view.value).toBe("session");
    expect(harness.controller.view.cursor).toBe(0);

    harness.controller.handleEditorKey(stroke("", {downArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("draft");
    expect(harness.controller.view.cursor).toBe("draft".length);

    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    harness.controller.handleEditorKey(stroke("", {upArrow: true}));
    await flush();
    expect(harness.controller.view.value).toBe("disk");
    harness.unmount();
  });

  it("continues paste IDs after loading persisted history", async () => {
    const historyPath = newHistoryPath();
    const content = "old\npaste";
    const marker = pasteMarker(7, content);
    writeFileSync(
      historyPath,
      `${JSON.stringify({
        v: 1,
        display: marker,
        pastes: [{id: 7, content, start: 0, end: marker.length}],
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const harness = renderController(() => 10, {historyPath});
    await vi.waitFor(() => {
      harness.controller.handleEditorKey(stroke("", {upArrow: true}));
      expect(harness.controller.view.value).toBe(marker);
    });
    harness.controller.handleEditorKey(stroke("", {downArrow: true}));
    harness.controller.handlePaste("new\npaste");
    await flush();

    expect(harness.controller.view.value).toBe("[Pasted text #8 +1 lines]");
    harness.unmount();
  });

  it("keeps the loaded paste ID floor after undo restores an older snapshot", async () => {
    const store = new PendingLoadHistoryStore();
    const harness = renderController(() => 10, {historyStore: store});
    harness.controller.handleEditorKey(stroke("typed"));
    const content = "old\npaste";
    const marker = pasteMarker(7, content);
    store.completeLoad([
      {
        v: 1,
        display: marker,
        pastes: [{id: 7, content, start: 0, end: marker.length}],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ]);
    await flush();

    harness.controller.handleEditorKey(stroke("\x1f"));
    harness.controller.handlePaste("new\npaste");
    await flush();

    expect(harness.controller.view.value).toBe("[Pasted text #8 +1 lines]");
    harness.unmount();
  });

  it("scans paste IDs before capping merged history to 100 entries", async () => {
    const store = new PendingLoadHistoryStore();
    const harness = renderController(() => 10, {historyStore: store});
    harness.controller.handleEditorKey(stroke("session"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    const content = "old\npaste";
    const marker = pasteMarker(7, content);
    const loaded: HistoryEntry[] = [
      {
        v: 1,
        display: marker,
        pastes: [{id: 7, content, start: 0, end: marker.length}],
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      ...Array.from({length: 99}, (_, index): HistoryEntry => ({
        v: 1,
        display: `disk ${index}`,
        pastes: [],
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      })),
    ];
    store.completeLoad(loaded);
    await flush();

    harness.controller.handlePaste("new\npaste");
    await flush();

    expect(harness.controller.view.value).toBe("[Pasted text #8 +1 lines]");
    harness.unmount();
  });

  it("persists slash commands but not exit control commands", async () => {
    const historyPath = newHistoryPath();
    const harness = renderController(() => 10, {historyPath});
    harness.controller.handleEditorKey(stroke("/help"));
    harness.controller.handleEditorKey(stroke("", {return: true}));
    harness.controller.handleEditorKey(stroke("exit"));
    harness.controller.handleEditorKey(stroke("", {return: true}));

    await vi.waitFor(
      () => expect(readFileSync(historyPath, "utf8")).toContain("/help"),
      {timeout: 3000},
    );
    const lines = readFileSync(historyPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("exit");
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

  it("App cancels history search before applying idle Ctrl+C exit behavior", async () => {
    const instance = render(makeApp(new MockProvider([])));
    await flush();
    instance.stdin.write("draft");
    instance.stdin.write("\x1b[D");
    instance.stdin.write("\x12");
    await flush();
    expect(instance.lastFrame()).toContain("no matching prompt:");

    instance.stdin.write("\x03");
    await flush();
    let frame = instance.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("draft");
    expect(frame).not.toContain("search prompts:");
    expect(frame).not.toContain("no matching prompt:");
    expect(frame).not.toContain("Press Ctrl-C again to exit");

    instance.stdin.write("\x03");
    await flush();
    frame = instance.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("Press Ctrl-C again to exit");
    expect(frame).not.toContain("draft");
    instance.unmount();
  });

  it("searches persisted folded paste and submits it through synchronous App routing", async () => {
    const historyPath = newHistoryPath();
    const content = "stored\ncontent";
    const marker = pasteMarker(7, content);
    writeFileSync(
      historyPath,
      `${JSON.stringify({
        v: 1,
        display: marker,
        pastes: [{id: 7, content, start: 0, end: marker.length}],
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const provider = new MockProvider([{content: "received"}]);
    const instance = render(makeApp(provider, historyPath));
    await flush();

    await vi.waitFor(() => {
      instance.stdin.write("\x1b[A");
      expect(instance.lastFrame()).toContain(marker);
    });
    instance.stdin.write("\x1b[B");
    await flush();

    instance.stdin.write("\x12");
    instance.stdin.write("Pasted");
    instance.stdin.write("\r");

    await vi.waitFor(
      () => expect(provider.lastUserContent).toBe(content),
      {timeout: 2000},
    );
    expect(instance.lastFrame()).toContain(marker);
    instance.unmount();
  });

  it("accepts a search with Tab and returns to editor routing in the same stdin batch", async () => {
    const historyPath = newHistoryPath();
    writeFileSync(
      historyPath,
      `${JSON.stringify({
        v: 1,
        display: "stored choice",
        pastes: [],
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const provider = new MockProvider([{content: "received"}]);
    const instance = render(makeApp(provider, historyPath));
    await flush();

    await vi.waitFor(() => {
      instance.stdin.write("\x1b[A");
      expect(instance.lastFrame()).toContain("stored choice");
    });
    instance.stdin.write("\x1b[B");
    await flush();

    instance.stdin.write("\x12");
    instance.stdin.write("\t");
    instance.stdin.write("!");
    instance.stdin.write("\r");

    await vi.waitFor(
      () => expect(provider.lastUserContent).toBe("stored choice!"),
      {timeout: 2000},
    );
    instance.unmount();
  });

  it("lets a second Ctrl+C exit after an aborted turn has settled", async () => {
    const instance = render(makeApp(new SlowProvider()));
    await flush();
    instance.stdin.write("run");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("working…"));

    instance.stdin.write("\x03");
    await vi.waitFor(
      () => expect(instance.lastFrame()).not.toContain("working…"),
      {timeout: 2000},
    );
    instance.stdin.write("\x03");
    await flush();
    instance.stdin.write("after exit");
    await flush();

    expect(instance.lastFrame()).not.toContain("after exit");
    instance.unmount();
  });

  it("clears the running-abort exit arm after unrelated idle input", async () => {
    const instance = render(makeApp(new SlowProvider()));
    await flush();
    instance.stdin.write("run");
    instance.stdin.write("\r");
    await vi.waitFor(() => expect(instance.lastFrame()).toContain("working…"));

    instance.stdin.write("\x03");
    await vi.waitFor(
      () => expect(instance.lastFrame()).not.toContain("working…"),
      {timeout: 2000},
    );
    instance.stdin.write("draft");
    instance.stdin.write("\x03");
    await flush();

    const frame = instance.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("Press Ctrl-C again to exit");
    expect(frame).not.toContain("draft");
    instance.unmount();
  });

  it("按测量宽度换行且不拆分 ZWJ emoji", async () => {
    const family = "👨‍👩‍👧‍👦";
    const {lastFrame, unmount} = render(
      <Box width={5}>
        <TextInput
          rootWidth={5}
          view={{value: `a${family}b`, cursor: 1, active: true}}
        />
      </Box>,
    );
    await flush();

    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame.split("\n")).toEqual([`❯ a`, `  ${family}`, "  b"]);
    unmount();
  });

  it("根宽度不足五格时只显示省略号", async () => {
    const {lastFrame, unmount} = render(
      <Box width={4}>
        <TextInput rootWidth={4} view={{value: "保留原模型", cursor: 5, active: true}} />
      </Box>,
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
    await vi.waitFor(
      () => expect(lastFrame()).toContain("你好，这是回复"),
      {timeout: 3000},
    );
    const frame = lastFrame()!;
    expect(frame).toContain("测试一下");
    expect(frame).toContain("你好，这是回复");
    expect(frame).toContain("↑10"); // 状态栏 tokens
    unmount();
  });

  it("colors only the history match and omits the inverse cursor while searching", () => {
    const value = "before target after";
    const start = value.indexOf("target");
    const row = {start: 0, end: value.length, width: value.length, hardBreak: false};
    const element = RowText({
      buffer: TextBuffer.from(value, start + "target".length),
      row,
      showCursor: false,
      match: {start, end: start + "target".length},
    });
    const children = React.Children.toArray(element.props.children);

    expect(children[0]).toBe("before ");
    const highlighted = children[1];
    if (!React.isValidElement<{color?: string; inverse?: boolean; children?: React.ReactNode}>(highlighted)) {
      throw new Error("history match did not render as a styled text span");
    }
    expect(highlighted.props.color).toBe(T.warn);
    expect(highlighted.props.children).toBe("target");
    expect(highlighted.props.inverse).toBeUndefined();
    expect(children[2]).toBe(" after");
  });

  it("accepts only the first prompt from one synchronous stdin batch", async () => {
    const provider = new SlowProvider();
    const instance = render(makeApp(provider));
    await flush();

    instance.stdin.write("one");
    instance.stdin.write("\r");
    instance.stdin.write("two");
    instance.stdin.write("\r");

    await vi.waitFor(() => expect(provider.streamCalls).toBe(1));
    await flush();
    const frame = instance.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("❯ one");
    expect(frame).not.toContain("❯ two");
    instance.unmount();
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
    await vi.waitFor(
      () => expect(lastFrame()).toContain("创建文件"),
      {timeout: 3000},
    );
    expect(lastFrame()).toContain("创建文件"); // 目标不存在 → "创建"标题
    expect(lastFrame()).toContain("要创建 hello.txt 吗？");
    stdin.write("1"); // 数字直选"是"
    await vi.waitFor(
      () => expect(lastFrame()).toContain("写完了"),
      {timeout: 3000},
    );
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
    await vi.waitFor(() => expect(lastFrame()).toContain("◈"), {timeout: 2000});

    stdin.write("\x12");
    await flush();
    expect(lastFrame()).toContain("◈");
    expect(lastFrame()).not.toContain("search prompts:");
    expect(lastFrame()).not.toContain("no matching prompt:");

    stdin.write("1"); // 数字直选"是"
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

  it("权限对话框按 Esc 拒绝：文件不写入，模型收到拒绝反馈", async () => {
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
    stdin.write("\x1b"); // Esc = 拒绝
    await flush(600);
    expect(lastFrame()).toContain("好的，不写了");
    expect(existsSync(target)).toBe(false);
    unmount();
  });

  it("会话级选项（数字 2）切到 acceptEdits：后续编辑不再询问，footer 显示模式", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const a = join(dir, "a.txt").replace(/\\/g, "/");
    const b = join(dir, "b.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: a, content: "1" }) },
        ],
      },
      {
        content: "",
        toolCalls: [
          { id: "t2", name: "write_file", args: JSON.stringify({ path: b, content: "2" }) },
        ],
      },
      { content: "两个都写完了" },
    ]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    stdin.write("写两个文件");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("创建文件"), { timeout: 3000 });
    stdin.write("2"); // 会话级：本会话内允许所有编辑
    await vi.waitFor(() => expect(lastFrame()).toContain("两个都写完了"), { timeout: 3000 });
    expect(readFileSync(a, "utf-8")).toBe("1");
    expect(readFileSync(b, "utf-8")).toBe("2"); // 第二个写入没有再弹窗
    const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("accept edits on"); // footer 模式指示
    unmount();
  });

  it("拒绝时 Tab 附言：反馈文本随工具结果回流", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const target = join(dir, "veto.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: target, content: "x" }) },
        ],
      },
      { content: "收到，换个方案" },
    ]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    stdin.write("写文件");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("创建文件"), { timeout: 3000 });
    stdin.write("\x1b[B"); // ↓ 到会话级
    stdin.write("\x1b[B"); // ↓ 到"否"
    stdin.write("\t"); // 展开附言
    await flush();
    stdin.write("改用别的方案");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("收到，换个方案"), { timeout: 3000 });
    expect(existsSync(target)).toBe(false);
    expect(lastFrame()).toContain("改用别的方案"); // 拒绝文案（含附言）进了工具结果预览
    unmount();
  });

  it("Shift+Tab 循环到 plan 模式：写操作直接拒绝并回流引导文案", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const target = join(dir, "plan.txt").replace(/\\/g, "/");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: target, content: "x" }) },
        ],
      },
      { content: "那我先给出计划" },
    ]);
    const { stdin, lastFrame, unmount } = render(makeApp(provider));
    await flush();
    stdin.write("\x1b[Z"); // Shift+Tab → acceptEdits
    stdin.write("\x1b[Z"); // Shift+Tab → plan
    await flush();
    let frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("plan mode on");

    stdin.write("写文件");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("那我先给出计划"), { timeout: 3000 });
    expect(existsSync(target)).toBe(false); // 没有弹窗，直接被 plan 模式拒绝
    frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(frame).toContain("plan 模式");
    unmount();
  });

  it("并发只读询问进队列：逐个确认，显示排队数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-tui-"));
    const f1 = join(dir, "one.txt").replace(/\\/g, "/");
    const f2 = join(dir, "two.txt").replace(/\\/g, "/");
    writeFileSync(f1, "1");
    writeFileSync(f2, "2");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", args: JSON.stringify({ path: f1 }) },
          { id: "t2", name: "read_file", args: JSON.stringify({ path: f2 }) },
        ],
      },
      { content: "都读完了" },
    ]);
    // ask 规则命中只读工具 → 两个并发 read_file 同时请求确认
    const { stdin, lastFrame, unmount } = render(
      <App
        provider={provider}
        projectContext=""
        tools={builtinTools}
        settings={{ permissions: { ask: ["read_file"] } }}
        initialSessionId={`tui-test-${Math.random().toString(36).slice(2)}`}
        initialHistory={[]}
        mcpToolCount={0}
        sessionDir={sessionDir}
        historyPath={newHistoryPath()}
      />,
    );
    await flush();
    stdin.write("读两个文件");
    stdin.write("\r");
    await vi.waitFor(() => expect(lastFrame()).toContain("还有 1 个待确认"), { timeout: 3000 });
    stdin.write("1"); // 放行第一个
    await flush();
    stdin.write("1"); // 放行第二个
    await vi.waitFor(() => expect(lastFrame()).toContain("都读完了"), { timeout: 3000 });
    unmount();
  });

  it("运行期活动行：英文状态词 + 执行时长 + 实时 tokens", async () => {
    const { stdin, lastFrame, unmount } = render(makeApp(new SlowProvider()));
    await flush();
    stdin.write("hi");
    stdin.write("\r");
    await vi.waitFor(
      () => expect(lastFrame()).toContain("↑1.2k"),
      {timeout: 3000},
    );
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
