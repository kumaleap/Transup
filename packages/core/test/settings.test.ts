/** 设置与权限持久化测试 */
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  saveSettings,
  isAllowed,
  persistAllow,
  persistPermissionRule,
} from "../src/settings.js";

describe("settings", () => {
  it("不存在的设置文件 → 空对象", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-settings-"));
    expect(await loadSettings(dir)).toEqual({});
  });

  it("保存后能读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-settings-"));
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
    const dir = await mkdtemp(join(tmpdir(), "transup-settings-"));
    const s = await loadSettings(dir);
    await persistAllow(s, "bash", dir);
    await persistAllow(s, "bash", dir); // 重复调用
    const reloaded = await loadSettings(dir);
    expect(reloaded.permissions?.allow).toEqual(["bash"]);
  });

  it("两层合并：列表拼接（项目在前），defaultMode local 优先", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-settings-"));
    await saveSettings(
      { permissions: { allow: ["grep"], deny: ["bash(rm:*)"], defaultMode: "default" } },
      dir,
    );
    await writeFile(
      join(dir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["bash(npm run:*)"], defaultMode: "acceptEdits" } }),
      "utf-8",
    );
    const s = await loadSettings(dir);
    expect(s.permissions?.allow).toEqual(["grep", "bash(npm run:*)"]);
    expect(s.permissions?.deny).toEqual(["bash(rm:*)"]);
    expect(s.permissions?.defaultMode).toBe("acceptEdits");
  });

  it("persistPermissionRule：写指定目的地单层文件，不把合并结果落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-settings-"));
    await saveSettings({ permissions: { allow: ["grep"] } }, dir);

    await persistPermissionRule("bash(npm run:*)", "allow", "localSettings", dir);
    await persistPermissionRule("bash(npm run:*)", "allow", "localSettings", dir); // 不重复
    await persistPermissionRule("edit_file", "deny", "projectSettings", dir);

    const local = JSON.parse(await readFile(join(dir, "settings.local.json"), "utf-8"));
    expect(local.permissions.allow).toEqual(["bash(npm run:*)"]);
    expect(local.permissions.allow).not.toContain("grep"); // 项目层规则没被复制过来

    const project = JSON.parse(await readFile(join(dir, "settings.json"), "utf-8"));
    expect(project.permissions.allow).toEqual(["grep"]);
    expect(project.permissions.deny).toEqual(["edit_file"]);

    const merged = await loadSettings(dir);
    expect(merged.permissions?.allow).toEqual(["grep", "bash(npm run:*)"]);
  });

  it("isAllowed 兼容内容规则语法（工具级查询不误放行）", () => {
    const s = { permissions: { allow: ["bash(npm run:*)"] } };
    expect(isAllowed(s, "bash")).toBe(false); // 只放行了特定前缀，不等于放行整个工具
  });
});
