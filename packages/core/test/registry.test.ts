/**
 * 工具执行管线测试
 *
 * 管线的核心承诺："任何一步失败都不崩溃，错误作为 tool result 喂回模型"。
 * 这里逐个验证每一道关卡。
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";

const allow = async () => true;
const deny = async () => false;

describe("工具执行管线", () => {
  const reg = new ToolRegistry();

  it("未知工具 → 错误结果而非异常", async () => {
    const r = await reg.execute("1", "not_a_tool", "{}", allow);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("可用工具");
  });

  it("非法 JSON 参数 → 错误结果", async () => {
    const r = await reg.execute("1", "read_file", "{oops", allow);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("JSON");
  });

  it("schema 校验失败 → 具体的字段级错误信息", async () => {
    const r = await reg.execute("1", "bash", JSON.stringify({ command: 123 }), allow);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("command");
  });

  it("权限拒绝 → 引导模型询问用户而非重试", async () => {
    const r = await reg.execute("1", "bash", JSON.stringify({ command: "echo hi" }), deny);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("拒绝");
  });

  it("只读工具不触发权限回调", async () => {
    let asked = false;
    const spy = async () => { asked = true; return true; };
    const dir = await mkdtemp(join(tmpdir(), "transup-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const r = await reg.execute("1", "read_file", JSON.stringify({ path: join(dir, "a.txt") }), spy);
    expect(r.isError).toBe(false);
    expect(asked).toBe(false);
  });

  it("执行异常 → 错误信息回流（edit_file 找不到 old_string）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-"));
    await writeFile(join(dir, "a.txt"), "hello world");
    const r = await reg.execute("1", "edit_file", JSON.stringify({
      path: join(dir, "a.txt"), old_string: "不存在的内容", new_string: "x",
    }), allow);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("read_file"); // 错误信息引导模型重新读文件
  });

  it("edit_file 多处匹配 → 要求提供更多上下文", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-"));
    await writeFile(join(dir, "a.txt"), "foo\nfoo\n");
    const r = await reg.execute("1", "edit_file", JSON.stringify({
      path: join(dir, "a.txt"), old_string: "foo", new_string: "bar",
    }), allow);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("2 次");
  });

  it("isReadOnly：fail-closed，未知工具按危险处理", () => {
    expect(reg.isReadOnly("grep")).toBe(true);
    expect(reg.isReadOnly("bash")).toBe(false);
    expect(reg.isReadOnly("unknown")).toBe(false);
  });
});
