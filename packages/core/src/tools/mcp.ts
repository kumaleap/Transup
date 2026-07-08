/**
 * MCP 客户端 —— 生态接入
 *
 * MCP（Model Context Protocol）是 coding agent 生态的工具标准：
 * 数据库、浏览器、issue 跟踪器…… 都以 MCP server 的形式提供工具。
 * 支持了 MCP，等于接入了整个生态，而不用自己写每一个集成。
 *
 * 设计决策：
 * 1. 命名 `mcp__<server>__<tool>`：与内建工具同池不同名，来源一目了然，
 *    权限规则也能按前缀配置。
 * 2. readOnly: false —— 我们无法验证外部工具是否真的只读，
 *    fail-closed：一律走权限确认。（MCP 协议有 readOnlyHint 注解，
 *    但那是 server 的自我声明，不可信任。）
 * 3. schema 用 server 自带的 JSON Schema（Tool.parameters 通道），
 *    参数校验交给 server —— 它比我们更知道什么是合法输入。
 *
 * 配置（项目根 .mycode/settings.json）：
 *   { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { Tool } from "./types.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** MCP 工具没有 zod 定义，本地只做"是对象"的宽松检查，真校验在 server 端 */
const passthrough = z.looseObject({});

export interface McpConnection {
  tools: Tool[];
  close: () => Promise<void>;
}

/** 连接一个 MCP server（stdio 传输），把它的工具包装成我们的 Tool 协议 */
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env as Record<string, string>, ...config.env },
  });
  const client = new Client({ name: "mycode", version: "0.1.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();

  const tools: Tool[] = mcpTools.map((t) => ({
    name: `mcp__${name}__${t.name}`,
    description: t.description ?? `(MCP 工具 ${t.name}，来自 ${name})`,
    schema: passthrough,
    parameters: t.inputSchema as Record<string, unknown>,
    readOnly: false, // 外部工具的只读声明不可信任，一律走权限门
    async execute(args) {
      const result = await client.callTool({
        name: t.name,
        arguments: args as Record<string, unknown>,
      });
      // MCP 结果是内容块数组，拼成文本给模型
      const text = (result.content as { type: string; text?: string }[])
        .map((c) => (c.type === "text" ? c.text : `[${c.type} 内容]`))
        .join("\n");
      if (result.isError) throw new Error(text || "MCP 工具执行失败");
      return text || "(无输出)";
    },
  }));

  return {
    tools,
    close: () => client.close(),
  };
}

/** 按配置连接全部 MCP server，失败的跳过并告知（一个坏 server 不该挡住启动） */
export async function connectAllMcpServers(
  servers: Record<string, McpServerConfig>,
  onError?: (name: string, err: Error) => void,
): Promise<McpConnection> {
  const connections: McpConnection[] = [];
  for (const [name, config] of Object.entries(servers)) {
    try {
      connections.push(await connectMcpServer(name, config));
    } catch (err: any) {
      onError?.(name, err);
    }
  }
  return {
    tools: connections.flatMap((c) => c.tools),
    close: async () => {
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}
