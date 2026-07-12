import {describe, expect, it} from "vitest";
import {measureText} from "../../src/tui/input/measured-text.js";
import {TextBuffer} from "../../src/tui/input/text-buffer.js";

describe("measureText", () => {
  it("wraps before a wide grapheme without splitting it", () => {
    const measured = measureText(TextBuffer.from("ab你c"), 2);

    expect(measured.rows).toEqual([
      {start: 0, end: 2, width: 2, hardBreak: false},
      {start: 2, end: 3, width: 2, hardBreak: false},
      {start: 3, end: 4, width: 1, hardBreak: false},
    ]);
  });

  it("creates a distinct hard row for every newline", () => {
    const measured = measureText(TextBuffer.from("a\n\nb"), 10);

    expect(measured.rows).toEqual([
      {start: 0, end: 1, width: 1, hardBreak: true},
      {start: 2, end: 2, width: 0, hardBreak: true},
      {start: 3, end: 4, width: 1, hardBreak: false},
    ]);
  });

  it("exposes only whole-cluster offsets for a ZWJ emoji", () => {
    const family = "👨‍👩‍👧‍👦";
    const measured = measureText(TextBuffer.from(family), 2);

    expect(measured.rows).toEqual([
      {start: 0, end: family.length, width: 2, hardBreak: false},
    ]);
    expect(measured.offsetAt(0, 0)).toBe(0);
    expect(measured.offsetAt(0, 1)).toBe(0);
    expect(measured.offsetAt(0, 2)).toBe(family.length);
  });

  it("chooses the nearest grapheme boundary on a shorter row", () => {
    const measured = measureText(TextBuffer.from("abcd\n你"), 10);

    expect(measured.offsetAt(1, 4)).toBe("abcd\n你".length);
    expect(measured.offsetAt(1, Number.POSITIVE_INFINITY)).toBe("abcd\n你".length);
  });

  it("places a cursor at the start of the later soft-wrapped row", () => {
    const buffer = TextBuffer.from("ab你c", 2);

    expect(measureText(buffer, 2).cursor).toEqual({row: 1, column: 0});
  });

  it("clamps editable width to two cells", () => {
    expect(measureText(TextBuffer.from("你a"), 0).rows).toEqual([
      {start: 0, end: 1, width: 2, hardBreak: false},
      {start: 1, end: 2, width: 1, hardBreak: false},
    ]);
  });

  it("places an over-wide grapheme on a row by itself", () => {
    const grapheme = "ᄀ가";
    const buffer = TextBuffer.from(`${grapheme}a`);

    expect(measureText(buffer, 2).rows).toEqual([
      {start: 0, end: buffer.text.length - 1, width: 4, hardBreak: false},
      {
        start: buffer.text.length - 1,
        end: buffer.text.length,
        width: 1,
        hardBreak: false,
      },
    ]);
  });
});
