/** 权限对话框选项构造（纯函数）：按工具路由 + 三段式模板 + safety 裁剪 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePermission, normalizeRules } from "@transup/core";
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

  it("bash：带引号的简单命令持久化后，下一次完全相同的调用会放行", () => {
    const command = 'npm run "build"';
    const view = buildPermissionView(confirmOf("bash", { command }));
    const scoped = view.options.find((option) => option.value === "yes-prefix");
    expect(scoped?.input?.value).toBe("npm run");

    const updates = scoped!.input!.buildUpdates(scoped!.input!.value);
    expect(updates).toEqual([
      { type: "addRule", list: "allow", rule: "bash(npm run:*)", destination: "localSettings" },
    ]);
    const update = updates[0];
    expect(update.type).toBe("addRule");
    if (update.type !== "addRule") return;

    const verdict = evaluatePermission(
      { mode: "default", rules: normalizeRules({ allow: [update.rule] }) },
      { toolName: "bash", args: { command }, readOnly: false },
    );
    expect(verdict.behavior).toBe("allow");
    expect(verdict.reason).toEqual({ type: "rule", rule: update.rule, list: "allow" });
  });

  it("bash：含 shell 语法的命令仅生成整条精确规则，且该规则可复用", () => {
    const command = "echo ok && printf done";
    const view = buildPermissionView(confirmOf("bash", { command }));
    const scoped = view.options.find((option) => option.value === "yes-prefix");
    expect(scoped?.input?.value).toBe(command);

    const updates = scoped!.input!.buildUpdates(scoped!.input!.value);
    expect(updates).toEqual([
      { type: "addRule", list: "allow", rule: `bash(${command})`, destination: "localSettings" },
    ]);
    const update = updates[0];
    if (update.type !== "addRule") throw new Error("expected addRule update");
    expect(
      evaluatePermission(
        { mode: "default", rules: normalizeRules({ allow: [update.rule] }) },
        { toolName: "bash", args: { command }, readOnly: false },
      ).behavior,
    ).toBe("allow");
  });

  it("bash：多行命令生成的整条精确规则也可复用", () => {
    const command = "echo ok\nprintf done";
    const view = buildPermissionView(confirmOf("bash", { command }));
    const scoped = view.options.find((option) => option.value === "yes-prefix");
    expect(scoped?.input?.value).toBe(command);

    const updates = scoped!.input!.buildUpdates(scoped!.input!.value);
    expect(updates).toEqual([
      { type: "addRule", list: "allow", rule: `bash(${command})`, destination: "localSettings" },
    ]);
    const update = updates[0];
    if (update.type !== "addRule") throw new Error("expected addRule update");
    expect(
      evaluatePermission(
        { mode: "default", rules: normalizeRules({ allow: [update.rule] }) },
        { toolName: "bash", args: { command }, readOnly: false },
      ).behavior,
    ).toBe("allow");
  });

  it("bash：精确规则统一忽略命令外层空白，且不改变命令正文", () => {
    for (const [command, normalized] of [
      ["  echo ok && printf done  ", "echo ok && printf done"],
      ["echo ok\nprintf done\n", "echo ok\nprintf done"],
      ['  echo "  body  " && printf done  ', 'echo "  body  " && printf done'],
    ] as const) {
      const view = buildPermissionView(confirmOf("bash", { command }));
      const scoped = view.options.find((option) => option.value === "yes-prefix");
      expect(scoped?.input?.value, command).toBe(normalized);

      const updates = scoped!.input!.buildUpdates(scoped!.input!.value);
      expect(updates, command).toEqual([
        {
          type: "addRule",
          list: "allow",
          rule: `bash(${normalized})`,
          destination: "localSettings",
        },
      ]);
      const update = updates[0];
      if (update.type !== "addRule") throw new Error("expected addRule update");
      expect(
        evaluatePermission(
          { mode: "default", rules: normalizeRules({ allow: [update.rule] }) },
          { toolName: "bash", args: { command }, readOnly: false },
        ).behavior,
        command,
      ).toBe("allow");
    }
  });

  it("bash：回车是命令内容而不是可忽略外层空白", () => {
    const command = "echo\r";
    const view = buildPermissionView(confirmOf("bash", { command }));
    const scoped = view.options.find((option) => option.value === "yes-prefix");
    expect(scoped?.input?.value).toBe(command);

    const updates = scoped!.input!.buildUpdates(scoped!.input!.value);
    expect(updates).toEqual([
      { type: "addRule", list: "allow", rule: `bash(${command})`, destination: "localSettings" },
    ]);
    const update = updates[0];
    if (update.type !== "addRule") throw new Error("expected addRule update");
    expect(
      evaluatePermission(
        { mode: "default", rules: normalizeRules({ allow: [update.rule] }) },
        { toolName: "bash", args: { command }, readOnly: false },
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission(
        { mode: "default", rules: normalizeRules({ allow: ["bash(echo)"] }) },
        { toolName: "bash", args: { command }, readOnly: false },
      ).behavior,
    ).toBe("ask");
  });

  it("bash：解释器安全询问不提供无法生效的持久化选项", () => {
    const command = "node -e 'console.log(1)'";
    const verdict = evaluatePermission(
      { mode: "bypassPermissions", rules: normalizeRules({ allow: [`bash(${command})`] }) },
      { toolName: "bash", args: { command }, readOnly: false },
    );
    expect(verdict.behavior).toBe("ask");
    if (verdict.behavior !== "ask") return;

    const view = buildPermissionView(confirmOf("bash", { command }, verdict));
    expect(view.options.map((option) => option.value)).toEqual(["yes", "no"]);
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
    expect(view.options.map((option) => option.value)).toEqual(["yes", "no"]);
    expect(view.options.every((option) => option.updates === undefined || option.updates.length === 0))
      .toBe(true);
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

  it("权限对话框在添加 ANSI 前净化模型控制的命令、diff、路径、工具名和参数", () => {
    const poison = "before\x1b]52;c;YXR0YWNr\x07\x1b[31m\x9b31m\x9d8;;evil\x9c\x7fafter";
    const views = [
      buildPermissionView(confirmOf("bash", { command: `echo ${poison}` })),
      buildPermissionView(
        confirmOf("write_file", { path: `${poison}.txt`, content: `content ${poison}` }),
      ),
      buildPermissionView(confirmOf(`mcp__external__${poison}`, { value: poison })),
    ];

    for (const view of views) {
      const rendered = [
        view.title,
        view.subtitle ?? "",
        view.preview,
        view.question,
        ...view.options.map(
          (option) => `${option.label}${option.input?.displayValue ?? option.input?.value ?? ""}`,
        ),
      ].join("\n");
      expect(rendered).not.toContain("\x1b]52;");
      expect(rendered).not.toContain("\x1b[31m");
      expect(rendered).not.toMatch(/[\x7f-\x9f]/);
      expect(rendered).toContain("before");
      expect(rendered).toContain("after");
    }
  });

  it("单行权限字段剥离 LF/tab，同时 Bash 规则保留独立语义原值", () => {
    const command = "echo ok\n2. forged option\t--danger";
    const bash = buildPermissionView(confirmOf("bash", { command }));
    const scoped = bash.options.find((option) => option.value === "yes-prefix");

    expect(scoped?.input?.value).toBe(command);
    expect(scoped?.input?.displayValue).toBe("echo ok2. forged option--danger");
    expect(scoped!.input!.buildUpdates(scoped!.input!.value)).toEqual([
      {
        type: "addRule",
        list: "allow",
        rule: `bash(${command})`,
        destination: "localSettings",
      },
    ]);
    expect(bash.preview).toContain("echo ok\n2. forged option\t--danger");

    const rule = buildPermissionView(
      confirmOf("bash", { command: "echo ok" }, {
        behavior: "ask",
        reason: { type: "rule", rule: "bash(echo:*)\n2. forged\trow", list: "ask" },
      }),
    );
    const safety = buildPermissionView(
      confirmOf("bash", { command: "echo ok" }, {
        behavior: "ask",
        reason: { type: "safety", path: ".git\n2. forged\trow" },
      }),
    );
    expect(rule.explanation).not.toMatch(/[\n\t]/);
    expect(safety.warning).not.toMatch(/[\n\t]/);
  });
});
