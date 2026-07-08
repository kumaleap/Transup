/**
 * 项目设置 —— .mycode/settings.json
 *
 * 一个文件承载两类配置：
 *   mcpServers   外部 MCP server 声明
 *   permissions  持久化的权限规则（跨会话记住"总是允许"）
 *
 * 权限规则支持通配后缀：如 "mcp__github__*" 允许该 server 的全部工具。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "./tools/mcp.js";

export interface Settings {
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: {
    allow?: string[];
  };
}

const SETTINGS_DIR = ".mycode";
const SETTINGS_FILE = "settings.json";

export async function loadSettings(dir: string = SETTINGS_DIR): Promise<Settings> {
  try {
    return JSON.parse(await readFile(join(dir, SETTINGS_FILE), "utf-8"));
  } catch {
    return {};
  }
}

export async function saveSettings(settings: Settings, dir: string = SETTINGS_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SETTINGS_FILE), JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

/** 判断工具是否在允许列表（支持 "prefix__*" 通配） */
export function isAllowed(settings: Settings, toolName: string): boolean {
  for (const rule of settings.permissions?.allow ?? []) {
    if (rule === toolName) return true;
    if (rule.endsWith("*") && toolName.startsWith(rule.slice(0, -1))) return true;
  }
  return false;
}

/** 把工具加入允许列表并落盘 */
export async function persistAllow(
  settings: Settings,
  toolName: string,
  dir: string = SETTINGS_DIR,
): Promise<void> {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  if (!settings.permissions.allow.includes(toolName)) {
    settings.permissions.allow.push(toolName);
    await saveSettings(settings, dir);
  }
}
