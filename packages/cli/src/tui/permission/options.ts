/**
 * 工具 → 对话框内容路由（交互规格 04 §1.3 / §3 / §4 的最小集）
 *
 * 每类工具一个构造分支，输出统一的 PermissionViewModel：
 *   edit_file / write_file  diff 预览 + "本会话允许所有编辑"（setMode acceptEdits）
 *   bash                    命令展示 + "不再询问"可编辑前缀（写 local settings）
 *   其余（MCP / 被 ask 规则命中的只读工具）  参数 JSON + 整工具放行
 *
 * 敏感路径或显式 ask 规则触发的询问不提供任何"不再询问"选项 ——
 * 前者不能被持久规则覆盖，后者优先于 allow/mode，承诺 scoped 放行会失实。
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { commandPrefix } from "@transup/core";
import { color } from "../../ui.js";
import { renderEditPreview, renderWritePreview } from "../../diff.js";
import type { PermissionOption, PermissionViewModel, ToolUseConfirm } from "./types.js";

function explanationFor(confirm: ToolUseConfirm): Pick<PermissionViewModel, "explanation" | "warning"> {
  const reason = confirm.verdict.reason;
  if (reason.type === "rule") {
    return { explanation: `权限规则 ${reason.rule} 要求确认（.transup/settings.json 可调整）` };
  }
  if (reason.type === "safety") {
    return { warning: `⚠ 目标涉及敏感路径 ${reason.path} —— 任何模式下都会询问` };
  }
  return {};
}

function yesOption(): PermissionOption {
  return {
    value: "yes",
    label: "是",
    kind: "allow",
    updates: [],
    feedbackPlaceholder: "告诉模型接下来做什么",
  };
}

function noOption(): PermissionOption {
  return {
    value: "no",
    label: "否",
    kind: "deny",
    feedbackPlaceholder: "告诉模型改做什么",
  };
}

/** 无法被 scoped allow 覆盖的询问只留 是/否 */
function withScoped(scoped: PermissionOption, confirm: ToolUseConfirm): PermissionOption[] {
  const reason = confirm.verdict.reason.type;
  return reason === "safety" || reason === "rule"
    ? [yesOption(), noOption()]
    : [yesOption(), scoped, noOption()];
}

export function buildPermissionView(confirm: ToolUseConfirm): PermissionViewModel {
  const { toolName, args } = confirm;

  if (toolName === "edit_file" || toolName === "write_file") {
    const path = typeof args.path === "string" ? args.path : "";
    const overwrite = toolName === "write_file" && path !== "" && existsSync(path);
    const scoped: PermissionOption = {
      value: "yes-session",
      label: "是，本会话内允许所有编辑",
      kind: "allow",
      updates: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      sessionShortcut: true,
    };
    return {
      title: toolName === "edit_file" ? "编辑文件" : overwrite ? "覆盖文件" : "创建文件",
      subtitle: path,
      preview: toolName === "edit_file" ? renderEditPreview(args) : renderWritePreview(args),
      previewKind: "diff",
      ...explanationFor(confirm),
      question:
        toolName === "edit_file"
          ? `要对 ${basename(path)} 应用这个修改吗？`
          : `要${overwrite ? "覆盖" : "创建"} ${basename(path)} 吗？`,
      options: withScoped(scoped, confirm),
    };
  }

  if (toolName === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const prefix = commandPrefix(command);
    const scoped: PermissionOption = {
      value: "yes-prefix",
      label: "是，且不再询问：",
      kind: "allow",
      input: {
        value: prefix,
        buildUpdates: (value) => {
          const v = value.trim();
          // 编辑后的值等于整条命令 → 精确规则；否则按前缀放行
          const rule = v === command.trim() ? `bash(${v})` : `bash(${v}:*)`;
          return [{ type: "addRule", list: "allow", rule, destination: "localSettings" }];
        },
      },
    };
    return {
      title: "Bash 命令",
      preview: command,
      ...explanationFor(confirm),
      question: "允许执行吗？",
      options: withScoped(scoped, confirm),
    };
  }

  // fallback：MCP 工具、被 ask 规则命中的只读工具、未来的新工具
  const scoped: PermissionOption = {
    value: "yes-tool",
    label: `是，本项目不再询问 ${toolName}`,
    kind: "allow",
    updates: [{ type: "addRule", list: "allow", rule: toolName, destination: "localSettings" }],
  };
  return {
    title: "工具调用",
    subtitle: toolName,
    preview: color.dim(JSON.stringify(args, null, 2)),
    ...explanationFor(confirm),
    question: "允许执行吗？",
    options: withScoped(scoped, confirm),
  };
}
