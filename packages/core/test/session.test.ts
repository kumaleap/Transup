/**
 * 会话持久化测试 —— append-only JSONL 的核心承诺：
 * 写入极简、恢复路径能容忍损坏的行（崩溃时写一半）。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, appendFile } from "node:fs/promises";
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
});
