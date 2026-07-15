/** 设置与权限持久化测试 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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
  userConfigDir: string;
}

async function makeSettingsContext(trusted = false): Promise<TestSettingsContext> {
  const root = await mkdtemp(join(tmpdir(), "transup-settings-context-"));
  const workspace = join(root, "workspace");
  const settingsDir = join(workspace, ".transup");
  const userConfigDir = join(root, "config");
  const trustStorePath = join(userConfigDir, "trusted-workspaces.json");
  await mkdir(settingsDir, { recursive: true });
  if (trusted) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      trustStorePath,
      JSON.stringify({ version: 1, trustedWorkspaces: [await realpath(workspace)] }),
      "utf-8",
    );
  }
  return { workspace, settingsDir, trustStorePath, userConfigDir };
}

function loadContext(ctx: TestSettingsContext) {
  return loadSettings(ctx.settingsDir, {
    workspace: ctx.workspace,
    trustStorePath: ctx.trustStorePath,
    userConfigDir: ctx.userConfigDir,
  });
}

async function expectedExternalSettingsPath(
  ctx: TestSettingsContext,
  workspace: string = ctx.workspace,
): Promise<string> {
  const canonicalWorkspace = await realpath(workspace);
  const key = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return join(ctx.userConfigDir, "workspaces", key, "settings.local.json");
}

function persistenceOptions(ctx: TestSettingsContext) {
  return { workspace: ctx.workspace, userConfigDir: ctx.userConfigDir };
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

  it("persistAllow：外部审批在未信任 reload 后生效，且不写入仓库", async () => {
    const ctx = await makeSettingsContext();
    const s = await loadContext(ctx);
    await persistAllow(s, "bash", ctx.settingsDir, persistenceOptions(ctx));
    await persistAllow(s, "bash", ctx.settingsDir, persistenceOptions(ctx)); // 重复调用
    const reloaded = await loadContext(ctx);
    expect(reloaded.permissions?.allow).toEqual(["bash"]);
    const external = JSON.parse(await readFile(await expectedExternalSettingsPath(ctx), "utf-8"));
    expect(external.permissions.allow).toEqual(["bash"]);
    await expect(readFile(join(ctx.settingsDir, "settings.local.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
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

  it("persistPermissionRule：project 写仓库，local 只写外部单层文件", async () => {
    const ctx = await makeSettingsContext(true);
    await saveSettings({ permissions: { allow: ["grep"] } }, ctx.settingsDir);

    await persistPermissionRule(
      "bash(npm run:*)",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );
    await persistPermissionRule(
      "bash(npm run:*)",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    ); // 不重复
    await persistPermissionRule(
      "edit_file",
      "deny",
      "projectSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    const local = JSON.parse(await readFile(await expectedExternalSettingsPath(ctx), "utf-8"));
    expect(local.permissions.allow).toEqual(["bash(npm run:*)"]);
    expect(local.permissions.allow).not.toContain("grep"); // 项目层规则没被复制过来

    const project = JSON.parse(await readFile(join(ctx.settingsDir, "settings.json"), "utf-8"));
    expect(project.permissions.allow).toEqual(["grep"]);
    expect(project.permissions.deny).toEqual(["edit_file"]);
    await expect(readFile(join(ctx.settingsDir, "settings.local.json"), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const merged = await loadContext(ctx);
    expect(merged.permissions?.allow).toEqual(["grep", "bash(npm run:*)"]);
  });

  it("isAllowed 兼容内容规则语法（工具级查询不误放行）", () => {
    const s = { permissions: { allow: ["bash(npm run:*)"] } };
    expect(isAllowed(s, "bash")).toBe(false); // 只放行了特定前缀，不等于放行整个工具
  });

  it("未信任时 project 与 legacy 仅保留限制，external local 完整生效", async () => {
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
    const externalPath = await expectedExternalSettingsPath(ctx);
    await mkdir(dirname(externalPath), { recursive: true });
    await writeFile(
      externalPath,
      JSON.stringify({
        mcpServers: { external: { command: "external-mcp" } },
        statusLine: { command: "external-status" },
        permissions: {
          allow: ["external-allow"],
          deny: ["external-deny"],
          ask: ["external-ask"],
          defaultMode: "acceptEdits",
        },
      }),
      "utf-8",
    );

    const settings = await loadContext(ctx);

    expect(settings.mcpServers).toEqual({ external: { command: "external-mcp" } });
    expect(settings.statusLine).toEqual({ command: "external-status" });
    expect(settings.permissions).toEqual({
      allow: ["external-allow"],
      deny: ["project-deny", "local-deny", "external-deny"],
      ask: ["project-ask", "local-ask", "external-ask"],
      defaultMode: "acceptEdits",
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

  it("设置源决定信任身份，受信任 caller 不能把信任借给另一工作区", async () => {
    const ctx = await makeSettingsContext();
    const trustedCaller = join(dirname(ctx.workspace), "trusted-caller");
    await mkdir(trustedCaller, { recursive: true });
    await trustWorkspace(trustedCaller, ctx.trustStorePath);
    await saveSettings(
      {
        mcpServers: { borrowed: { command: "borrowed-mcp" } },
        statusLine: { command: "borrowed-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
      ctx.settingsDir,
    );

    const previousCwd = process.cwd();
    let settings: Awaited<ReturnType<typeof loadSettings>>;
    try {
      process.chdir(trustedCaller);
      settings = await loadSettings(ctx.settingsDir, {
        trustStorePath: ctx.trustStorePath,
        userConfigDir: ctx.userConfigDir,
      });
    } finally {
      process.chdir(previousCwd);
    }

    expect(settings.mcpServers).toBeUndefined();
    expect(settings.statusLine).toBeUndefined();
    expect(settings.permissions?.allow ?? []).toEqual([]);
    expect(settings.permissions?.defaultMode).toBeUndefined();
  });

  it("显式 workspace 断言与 canonical 设置源不匹配时 fail closed", async () => {
    const ctx = await makeSettingsContext();
    const trustedWorkspace = join(dirname(ctx.workspace), "trusted-workspace");
    await mkdir(trustedWorkspace, { recursive: true });
    await trustWorkspace(trustedWorkspace, ctx.trustStorePath);
    await saveSettings(
      { mcpServers: { borrowed: { command: "borrowed-mcp" } } },
      ctx.settingsDir,
    );

    await expect(
      loadSettings(ctx.settingsDir, {
        workspace: trustedWorkspace,
        trustStorePath: ctx.trustStorePath,
      }),
    ).rejects.toThrow(/settings source.*workspace/i);
  });

  it("工作区内的 .transup symlink 逃逸不能借用工作区信任", async () => {
    const root = await mkdtemp(join(tmpdir(), "transup-settings-escape-"));
    const workspace = join(root, "workspace");
    const outsideSettings = join(root, "outside-settings");
    const settingsDir = join(workspace, ".transup");
    const trustStorePath = join(root, "config", "trusted-workspaces.json");
    await mkdir(workspace, { recursive: true });
    await mkdir(outsideSettings, { recursive: true });
    await symlink(outsideSettings, settingsDir, "dir");
    await trustWorkspace(workspace, trustStorePath);
    await saveSettings(
      {
        statusLine: { command: "escaped-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
      settingsDir,
    );

    await expect(
      loadSettings(settingsDir, { workspace, trustStorePath }),
    ).rejects.toThrow(/settings source.*workspace/i);
  });

  it("dangling .transup symlink 必须 fail closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "transup-settings-dangling-"));
    const workspace = join(root, "workspace");
    const settingsDir = join(workspace, ".transup");
    const trustStorePath = join(root, "config", "trusted-workspaces.json");
    await mkdir(workspace, { recursive: true });
    await symlink(join(root, "missing-settings"), settingsDir, "dir");
    await trustWorkspace(workspace, trustStorePath);

    await expect(
      loadSettings(settingsDir, { workspace, trustStorePath }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("canonical workspace alias 共享同一个 external local 文件", async () => {
    const ctx = await makeSettingsContext();
    const alias = join(dirname(ctx.workspace), "workspace-alias");
    await symlink(ctx.workspace, alias, "dir");

    await persistPermissionRule(
      "bash(npm run:*)",
      "allow",
      "localSettings",
      join(alias, ".transup"),
      { workspace: alias, userConfigDir: ctx.userConfigDir },
    );
    await persistPermissionRule(
      "edit_file",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    const external = JSON.parse(await readFile(await expectedExternalSettingsPath(ctx), "utf-8"));
    expect(external.permissions.allow).toEqual(["bash(npm run:*)", "edit_file"]);
    expect(await expectedExternalSettingsPath(ctx, alias)).toBe(
      await expectedExternalSettingsPath(ctx),
    );
  });

  it("受信任工作区按 project < legacy < external 合并", async () => {
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
    const externalPath = await expectedExternalSettingsPath(ctx);
    await mkdir(dirname(externalPath), { recursive: true });
    await writeFile(
      externalPath,
      JSON.stringify({
        mcpServers: {
          shared: { command: "external-mcp" },
          external: { command: "external-only-mcp" },
        },
        statusLine: { command: "external-status" },
        permissions: { allow: ["list_dir"], defaultMode: "default" },
      }),
      "utf-8",
    );

    const settings = await loadContext(ctx);

    expect(settings.mcpServers).toEqual({
      shared: { command: "external-mcp" },
      project: { command: "project-only-mcp" },
      local: { command: "local-only-mcp" },
      external: { command: "external-only-mcp" },
    });
    expect(settings.statusLine).toEqual({ command: "external-status" });
    expect(settings.permissions?.allow).toEqual(["bash", "edit_file", "list_dir"]);
    expect(settings.permissions?.defaultMode).toBe("default");
  });
});
