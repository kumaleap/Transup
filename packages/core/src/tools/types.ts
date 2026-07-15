/**
 * 工具协议
 *
 * 工具是"协议对象"而非裸函数：除执行逻辑外还声明参数 schema（zod，
 * 一份定义同时用于发给模型的 JSON Schema 和本地运行时校验）与安全属性。
 *
 * fail-closed 原则：readOnly 必须显式声明为 true 才免用户确认，
 * 忘了声明就按"危险"处理。
 */
import type { z } from "zod";

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  /** 写给模型看的说明书 —— 描述质量直接决定模型用不用得对 */
  description: string;
  schema: S;
  /**
   * 原生 JSON Schema 覆盖（MCP 等外部工具用）：外部工具自带 JSON Schema，
   * 没有 zod 定义 —— 设了此字段则发给模型时用它，本地校验交给外部服务端。
   */
  parameters?: Record<string, unknown>;
  /** true = 不修改任何状态，可免确认执行 */
  readOnly: boolean;
  /** true = 副作用一旦开始必须等它提交完，abort 不能把真实结果留在后台 */
  commitOnAbort?: boolean;
  /**
   * 约定：返回字符串（给模型看）；抛异常 = 失败，错误信息也会喂回模型。
   * onProgress：长任务（如 bash）可在执行中吐出增量输出，供 UI 实时显示；
   * signal：宿主取消当前 turn 时向已启动工具传播，工具应尽快停止副作用并收尾；
   * 最终返回值仍是完整结果 —— 进度只给人看，结果才给模型看。
   */
  execute: (
    args: z.infer<S>,
    onProgress?: (chunk: string) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/**
 * 权限回调 —— core 不知道"怎么问用户"（终端? IDE 弹窗? 自动策略?），
 * 由宿主（CLI/服务端）注入实现。这是 core 保持 UI 无关的关键接缝。
 *
 * 所有工具（含只读）都会经过回调 —— deny 规则对只读工具同样生效；
 * 宿主对只读调用通常走无 UI 的快速判定。
 */
export type PermissionDecision =
  | {
      behavior: "allow";
      /** 对话框里修改过的参数（如编辑过的命令），执行前会重新过 schema 校验 */
      updatedInput?: Record<string, unknown>;
      /** 用户附言（"顺便…"），随工具结果一起喂回模型 */
      feedback?: string;
    }
  | {
      behavior: "deny";
      /** 拒绝原因，喂回模型；不传用默认文案 */
      message?: string;
    };

/** Boolean results remain supported for hosts compiled against the pre-dialog API. */
export type PermissionResult = PermissionDecision | boolean;

export type PermissionFn = (
  toolName: string,
  args: Record<string, unknown>,
  meta: { readOnly: boolean },
) => Promise<PermissionResult>;
