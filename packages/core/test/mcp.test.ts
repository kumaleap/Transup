/**
 * MCP 集成测试 —— 起一个真实的 stdio MCP server（fixture）连给它。
 * 验证：工具发现、命名规范、调用往返、fail-closed 权限属性、坏 server 跳过。
 */
import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectMcpServer, connectAllMcpServers, type McpConnection } from "../src/tools/mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "echo-mcp-server.mts");
const NPX_TSX = { command: "npx", args: ["tsx", FIXTURE] };

let conn: McpConnection | null = null;
afterAll(async () => { await conn?.close(); });

describe("MCP 客户端", () => {
  it("连接 server、发现工具、命名为 mcp__server__tool", async () => {
    conn = await connectMcpServer("echo", NPX_TSX);
    expect(conn.tools).toHaveLength(1);
    const tool = conn.tools[0];
    expect(tool.name).toBe("mcp__echo__echo");
    expect(tool.readOnly).toBe(false); // fail-closed：外部工具一律走权限门
    expect(tool.parameters).toBeTruthy(); // 用 server 自带的 JSON Schema
  }, 60_000);

  it("调用往返：参数进、文本结果出", async () => {
    conn ??= await connectMcpServer("echo", NPX_TSX);
    const result = await conn.tools[0].execute({ text: "你好 MCP" });
    expect(result).toBe("echo: 你好 MCP");
  }, 60_000);

  it("坏 server 被跳过且报告，不挡启动", async () => {
    const errors: string[] = [];
    const all = await connectAllMcpServers(
      { broken: { command: "/不存在的命令" } },
      (name) => errors.push(name),
    );
    expect(all.tools).toHaveLength(0);
    expect(errors).toEqual(["broken"]);
  }, 30_000);
});
