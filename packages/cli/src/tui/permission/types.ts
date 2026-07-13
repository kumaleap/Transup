/**
 * 权限对话框的领域类型
 *
 * ToolUseConfirm 是"一次待确认的工具调用"：engine 的 canUseTool 挂起为
 * Promise，confirm 进入队列，对话框 resolve 一个 PermissionOutcome。
 * 所有对话框的输出统一收敛为 allow(updates, feedback?) / deny(feedback?) ——
 * 持久化动作（updates）由 App 统一应用，对话框只负责"选了什么"。
 */
import type { PermissionUpdate, PermissionVerdict } from "@transup/core";

export type AskVerdict = Extract<PermissionVerdict, { behavior: "ask" }>;

export interface ToolUseConfirm {
  id: number;
  toolName: string;
  args: Record<string, unknown>;
  readOnly: boolean;
  /** 判定层给出的"为什么要问"（默认 / 规则 / 敏感路径） */
  verdict: AskVerdict;
  resolve: (outcome: PermissionOutcome) => void;
}

export type PermissionOutcome =
  | { kind: "allow"; updates: PermissionUpdate[]; feedback?: string }
  | { kind: "deny"; feedback?: string };

/** 三段式模板的一个选项 */
export interface PermissionOption {
  value: string;
  label: string;
  kind: "allow" | "deny";
  /** 选中即应用的持久化动作（input 型选项改由 buildUpdates 生成） */
  updates?: PermissionUpdate[];
  /** 有此字段的选项可用 Tab 展开附言输入 */
  feedbackPlaceholder?: string;
  /** 可编辑预填值（bash "不再询问"前缀）；Enter 以当前值提交 */
  input?: {
    value: string;
    buildUpdates: (value: string) => PermissionUpdate[];
  };
  /** Shift+Tab 直选此项（会话级选项约定） */
  sessionShortcut?: boolean;
}

/** 对话框渲染所需的全部静态内容（按工具路由生成，纯数据可单测） */
export interface PermissionViewModel {
  title: string;
  subtitle?: string;
  /** 已渲染好的 ANSI 预览（diff / 命令 / 参数 JSON） */
  preview: string;
  previewKind?: "diff";
  /** 为什么要问你（命中了哪条规则） */
  explanation?: string;
  /** 敏感路径警告（黄字） */
  warning?: string;
  question: string;
  options: PermissionOption[];
}
