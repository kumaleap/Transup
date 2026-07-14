/**
 * 项目设置 —— .transup/settings.json（+ settings.local.json）
 *
 * 两层工作区文件，读取时先按 workspace trust 过滤再合并：
 *   settings.json        项目级，进版本库，团队共享
 *   settings.local.json  个人级，应加入 gitignore；"不再询问"默认写这里
 * 未信任时只保留 deny/ask；信任后 mcpServers 按名覆盖（local 优先），权限列表拼接；
 * defaultMode 取 local，缺省回退项目级。
 *
 * 权限规则语法见 permissions.ts（工具级 / 前缀通配 / 内容级）。
 */
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
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
const LOCAL_SETTINGS_FILE = "settings.local.json";
const TRUST_STORE_VERSION = 1;
const TRUST_STORE_FILE = "trusted-workspaces.json";

interface WorkspaceTrustStore {
  version: typeof TRUST_STORE_VERSION;
  trustedWorkspaces: string[];
}

export interface LoadSettingsOptions {
  /** 被设置文件控制的工作区；信任比较前会 canonicalize。 */
  workspace?: string;
  /** 仅供宿主/测试注入；CLI 默认使用 OS 账户配置目录。 */
  trustStorePath?: string;
}

const FILE_FOR_DESTINATION: Record<Exclude<PermissionDestination, "session">, string> = {
  projectSettings: SETTINGS_FILE,
  localSettings: LOCAL_SETTINGS_FILE,
};

async function loadFile(dir: string, file: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(join(dir, file), "utf-8"));
  } catch {
    return {};
  }
}

/** 信任状态只保存在 OS 账户配置目录，绝不放进工作区的 .transup。 */
export function defaultTrustStorePath(homeDir: string = userInfo().homedir): string {
  return join(homeDir, ".config", "transup", TRUST_STORE_FILE);
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
  try {
    return parseTrustStore(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
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
  const existing = await readTrustStore(trustStorePath);
  const trustedWorkspaces = existing?.trustedWorkspaces ?? [];
  if (!trustedWorkspaces.includes(canonical)) trustedWorkspaces.push(canonical);

  await mkdir(dirname(trustStorePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${trustStorePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: TRUST_STORE_VERSION, trustedWorkspaces }, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600, flag: "wx" },
    );
    await rename(temporaryPath, trustStorePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
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

/** 先保留两层来源完成信任过滤，再按 local 优先规则合并。 */
export async function loadSettings(
  dir: string = SETTINGS_DIR,
  options: LoadSettingsOptions = {},
): Promise<Settings> {
  const project = await loadFile(dir, SETTINGS_FILE);
  const local = await loadFile(dir, LOCAL_SETTINGS_FILE);
  const trusted = await isWorkspaceTrusted(
    options.workspace ?? process.cwd(),
    options.trustStorePath ?? defaultTrustStorePath(),
  );
  return trusted ? mergeSettingsLayers(project, local) : restrictUntrustedLayers(project, local);
}

/** 覆写项目级设置文件（不触碰 local 层） */
export async function saveSettings(settings: Settings, dir: string = SETTINGS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
): Promise<void> {
  const file = FILE_FOR_DESTINATION[destination];
  const layer = await loadFile(dir, file);
  layer.permissions ??= {};
  const rules = (layer.permissions[list] ??= []);
  if (!rules.includes(rule)) {
    rules.push(rule);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, file), JSON.stringify(layer, null, 2) + "\n", "utf-8");
  }
}

/** @deprecated 用 persistPermissionRule；保留给旧调用方（写 local 层工具级 allow） */
export async function persistAllow(
  _settings: Settings,
  toolName: string,
  dir: string = SETTINGS_DIR,
): Promise<void> {
  await persistPermissionRule(toolName, "allow", "localSettings", dir);
}
