/**
 * 工具执行管线测试
 *
 * 管线的核心承诺："任何一步失败都不崩溃，错误作为 tool result 喂回模型"。
 * 这里逐个验证每一道关卡。
 */
import { describe, it, expect, vi } from "vitest";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";
import { writeFileTool } from "../src/tools/write-file.js";

const allow = async () => ({ behavior: "allow" as const });
const deny = async () => ({ behavior: "deny" as const });

const captureSchema = z.object({ value: z.string() });

function captureRegistry(
  execute: Tool<typeof captureSchema>["execute"],
): ToolRegistry {
  return new ToolRegistry([{
    name: "capture",
    description: "capture test input",
    schema: captureSchema,
    readOnly: false,
    execute,
  }]);
}

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

  it("legacy boolean false denies execution instead of failing open", async () => {
    const execute = vi.fn(async () => "must not run");
    const local = captureRegistry(execute);

    const result = await local.execute(
      "legacy-false",
      "capture",
      JSON.stringify({ value: "x" }),
      (async () => false) as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("拒绝");
    expect(execute).not.toHaveBeenCalled();
  });

  it("malformed permission decisions fail closed without rejecting the tool pipeline", async () => {
    const execute = vi.fn(async () => "must not run");
    const local = captureRegistry(execute);

    const result = await local.execute(
      "malformed-decision",
      "capture",
      JSON.stringify({ value: "x" }),
      (async () => null) as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("权限检查");
    expect(execute).not.toHaveBeenCalled();
  });

  it("permission callback failures return an error result without executing the tool", async () => {
    const execute = vi.fn(async () => "must not run");
    const local = captureRegistry(execute);

    const result = await local.execute(
      "permission-error",
      "capture",
      JSON.stringify({ value: "x" }),
      async () => {
        throw new Error("permission host unavailable");
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("权限检查失败");
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancellation while permission is pending prevents the tool from starting", async () => {
    const execute = vi.fn(async () => "must not run");
    const local = captureRegistry(execute);
    let markPermissionStarted!: () => void;
    const permissionStarted = new Promise<void>((resolve) => {
      markPermissionStarted = resolve;
    });
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    const controller = new AbortController();

    const pending = local.execute(
      "permission-abort",
      "capture",
      JSON.stringify({ value: "x" }),
      async () => {
        markPermissionStarted();
        await permissionGate;
        return { behavior: "allow" as const };
      },
      undefined,
      controller.signal,
    );
    await permissionStarted;
    controller.abort();
    releasePermission();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("中断");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not mask a real permission host failure that races with cancellation", async () => {
    const execute = vi.fn(async () => "must not run");
    const local = captureRegistry(execute);
    let markPermissionStarted!: () => void;
    const permissionStarted = new Promise<void>((resolve) => {
      markPermissionStarted = resolve;
    });
    let releasePermission!: () => void;
    const permissionGate = new Promise<void>((resolve) => {
      releasePermission = resolve;
    });
    const controller = new AbortController();

    const pending = local.execute(
      "permission-error-after-abort",
      "capture",
      JSON.stringify({ value: "x" }),
      async () => {
        markPermissionStarted();
        await permissionGate;
        throw new Error("permission host crashed");
      },
      undefined,
      controller.signal,
    );
    await permissionStarted;
    controller.abort();
    releasePermission();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("permission host crashed");
    expect(result.content).not.toContain("用户中断");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not mask a real tool failure that races with cancellation", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const local = captureRegistry(async () => {
      markStarted();
      await gate;
      throw new Error("disk full");
    });
    const controller = new AbortController();

    const pending = local.execute(
      "real-error-after-abort",
      "capture",
      JSON.stringify({ value: "x" }),
      allow,
      undefined,
      controller.signal,
    );
    await started;
    controller.abort();
    release();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disk full");
    expect(result.content).not.toContain("用户中断");
  });

  it("write_file declares commit before creating a missing parent directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "transup-write-boundary-"));
    const parent = join(dir, "new", "nested");
    const target = join(parent, "file.txt");
    const sentinel = new Error("commit boundary rejected");

    await expect(
      writeFileTool.execute(
        { path: target, content: "must not be written" },
        undefined,
        undefined,
        () => {
          throw sentinel;
        },
      ),
    ).rejects.toBe(sentinel);
    await expect(access(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("只读工具也过权限回调（deny 规则才能管到它们），并带 readOnly 标记", async () => {
    let seenReadOnly: boolean | undefined;
    const spy = async (_n: string, _a: Record<string, unknown>, meta: { readOnly: boolean }) => {
      seenReadOnly = meta.readOnly;
      return { behavior: "allow" as const };
    };
    const dir = await mkdtemp(join(tmpdir(), "transup-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const r = await reg.execute("1", "read_file", JSON.stringify({ path: join(dir, "a.txt") }), spy);
    expect(r.isError).toBe(false);
    expect(seenReadOnly).toBe(true);
  });

  it("有效 updatedInput 重新校验后作为最终参数执行", async () => {
    const executed: string[] = [];
    const local = captureRegistry(async ({ value }) => {
      executed.push(value);
      return `captured:${value}`;
    });

    const result = await local.execute(
      "updated-valid",
      "capture",
      JSON.stringify({ value: "original" }),
      async () => ({ behavior: "allow", updatedInput: { value: "updated" } }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("captured:updated");
    expect(executed).toEqual(["updated"]);
  });

  it("无效 updatedInput 返回校验错误且不执行工具", async () => {
    const execute = vi.fn(async () => "should not run");
    const local = captureRegistry(execute);

    const result = await local.execute(
      "updated-invalid",
      "capture",
      JSON.stringify({ value: "original" }),
      async () => ({ behavior: "allow", updatedInput: { value: 42 } }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("修改后的参数校验失败");
    expect(execute).not.toHaveBeenCalled();
  });

  it("成功工具结果保留权限附言", async () => {
    const local = captureRegistry(async () => "captured");
    const result = await local.execute(
      "feedback-success",
      "capture",
      JSON.stringify({ value: "x" }),
      async () => ({ behavior: "allow", feedback: "also verify tests" }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("captured");
    expect(result.content).toContain("[用户附言] also verify tests");
  });

  it("失败工具结果同样保留权限附言", async () => {
    const local = captureRegistry(async () => {
      throw new Error("capture failed");
    });
    const result = await local.execute(
      "feedback-error",
      "capture",
      JSON.stringify({ value: "x" }),
      async () => ({ behavior: "allow", feedback: "try another source" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("capture failed");
    expect(result.content).toContain("[用户附言] try another source");
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
