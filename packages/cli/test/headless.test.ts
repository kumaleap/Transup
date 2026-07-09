/**
 * Headless 模式测试 —— mock provider 驱动，不碰真实 API
 *
 * 验证 core"多宿主"承诺的第一个非终端消费者：
 *   - stdout 只有正文、stderr 只有过程信息（管道友好）
 *   - fail-closed 权限：写操作默认拒绝，--allow-all / settings 放行
 *   - 退出码语义：正常 0，断档 1
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, Provider, ProviderEvent, ToolCall } from "@transup/core";
import { builtinTools } from "@transup/core";
import { runHeadless, type HeadlessOptions } from "../src/headless.js";

class MockProvider implements Provider {
  readonly id = "mock";
  readonly model = "test-model";
  calls: Message[][] = [];
  private step = 0;
  constructor(private replies: { content: string; toolCalls?: ToolCall[] }[]) {}
  async *stream(messages: Message[]): AsyncIterable<ProviderEvent> {
    this.calls.push(structuredClone(messages));
    const r = this.replies[Math.min(this.step++, this.replies.length - 1)] ?? { content: "(空)" };
    if (r.content) yield { type: "text_delta", text: r.content };
    yield {
      type: "message_done",
      content: r.content,
      toolCalls: r.toolCalls ?? [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const sessionDir = mkdtempSync(join(tmpdir(), "transup-headless-"));

async function run(provider: Provider, opts: Partial<HeadlessOptions> = {}) {
  let out = "";
  let err = "";
  const code = await runHeadless({
    provider,
    tools: builtinTools,
    settings: {},
    projectContext: "",
    sessionId: `headless-${Math.random().toString(36).slice(2)}`,
    history: [],
    prompt: "测试任务",
    sessionDir,
    out: (s) => (out += s),
    err: (s) => (err += s),
    ...opts,
  });
  return { code, out, err };
}

describe("headless 模式", () => {
  it("正文进 stdout，过程信息进 stderr，正常退出码 0", async () => {
    const provider = new MockProvider([
      { content: "", toolCalls: [{ id: "t1", name: "list_dir", args: "{}" }] },
      { content: "目录看完了。" },
    ]);
    const { code, out, err } = await run(provider);

    expect(code).toBe(0);
    expect(out).toContain("目录看完了。");
    expect(out).not.toContain("list_dir"); // 工具活动不污染 stdout
    expect(err).toContain("⏺ list_dir");
  });

  it("写操作默认拒绝（fail-closed），拒绝原因喂回模型", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-headless-deny-"));
    const target = join(dir, "no.txt");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: target, content: "x" }) },
        ],
      },
      { content: "好的，没有权限就不写了。" },
    ]);
    const { code, out, err } = await run(provider);

    expect(existsSync(target)).toBe(false);
    expect(err).toContain("已拒绝写操作 write_file");
    expect(out).toContain("没有权限就不写了");
    expect(code).toBe(0);
    // 模型必须收到"被拒绝"的工具结果，才能明白发生了什么
    const fed = provider.calls[1].find((m) => m.role === "tool") as any;
    expect(fed.content).toContain("拒绝");
  });

  it("--allow-all 放行写操作", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-headless-allow-"));
    const target = join(dir, "yes.txt");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: target, content: "hi" }) },
        ],
      },
      { content: "写好了。" },
    ]);
    const { code } = await run(provider, { allowAll: true });

    expect(code).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe("hi");
  });

  it("settings 允许清单同样放行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-headless-settings-"));
    const target = join(dir, "ok.txt");
    const provider = new MockProvider([
      {
        content: "",
        toolCalls: [
          { id: "t1", name: "write_file", args: JSON.stringify({ path: target, content: "ok" }) },
        ],
      },
      { content: "完成。" },
    ]);
    const { code } = await run(provider, { settings: { permissions: { allow: ["write_file"] } } });

    expect(code).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe("ok");
  });

  it("API 持续失败 → 错误进 stderr，退出码 1", async () => {
    const broken: Provider = {
      id: "mock",
      model: "broken",
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<ProviderEvent> {
        throw Object.assign(new Error("bad request"), { status: 400 });
      },
    };
    const { code, err } = await run(broken);

    expect(code).toBe(1);
    expect(err).toContain("bad request");
  });
});
