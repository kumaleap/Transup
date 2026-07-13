/** 权限判定：规则匹配、优先级链、模式循环、bash 前缀启发 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

  it("Bash 前缀规则只授权单个简单命令，复合命令需要整条精确规则", () => {
    expect(ruleMatches("bash(npm run:*)", "bash", { command: "npm runner" })).toBe(false);
    expect(
      ruleMatches("bash(npm run:*)", "bash", { command: "npm run build && rm -rf dist" }),
    ).toBe(false);

    const compound = {
      toolName: "bash",
      args: { command: "npm run build && echo done" },
      readOnly: false,
    };
    expect(
      evaluatePermission(
        ctx({ rules: rules({ allow: ["bash(npm run:*)"] }) }),
        compound,
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        ctx({
          rules: rules({ allow: ["bash(npm run:*)", "bash(echo:*)"] }),
        }),
        compound,
      ).behavior,
    ).toBe("ask");
    expect(
      evaluatePermission(
        ctx({
          rules: rules({ allow: ["bash(npm run build && echo done)"] }),
        }),
        compound,
      ).behavior,
    ).toBe("allow");
    expect(
      evaluatePermission(
        ctx({
          mode: "bypassPermissions",
          rules: rules({ deny: ["bash(rm:*)"] }),
        }),
        { ...compound, args: { command: "echo ok && rm -rf dist" } },
      ).behavior,
    ).toBe("deny");
    for (const command of ['echo ok && rm -rf "dist"', "rm -rf dist > /tmp/rm.log"]) {
      expect(
        evaluatePermission(
          ctx({
            mode: "bypassPermissions",
            rules: rules({ deny: ["bash(rm:*)"] }),
          }),
          { ...compound, args: { command } },
        ).behavior,
        command,
      ).toBe("deny");
    }
  });

  it("Bash deny/ask 前缀识别否定、包装器、赋值、绝对路径和条件分支中的命令", () => {
    const concealedCommands = [
      "! rm -rf dist",
      "time rm -rf dist",
      "time ! rm -rf dist",
      "FOO=x rm -rf dist",
      "FOO+=x rm -rf dist",
      "FOO[0]=x rm -rf dist",
      "/bin/rm -rf dist",
      "if test -d dist; then rm -rf dist; fi",
      "env FOO=x rm -rf dist",
      "command rm -rf dist",
      "exec rm -rf dist",
      "sudo rm -rf dist",
      "nohup rm -rf dist",
      "nice rm -rf dist",
      "nice -n5 rm -rf dist",
      "time -f elapsed:%E rm -rf dist",
      "arch -arm64 rm -rf dist",
      "printf dist | xargs rm -rf",
    ];

    for (const list of ["deny", "ask"] as const) {
      for (const command of concealedCommands) {
        const verdict = evaluatePermission(
          ctx({
            mode: "bypassPermissions",
            rules: rules({ [list]: ["bash(rm:*)"] }),
          }),
          { toolName: "bash", args: { command }, readOnly: false },
        );
        expect(verdict.behavior, `${list}: ${command}`).toBe(list);
        expect(verdict.reason.type, `${list}: ${command}`).toBe("rule");
      }
    }
  });

  it("引号内的普通参数仍可由 Bash 前缀规则授权", () => {
    expect(ruleMatches("bash(npm run:*)", "bash", { command: 'npm run "build"' })).toBe(true);
  });

  it("内容级：文件工具匹配路径", () => {
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src/a.ts" })).toBe(true);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "test/a.ts" })).toBe(false);
    // 工具名不同不串台
    expect(ruleMatches("edit_file(src/:*)", "write_file", { path: "src/a.ts" })).toBe(false);
  });

  it("文件前缀规则按规范化目录边界匹配，拒绝遍历和相邻前缀", () => {
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "./src/a.ts" })).toBe(true);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src\\a.ts" })).toBe(
      sep === "\\",
    );
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src/lib/../a.ts" })).toBe(true);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src/../../outside.ts" })).toBe(false);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src/../src-private/a.ts" })).toBe(false);
    expect(ruleMatches("edit_file(src/:*)", "edit_file", { path: "src-other/a.ts" })).toBe(false);

    const alternateSpelling = {
      toolName: "edit_file",
      args: { path: "./src/a.ts" },
      readOnly: false,
    };
    expect(
      evaluatePermission(
        ctx({
          mode: "bypassPermissions",
          rules: rules({ deny: ["edit_file(src/:*)"] }),
        }),
        alternateSpelling,
      ).behavior,
    ).toBe("deny");
  });

  it("文件 allow 前缀不跟随逃出授权目录的符号链接", () => {
    const root = mkdtempSync(join(tmpdir(), "transup-permission-path-"));
    try {
      const source = join(root, "src");
      const outside = join(root, "outside");
      mkdirSync(source);
      mkdirSync(outside);
      writeFileSync(join(outside, "existing.txt"), "outside");
      writeFileSync(join(root, "escaped.txt"), "outside via symlink parent");
      symlinkSync(outside, join(source, "link"), "dir");
      const rule = `edit_file(${source}${sep}:*)`;

      for (const path of [
        join(source, "link", "existing.txt"),
        join(source, "link", "new", "file.txt"),
        `${source}${sep}link${sep}..${sep}escaped.txt`,
        `${source}${sep}link${sep}..${sep}future.txt`,
      ]) {
        expect(ruleMatches(rule, "edit_file", { path }), path).toBe(false);
        expect(
          evaluatePermission(
            ctx({ rules: rules({ allow: [rule] }) }),
            { toolName: "edit_file", args: { path }, readOnly: false },
          ).behavior,
          path,
        ).toBe("ask");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("文件 deny/ask 前缀同时按词法路径与真实路径保守匹配符号链接", () => {
    const root = mkdtempSync(join(tmpdir(), "transup-permission-path-"));
    try {
      const source = join(root, "src");
      const outside = join(root, "outside");
      mkdirSync(source);
      mkdirSync(outside);
      writeFileSync(join(outside, "existing.txt"), "outside");
      symlinkSync(outside, join(source, "link"), "dir");
      const lexicalRule = `edit_file(${source}${sep}:*)`;
      const canonicalRule = `edit_file(${outside}${sep}:*)`;

      for (const path of [
        join(source, "link", "existing.txt"),
        join(source, "link", "new", "file.txt"),
      ]) {
        for (const [list, expected] of [
          ["deny", "deny"],
          ["ask", "ask"],
        ] as const) {
          for (const rule of [lexicalRule, canonicalRule]) {
            expect(
              evaluatePermission(
                ctx({ mode: "bypassPermissions", rules: rules({ [list]: [rule] }) }),
                { toolName: "edit_file", args: { path }, readOnly: false },
              ).behavior,
              `${list}: ${rule} -> ${path}`,
            ).toBe(expected);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      bash("rm -rf .GIT"),
      edit(".GIT/config"),
      { toolName: "write_file", args: { path: "/Users/x/.ZSHRC" }, readOnly: false },
    ]) {
      const v = evaluatePermission(ctx({ mode: "bypassPermissions" }), q);
      expect(v.behavior).toBe("ask");
      expect(v.behavior === "ask" && v.reason.type).toBe("safety");
    }
  });

  it("safetyCheck：识别引号、展开、拼接、重定向和 git config", () => {
    for (const command of [
      'echo x > "${HOME}/.zshrc"',
      "echo x > $HOME/.bash_profile",
      'echo x > ~/.zsh""rc',
      "echo x > ~/.zsh\\rc",
      "printf x>>~/.profile",
      "git config --global core.sshCommand evil",
    ]) {
      const verdict = evaluatePermission(
        ctx({ mode: "bypassPermissions" }),
        { toolName: "bash", args: { command }, readOnly: false },
      );
      expect(verdict.behavior, command).toBe("ask");
      expect(verdict.behavior === "ask" && verdict.reason.type, command).toBe("safety");
    }
  });

  it("safetyCheck：未知展开和 shell 间接执行在 bypass 下保守询问", () => {
    for (const command of [
      'echo x > "$TARGET"',
      'eval "echo x > target"',
      'bash -c "echo x > target"',
      'sh -lc "echo x > target"',
      "cat <(echo target)",
      "command echo target",
    ]) {
      const verdict = evaluatePermission(
        ctx({ mode: "bypassPermissions" }),
        { toolName: "bash", args: { command }, readOnly: false },
      );
      expect(verdict.behavior, command).toBe("ask");
      expect(verdict.behavior === "ask" && verdict.reason.type, command).toBe("safety");
    }
  });

  it("safetyCheck：解释器代码参数、裸 shell 和管道 shell 在 bypass 下保守询问", () => {
    for (const command of [
      "node -e 'console.log(1)'",
      "node --eval='console.log(1)'",
      "node -p '1 + 1'",
      "python3 -c 'print(1)'",
      "python3 -Bc 'print(1)'",
      "python3 -Iqc 'print(1)'",
      "perl -e 'print 1'",
      "ruby -e 'puts 1'",
      "bash",
      "/bin/sh",
      "zsh script.zsh",
      "printf 'echo ok' | sh",
    ]) {
      const verdict = evaluatePermission(
        ctx({
          mode: "bypassPermissions",
          rules: rules({ allow: [`bash(${command})`] }),
        }),
        bash(command),
      );
      expect(verdict.behavior, command).toBe("ask");
      expect(verdict.behavior === "ask" && verdict.reason.type, command).toBe("safety");
    }
  });

  it("safetyCheck：代码字符串内的敏感 basename 使用语法边界而不是路径分词", () => {
    for (const [command, sensitiveName] of [
      [`python3 -c 'open("/tmp/.zshrc","w").write("x")'`, ".zshrc"],
      [`node -e 'require("fs").writeFileSync("/tmp/.bashrc","x")'`, ".bashrc"],
      [`perl -e 'open(F,">/tmp/.profile");print F "x"'`, ".profile"],
      [`ruby -e 'File.write("/tmp/.zprofile","x")'`, ".zprofile"],
    ]) {
      const verdict = evaluatePermission(ctx({ mode: "bypassPermissions" }), bash(command));
      expect(verdict.behavior, command).toBe("ask");
      expect(verdict.behavior === "ask" && verdict.reason.type, command).toBe("safety");
      expect(
        verdict.behavior === "ask" && verdict.reason.type === "safety"
          ? verdict.reason.path
          : undefined,
        command,
      ).toBe(sensitiveName);
    }

    const nonsensitiveSuffix = evaluatePermission(
      ctx({ mode: "bypassPermissions" }),
      bash("echo x > /tmp/.zshrc.bak"),
    );
    expect(nonsensitiveSuffix.behavior).toBe("ask");
    expect(nonsensitiveSuffix.reason.type).toBe("default");
  });

  it("safetyCheck：文件工具按真实路径识别指向敏感目录的符号链接", () => {
    const root = mkdtempSync(join(tmpdir(), "transup-permission-sensitive-"));
    try {
      const source = join(root, "src");
      const gitDir = join(root, ".git");
      mkdirSync(source);
      mkdirSync(gitDir);
      writeFileSync(join(gitDir, "config"), "[core]");
      symlinkSync(gitDir, join(source, "link"), "dir");

      const verdict = evaluatePermission(
        ctx({ mode: "bypassPermissions" }),
        edit(join(source, "link", "config")),
      );
      expect(verdict.behavior).toBe("ask");
      expect(verdict.behavior === "ask" && verdict.reason.type).toBe("safety");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("无法证明为单一简单命令的 Bash 调用在 bypass 下仍需确认，精确规则除外", () => {
    const command = "echo ok && printf done";
    expect(evaluatePermission(ctx({ mode: "bypassPermissions" }), bash(command)).behavior).toBe(
      "ask",
    );
    expect(
      evaluatePermission(
        ctx({ rules: rules({ allow: [`bash(${command})`] }) }),
        bash(command),
      ).behavior,
    ).toBe("allow");
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

  it("带普通引号的简单命令仍生成可复用前缀", () => {
    expect(commandPrefix('npm run "build"')).toBe("npm run");
    expect(bashPrefixRule('npm run "build"')).toBe("bash(npm run:*)");
  });
});
