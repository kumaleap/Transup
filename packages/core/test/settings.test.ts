/** 设置与权限持久化测试 */
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as settingsApi from "../src/settings.js";

const {
  loadSettings,
  saveSettings,
  isAllowed,
  persistAllow,
  persistPermissionRule,
  trustWorkspace,
  isWorkspaceTrusted,
} = settingsApi;

interface TestSettingsContext {
  workspace: string;
  settingsDir: string;
  trustStorePath: string;
}

async function makeSettingsContext(trusted = false): Promise<TestSettingsContext> {
  const root = await mkdtemp(join(tmpdir(), "transup-settings-context-"));
  const workspace = join(root, "workspace");
  const settingsDir = join(workspace, ".transup");
  const trustStorePath = join(root, "config", "trusted-workspaces.json");
  await mkdir(settingsDir, { recursive: true });
  if (trusted) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      trustStorePath,
      JSON.stringify({ version: 1, trustedWorkspaces: [await realpath(workspace)] }),
      "utf-8",
    );
  }
  return { workspace, settingsDir, trustStorePath };
}

function loadContext(ctx: TestSettingsContext) {
  return loadSettings(ctx.settingsDir, {
    workspace: ctx.workspace,
    trustStorePath: ctx.trustStorePath,
  });
}

describe("settings", () => {
  it("不存在的设置文件 → 空对象", async () => {
    const ctx = await makeSettingsContext();
    expect(await loadContext(ctx)).toEqual({});
  });

  it("保存后能读回", async () => {
    const ctx = await makeSettingsContext(true);
    await saveSettings({ permissions: { allow: ["bash"] } }, ctx.settingsDir);
    const s = await loadContext(ctx);
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
    const ctx = await makeSettingsContext(true);
    const s = await loadContext(ctx);
    await persistAllow(s, "bash", ctx.settingsDir);
    await persistAllow(s, "bash", ctx.settingsDir); // 重复调用
    const reloaded = await loadContext(ctx);
    expect(reloaded.permissions?.allow).toEqual(["bash"]);
  });

  it("两层合并：列表拼接（项目在前），defaultMode local 优先", async () => {
    const ctx = await makeSettingsContext(true);
    await saveSettings(
      { permissions: { allow: ["grep"], deny: ["bash(rm:*)"], defaultMode: "default" } },
      ctx.settingsDir,
    );
    await writeFile(
      join(ctx.settingsDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["bash(npm run:*)"], defaultMode: "acceptEdits" } }),
      "utf-8",
    );
    const s = await loadContext(ctx);
    expect(s.permissions?.allow).toEqual(["grep", "bash(npm run:*)"]);
    expect(s.permissions?.deny).toEqual(["bash(rm:*)"]);
    expect(s.permissions?.defaultMode).toBe("acceptEdits");
  });

  it("persistPermissionRule：写指定目的地单层文件，不把合并结果落盘", async () => {
    const ctx = await makeSettingsContext(true);
    await saveSettings({ permissions: { allow: ["grep"] } }, ctx.settingsDir);

    await persistPermissionRule("bash(npm run:*)", "allow", "localSettings", ctx.settingsDir);
    await persistPermissionRule("bash(npm run:*)", "allow", "localSettings", ctx.settingsDir); // 不重复
    await persistPermissionRule("edit_file", "deny", "projectSettings", ctx.settingsDir);

    const local = JSON.parse(await readFile(join(ctx.settingsDir, "settings.local.json"), "utf-8"));
    expect(local.permissions.allow).toEqual(["bash(npm run:*)"]);
    expect(local.permissions.allow).not.toContain("grep"); // 项目层规则没被复制过来

    const project = JSON.parse(await readFile(join(ctx.settingsDir, "settings.json"), "utf-8"));
    expect(project.permissions.allow).toEqual(["grep"]);
    expect(project.permissions.deny).toEqual(["edit_file"]);

    const merged = await loadContext(ctx);
    expect(merged.permissions?.allow).toEqual(["grep", "bash(npm run:*)"]);
  });

  it("isAllowed 兼容内容规则语法（工具级查询不误放行）", () => {
    const s = { permissions: { allow: ["bash(npm run:*)"] } };
    expect(isAllowed(s, "bash")).toBe(false); // 只放行了特定前缀，不等于放行整个工具
  });

  it("未信任工作区过滤两层可执行与放宽权限配置，同时保留限制规则", async () => {
    const ctx = await makeSettingsContext();
    await saveSettings(
      {
        mcpServers: { project: { command: "project-mcp" } },
        statusLine: { command: "project-status" },
        permissions: {
          allow: ["project-allow"],
          deny: ["project-deny"],
          ask: ["project-ask"],
          defaultMode: "bypassPermissions",
        },
      },
      ctx.settingsDir,
    );
    await writeFile(
      join(ctx.settingsDir, "settings.local.json"),
      JSON.stringify({
        mcpServers: { local: { command: "local-mcp" } },
        statusLine: { command: "local-status" },
        permissions: {
          allow: ["local-allow"],
          deny: ["local-deny"],
          ask: ["local-ask"],
          defaultMode: "acceptEdits",
        },
      }),
      "utf-8",
    );

    const settings = await loadContext(ctx);

    expect(settings.mcpServers).toBeUndefined();
    expect(settings.statusLine).toBeUndefined();
    expect(settings.permissions).toEqual({
      allow: [],
      deny: ["project-deny", "local-deny"],
      ask: ["project-ask", "local-ask"],
      defaultMode: undefined,
    });
  });

  it("缺失或损坏的信任存储 fail closed", async () => {
    const ctx = await makeSettingsContext();
    await saveSettings(
      {
        mcpServers: { project: { command: "project-mcp" } },
        statusLine: { command: "project-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
      ctx.settingsDir,
    );

    for (const malformed of [null, "{", JSON.stringify({ version: 1, trustedWorkspaces: "all" })]) {
      if (malformed !== null) {
        await mkdir(dirname(ctx.trustStorePath), { recursive: true });
        await writeFile(ctx.trustStorePath, malformed, "utf-8");
      }
      const settings = await loadContext(ctx);
      expect(settings.mcpServers).toBeUndefined();
      expect(settings.statusLine).toBeUndefined();
      expect(settings.permissions?.allow ?? []).toEqual([]);
      expect(settings.permissions?.defaultMode).toBeUndefined();
    }
  });

  it("信任持久化使用 canonical path，symlink 别名不能改变信任结果", async () => {
    const ctx = await makeSettingsContext();
    const alias = join(ctx.workspace, "..", "workspace-alias");
    await symlink(ctx.workspace, alias, "dir");

    const canonical = await trustWorkspace(alias, ctx.trustStorePath);
    expect(canonical).toBe(await realpath(ctx.workspace));
    expect(await isWorkspaceTrusted(ctx.workspace, ctx.trustStorePath)).toBe(true);
    expect(await isWorkspaceTrusted(alias, ctx.trustStorePath)).toBe(true);

    const stored = JSON.parse(await readFile(ctx.trustStorePath, "utf-8"));
    expect(stored).toEqual({ version: 1, trustedWorkspaces: [canonical] });
  });

  it("受信任工作区保留项目配置行为", async () => {
    const ctx = await makeSettingsContext();
    await trustWorkspace(ctx.workspace, ctx.trustStorePath);
    await saveSettings(
      {
        mcpServers: {
          shared: { command: "project-mcp" },
          project: { command: "project-only-mcp" },
        },
        statusLine: { command: "project-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
      ctx.settingsDir,
    );
    await writeFile(
      join(ctx.settingsDir, "settings.local.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "local-mcp" },
          local: { command: "local-only-mcp" },
        },
        statusLine: { command: "local-status" },
        permissions: { allow: ["edit_file"], defaultMode: "acceptEdits" },
      }),
      "utf-8",
    );

    const settings = await loadContext(ctx);

    expect(settings.mcpServers).toEqual({
      shared: { command: "local-mcp" },
      project: { command: "project-only-mcp" },
      local: { command: "local-only-mcp" },
    });
    expect(settings.statusLine).toEqual({ command: "local-status" });
    expect(settings.permissions?.allow).toEqual(["bash", "edit_file"]);
    expect(settings.permissions?.defaultMode).toBe("acceptEdits");
  });
});
