/**
 * 权限判定 —— 一次工具调用能不能跑，由谁说了算
 *
 * 判定优先级（先命中先返回，对齐交互规格 04 §1.1）：
 *   1. deny 规则        —— 禁止就是禁止，任何模式都翻不了案
 *   2. ask 规则         —— 显式要求确认的调用，bypass 模式也不能跳过
 *   3. safetyCheck      —— 敏感路径（.git/ .transup/ shell 配置）写操作必须弹窗，bypass 免疫
 *   4. plan 模式        —— 只读放行、写操作拒绝（先给计划，批准后再动手）
 *   5. 模式放行         —— bypassPermissions 全放；acceptEdits 放文件编辑
 *   6. allow 规则       —— 用户攒下的"不再询问"
 *   7. readOnly 放行    —— 只读工具免确认（fail-closed：readOnly 必须显式声明）
 *   8. 默认 ask         —— 以上都没命中，弹窗问用户
 *
 * 规则语法（settings.permissions.allow/deny/ask 三个列表通用）：
 *   "bash"               整个工具
 *   "mcp__github__*"     工具名前缀通配
 *   "bash(git status)"   内容精确匹配（bash 匹配命令，文件工具匹配路径）
 *   "bash(npm run:*)"    内容前缀匹配
 */

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface ToolPermissionContext {
  mode: PermissionMode;
  rules: PermissionRules;
}

export interface PermissionQuery {
  toolName: string;
  args: Record<string, unknown>;
  readOnly: boolean;
}

export type PermissionReason =
  | { type: "rule"; rule: string; list: keyof PermissionRules }
  | { type: "mode"; mode: PermissionMode }
  | { type: "safety"; path: string }
  | { type: "readOnly" }
  | { type: "default" };

export type PermissionVerdict =
  | { behavior: "allow"; reason: PermissionReason }
  | { behavior: "deny"; reason: PermissionReason; message: string }
  | { behavior: "ask"; reason: PermissionReason };

/** 对话框决策产生的持久化动作，由宿主统一应用（内存 or 落盘） */
export type PermissionDestination = "session" | "localSettings" | "projectSettings";

export type PermissionUpdate =
  | { type: "addRule"; list: keyof PermissionRules; rule: string; destination: PermissionDestination }
  | { type: "setMode"; mode: PermissionMode; destination: "session" };

/** settings.permissions 的宽松形状 → 规范化规则集 */
export function normalizeRules(partial?: {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}): PermissionRules {
  return {
    allow: [...(partial?.allow ?? [])],
    deny: [...(partial?.deny ?? [])],
    ask: [...(partial?.ask ?? [])],
  };
}

// ── 规则匹配 ──────────────────────────────────────────────

/** 各工具可被内容规则匹配的字段：bash 是命令，文件工具是路径 */
function contentOf(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "bash") return typeof args.command === "string" ? args.command : undefined;
  return typeof args.path === "string" ? args.path : undefined;
}

/** 单条规则是否命中（工具级 or 内容级） */
export function ruleMatches(
  rule: string,
  toolName: string,
  args?: Record<string, unknown>,
): boolean {
  const m = /^([^()]+)\((.*)\)$/.exec(rule);
  if (!m) {
    // 工具级：精确 或 前缀通配
    if (rule === toolName) return true;
    return rule.endsWith("*") && toolName.startsWith(rule.slice(0, -1));
  }
  // 内容级：工具名必须精确，内容精确或 "前缀:*"
  const [, tool, pattern] = m;
  if (tool !== toolName || !args) return false;
  const content = contentOf(toolName, args);
  if (content === undefined) return false;
  if (pattern.endsWith(":*")) return content.startsWith(pattern.slice(0, -2));
  return content === pattern;
}

function findMatch(
  rules: string[],
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  return rules.find((r) => ruleMatches(r, toolName, args));
}

// ── safetyCheck：敏感路径 ─────────────────────────────────

const SENSITIVE_SEGMENTS = [".git/", ".transup/"];
const SENSITIVE_BASENAMES = [
  ".git",
  ".transup",
  ".bashrc",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".profile",
  ".bash_profile",
];

function isSensitivePath(p: string): boolean {
  const norm = p.replace(/\\/g, "/");
  if (SENSITIVE_SEGMENTS.some((s) => norm.includes(s))) return true;
  const base = norm.split("/").filter(Boolean).pop() ?? "";
  return SENSITIVE_BASENAMES.includes(base);
}

/** 写操作是否触碰敏感路径；命中返回引发警报的那个片段 */
function sensitiveTarget(toolName: string, args: Record<string, unknown>): string | undefined {
  const candidates: string[] = [];
  if (typeof args.path === "string") candidates.push(args.path);
  if (toolName === "bash" && typeof args.command === "string") {
    candidates.push(...args.command.split(/\s+/));
  }
  return candidates.find(isSensitivePath);
}

// ── 判定主函数 ────────────────────────────────────────────

const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export function evaluatePermission(
  ctx: ToolPermissionContext,
  query: PermissionQuery,
): PermissionVerdict {
  const { toolName, args, readOnly } = query;

  const denyRule = findMatch(ctx.rules.deny, toolName, args);
  if (denyRule) {
    return {
      behavior: "deny",
      reason: { type: "rule", rule: denyRule, list: "deny" },
      message: `权限规则 ${denyRule} 禁止此调用。请换一种方式完成任务，或请用户调整规则。`,
    };
  }

  const askRule = findMatch(ctx.rules.ask, toolName, args);
  if (askRule) {
    return { behavior: "ask", reason: { type: "rule", rule: askRule, list: "ask" } };
  }

  if (!readOnly) {
    const sensitive = sensitiveTarget(toolName, args);
    if (sensitive) {
      return { behavior: "ask", reason: { type: "safety", path: sensitive } };
    }
  }

  if (ctx.mode === "plan" && !readOnly) {
    return {
      behavior: "deny",
      reason: { type: "mode", mode: "plan" },
      message:
        "当前处于 plan 模式：先只读地调研并给出完整计划，待用户批准后才能执行写操作。",
    };
  }

  if (ctx.mode === "bypassPermissions") {
    return { behavior: "allow", reason: { type: "mode", mode: "bypassPermissions" } };
  }
  if (ctx.mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: { type: "mode", mode: "acceptEdits" } };
  }

  const allowRule = findMatch(ctx.rules.allow, toolName, args);
  if (allowRule) {
    return { behavior: "allow", reason: { type: "rule", rule: allowRule, list: "allow" } };
  }

  if (readOnly) {
    return { behavior: "allow", reason: { type: "readOnly" } };
  }

  return { behavior: "ask", reason: { type: "default" } };
}

// ── 模式循环（Shift+Tab） ─────────────────────────────────

/** default → acceptEdits → plan → (bypass 若可用) → default */
export function nextPermissionMode(
  mode: PermissionMode,
  bypassAvailable: boolean,
): PermissionMode {
  switch (mode) {
    case "default":
      return "acceptEdits";
    case "acceptEdits":
      return "plan";
    case "plan":
      return bypassAvailable ? "bypassPermissions" : "default";
    case "bypassPermissions":
      return "default";
  }
}

// ── bash 前缀启发（"不再询问"预填值） ─────────────────────

/**
 * 复合命令（&& | ; 等）不给前缀 —— 前缀放行会连带放行后半段任意命令，
 * 退回整条命令精确匹配。简单命令取"命令 + 子命令"两词（npm run、
 * git commit 这类），第二词是选项/路径时只取首词。
 */
export function commandPrefix(command: string): string {
  const trimmed = command.trim();
  if (/[|;&<>`$]/.test(trimmed)) return trimmed;
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) return trimmed;
  const second = words[1];
  if (second.startsWith("-") || second.includes("/")) return words[0];
  return `${words[0]} ${second}`;
}

/** 由前缀生成 bash 内容规则："npm run" → "bash(npm run:*)"；整条命令 → 精确规则 */
export function bashPrefixRule(command: string): string {
  const prefix = commandPrefix(command);
  return prefix === command.trim() ? `bash(${prefix})` : `bash(${prefix}:*)`;
}
