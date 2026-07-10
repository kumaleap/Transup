import {describe, expect, it} from "vitest";
import {TextBuffer} from "../../src/tui/input/text-buffer.js";

describe("TextBuffer", () => {
  it.each(["x", "你", "e\u0301", "é", "👍🏽", "🇨🇳", "👨‍👩‍👧‍👦"])(
    "deletes %s as one grapheme",
    (value) => {
      const buffer = TextBuffer.from(`a${value}b`, 1 + value.length).deleteBackward();

      expect(buffer.text).toBe("ab");
      expect(buffer.cursor).toBe(1);
    },
  );

  it("normalizes across the insertion boundary and remaps the cursor", () => {
    const result = TextBuffer.from("e", 1).insert("\u0301");

    expect(result.text).toBe("é");
    expect(result.cursor).toBe(1);
  });

  it("clamps a cursor inside a surrogate pair to a boundary", () => {
    expect(TextBuffer.from("a😀b", 2).cursor).toBe(1);
  });

  it("clamps cursor changes toward the preceding grapheme boundary", () => {
    const buffer = TextBuffer.from("a👍🏽b");

    expect(buffer.withCursor(3).cursor).toBe(1);
    expect(buffer.cursor).toBe(buffer.text.length);
  });

  it("moves and deletes forward by whole graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    const before = TextBuffer.from(`a${family}b`, 1);

    expect(before.moveRight().cursor).toBe(1 + family.length);
    expect(before.moveRight().moveLeft().cursor).toBe(1);
    expect(before.deleteForward()).toEqual(TextBuffer.from("ab", 1));
  });

  it("replaces ranges immutably, expands inserted tabs, and normalizes", () => {
    const original = TextBuffer.from("aXb", 2);
    const result = original.replace(1, 2, "e\u0301\t");

    expect(result.text).toBe("aé    b");
    expect(result.cursor).toBe(6);
    expect(original.text).toBe("aXb");
    expect(original.cursor).toBe(2);
  });

  it("reports current hard-line bounds", () => {
    const buffer = TextBuffer.from("one\ntwo\nthree", 6);

    expect(buffer.lineStart()).toBe(4);
    expect(buffer.lineEnd()).toBe(7);
    expect(TextBuffer.from("\nnext", 0).lineStart()).toBe(0);
  });

  it("finds word bounds across punctuation and CJK text", () => {
    const text = "hello, 世界!";

    expect(TextBuffer.from(text).previousWordStart()).toBe(7);
    expect(TextBuffer.from(text, 5).nextWordEnd()).toBe(9);
  });
});
