/**
 * 项目设置 —— .transup/settings.json（+ settings.local.json）
 *
 * 两层文件，读取时合并：
 *   settings.json        项目级，进版本库，团队共享
 *   settings.local.json  个人级，应加入 gitignore；"不再询问"默认写这里
 * 合并规则：mcpServers 按名覆盖（local 优先）；权限三列表拼接（两层都生效）；
 * defaultMode 取 local，缺省回退项目级。
 *
 * 权限规则语法见 permissions.ts（工具级 / 前缀通配 / 内容级）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** 读取并合并两层设置（只用于消费；持久化必须写单层文件，见 persist*） */
export async function loadSettings(dir: string = SETTINGS_DIR): Promise<Settings> {
  const project = await loadFile(dir, SETTINGS_FILE);
  const local = await loadFile(dir, LOCAL_SETTINGS_FILE);

  const merged: Settings = { ...project };
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
