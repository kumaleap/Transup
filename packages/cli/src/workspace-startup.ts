import { join } from "node:path";
import {
  connectAllMcpServers,
  loadSettings,
  type McpConnection,
  type Settings,
} from "@transup/core";

export interface WorkspaceStartupOptions {
  workspace?: string;
  settingsDir?: string;
  /** 宿主/测试注入点；CLI 不从项目 env/settings 读取此路径。 */
  trustStorePath?: string;
  connectMcp?: boolean;
  onMcpError?: (name: string, error: Error) => void;
}

export interface WorkspaceStartup {
  settings: Settings;
  mcp: McpConnection;
}

/** 普通 CLI 启动唯一的 workspace settings -> MCP 组装边界。 */
export async function prepareWorkspaceStartup(
  options: WorkspaceStartupOptions = {},
): Promise<WorkspaceStartup> {
  const workspace = options.workspace ?? process.cwd();
  const settings = await loadSettings(options.settingsDir ?? join(workspace, ".transup"), {
    workspace,
    ...(options.trustStorePath ? { trustStorePath: options.trustStorePath } : {}),
  });
  const mcp = options.connectMcp === false
    ? { tools: [], close: async () => {} }
    : await connectAllMcpServers(settings.mcpServers ?? {}, options.onMcpError);
  return { settings, mcp };
}
