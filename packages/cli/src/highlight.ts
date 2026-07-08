/**
 * 语法高亮 —— 纯函数，输入 markdown 风格文本，输出 ANSI 上色字符串
 *
 * 不引入 highlight.js 之类的重型库：终端里够用的高亮只需要三类信息 ——
 * 注释（暗）、字符串（黄）、关键字（品红），加上 diff 的红删绿增。
 * 覆盖不了的语言按普通文本渲染，永远不会出错。
 */
import { color } from "./ui.js";

// ── 语言定义 ────────────────────────────────────────────────
interface LangDef {
  /** 单行注释前缀（正则片段） */
  lineComment?: string;
  keywords: Set<string>;
}

const JS_KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "class", "extends", "new", "import", "export", "from", "default", "async",
  "await", "try", "catch", "finally", "throw", "switch", "case", "break",
  "continue", "typeof", "instanceof", "in", "of", "this", "null", "undefined",
  "true", "false", "yield", "static", "get", "set", "interface", "type",
  "enum", "namespace", "readonly", "public", "private", "protected", "as",
]);

const PY_KEYWORDS = new Set([
  "def", "class", "return", "if", "elif", "else", "for", "while", "import",
  "from", "as", "try", "except", "finally", "raise", "with", "lambda",
  "yield", "async", "await", "pass", "break", "continue", "global", "None",
  "True", "False", "and", "or", "not", "in", "is", "assert", "del",
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while",
  "case", "esac", "function", "return", "export", "local", "echo", "exit",
]);

const RUST_GO_KEYWORDS = new Set([
  "fn", "let", "mut", "pub", "impl", "struct", "enum", "trait", "match",
  "use", "mod", "crate", "func", "package", "go", "defer", "chan", "map",
  "range", "var", "const", "type", "interface", "return", "if", "else",
  "for", "while", "break", "continue", "true", "false", "nil", "self",
]);

const LANGS: Record<string, LangDef> = {
  js: { lineComment: "//", keywords: JS_KEYWORDS },
  jsx: { lineComment: "//", keywords: JS_KEYWORDS },
  ts: { lineComment: "//", keywords: JS_KEYWORDS },
  tsx: { lineComment: "//", keywords: JS_KEYWORDS },
  javascript: { lineComment: "//", keywords: JS_KEYWORDS },
  typescript: { lineComment: "//", keywords: JS_KEYWORDS },
  json: { keywords: new Set(["true", "false", "null"]) },
  py: { lineComment: "#", keywords: PY_KEYWORDS },
  python: { lineComment: "#", keywords: PY_KEYWORDS },
  sh: { lineComment: "#", keywords: SH_KEYWORDS },
  bash: { lineComment: "#", keywords: SH_KEYWORDS },
  shell: { lineComment: "#", keywords: SH_KEYWORDS },
  zsh: { lineComment: "#", keywords: SH_KEYWORDS },
  yaml: { lineComment: "#", keywords: new Set(["true", "false", "null"]) },
  yml: { lineComment: "#", keywords: new Set(["true", "false", "null"]) },
  toml: { lineComment: "#", keywords: new Set(["true", "false"]) },
  rust: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
  rs: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
  go: { lineComment: "//", keywords: RUST_GO_KEYWORDS },
};

// ── 单行代码高亮 ────────────────────────────────────────────
// 顺序：先摘出注释，再在剩余部分染字符串，最后染关键字。
// 用占位符避免二次匹配污染（关键字正则不会命中已含 ANSI 码的片段，
// 但字符串里的关键字会 —— 所以字符串先行）。
export function highlightCodeLine(line: string, lang: LangDef): string {
  let comment = "";
  let code = line;
  if (lang.lineComment) {
    // 注意不能把字符串里的 // 当注释（如 "http://"）——简单启发：
    // 注释前缀之前的引号数为偶数才算注释
    const idx = findCommentStart(line, lang.lineComment);
    if (idx !== -1) {
      comment = color.dim(line.slice(idx));
      code = line.slice(0, idx);
    }
  }

  // 字符串染色，同时保护其内容不参与关键字匹配
  const parts: string[] = [];
  const strRe = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0;
  for (const m of code.matchAll(strRe)) {
    parts.push(highlightKeywords(code.slice(last, m.index), lang.keywords));
    parts.push(color.yellow(m[0]));
    last = m.index + m[0].length;
  }
  parts.push(highlightKeywords(code.slice(last), lang.keywords));
  return parts.join("") + comment;
}

function findCommentStart(line: string, prefix: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (line.startsWith(prefix, i)) {
      return i;
    }
  }
  return -1;
}

function highlightKeywords(text: string, keywords: Set<string>): string {
  return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) =>
    keywords.has(w) ? color.magenta(w) : w,
  );
}

/** diff 行：+ 绿 / - 红 / @@ 青，其余原样 */
export function highlightDiffLine(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return color.green(line);
  if (line.startsWith("-") && !line.startsWith("---")) return color.red(line);
  if (line.startsWith("@@")) return color.cyan(line);
  return line;
}

// ── Markdown 渲染 ───────────────────────────────────────────
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

function renderInline(line: string): string {
  return line
    .replace(INLINE_CODE_RE, (_, code) => color.cyan(code))
    .replace(BOLD_RE, (_, text) => color.bold(text));
}

/**
 * 把 markdown 风格文本渲染为 ANSI 字符串：
 * - fenced code block：边框暗色，代码按语言高亮，diff 红绿
 * - 标题（#）加粗，inline `code` 青色，**bold** 加粗
 * 未闭合的 fence（流式输出中常见）按已开启的代码块渲染。
 */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let fenceLang: LangDef | null = null;
  let fenceIsDiff = false;

  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        const tag = fence[1].toLowerCase();
        fenceIsDiff = tag === "diff" || tag === "patch";
        fenceLang = LANGS[tag] ?? null;
      } else {
        inFence = false;
      }
      out.push(color.dim(line));
      continue;
    }

    if (inFence) {
      if (fenceIsDiff) out.push(highlightDiffLine(line));
      else if (fenceLang) out.push(highlightCodeLine(line, fenceLang));
      else out.push(line);
      continue;
    }

    if (/^\s*#{1,6}\s/.test(line)) {
      out.push(color.bold(renderInline(line)));
    } else {
      out.push(renderInline(line));
    }
  }
  return out.join("\n");
}
