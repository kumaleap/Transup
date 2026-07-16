/**
 * 工具注册表 + 执行管线
 *
 * 管线：① JSON 解析 → ② schema 校验 → ③ 权限（回调）→ ④ 执行 → ⑤ 标准化
 * 任何一步失败都不崩溃，错误作为 tool result 喂回模型让它自我纠正。
 *
 * 与 V1 的区别：权限不再依赖 readline，而是宿主注入的 PermissionFn —
 * 同一套管线可以跑在终端（弹确认）、CI（自动策略）、IDE（弹窗）。
 */
import { z } from "zod";
import type { PermissionDecision, PermissionFn, Tool, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider/types.js";
import { readFileTool } from "./read-file.js";
import { listDirTool } from "./list-dir.js";
import { grepTool } from "./grep.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { bashTool } from "./bash.js";

export const builtinTools: Tool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  writeFileTool,
  editFileTool,
  bashTool,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePermissionDecision(value: unknown): PermissionDecision | null {
  if (value === true) return { behavior: "allow" };
  if (value === false) return { behavior: "deny" };
  if (!isRecord(value)) return null;
  if (value.behavior === "deny") {
    if (value.message !== undefined && typeof value.message !== "string") return null;
    return {
      behavior: "deny",
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  if (value.behavior !== "allow") return null;
  if (value.updatedInput !== undefined && !isRecord(value.updatedInput)) return null;
  if (value.feedback !== undefined && typeof value.feedback !== "string") return null;
  return {
    behavior: "allow",
    ...(isRecord(value.updatedInput) ? { updatedInput: value.updatedInput } : {}),
    ...(typeof value.feedback === "string" ? { feedback: value.feedback } : {}),
  };
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason) return true;
  if (!isRecord(error)) return false;
  return error.name === "AbortError" || error.code === "ABORT_ERR";
}

export class ToolRegistry {
  private map: Map<string, Tool>;

  constructor(tools: Tool[] = builtinTools) {
    this.map = new Map(tools.map((t) => [t.name, t]));
  }

  /** 查询工具是否只读（用于并行调度）。未知工具按危险处理（fail-closed）。 */
  isReadOnly(name: string): boolean {
    return this.map.get(name)?.readOnly ?? false;
  }

  /** 转成 provider 中立的工具声明（zod → JSON Schema；外部工具用自带的） */
  specs(): ToolSpec[] {
    return [...this.map.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? (z.toJSONSchema(t.schema) as Record<string, unknown>),
    }));
  }

  async execute(
    toolCallId: string,
    name: string,
    rawArgs: string,
    canUse: PermissionFn,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
    onCommitStart?: () => void,
  ): Promise<ToolResult> {
    const fail = (content: string): ToolResult => ({ toolCallId, content, isError: true });
    const interrupted = (note = ""): ToolResult => fail(`工具执行已被用户中断。${note}`);

    const tool = this.map.get(name);
    if (!tool) return fail(`未知工具: ${name}。可用工具: ${[...this.map.keys()].join(", ")}`);
    if (signal?.aborted) return interrupted();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs || "{}");
    } catch {
      return fail(`参数不是合法 JSON: ${rawArgs}`);
    }

    const check = tool.schema.safeParse(parsed);
    if (!check.success) {
      return fail(
        `参数校验失败:\n${check.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`,
      );
    }

    let rawDecision: unknown;
    try {
      rawDecision = await canUse(name, check.data as Record<string, unknown>, {
        readOnly: tool.readOnly,
      });
    } catch (error) {
      if (signal?.aborted && isAbortFailure(error, signal)) return interrupted();
      const detail = error instanceof Error ? `: ${error.message}` : "";
      return fail(`权限检查失败${detail}`);
    }
    if (signal?.aborted) return interrupted();
    const decision = normalizePermissionDecision(rawDecision);
    if (!decision) return fail("权限检查返回无效结果，已拒绝执行。");
    if (decision.behavior === "deny") {
      return fail(decision.message ?? "用户拒绝了本次操作。请询问用户希望如何处理，不要重复尝试。");
    }

    // 对话框里改过的参数同样要过校验 —— 权限层不能成为绕过 schema 的后门
    let finalArgs = check.data;
    if (decision.updatedInput) {
      const recheck = tool.schema.safeParse(decision.updatedInput);
      if (!recheck.success) {
        return fail(
          `修改后的参数校验失败:\n${recheck.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`,
        );
      }
      finalArgs = recheck.data;
    }

    const note = decision.feedback ? `\n\n[用户附言] ${decision.feedback}` : "";
    if (signal?.aborted) return interrupted(note);
    try {
      const result = await tool.execute(finalArgs, onProgress, signal, onCommitStart);
      return { toolCallId, content: (result || "(无输出)") + note, isError: false };
    } catch (error) {
      if (signal?.aborted && isAbortFailure(error, signal)) return interrupted(note);
      const detail = error instanceof Error ? error.message : String(error);
      return fail(`工具执行出错: ${detail}${note}`);
    }
  }
}
