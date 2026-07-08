/** 测试用 MCP server：一个 echo 工具，stdio 传输 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "1.0.0" });

server.tool("echo", "原样返回输入的文本", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));

await server.connect(new StdioServerTransport());
