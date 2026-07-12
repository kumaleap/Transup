import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

describe("terminal string width compatibility", () => {
  const cases = [
    ["an unqualified keycap", "1\u20e3", 2],
    ["compound Hangul jamo", "\u1100\u1100\u1161", 4],
    ["a Devanagari spacing mark", "\u0915\u093e", 2],
  ] as const;

  it.each(cases)("measures %s like Ink", (_name, value, expected) => {
    expect(stringWidth(value)).toBe(expected);
  });
});
