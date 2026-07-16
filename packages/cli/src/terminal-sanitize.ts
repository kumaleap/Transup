export interface TerminalTextOptions {
  preserveNewlines?: boolean;
  preserveTabs?: boolean;
}

/** Provider/tool prose boundary: remove C0/C1/DEL while preserving intentional layout only. */
export function sanitizeTerminalText(
  text: string,
  options: TerminalTextOptions = {},
): string {
  const preserveNewlines = options.preserveNewlines ?? true;
  const preserveTabs = options.preserveTabs ?? true;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f) {
      if ((code === 0x0a && preserveNewlines) || (code === 0x09 && preserveTabs)) out += char;
      continue;
    }
    if (code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += char;
  }
  return out;
}

/** Diff/preview boundary: make controls inert without hiding byte-level differences. */
export function escapeTerminalControls(
  text: string,
  options: TerminalTextOptions = {},
): string {
  const preserveNewlines = options.preserveNewlines ?? true;
  const preserveTabs = options.preserveTabs ?? true;
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a && preserveNewlines) {
      out += char;
    } else if (code === 0x09 && preserveTabs) {
      out += char;
    } else if (char === "\\") {
      out += "\\\\";
    } else if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += char;
    }
  }
  return out;
}

/** Structural terminal field boundary: no control may alter the containing row. */
export function sanitizeTerminalField(text: string): string {
  return sanitizeTerminalText(text, { preserveNewlines: false, preserveTabs: false });
}
