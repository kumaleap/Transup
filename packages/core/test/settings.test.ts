/** 设置与权限持久化测试 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

function saveContextSettings(ctx: TestSettingsContext, settings: Parameters<typeof saveSettings>[0]) {
  return saveSettings(settings, ctx.settingsDir, { userConfigDir: ctx.userConfigDir });
}

async function expectedSettingsLockPath(
  ctx: TestSettingsContext,
  targetPath: string,
): Promise<string> {
  const absolutePath = resolve(targetPath);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const canonicalTarget = join(await realpath(dirname(absolutePath)), basename(absolutePath));
  const lockDir = resolve(ctx.userConfigDir, "locks");
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const targetKey = createHash("sha256").update(canonicalTarget).digest("hex");
  return join(await realpath(lockDir), `${targetKey}.lock`);
}

const permissionWorker = fileURLToPath(
  new URL("./fixtures/persist-permission-worker.mts", import.meta.url),
);
const settingsLockHolder = fileURLToPath(
  new URL("./fixtures/hold-settings-lock-worker.mts", import.meta.url),
);
const settingsLockRecoveryWorker = fileURLToPath(
  new URL("./fixtures/recover-settings-lock-worker.mts", import.meta.url),
);
const nativeAddonUnavailableWorker = fileURLToPath(
  new URL("./fixtures/native-addon-unavailable-worker.mts", import.meta.url),
);

async function waitForPaths(paths: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for worker paths: ${paths.join(", ")}`);
}

function runPermissionWorker(args: string[]): Promise<void> {
  return runSettingsWorker(permissionWorker, "permission worker", args);
}

function runSettingsLockRecoveryWorker(args: string[]): Promise<void> {
  return runSettingsWorker(settingsLockRecoveryWorker, "settings lock recovery worker", args);
}

function runSettingsWorker(worker: string, label: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 15_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`${label} timed out and was terminated: ${stderr}`));
      else if (code === 0) resolve();
      else reject(new Error(`${label} failed (${code ?? signal}): ${stderr}`));
    });
  });
}

function runSettingsLockHolder(lockPath: string, readyPath: string) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", settingsLockHolder, lockPath, readyPath],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === 0) reject(new Error(`settings lock holder exited early: ${stderr}`));
        else resolve({ code, signal });
      });
    },
  );
  return { child, exited };
}

describe("settings", () => {
  it("imports when the native lock addon cannot load", async () => {
    await runSettingsWorker(nativeAddonUnavailableWorker, "settings import worker", ["import"]);
  });

  it("persists settings with a fallback lock when the native addon cannot load", async () => {
    const ctx = await makeSettingsContext();
    await runSettingsWorker(nativeAddonUnavailableWorker, "fallback settings worker", [
      "persist",
      "bash(fallback)",
      ctx.settingsDir,
      ctx.workspace,
      ctx.userConfigDir,
    ]);

    const stored = JSON.parse(await readFile(await expectedExternalSettingsPath(ctx), "utf-8"));
    expect(stored.permissions.allow).toEqual(["bash(fallback)"]);
  });

  it("fallback locking uses a directory marker beside the persistent native inode", async () => {
    const ctx = await makeSettingsContext();
    const externalPath = await expectedExternalSettingsPath(ctx);
    const lockPath = await expectedSettingsLockPath(ctx, externalPath);
    const markerPath = `${lockPath}.fallback`;
    await writeFile(lockPath, "", { flag: "wx", mode: 0o600 });
    const lockIdentity = await stat(lockPath, { bigint: true });
    await writeFile(
      externalPath,
      JSON.stringify({ padding: "x".repeat(64_000_000), permissions: { allow: [] } }),
      "utf-8",
    );

    const worker = runSettingsWorker(nativeAddonUnavailableWorker, "fallback settings worker", [
      "persist",
      "bash(directory-marker)",
      ctx.settingsDir,
      ctx.workspace,
      ctx.userConfigDir,
    ]);
    try {
      await waitForPaths([markerPath]);
      expect((await stat(markerPath)).isDirectory()).toBe(true);
    } finally {
      await worker;
    }

    const currentIdentity = await stat(lockPath, { bigint: true });
    expect([currentIdentity.dev, currentIdentity.ino]).toEqual([
      lockIdentity.dev,
      lockIdentity.ino,
    ]);
  }, 30_000);

  it("removes its fallback lock after a successful settings write", async () => {
    const ctx = await makeSettingsContext();
    const externalPath = await expectedExternalSettingsPath(ctx);
    const fallbackLockPath = `${await expectedSettingsLockPath(ctx, externalPath)}.fallback`;

    await runSettingsWorker(nativeAddonUnavailableWorker, "fallback settings worker", [
      "persist",
      "bash(released)",
      ctx.settingsDir,
      ctx.workspace,
      ctx.userConfigDir,
    ]);

    await expect(access(fallbackLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on pre-existing backend markers with manual cleanup guidance", async () => {
    for (const markerType of ["native-file", "fallback-directory"] as const) {
      const ctx = await makeSettingsContext();
      const externalPath = await expectedExternalSettingsPath(ctx);
      const markerPath = `${await expectedSettingsLockPath(ctx, externalPath)}.fallback`;
      const ownerPath = join(markerPath, "existing-owner");
      if (markerType === "native-file") {
        await writeFile(markerPath, "owned elsewhere", { flag: "wx", mode: 0o600 });
      } else {
        await mkdir(markerPath, { mode: 0o700 });
        await writeFile(ownerPath, "owned elsewhere", { flag: "wx", mode: 0o600 });
      }

      const write = runSettingsWorker(nativeAddonUnavailableWorker, "fallback settings worker", [
        "persist",
        "bash(blocked)",
        ctx.settingsDir,
        ctx.workspace,
        ctx.userConfigDir,
      ]);

      await expect(write).rejects.toThrow(markerPath);
      await expect(write).rejects.toThrow(
        /confirm no Transup process is running before manually removing/i,
      );
      expect(await readFile(markerType === "native-file" ? markerPath : ownerPath, "utf-8"))
        .toBe("owned elsewhere");
      await expect(access(externalPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("不存在的设置文件 → 空对象", async () => {
    const ctx = await makeSettingsContext();
    expect(await loadContext(ctx)).toEqual({});
  });

  it("保存后能读回", async () => {
    const ctx = await makeSettingsContext(true);
    await saveContextSettings(ctx, { permissions: { allow: ["bash"] } });
    const s = await loadContext(ctx);
    expect(s.permissions?.allow).toEqual(["bash"]);
  });

  it("rejects a project settings symlink before reading its target", async () => {
    const ctx = await makeSettingsContext();
    const outsidePath = join(dirname(ctx.workspace), "outside-settings.json");
    await writeFile(outsidePath, JSON.stringify({ permissions: { deny: ["outside"] } }), "utf-8");
    await symlink(outsidePath, join(ctx.settingsDir, "settings.json"));

    await expect(loadContext(ctx)).rejects.toThrow(/regular file/i);
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
    await saveContextSettings(
      ctx,
      { permissions: { allow: ["grep"], deny: ["bash(rm:*)"], defaultMode: "default" } },
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
    await saveContextSettings(ctx, { permissions: { allow: ["grep"] } });

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

  it("atomic settings replacement preserves existing permission bits", async () => {
    const ctx = await makeSettingsContext();
    const projectPath = join(ctx.settingsDir, "settings.json");
    await writeFile(projectPath, JSON.stringify({ permissions: { allow: [] } }), "utf-8");
    await chmod(projectPath, 0o640);

    await persistPermissionRule(
      "bash(preserve-mode)",
      "allow",
      "projectSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    expect((await stat(projectPath)).mode & 0o777).toBe(0o640);
  });

  it("persistPermissionRule preserves simultaneous updates from separate processes", async () => {
    const ctx = await makeSettingsContext();
    const root = dirname(ctx.workspace);
    const gatePath = join(root, "permission-workers.go");
    const rules = ["bash(one)", "bash(two)", "bash(three)", "bash(four)"];
    const readyPaths = rules.map((_, index) => join(root, `permission-worker-${index}.ready`));
    const externalPath = await expectedExternalSettingsPath(ctx);
    await mkdir(dirname(externalPath), { recursive: true });
    await writeFile(
      externalPath,
      JSON.stringify({ padding: "x".repeat(1_000_000), permissions: { allow: [] } }),
      "utf-8",
    );
    const workers = rules.map((rule, index) => runPermissionWorker([
      readyPaths[index],
      gatePath,
      rule,
      ctx.settingsDir,
      ctx.workspace,
      ctx.userConfigDir,
    ]));

    try {
      await waitForPaths(readyPaths);
      await writeFile(gatePath, "go", "utf-8");
      await Promise.all(workers);
    } finally {
      if (!existsSync(gatePath)) await writeFile(gatePath, "go", "utf-8");
      await Promise.allSettled(workers);
    }

    const external = JSON.parse(await readFile(externalPath, "utf-8"));
    expect(new Set(external.permissions.allow)).toEqual(new Set(rules));
  }, 30_000);

  it("an empty lock artifact cannot block a settings write", async () => {
    const ctx = await makeSettingsContext();
    const externalPath = await expectedExternalSettingsPath(ctx);
    const lockPath = await expectedSettingsLockPath(ctx, externalPath);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "", { mode: 0o600 });
    const identity = await stat(lockPath, { bigint: true });

    await persistPermissionRule(
      "bash(recovered)",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    const stored = JSON.parse(await readFile(externalPath, "utf-8"));
    expect(stored.permissions.allow).toEqual(["bash(recovered)"]);
    const currentIdentity = await stat(lockPath, { bigint: true });
    expect([currentIdentity.dev, currentIdentity.ino]).toEqual([identity.dev, identity.ino]);
  });

  it("native locking fails closed while a fallback directory marker exists", async () => {
    const ctx = await makeSettingsContext();
    const externalPath = await expectedExternalSettingsPath(ctx);
    const markerPath = `${await expectedSettingsLockPath(ctx, externalPath)}.fallback`;
    await mkdir(markerPath, { mode: 0o700 });

    const write = persistPermissionRule(
      "bash(blocked-by-fallback)",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    await expect(write).rejects.toThrow(markerPath);
    await expect(access(externalPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(markerPath)).isDirectory()).toBe(true);
  });

  it("native locking recovers a stale regular marker after acquiring the advisory lock", async () => {
    const ctx = await makeSettingsContext();
    const externalPath = await expectedExternalSettingsPath(ctx);
    const markerPath = `${await expectedSettingsLockPath(ctx, externalPath)}.fallback`;
    await writeFile(markerPath, "", { flag: "wx", mode: 0o600 });

    await persistPermissionRule(
      "bash(recovered-marker)",
      "allow",
      "localSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    const stored = JSON.parse(await readFile(externalPath, "utf-8"));
    expect(stored.permissions.allow).toEqual(["bash(recovered-marker)"]);
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("project persistence does not follow a repository-controlled sibling lock symlink", async () => {
    const ctx = await makeSettingsContext();
    const projectPath = join(ctx.settingsDir, "settings.json");
    const outsideLockPath = join(dirname(ctx.workspace), "outside-settings.lock");
    await symlink(outsideLockPath, `${projectPath}.lock`);

    await persistPermissionRule(
      "edit_file",
      "allow",
      "projectSettings",
      ctx.settingsDir,
      persistenceOptions(ctx),
    );

    await expect(access(outsideLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const stored = JSON.parse(await readFile(projectPath, "utf-8"));
    expect(stored.permissions.allow).toEqual(["edit_file"]);
  });

  it("releases a crashed process lock before concurrent settings writers continue", async () => {
    const ctx = await makeSettingsContext();
    const root = dirname(ctx.workspace);
    const externalPath = await expectedExternalSettingsPath(ctx);
    const lockPath = await expectedSettingsLockPath(ctx, externalPath);
    const holderReadyPath = join(root, "settings-lock-holder.ready");
    const rules = ["bash(after-one)", "bash(after-two)", "bash(after-three)"];
    const blockedPaths = rules.map((_, index) => join(root, `crash-worker-${index}.blocked`));
    await mkdir(dirname(externalPath), { recursive: true });
    const holder = runSettingsLockHolder(lockPath, holderReadyPath);
    let workers: Promise<void>[] = [];

    try {
      await waitForPaths([holderReadyPath]);
      const identity = await stat(lockPath, { bigint: true });
      workers = rules.map((rule, index) => runSettingsLockRecoveryWorker([
        blockedPaths[index],
        lockPath,
        rule,
        ctx.settingsDir,
        ctx.workspace,
        ctx.userConfigDir,
      ]));
      const workersDone = Promise.all(workers);
      await waitForPaths(blockedPaths);

      holder.child.kill("SIGKILL");
      await holder.exited;
      await workersDone;
      const currentIdentity = await stat(lockPath, { bigint: true });
      expect([currentIdentity.dev, currentIdentity.ino]).toEqual([identity.dev, identity.ino]);
    } finally {
      holder.child.kill("SIGKILL");
      await Promise.allSettled([holder.exited, ...workers]);
    }

    const stored = JSON.parse(await readFile(externalPath, "utf-8"));
    expect(new Set(stored.permissions.allow)).toEqual(new Set(rules));
  }, 30_000);

  it("trustWorkspace preserves simultaneous updates to one trust store", async () => {
    const root = await mkdtemp(join(tmpdir(), "transup-trust-concurrent-"));
    const trustStorePath = join(root, "config", "trusted-workspaces.json");
    const workspaces = Array.from({ length: 8 }, (_, index) => join(root, `workspace-${index}`));
    await Promise.all(workspaces.map((workspace) => mkdir(workspace, { recursive: true })));

    const canonical = await Promise.all(
      workspaces.map((workspace) => trustWorkspace(workspace, trustStorePath)),
    );
    const stored = JSON.parse(await readFile(trustStorePath, "utf-8"));

    expect(new Set(stored.trustedWorkspaces)).toEqual(new Set(canonical));
  });

  it("isAllowed 兼容内容规则语法（工具级查询不误放行）", () => {
    const s = { permissions: { allow: ["bash(npm run:*)"] } };
    expect(isAllowed(s, "bash")).toBe(false); // 只放行了特定前缀，不等于放行整个工具
  });

  it("未信任时 project 与 legacy 仅保留限制，external local 完整生效", async () => {
    const ctx = await makeSettingsContext();
    await saveContextSettings(
      ctx,
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
    await saveContextSettings(
      ctx,
      {
        mcpServers: { project: { command: "project-mcp" } },
        statusLine: { command: "project-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
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

  it("rejects a trust-store symlink before reading its target", async () => {
    const ctx = await makeSettingsContext();
    const outsidePath = join(dirname(ctx.workspace), "outside-trust-store.json");
    await writeFile(
      outsidePath,
      JSON.stringify({ version: 1, trustedWorkspaces: [await realpath(ctx.workspace)] }),
      "utf-8",
    );
    await mkdir(dirname(ctx.trustStorePath), { recursive: true });
    await symlink(outsidePath, ctx.trustStorePath);

    expect(await isWorkspaceTrusted(ctx.workspace, ctx.trustStorePath)).toBe(false);
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
    await saveContextSettings(
      ctx,
      {
        mcpServers: { borrowed: { command: "borrowed-mcp" } },
        statusLine: { command: "borrowed-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
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
    await saveContextSettings(ctx, {
      mcpServers: { borrowed: { command: "borrowed-mcp" } },
    });

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
      { userConfigDir: dirname(trustStorePath) },
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
    await saveContextSettings(
      ctx,
      {
        mcpServers: {
          shared: { command: "project-mcp" },
          project: { command: "project-only-mcp" },
        },
        statusLine: { command: "project-status" },
        permissions: { allow: ["bash"], defaultMode: "bypassPermissions" },
      },
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
