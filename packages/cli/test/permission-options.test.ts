/** 权限对话框选项构造（纯函数）：按工具路由 + 三段式模板 + safety 裁剪 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPermissionView } from "../src/tui/permission/options.js";
import type { AskVerdict, ToolUseConfirm } from "../src/tui/permission/types.js";

const askDefault: AskVerdict = { behavior: "ask", reason: { type: "default" } };

function confirmOf(
  toolName: string,
  args: Record<string, unknown>,
  verdict: AskVerdict = askDefault,
): ToolUseConfirm {
  return { id: 1, toolName, args, readOnly: false, verdict, resolve: () => {} };
}

describe("buildPermissionView", () => {
  it("edit_file：三段式 + 会话级选项挂 acceptEdits setMode", () => {
    const view = buildPermissionView(
      confirmOf("edit_file", { path: "src/a.ts", old_string: "x", new_string: "y" }),
    );
    expect(view.title).toBe("编辑文件");
    expect(view.subtitle).toBe("src/a.ts");
    expect(view.previewKind).toBe("diff");
    expect(view.question).toContain("a.ts");
    expect(view.options.map((o) => o.value)).toEqual(["yes", "yes-session", "no"]);
    const session = view.options[1];
    expect(session.sessionShortcut).toBe(true);
    expect(session.updates).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    // 是/否 都可 Tab 附言
    expect(view.options[0].feedbackPlaceholder).toBeTruthy();
    expect(view.options[2].feedbackPlaceholder).toBeTruthy();
  });

  it("write_file：按目标是否存在区分 创建/覆盖 标题", () => {
    const dir = mkdtempSync(join(tmpdir(), "transup-perm-"));
    const fresh = buildPermissionView(
      confirmOf("write_file", { path: join(dir, "new.txt"), content: "" }),
    );
    expect(fresh.title).toBe("创建文件");

    const existing = join(dir, "old.txt");
    writeFileSync(existing, "x");
    const over = buildPermissionView(confirmOf("write_file", { path: existing, content: "" }));
    expect(over.title).toBe("覆盖文件");
  });

  it("bash：不再询问选项预填前缀，buildUpdates 生成 local 规则", () => {
    const view = buildPermissionView(confirmOf("bash", { command: "npm run build" }));
    expect(view.title).toBe("Bash 命令");
    const scoped = view.options[1];
    expect(scoped.input?.value).toBe("npm run");
    expect(scoped.input!.buildUpdates("npm run")).toEqual([
      { type: "addRule", list: "allow", rule: "bash(npm run:*)", destination: "localSettings" },
    ]);
    // 编辑为整条命令 → 精确规则
    expect(scoped.input!.buildUpdates("npm run build")).toEqual([
      { type: "addRule", list: "allow", rule: "bash(npm run build)", destination: "localSettings" },
    ]);
  });

  it("safety 询问：裁掉持久化选项，只留 是/否 + 警告", () => {
    const view = buildPermissionView(
      confirmOf(
        "bash",
        { command: "rm -rf .git" },
        { behavior: "ask", reason: { type: "safety", path: ".git" } },
      ),
    );
    expect(view.options.map((o) => o.value)).toEqual(["yes", "no"]);
    expect(view.warning).toContain(".git");
  });

  it("ask 规则命中时给出解释行", () => {
    const view = buildPermissionView(
      confirmOf(
        "bash",
        { command: "npm publish" },
        { behavior: "ask", reason: { type: "rule", rule: "bash(npm publish:*)", list: "ask" } },
      ),
    );
    expect(view.explanation).toContain("bash(npm publish:*)");
  });

  it("fallback（MCP 等）：整工具不再询问选项", () => {
    const view = buildPermissionView(confirmOf("mcp__github__create_issue", { title: "t" }));
    expect(view.title).toBe("工具调用");
    expect(view.subtitle).toBe("mcp__github__create_issue");
    expect(view.options[1].updates).toEqual([
      {
        type: "addRule",
        list: "allow",
        rule: "mcp__github__create_issue",
        destination: "localSettings",
      },
    ]);
  });
});
