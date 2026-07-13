/** 权限判定：规则匹配、优先级链、模式循环、bash 前缀启发 */
import { describe, it, expect } from "vitest";
import {
  bashPrefixRule,
  commandPrefix,
  evaluatePermission,
  nextPermissionMode,
  normalizeRules,
  ruleMatches,
  type ToolPermissionContext,
} from "../src/permissions.js";

const ctx = (over: Partial<ToolPermissionContext> = {}): ToolPermissionContext => ({
  mode: "default",
  rules: normalizeRules(),
  ...over,
});

const rules = (over: Partial<Record<"allow" | "deny" | "ask", string[]>>) =>
  normalizeRules(over);

describe("ruleMatches", () => {
  it("工具级：精确与前缀通配", () => {
    expect(ruleMatches("bash", "bash")).toBe(true);
    expect(ruleMatches("bash", "bash2")).toBe(false);
    expect(ruleMatches("mcp__github__*", "mcp__github__create_issue")).toBe(true);
    expect(ruleMatches("mcp__github__*", "mcp__jira__create_issue")).toBe(false);
  });

  it("内容级：bash 命令精确与前缀", () => {
    expect(ruleMatches("bash(git status)", "bash", { command: "git status" })).toBe(true);
    expect(ruleMatches("bash(git status)", "bash", { command: "git status --short" })).toBe(false);
    expect(ruleMatches("bash(npm run:*)", "bash", { command: "npm run build" })).toBe(true);
    expect(ruleMatches("bash(npm run:*)", "bash", { command: "npm install" })).toBe(false);
  });

  it("内容级：文件工具匹配路径", () => {
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "test/a.ts" })).toBe(false);
    // 工具名不同不串台
    expect(ruleMatches("edit_file(src/:*)", "write_file", { path: "src/a.ts" })).toBe(false);
  });
});

describe("evaluatePermission 优先级", () => {
  const bash = (command: string) => ({ toolName: "bash", args: { command }, readOnly: false });
  const edit = (path: string) => ({ toolName: "edit_file", args: { path }, readOnly: false });
  const read = (path: string) => ({ toolName: "read_file", args: { path }, readOnly: true });

  it("deny 规则最高：bypass 模式也拦截，且盖过 allow 规则", () => {
    const v = evaluatePermission(
      ctx({ mode: "bypassPermissions", rules: rules({ deny: ["bash(rm:*)"], allow: ["bash"] }) }),
      bash("rm -rf dist"),
    );
    expect(v.behavior).toBe("deny");
  });

  it("ask 规则：bypass 模式也不能跳过", () => {
    const v = evaluatePermission(
      ctx({ mode: "bypassPermissions", rules: rules({ ask: ["bash(npm publish:*)"] }) }),
      bash("npm publish --tag latest"),
    );
    expect(v.behavior).toBe("ask");
    expect(v.behavior === "ask" && v.reason.type).toBe("rule");
  });

  it("safetyCheck：敏感路径写操作 bypass 免疫，必须询问", () => {
    for (const q of [
      edit(".git/config"),
      edit(".transup/settings.json"),
      { toolName: "write_file", args: { path: "/Users/x/.zshrc" }, readOnly: false },
      bash("echo hacked >> ~/.bashrc"),
      bash("rm -rf .git"),
    ]) {
      const v = evaluatePermission(ctx({ mode: "bypassPermissions" }), q);
      expect(v.behavior).toBe("ask");
      expect(v.behavior === "ask" && v.reason.type).toBe("safety");
    }
  });

  it("safetyCheck 只管写操作：只读读取 .git 正常放行", () => {
    const v = evaluatePermission(ctx(), read(".git/config"));
    expect(v.behavior).toBe("allow");
  });

  it("plan 模式：写操作拒绝（带引导文案），只读放行", () => {
    const denyV = evaluatePermission(ctx({ mode: "plan" }), edit("src/a.ts"));
    expect(denyV.behavior).toBe("deny");
    expect(denyV.behavior === "deny" && denyV.message).toContain("plan");
    expect(evaluatePermission(ctx({ mode: "plan" }), read("src/a.ts")).behavior).toBe("allow");
  });

  it("acceptEdits：文件编辑放行，bash 仍询问", () => {
    expect(evaluatePermission(ctx({ mode: "acceptEdits" }), edit("src/a.ts")).behavior).toBe("allow");
    expect(evaluatePermission(ctx({ mode: "acceptEdits" }), bash("make build")).behavior).toBe("ask");
  });

  it("allow 规则放行写操作；默认写操作询问、只读放行", () => {
    expect(
      evaluatePermission(ctx({ rules: rules({ allow: ["bash(npm run:*)"] }) }), bash("npm run test"))
        .behavior,
    ).toBe("allow");
    expect(evaluatePermission(ctx(), bash("npm run test")).behavior).toBe("ask");
    expect(evaluatePermission(ctx(), read("a.txt")).behavior).toBe("allow");
  });
});

describe("nextPermissionMode", () => {
  it("循环：default → acceptEdits → plan → default（bypass 不可用）", () => {
    expect(nextPermissionMode("default", false)).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits", false)).toBe("plan");
    expect(nextPermissionMode("plan", false)).toBe("default");
  });

  it("bypass 可用时 plan → bypass → default", () => {
    expect(nextPermissionMode("plan", true)).toBe("bypassPermissions");
    expect(nextPermissionMode("bypassPermissions", true)).toBe("default");
  });
});

describe("bash 前缀启发", () => {
  it("命令 + 子命令两词；选项/路径回退单词；单词命令取全命令", () => {
    expect(commandPrefix("npm run build")).toBe("npm run");
    expect(commandPrefix("git -C /tmp status")).toBe("git");
    expect(commandPrefix("ls")).toBe("ls");
  });

  it("复合命令不给前缀，退回整条精确规则", () => {
    expect(bashPrefixRule("echo a && rm -rf /")).toBe("bash(echo a && rm -rf /)");
    expect(bashPrefixRule("npm run build")).toBe("bash(npm run:*)");
    expect(bashPrefixRule("ls")).toBe("bash(ls)");
  });
});
