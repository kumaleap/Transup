import {describe, expect, it} from "vitest";
import {
  expandPasteReferences,
  insertPaste,
  normalizePaste,
  pasteMarker,
  transformPasteReferences,
  type PasteReference,
  type PasteRegistryState,
} from "../../src/tui/input/paste-registry.js";

const emptyRegistry = (): PasteRegistryState => ({nextId: 1, references: []});

const reference = (start = 5, end = 10): PasteReference => ({
  id: 3,
  content: "first\nsecond",
  start,
  end,
});

describe("paste registry", () => {
  describe("normalization and insertion", () => {
    it("normalizes CRLF, bare CR, and tabs before storage", () => {
      expect(normalizePaste("a\r\nb\rc\td")).toBe("a\nb\nc    d");
    });

    it("normalizes pasted text to NFC before inline or folded storage", () => {
      const content = "e\u0301\nvalue";
      const result = insertPaste("", 0, emptyRegistry(), content);
      const belowFoldThreshold = insertPaste(
        "",
        0,
        emptyRegistry(),
        "e\u0301".repeat(401),
      );

      expect(normalizePaste("e\u0301")).toBe("é");
      expect(result.state.references[0]?.content).toBe("é\nvalue");
      expect(
        expandPasteReferences(result.display, result.state.references),
      ).toBe("é\nvalue");
      expect(belowFoldThreshold.display).toBe("é".repeat(401));
      expect(belowFoldThreshold.state.references).toEqual([]);
    });

    it("inserts a short single-line paste inline without consuming an id", () => {
      const result = insertPaste("ac", 1, emptyRegistry(), "b\t");

      expect(result).toEqual({
        display: "ab    c",
        cursor: 6,
        state: {nextId: 1, references: []},
      });
    });

    it("folds multiline content and reports the newline count", () => {
      const content = "line one\nline two\nline three";
      const marker = "[Pasted text #1 +2 lines]";
      const result = insertPaste("", 0, emptyRegistry(), "line one\r\nline two\rline three");

      expect(pasteMarker(1, content)).toBe(marker);
      expect(result).toEqual({
        display: marker,
        cursor: marker.length,
        state: {
          nextId: 2,
          references: [{id: 1, content, start: 0, end: marker.length}],
        },
      });
    });

    it("folds a single line only after 800 UTF-16 code units", () => {
      const atLimit = "x".repeat(800);
      const overLimit = "x".repeat(801);
      const inline = insertPaste("", 0, emptyRegistry(), atLimit);
      const folded = insertPaste("", 0, emptyRegistry(), overLimit);
      const marker = "[Pasted text #1 +0 lines]";

      expect(inline).toEqual({
        display: atLimit,
        cursor: atLimit.length,
        state: {nextId: 1, references: []},
      });
      expect(folded.display).toBe(marker);
      expect(folded.cursor).toBe(marker.length);
      expect(folded.state).toEqual({
        nextId: 2,
        references: [{id: 1, content: overLimit, start: 0, end: marker.length}],
      });
    });

    it("tracks multiple references and resumes from a restored nextId", () => {
      const first = insertPaste(">", 1, emptyRegistry(), "one\ntwo");
      const second = insertPaste(first.display, first.cursor, first.state, "three\nfour\nfive");

      expect(second.state.nextId).toBe(3);
      expect(second.state.references.map(({id}) => id)).toEqual([1, 2]);
      expect(second.state.references[0]).toMatchObject({start: 1});
      expect(second.state.references[1]).toMatchObject({start: first.cursor});

      const restored: PasteRegistryState = {
        nextId: 7,
        references: second.state.references,
      };
      const third = insertPaste(second.display, second.cursor, restored, "six\nseven");

      expect(third.state.nextId).toBe(8);
      expect(third.state.references.map(({id}) => id)).toEqual([1, 2, 7]);
      expect(third.display).toContain("[Pasted text #7 +1 lines]");
    });

    it("keeps IDs safe and inserts literal content after the ID space is exhausted", () => {
      const first = insertPaste(
        "",
        0,
        {nextId: Number.MAX_SAFE_INTEGER - 1, references: []},
        "one\ntwo",
      );
      const second = insertPaste(
        first.display,
        first.cursor,
        first.state,
        "three\nfour",
      );

      expect(first.state.references[0]?.id).toBe(Number.MAX_SAFE_INTEGER - 1);
      expect(first.state.nextId).toBe(Number.MAX_SAFE_INTEGER);
      expect(second.state.references).toHaveLength(1);
      expect(second.display.endsWith("three\nfour")).toBe(true);
      expect(
        expandPasteReferences(second.display, second.state.references),
      ).toBe("one\ntwothree\nfour");
    });
  });

  describe("range transforms", () => {
    it.each([
      {name: "before", point: 2, expected: {start: 8, end: 13}},
      {name: "at the marker start", point: 5, expected: {start: 8, end: 13}},
      {name: "inside the marker", point: 7, expected: undefined},
      {name: "at the marker end", point: 10, expected: {start: 5, end: 10}},
      {name: "after", point: 12, expected: {start: 5, end: 10}},
    ])("handles insertion $name", ({point, expected}) => {
      const result = transformPasteReferences([reference()], point, point, 3);

      if (!expected) {
        expect(result).toEqual([]);
        return;
      }
      expect(result).toEqual([{...reference(), ...expected}]);
    });

    it.each([
      {name: "fully before", start: 1, end: 3, expected: {start: 3, end: 8}},
      {name: "ending at the marker start", start: 2, end: 5, expected: {start: 2, end: 7}},
      {name: "starting at the marker end", start: 10, end: 12, expected: {start: 5, end: 10}},
      {name: "fully after", start: 12, end: 14, expected: {start: 5, end: 10}},
      {name: "overlapping the start", start: 4, end: 6, expected: undefined},
      {name: "inside the marker", start: 6, end: 8, expected: undefined},
      {name: "overlapping the end", start: 9, end: 11, expected: undefined},
      {name: "covering the marker", start: 2, end: 12, expected: undefined},
    ])("handles deletion $name", ({start, end, expected}) => {
      const result = transformPasteReferences([reference()], start, end, 0);

      if (!expected) {
        expect(result).toEqual([]);
        return;
      }
      expect(result).toEqual([{...reference(), ...expected}]);
    });
  });

  describe("validated expansion", () => {
    it("expands multiple references from their recorded ranges regardless of input order", () => {
      const firstContent = "first\ncontent";
      const secondContent = "second\ncontent\nwith another line";
      const firstMarker = pasteMarker(1, firstContent);
      const secondMarker = pasteMarker(2, secondContent);
      const display = `A${firstMarker}B${secondMarker}C`;
      const firstStart = 1;
      const secondStart = firstStart + firstMarker.length + 1;
      const references: PasteReference[] = [
        {
          id: 2,
          content: secondContent,
          start: secondStart,
          end: secondStart + secondMarker.length,
        },
        {
          id: 1,
          content: firstContent,
          start: firstStart,
          end: firstStart + firstMarker.length,
        },
      ];

      expect(expandPasteReferences(display, references)).toBe(
        `A${firstContent}B${secondContent}C`,
      );
    });

    it("expands only the recorded occurrence of same-looking literal marker text", () => {
      const content = "alpha\nbeta";
      const marker = pasteMarker(1, content);
      const display = `literal ${marker} / recorded ${marker}`;
      const start = display.lastIndexOf(marker);

      expect(
        expandPasteReferences(display, [
          {id: 1, content, start, end: start + marker.length},
        ]),
      ).toBe(`literal ${marker} / recorded ${content}`);
      expect(expandPasteReferences(marker, [])).toBe(marker);
    });

    it.each([
      {
        name: "out-of-bounds range",
        invalid: (marker: string, content: string): PasteReference => ({
          id: 2,
          content,
          start: marker.length + 1,
          end: marker.length * 2 + 1,
        }),
      },
      {
        name: "range whose display slice does not match its marker",
        invalid: (marker: string, content: string): PasteReference => ({
          id: 2,
          content,
          start: 1,
          end: marker.length + 1,
        }),
      },
    ])("rejects an $name atomically", ({invalid}) => {
      const validContent = "valid\ncontent";
      const invalidContent = "invalid\ncontent";
      const marker = pasteMarker(1, validContent);
      const display = `${marker} tail`;
      const valid: PasteReference = {
        id: 1,
        content: validContent,
        start: 0,
        end: marker.length,
      };

      expect(expandPasteReferences(display, [valid, invalid(marker, invalidContent)])).toBe(
        display,
      );
    });

    it("rejects overlapping references atomically", () => {
      const content = "left\nright";
      const marker = pasteMarker(1, content);
      const display = `${marker} tail`;
      const duplicatedRange: PasteReference = {
        id: 1,
        content,
        start: 0,
        end: marker.length,
      };

      expect(
        expandPasteReferences(display, [duplicatedRange, {...duplicatedRange}]),
      ).toBe(display);
    });
  });
});
