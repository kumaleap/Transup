/**
 * 设置来源与 provenance：
 *
 *   .transup/settings.json        project，进版本库
 *   .transup/settings.local.json  legacy workspace-local，仅作仓库来源兼容读取
 *   OS config/workspaces/<hash>/settings.local.json  external user-local，个人审批写这里
 * 未信任时 project/legacy 只保留 deny/ask，再完整合并 external；信任后按
 * project < legacy < external 合并。权限列表按 provenance 顺序拼接。
 *
 * 权限规则语法见 permissions.ts（工具级 / 前缀通配 / 内容级）。
 */
import { lstat, mkdir, open, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServerConfig } from "./tools/mcp.js";
import {
  ruleMatches,
  type PermissionDestination,
  type PermissionMode,
  type PermissionRules,
} from "./permissions.js";

export interface Settings {
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    /** 启动时的权限模式；bypassPermissions 写在这里即声明 bypass 可用 */
    defaultMode?: PermissionMode;
  };
  /**
   * 自定义状态行：一条 shell 命令，会话状态以 JSON 经 stdin 传入，
   * stdout 显示在状态栏上方（支持 ANSI 颜色）。字段见 cli 的 statusline.ts。
   */
  statusLine?: {
    command: string;
    /** 命令执行超时（默认 5000ms），超时静默丢弃 */
    timeoutMs?: number;
  };
}

const SETTINGS_DIR = ".transup";
const SETTINGS_FILE = "settings.json";
const LEGACY_LOCAL_SETTINGS_FILE = "settings.local.json";
const WORKSPACE_SETTINGS_DIR = "workspaces";
const TRUST_STORE_VERSION = 1;
const TRUST_STORE_FILE = "trusted-workspaces.json";
const SETTINGS_LOCKS_DIR = "locks";
const SETTINGS_LOCK_WAIT_MS = 10_000;
const SETTINGS_LOCK_RETRY_MS = 20;

const settingsWriteQueues = new Map<string, Promise<void>>();

interface WorkspaceTrustStore {
  version: typeof TRUST_STORE_VERSION;
  trustedWorkspaces: string[];
}

async function settingsLockPath(path: string, userConfigDir: string): Promise<string> {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  const canonicalTarget = join(await realpath(dirname(absolutePath)), basename(absolutePath));
  const lockDir = resolve(userConfigDir, SETTINGS_LOCKS_DIR);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const targetKey = createHash("sha256").update(canonicalTarget).digest("hex");
  return join(await realpath(lockDir), `${targetKey}.lock`);
}

function settingsBackendMarkerPath(lockPath: string): string {
  return `${lockPath}.fallback`;
}

function fallbackLockConflict(path: string, cause: unknown): Error {
  return new Error(
    `Fallback settings lock already exists: ${path}. `
    + "Confirm no Transup process is running before manually removing this artifact.",
    { cause },
  );
}

async function acquireFallbackSettingsLock(lockPath: string): Promise<() => Promise<void>> {
  const fallbackPath = settingsBackendMarkerPath(lockPath);
  try {
    await mkdir(fallbackPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw fallbackLockConflict(fallbackPath, error);
    }
    throw error;
  }
  const ownerPath = join(fallbackPath, randomUUID());
  try {
    const owner = await open(ownerPath, "wx", 0o600);
    await owner.close();
  } catch (error) {
    await rmdir(fallbackPath).catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(ownerPath);
    await rmdir(fallbackPath);
  };
}

async function acquireNativeBackendMarker(lockPath: string): Promise<() => Promise<void>> {
  const markerPath = settingsBackendMarkerPath(lockPath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(markerPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let markerEntry: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      markerEntry = await lstat(markerPath);
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
    }
    if (markerEntry !== undefined) {
      if (!markerEntry.isFile()) throw fallbackLockConflict(markerPath, error);
      await unlink(markerPath);
    }
    try {
      handle = await open(markerPath, "wx", 0o600);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") {
        throw fallbackLockConflict(markerPath, retryError);
      }
      throw retryError;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await unlink(markerPath);
  };
}

async function acquireSettingsLock(lockPath: string): Promise<() => Promise<void>> {
  let fsNativeExtensions: (typeof import("fs-native-extensions"))["default"];
  try {
    ({ default: fsNativeExtensions } = await import("fs-native-extensions"));
  } catch {
    return acquireFallbackSettingsLock(lockPath);
  }
  const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
  // The stable inode is the synchronization primitive; never rename or unlink this file.
  const handle = await open(lockPath, "a+", 0o600);
  let locked = false;
  let releaseMarker: (() => Promise<void>) | undefined;

  try {
    while (!fsNativeExtensions.tryLock(handle.fd)) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for settings lock: ${lockPath}`);
      }
      await delay(SETTINGS_LOCK_RETRY_MS);
    }
    locked = true;
    releaseMarker = await acquireNativeBackendMarker(lockPath);
  } catch (error) {
    if (locked) {
      try {
        fsNativeExtensions.unlock(handle.fd);
      } catch {
        // Preserve the acquisition failure.
      }
    }
    await handle.close().catch(() => {});
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let releaseError: unknown;
    try {
      await releaseMarker?.();
    } catch (error) {
      releaseError = error;
    }
    try {
      fsNativeExtensions.unlock(handle.fd);
    } catch (error) {
      if (releaseError === undefined) releaseError = error;
    }
    try {
      await handle.close();
    } catch (error) {
      if (releaseError === undefined) releaseError = error;
    }
    if (releaseError !== undefined) throw releaseError;
  };
}

async function serializeSettingsWrite<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = settingsWriteQueues.get(path) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(action);
  const tail = run.then(() => undefined, () => undefined);
  settingsWriteQueues.set(path, tail);
  try {
    return await run;
  } finally {
    if (settingsWriteQueues.get(path) === tail) settingsWriteQueues.delete(path);
  }
}

async function withSettingsWriteLock<T>(
  path: string,
  action: () => Promise<T>,
  userConfigDir: string = defaultUserConfigDir(),
): Promise<T> {
  const lockPath = await settingsLockPath(path, userConfigDir);
  return serializeSettingsWrite(lockPath, async () => {
    const release = await acquireSettingsLock(lockPath);
    let primaryError: unknown;
    try {
      return await action();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (releaseError) {
        if (primaryError === undefined) throw releaseError;
      }
    }
  });
}

async function atomicWriteJson(path: string, value: unknown, mode: number = 0o666): Promise<void> {
  const payload = JSON.stringify(value, null, 2) + "\n";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let existingMode: number | undefined;
  try {
    const existing = await lstat(path);
    if (existing.isFile()) existingMode = existing.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", existingMode ?? mode);
    if (existingMode !== undefined) await handle.chmod(existingMode);
    await handle.writeFile(payload, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export interface SettingsPersistenceOptions {
  /** 可选的 workspace 断言；必须与 canonical 设置源的父目录一致。 */
  workspace?: string;
  /** 仅供宿主/测试显式注入；生产 CLI 不从 env 或项目设置读取。 */
  userConfigDir?: string;
}

export interface SettingsPersistenceContext extends SettingsPersistenceOptions {
  workspace: string;
  settingsDir: string;
}

export interface LoadSettingsOptions extends SettingsPersistenceOptions {
  /** 仅供宿主/测试注入；CLI 默认使用 OS 账户配置目录。 */
  trustStorePath?: string;
}

async function readRegularFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const [openedFile, pathEntry] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !openedFile.isFile()
      || !pathEntry.isFile()
      || openedFile.dev !== pathEntry.dev
      || openedFile.ino !== pathEntry.ino
    ) {
      throw new Error(`Refusing to read a path that is not the same regular file: ${path}`);
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function loadPath(path: string): Promise<Settings> {
  let raw: string;
  try {
    raw = await readRegularFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function loadFile(dir: string, file: string): Promise<Settings> {
  return loadPath(join(dir, file));
}

async function canonicalSettingsSource(dir: string): Promise<{
  settingsDir: string;
  workspace: string;
}> {
  const absoluteDir = resolve(dir);
  let settingsDir: string;
  try {
    settingsDir = await realpath(absoluteDir);
  } catch (error) {
    try {
      await lstat(absoluteDir);
    } catch (lstatError) {
      if ((lstatError as NodeJS.ErrnoException).code !== "ENOENT") throw lstatError;
      settingsDir = join(await realpath(dirname(absoluteDir)), basename(absoluteDir));
      return { settingsDir, workspace: dirname(settingsDir) };
    }
    throw error;
  }
  return { settingsDir, workspace: dirname(settingsDir) };
}

async function resolveSettingsSource(
  dir: string,
  assertedWorkspace?: string,
): Promise<{ settingsDir: string; workspace: string }> {
  const source = await canonicalSettingsSource(dir);
  if (assertedWorkspace !== undefined) {
    const canonicalAssertion = await realpath(assertedWorkspace);
    if (canonicalAssertion !== source.workspace) {
      throw new Error(
        `Settings source ${source.settingsDir} does not belong to workspace ${canonicalAssertion}`,
      );
    }
  }
  return source;
}

/** OS-account config root; intentionally ignores HOME/XDG/project environment overrides. */
export function defaultUserConfigDir(homeDir: string = userInfo().homedir): string {
  return join(homeDir, ".config", "transup");
}

function externalSettingsPath(canonicalWorkspace: string, userConfigDir: string): string {
  const workspaceKey = createHash("sha256").update(canonicalWorkspace).digest("hex");
  return join(userConfigDir, WORKSPACE_SETTINGS_DIR, workspaceKey, LEGACY_LOCAL_SETTINGS_FILE);
}

/** 返回 canonical workspace 对应的 external user-local 设置路径。 */
export async function userLocalSettingsPath(
  workspace: string = process.cwd(),
  userConfigDir: string = defaultUserConfigDir(),
): Promise<string> {
  return externalSettingsPath(await realpath(workspace), userConfigDir);
}

/** 信任状态只保存在 OS 账户配置目录，绝不放进工作区的 .transup。 */
export function defaultTrustStorePath(homeDir: string = userInfo().homedir): string {
  return join(defaultUserConfigDir(homeDir), TRUST_STORE_FILE);
}

function parseTrustStore(raw: string): WorkspaceTrustStore | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<WorkspaceTrustStore>;
    if (candidate.version !== TRUST_STORE_VERSION) return null;
    if (!Array.isArray(candidate.trustedWorkspaces)) return null;
    if (!candidate.trustedWorkspaces.every((entry) => typeof entry === "string")) return null;
    return {
      version: TRUST_STORE_VERSION,
      trustedWorkspaces: candidate.trustedWorkspaces,
    };
  } catch {
    return null;
  }
}

async function readTrustStore(path: string): Promise<WorkspaceTrustStore | null> {
  let raw: string;
  try {
    raw = await readRegularFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  return parseTrustStore(raw);
}

export async function isWorkspaceTrusted(
  workspace: string = process.cwd(),
  trustStorePath: string = defaultTrustStorePath(),
): Promise<boolean> {
  try {
    const [canonical, store] = await Promise.all([
      realpath(workspace),
      readTrustStore(trustStorePath),
    ]);
    return store?.trustedWorkspaces.includes(canonical) ?? false;
  } catch {
    return false;
  }
}

/** 显式信任动作；返回持久化后的 canonical workspace，便于 CLI 回显。 */
export async function trustWorkspace(
  workspace: string = process.cwd(),
  trustStorePath: string = defaultTrustStorePath(),
): Promise<string> {
  const canonical = await realpath(workspace);
  await withSettingsWriteLock(trustStorePath, async () => {
    const existing = await readTrustStore(trustStorePath);
    const trustedWorkspaces = [...(existing?.trustedWorkspaces ?? [])];
    if (!trustedWorkspaces.includes(canonical)) trustedWorkspaces.push(canonical);
    await atomicWriteJson(
      trustStorePath,
      { version: TRUST_STORE_VERSION, trustedWorkspaces },
      0o600,
    );
  }, dirname(resolve(trustStorePath)));
  return canonical;
}

function mergeSettingsLayers(project: Settings, local: Settings): Settings {
  const merged: Settings = { ...project, ...local };
  if (project.mcpServers || local.mcpServers) {
    merged.mcpServers = { ...project.mcpServers, ...local.mcpServers };
  }
  if (project.permissions || local.permissions) {
    merged.permissions = {
      allow: [...(project.permissions?.allow ?? []), ...(local.permissions?.allow ?? [])],
      deny: [...(project.permissions?.deny ?? []), ...(local.permissions?.deny ?? [])],
      ask: [...(project.permissions?.ask ?? []), ...(local.permissions?.ask ?? [])],
      defaultMode: local.permissions?.defaultMode ?? project.permissions?.defaultMode,
    };
  }
  return merged;
}

function restrictUntrustedLayers(project: Settings, local: Settings): Settings {
  if (!project.permissions && !local.permissions) return {};
  return {
    permissions: {
      allow: [],
      deny: [...(project.permissions?.deny ?? []), ...(local.permissions?.deny ?? [])],
      ask: [...(project.permissions?.ask ?? []), ...(local.permissions?.ask ?? [])],
      defaultMode: undefined,
    },
  };
}

/** 设置源的 canonical 父目录决定信任身份；显式 workspace 只能作一致性断言。 */
export async function loadSettings(
  dir: string = SETTINGS_DIR,
  options: LoadSettingsOptions = {},
): Promise<Settings> {
  const source = await resolveSettingsSource(dir, options.workspace);
  const externalPath = externalSettingsPath(
    source.workspace,
    options.userConfigDir ?? defaultUserConfigDir(),
  );
  const [project, legacy, external, trusted] = await Promise.all([
    loadFile(source.settingsDir, SETTINGS_FILE),
    loadFile(source.settingsDir, LEGACY_LOCAL_SETTINGS_FILE),
    loadPath(externalPath),
    isWorkspaceTrusted(source.workspace, options.trustStorePath ?? defaultTrustStorePath()),
  ]);
  const workspaceLayers = trusted
    ? mergeSettingsLayers(project, legacy)
    : restrictUntrustedLayers(project, legacy);
  return mergeSettingsLayers(workspaceLayers, external);
}

/** 覆写项目级设置文件（不触碰 local 层） */
export async function saveSettings(
  settings: Settings,
  dir: string = SETTINGS_DIR,
  options: Pick<SettingsPersistenceOptions, "userConfigDir"> = {},
): Promise<void> {
  const path = join(dir, SETTINGS_FILE);
  await withSettingsWriteLock(
    path,
    () => atomicWriteJson(path, settings),
    options.userConfigDir ?? defaultUserConfigDir(),
  );
}

/** 合并后的设置 → 判定用规则集 */
export function settingsRules(settings: Settings): PermissionRules {
  return {
    allow: [...(settings.permissions?.allow ?? [])],
    deny: [...(settings.permissions?.deny ?? [])],
    ask: [...(settings.permissions?.ask ?? [])],
  };
}

/** 工具级快速判断（headless / 旧调用方兼容）：只查 allow 列表 */
export function isAllowed(settings: Settings, toolName: string): boolean {
  return (settings.permissions?.allow ?? []).some((r) => ruleMatches(r, toolName));
}

/**
 * 把一条权限规则写入指定目的地文件。
 * 读单层原文再写回 —— 绝不能把合并结果落盘（会把 local 规则复制进项目文件）。
 */
export async function persistPermissionRule(
  rule: string,
  list: keyof PermissionRules,
  destination: Exclude<PermissionDestination, "session">,
  dir: string = SETTINGS_DIR,
  options: SettingsPersistenceOptions = {},
): Promise<void> {
  const source = await resolveSettingsSource(dir, options.workspace);
  const userConfigDir = options.userConfigDir ?? defaultUserConfigDir();
  const path = destination === "projectSettings"
    ? join(source.settingsDir, SETTINGS_FILE)
    : externalSettingsPath(
        source.workspace,
        userConfigDir,
      );
  await withSettingsWriteLock(path, async () => {
    const layer = await loadPath(path);
    layer.permissions ??= {};
    const rules = (layer.permissions[list] ??= []);
    if (rules.includes(rule)) return;
    rules.push(rule);
    await atomicWriteJson(
      path,
      layer,
      destination === "localSettings" ? 0o600 : 0o666,
    );
  }, userConfigDir);
}

/** @deprecated 用 persistPermissionRule；保留给旧调用方（写 local 层工具级 allow） */
export async function persistAllow(
  _settings: Settings,
  toolName: string,
  dir: string = SETTINGS_DIR,
  options: SettingsPersistenceOptions = {},
): Promise<void> {
  await persistPermissionRule(toolName, "allow", "localSettings", dir, options);
}
