import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

function parseContentRule(rule: string): { tool: string; pattern: string } | undefined {
  const match = /^([^()]+)\(([\s\S]*)\)$/.exec(rule);
  return match === null ? undefined : { tool: match[1], pattern: match[2] };
}

function normalizeBashOuterWhitespace(command: string): string {
  return command.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
}

type BashToken = { kind: "word" | "operator"; value: string };

interface BashAnalysis {
  tokens: BashToken[];
  simpleWords: string[] | null;
  commandCandidates: string[][];
}

const CONTROL_OPERATORS = new Set(["&&", "||", ";", "|", "&", "\n", "(", ")"]);
const SHELL_RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
]);
const COMMAND_WRAPPERS = new Set([
  "time",
  "env",
  "command",
  "builtin",
  "exec",
  "sudo",
  "nohup",
  "nice",
  "xargs",
  "arch",
]);

function shellCommandName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?\+?=/.test(word);
}

function commandStartIndex(words: string[], from: number): number {
  let index = from;
  while (
    index < words.length &&
    (words[index] === "!" ||
      SHELL_RESERVED_WORDS.has(words[index]) ||
      isShellAssignment(words[index]))
  ) {
    index += 1;
  }
  return index;
}

function tokenizeBash(command: string): { tokens: BashToken[]; unsafe: boolean } {
  const tokens: BashToken[] = [];
  let word = "";
  let wordStarted = false;
  let unsafe = false;

  const pushWord = () => {
    if (!wordStarted) return;
    tokens.push({ kind: "word", value: word });
    word = "";
    wordStarted = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (char === " " || char === "\t") {
      pushWord();
      continue;
    }
    if (char === "\n") {
      pushWord();
      tokens.push({ kind: "operator", value: "\n" });
      unsafe = true;
      continue;
    }
    if (char === "'" || char === '"') {
      wordStarted = true;
      const quote = char;
      let closed = false;
      for (i += 1; i < command.length; i += 1) {
        const quoted = command[i];
        if (quoted === quote) {
          closed = true;
          break;
        }
        if (quote === '"' && (quoted === "$" || quoted === "`" || quoted === "\\")) {
          unsafe = true;
        }
        word += quoted;
      }
      if (!closed) unsafe = true;
      continue;
    }
    if (char === "\\") {
      wordStarted = true;
      unsafe = true;
      if (i + 1 < command.length) word += command[(i += 1)];
      continue;
    }
    if (";&|<>()".includes(char)) {
      pushWord();
      const pair = command.slice(i, i + 2);
      const operator =
        pair === "&&" || pair === "||" || pair === ">>" || pair === "<<" ? pair : char;
      if (operator.length === 2) i += 1;
      tokens.push({ kind: "operator", value: operator });
      unsafe = true;
      continue;
    }
    if (char === "#" && !wordStarted) {
      unsafe = true;
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (
      char === "$" ||
      char === "`" ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      char === "{"
    ) {
      unsafe = true;
    }
    wordStarted = true;
    word += char;
  }
  pushWord();
  return { tokens, unsafe };
}

function optionValueIndex(words: string[], index: number, optionsWithValue: Set<string>): number {
  const option = words[index];
  if (!option.startsWith("-") || option === "-") return index;
  if (option === "--") return index + 1;
  if (optionsWithValue.has(option)) return index + 2;
  return index + 1;
}

function wrappedCommandIndex(words: string[], index: number, wrapper: string): number | null {
  let next = index + 1;
  if (wrapper === "env") {
    while (next < words.length && words[next].startsWith("-")) {
      next = optionValueIndex(words, next, new Set(["-u", "--unset", "-C", "--chdir"]));
    }
    while (next < words.length && isShellAssignment(words[next])) next += 1;
    return next < words.length ? next : null;
  }
  if (wrapper === "command") {
    if (words.slice(next).some((word) => word === "-v" || word === "-V")) return null;
    while (next < words.length && words[next].startsWith("-")) next += 1;
    return next < words.length ? next : null;
  }
  if (wrapper === "sudo") {
    const optionsWithValue = new Set([
      "-C",
      "--close-from",
      "-D",
      "--chdir",
      "-g",
      "--group",
      "-h",
      "--host",
      "-p",
      "--prompt",
      "-R",
      "--chroot",
      "-r",
      "--role",
      "-t",
      "--type",
      "-T",
      "--command-timeout",
      "-u",
      "--user",
    ]);
    while (next < words.length && words[next].startsWith("-")) {
      next = optionValueIndex(words, next, optionsWithValue);
    }
    return next < words.length ? next : null;
  }
  if (wrapper === "nice") {
    if (words[next] === "-n" || words[next] === "--adjustment") next += 2;
    else if (words[next]?.startsWith("--adjustment=") || /^-(?:n)?\d+$/.test(words[next] ?? "")) {
      next += 1;
    }
    return next < words.length ? next : null;
  }
  if (wrapper === "time") {
    const optionsWithValue = new Set(["-f", "--format", "-o", "--output"]);
    while (next < words.length && words[next].startsWith("-")) {
      next = optionValueIndex(words, next, optionsWithValue);
    }
    return next < words.length ? next : null;
  }
  if (wrapper === "xargs") {
    const optionsWithValue = new Set([
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "--eof",
      "-I",
      "--replace",
      "-L",
      "--max-lines",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
    ]);
    while (next < words.length && words[next].startsWith("-")) {
      next = optionValueIndex(words, next, optionsWithValue);
    }
    return next < words.length ? next : null;
  }
  if (wrapper === "arch") {
    const optionsWithValue = new Set(["-arch", "--arch", "-d", "-e"]);
    while (next < words.length && words[next].startsWith("-")) {
      next = optionValueIndex(words, next, optionsWithValue);
    }
    return next < words.length ? next : null;
  }
  if (wrapper === "exec" && words[next] === "-a") next += 2;
  while (next < words.length && words[next].startsWith("-")) next += 1;
  return next < words.length ? next : null;
}

function commandCandidates(tokens: BashToken[]): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];
  for (const token of tokens) {
    if (token.kind === "operator" && CONTROL_OPERATORS.has(token.value)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    } else if (token.kind === "word") {
      segment.push(token.value);
    }
  }
  if (segment.length > 0) segments.push(segment);

  const candidates: string[][] = [];
  for (const words of segments) {
    let index = commandStartIndex(words, 0);
    const seen = new Set<number>();
    while (index < words.length && !seen.has(index)) {
      seen.add(index);
      const normalized = [...words.slice(index)];
      normalized[0] = shellCommandName(normalized[0]);
      candidates.push(normalized);
      const wrapper = normalized[0];
      if (!COMMAND_WRAPPERS.has(wrapper)) break;
      const nested = wrappedCommandIndex(words, index, wrapper);
      if (nested === null || nested <= index) break;
      index = commandStartIndex(words, nested);
    }
  }
  return candidates;
}

/**
 * Ordinary quoted words are safe to compare. Anything that changes command
 * boundaries or executable selection remains analyzable for deny/ask, but is
 * never eligible for prefix authorization.
 */
function analyzeBash(command: string): BashAnalysis {
  const { tokens, unsafe } = tokenizeBash(command);
  const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
  const first = words[0];
  const simpleWords =
    !unsafe &&
    tokens.length > 0 &&
    tokens.every((token) => token.kind === "word") &&
    first !== undefined &&
    first !== "!" &&
    !isShellAssignment(first) &&
    !SHELL_RESERVED_WORDS.has(first) &&
    !COMMAND_WRAPPERS.has(shellCommandName(first)) &&
    !first.includes("/")
      ? words
      : null;
  return { tokens, simpleWords, commandCandidates: commandCandidates(tokens) };
}

function wordsStartWith(words: string[], prefix: string[]): boolean {
  return (
    prefix.length > 0 &&
    prefix.length <= words.length &&
    prefix.every((word, i) => words[i] === word)
  );
}

function bashPrefixMatches(prefix: string, command: string): boolean {
  const prefixWords = analyzeBash(prefix).simpleWords;
  const commandWords = analyzeBash(command).simpleWords;
  return prefixWords !== null && commandWords !== null && wordsStartWith(commandWords, prefixWords);
}

/** Deny/ask inspect visible executable positions even when allow cannot prove simplicity. */
function bashPrefixMayMatch(rule: string, command: string): boolean {
  const parsed = parseContentRule(rule);
  const prefix =
    parsed?.tool === "bash" && parsed.pattern.endsWith(":*")
      ? parsed.pattern.slice(0, -2)
      : undefined;
  const prefixWords = prefix === undefined ? null : analyzeBash(prefix).simpleWords;
  if (prefixWords === null) return false;
  return analyzeBash(command).commandCandidates.some((candidate) =>
    wordsStartWith(candidate, prefixWords),
  );
}

function splitPathSegments(value: string): string[] {
  const separator = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  return value.split(separator).filter((segment) => segment !== "");
}

function foldMissingPath(current: string, segments: string[]): string {
  let folded = current;
  for (const segment of segments) {
    if (segment === ".") continue;
    folded = segment === ".." ? dirname(folded) : join(folded, segment);
  }
  return folded;
}

function canonicalPath(value: string): string | undefined {
  const initial = parse(value);
  let current: string;
  let pending: string[];

  try {
    if (isAbsolute(value)) {
      current = realpathSync.native(initial.root);
      pending = splitPathSegments(value.slice(initial.root.length));
    } else {
      current = realpathSync.native(process.cwd());
      pending = splitPathSegments(value);
    }
  } catch {
    return undefined;
  }

  let followedLinks = 0;
  const missing: string[] = [];
  while (pending.length > 0) {
    const segment = pending.shift()!;
    if (segment === ".") continue;
    if (segment === "..") {
      if (missing.length > 0) missing.pop();
      else current = dirname(current);
      continue;
    }
    if (missing.length > 0) {
      missing.push(segment);
      continue;
    }

    const candidate = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return undefined;
      missing.push(segment);
      continue;
    }

    if (!stat.isSymbolicLink()) {
      if (pending.length > 0 && !stat.isDirectory()) return undefined;
      try {
        current = realpathSync.native(candidate);
      } catch {
        return undefined;
      }
      continue;
    }

    followedLinks += 1;
    if (followedLinks > 40) return undefined;
    try {
      const target = readlinkSync(candidate);
      if (!isAbsolute(target)) {
        pending.unshift(...splitPathSegments(target));
        continue;
      }

      const targetRoot = parse(target).root;
      try {
        current = realpathSync.native(targetRoot);
      } catch {
        return undefined;
      }
      pending.unshift(...splitPathSegments(target.slice(targetRoot.length)));
    } catch {
      return undefined;
    }
  }
  return missing.length === 0 ? current : foldMissingPath(current, missing);
}

function pathIsDescendant(prefix: string, content: string): boolean {
  const fromBase = relative(prefix, content);
  return (
    fromBase !== "" &&
    fromBase !== ".." &&
    !fromBase.startsWith(`..${sep}`) &&
    !isAbsolute(fromBase)
  );
}

function pathPrefixMatches(prefix: string, content: string, conservative: boolean): boolean {
  if (!prefix || !content) return false;
  const lexicalPrefix = resolve(prefix);
  const lexicalContent = resolve(content);
  const realPrefix = canonicalPath(prefix);
  const realContent = canonicalPath(content);
  const canonicalMatch =
    realPrefix !== undefined &&
    realContent !== undefined &&
    pathIsDescendant(realPrefix, realContent);
  return canonicalMatch || (conservative && pathIsDescendant(lexicalPrefix, lexicalContent));
}

function ruleMatchesWithPolicy(
  rule: string,
  toolName: string,
  args?: Record<string, unknown>,
  conservativePaths = false,
): boolean {
  const parsed = parseContentRule(rule);
  if (!parsed) {
    // 工具级：精确 或 前缀通配
    if (rule === toolName) return true;
    return rule.endsWith("*") && toolName.startsWith(rule.slice(0, -1));
  }
  // 内容级：工具名必须精确，内容精确或 "前缀:*"
  const { tool, pattern } = parsed;
  if (tool !== toolName || !args) return false;
  const content = contentOf(toolName, args);
  if (content === undefined) return false;
  if (toolName === "bash") {
    if (pattern.endsWith(":*")) return bashPrefixMatches(pattern.slice(0, -2), content);
    return normalizeBashOuterWhitespace(content) === normalizeBashOuterWhitespace(pattern);
  }
  if (pattern.endsWith(":*")) {
    return pathPrefixMatches(pattern.slice(0, -2), content, conservativePaths);
  }
  const realContent = canonicalPath(content);
  const realPattern = canonicalPath(pattern);
  const canonicalMatch =
    realContent !== undefined && realPattern !== undefined && realContent === realPattern;
  return canonicalMatch || (conservativePaths && resolve(content) === resolve(pattern));
}

/** 单条规则是否命中（工具级 or 内容级）；文件 scope 使用授权所需的真实路径语义。 */
export function ruleMatches(
  rule: string,
  toolName: string,
  args?: Record<string, unknown>,
): boolean {
  return ruleMatchesWithPolicy(rule, toolName, args);
}

function findMatch(
  rules: string[],
  toolName: string,
  args: Record<string, unknown>,
  list: keyof PermissionRules,
): string | undefined {
  const direct = rules.find((rule) =>
    ruleMatchesWithPolicy(rule, toolName, args, list !== "allow"),
  );
  if (direct || toolName !== "bash" || typeof args.command !== "string") return direct;
  const command = args.command;

  if (list !== "allow") {
    return rules.find((rule) => bashPrefixMayMatch(rule, command));
  }
  return undefined;
}

function hasExactBashContentRule(rules: string[], command: string): boolean {
  const normalizedCommand = normalizeBashOuterWhitespace(command);
  return rules.some((rule) => {
    const parsed = parseContentRule(rule);
    return (
      parsed?.tool === "bash" &&
      !parsed.pattern.endsWith(":*") &&
      normalizeBashOuterWhitespace(parsed.pattern) === normalizedCommand
    );
  });
}

// ── safetyCheck：敏感路径 ─────────────────────────────────

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
const SENSITIVE_DIRECTORY_NAMES = new Set([".git", ".transup"]);
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
]);
const INDIRECT_WRAPPERS = new Set([
  "eval",
  "source",
  ".",
  "command",
  "builtin",
  "env",
  "sudo",
  "nohup",
  "xargs",
  "exec",
]);

function sensitivePathName(path: string): string | undefined {
  const resolved = resolve(path);
  const segments = resolved.split(sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const sensitiveDirectory = segments.find((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment));
  if (sensitiveDirectory) return sensitiveDirectory;
  const base = basename(resolved).toLowerCase();
  return SENSITIVE_BASENAMES.includes(base) ? base : undefined;
}

function sensitiveLiteralName(source: string): string | undefined {
  const dequoted = source.replace(/["']/g, "").toLowerCase();
  const isNameCharacter = (char: string | undefined) =>
    char !== undefined && /[A-Za-z0-9_.-]/.test(char);

  for (const name of SENSITIVE_BASENAMES) {
    let from = 0;
    for (;;) {
      const index = dequoted.indexOf(name, from);
      if (index === -1) break;
      const before = index === 0 ? undefined : dequoted[index - 1];
      const after = dequoted[index + name.length];
      if (!isNameCharacter(before) && !isNameCharacter(after)) return name;
      from = index + name.length;
    }
  }
  return undefined;
}

function interpreterSafetyTarget(command: string): string | undefined {
  const analysis = analyzeBash(command);
  for (const candidate of analysis.commandCandidates) {
    const [interpreter, ...args] = candidate;
    if (SHELL_INTERPRETERS.has(interpreter)) return "shell interpreter";
    if (/^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
      if (args.some((arg) => /^-[^-]*c/.test(arg))) return "interpreter execution";
    } else if (/^(?:node|nodejs)(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
      if (
        args.some(
          (arg) =>
            arg.startsWith("-e") ||
            arg.startsWith("-p") ||
            arg === "--eval" ||
            arg.startsWith("--eval=") ||
            arg === "--print" ||
            arg.startsWith("--print="),
        )
      ) {
        return "interpreter execution";
      }
    } else if (/^(?:perl|ruby)(?:\d+(?:\.\d+)*)?$/.test(interpreter)) {
      if (args.some((arg) => /^-[^-]*[eEc]/.test(arg))) return "interpreter execution";
    }
  }
  return undefined;
}

function sensitiveShellTarget(command: string): string | undefined {
  const literal = sensitiveLiteralName(command);
  if (literal) return literal;

  const dequoted = command.replace(/["']/g, "");
  // `git config` can write repository, global, or system configuration. Without
  // fully parsing its flags, every invocation stays behind an explicit ask.
  if (/\bgit\b[^\n;&|]*\bconfig\b/.test(dequoted)) return "git config";

  // Expansion and indirect shell execution can construct a sensitive target
  // that is absent from the literal command. Fail closed rather than guessing.
  if (/[$`*?\\]|\[[^\]]*\]|\{[^}]*\}|(?:<|>)\(|<<<?/.test(command)) {
    return "shell expansion";
  }
  const interpreter = interpreterSafetyTarget(command);
  if (interpreter) return interpreter;

  const hasIndirectWrapper = analyzeBash(command).commandCandidates.some(([name]) =>
    INDIRECT_WRAPPERS.has(name),
  );
  if (hasIndirectWrapper) {
    return "shell indirection";
  }
  return undefined;
}

/** 写操作是否触碰敏感路径；命中返回引发警报的那个片段 */
function sensitiveTarget(toolName: string, args: Record<string, unknown>): string | undefined {
  if (toolName === "bash" && typeof args.command === "string") {
    const shellTarget = sensitiveShellTarget(args.command);
    if (shellTarget) return shellTarget;
  }
  if (typeof args.path !== "string") return undefined;
  const lexical = sensitivePathName(args.path);
  if (lexical) return lexical;
  const real = canonicalPath(args.path);
  return real === undefined ? undefined : sensitivePathName(real);
}

// ── 判定主函数 ────────────────────────────────────────────

const EDIT_TOOLS = new Set(["edit_file", "write_file"]);

export function evaluatePermission(
  ctx: ToolPermissionContext,
  query: PermissionQuery,
): PermissionVerdict {
  const { toolName, args, readOnly } = query;

  const denyRule = findMatch(ctx.rules.deny, toolName, args, "deny");
  if (denyRule) {
    return {
      behavior: "deny",
      reason: { type: "rule", rule: denyRule, list: "deny" },
      message: `权限规则 ${denyRule} 禁止此调用。请换一种方式完成任务，或请用户调整规则。`,
    };
  }

  const askRule = findMatch(ctx.rules.ask, toolName, args, "ask");
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

  if (
    toolName === "bash" &&
    typeof args.command === "string" &&
    analyzeBash(args.command).simpleWords === null &&
    !hasExactBashContentRule(ctx.rules.allow, args.command)
  ) {
    return { behavior: "ask", reason: { type: "default" } };
  }

  if (ctx.mode === "bypassPermissions") {
    return { behavior: "allow", reason: { type: "mode", mode: "bypassPermissions" } };
  }
  if (ctx.mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { behavior: "allow", reason: { type: "mode", mode: "acceptEdits" } };
  }

  const allowRule = findMatch(ctx.rules.allow, toolName, args, "allow");
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
  const trimmed = normalizeBashOuterWhitespace(command);
  const words = analyzeBash(command).simpleWords;
  if (words === null) return trimmed;
  if (words.length <= 1) return trimmed;
  const second = words[1];
  const prefixWords =
    second.startsWith("-") || second.includes("/") ? [words[0]] : words.slice(0, 2);
  if (!prefixWords.every((word) => /^[A-Za-z0-9_@%+=:,.-]+$/.test(word))) return trimmed;
  const prefix = prefixWords.join(" ");
  return bashPrefixMatches(prefix, command) ? prefix : trimmed;
}

/** 由前缀生成 bash 内容规则："npm run" → "bash(npm run:*)"；整条命令 → 精确规则 */
export function bashPrefixRule(command: string, requestedPrefix = commandPrefix(command)): string {
  const trimmed = normalizeBashOuterWhitespace(command);
  const prefix = normalizeBashOuterWhitespace(requestedPrefix);
  return prefix !== trimmed && bashPrefixMatches(prefix, command)
    ? `bash(${prefix}:*)`
    : `bash(${trimmed})`;
}
