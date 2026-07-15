/**
 * 会话持久化测试 —— append-only JSONL 的核心承诺：
 * 写入极简、恢复路径能容忍损坏的行（崩溃时写一半）。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session/store.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "transup-sessions-"));
}

describe("SessionStore", () => {
  it("append 后 load 恢复完整消息", async () => {
    const dir = await tempDir();
    const s = new SessionStore("s1", dir);
    await s.append({ role: "user", content: "你好" });
    await s.append({ role: "assistant", content: "嗨", toolCalls: [{ id: "t1", name: "grep", args: "{}" }] });
    const loaded = await new SessionStore("s1", dir).load();
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toMatchObject({ role: "assistant", toolCalls: [{ id: "t1" }] });
  });

  it("appendBatch 把多条消息按顺序序列化为一个连续批次", async () => {
    const dir = await tempDir();
    const s = new SessionStore("batch", dir);
    const summary = { role: "user" as const, content: "compact summary" };
    const acknowledgement = { role: "assistant" as const, content: "acknowledged" };

    await s.append({ role: "user", content: "before" });
    await s.appendBatch([summary, acknowledgement]);

    expect(await s.load()).toEqual([
      { role: "user", content: "before" },
      summary,
      acknowledgement,
    ]);
    expect((await readFile(join(dir, "batch.jsonl"), "utf-8")).split("\n")).toEqual([
      JSON.stringify({ role: "user", content: "before" }),
      JSON.stringify(summary),
      JSON.stringify(acknowledgement),
      "",
    ]);
  });

  it("损坏的行（崩溃写一半）被跳过而非报错", async () => {
    const dir = await tempDir();
    const s = new SessionStore("s2", dir);
    await s.append({ role: "user", content: "完整的" });
    await appendFile(join(dir, "s2.jsonl"), '{"role":"assistant","content":"写到一半就崩'); // 无结尾
    const loaded = await new SessionStore("s2", dir).load();
    expect(loaded).toHaveLength(1);
  });

  it("不存在的会话 → 空数组", async () => {
    const dir = await tempDir();
    expect(await new SessionStore("nope", dir).load()).toEqual([]);
  });

  it("latestId 返回字典序最大的会话（id 用时间戳所以有序）", async () => {
    const dir = await tempDir();
    await new SessionStore("2026-01-01", dir).append({ role: "user", content: "a" });
    await new SessionStore("2026-06-30", dir).append({ role: "user", content: "b" });
    expect(await SessionStore.latestId(dir)).toBe("2026-06-30");
  });

  it("firstPrompt：取首条真实用户输入，跳过系统注入，首行截断", async () => {
    const dir = await tempDir();
    const s = new SessionStore("s3", dir);
    await s.append({ role: "user", content: "[系统提示] 对话历史已被压缩。" }); // 注入不算
    await s.append({ role: "user", content: "帮我修登录页的 bug\n补充：报错在控制台" });
    await s.append({ role: "assistant", content: "好" });
    expect(await SessionStore.firstPrompt("s3", dir)).toBe("帮我修登录页的 bug");

    const long = new SessionStore("s4", dir);
    await long.append({ role: "user", content: "长".repeat(80) });
    expect(await SessionStore.firstPrompt("s4", dir)).toBe("长".repeat(60) + "…");

    expect(await SessionStore.firstPrompt("不存在", dir)).toBeNull();
  });
});
