/** 设置与权限持久化测试 */
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, saveSettings, isAllowed, persistAllow } from "../src/settings.js";

describe("settings", () => {
  it("不存在的设置文件 → 空对象", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mycode-settings-"));
    expect(await loadSettings(dir)).toEqual({});
  });

  it("保存后能读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mycode-settings-"));
    await saveSettings({ permissions: { allow: ["bash"] } }, dir);
    const s = await loadSettings(dir);
    expect(s.permissions?.allow).toEqual(["bash"]);
  });

  it("isAllowed：精确匹配与通配后缀", () => {
    const s = { permissions: { allow: ["bash", "mcp__github__*"] } };
    expect(isAllowed(s, "bash")).toBe(true);
    expect(isAllowed(s, "edit_file")).toBe(false);
    expect(isAllowed(s, "mcp__github__create_issue")).toBe(true);
    expect(isAllowed(s, "mcp__jira__create_issue")).toBe(false);
  });

  it("persistAllow：追加并落盘，不重复", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mycode-settings-"));
    const s = await loadSettings(dir);
    await persistAllow(s, "bash", dir);
    await persistAllow(s, "bash", dir); // 重复调用
    const reloaded = await loadSettings(dir);
    expect(reloaded.permissions?.allow).toEqual(["bash"]);
  });
});
