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
  /**
   * 约定：返回字符串（给模型看）；抛异常 = 失败，错误信息也会喂回模型。
   * onProgress：长任务（如 bash）可在执行中吐出增量输出，供 UI 实时显示；
   * 最终返回值仍是完整结果 —— 进度只给人看，结果才给模型看。
   */
  execute: (args: z.infer<S>, onProgress?: (chunk: string) => void) => Promise<string>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/**
 * 权限回调 —— core 不知道"怎么问用户"（终端? IDE 弹窗? 自动策略?），
 * 由宿主（CLI/服务端）注入实现。这是 core 保持 UI 无关的关键接缝。
 */
export type PermissionFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<boolean>;
