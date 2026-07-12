import {describe, expect, it} from "vitest";
import {createEditorState, type EditorState} from "../../src/tui/input/editor.js";
import {
  nextHistoryMatch,
  startHistorySearch,
  updateHistoryQuery,
} from "../../src/tui/input/history-search.js";
import {type HistoryEntry} from "../../src/tui/input/history-store.js";
import {pasteMarker} from "../../src/tui/input/paste-registry.js";
import {TextBuffer} from "../../src/tui/input/text-buffer.js";

function entry(
  display: string,
  pastes: HistoryEntry["pastes"] = [],
): HistoryEntry {
  return {
    v: 1,
    display,
    pastes,
    timestamp: "2026-07-12T00:00:00.000Z",
  };
}

function searchFor(
  original: EditorState,
  history: readonly HistoryEntry[],
  query: string,
) {
  return updateHistoryQuery(
    startHistorySearch(original, history),
    history,
    TextBuffer.from(query),
  );
}

describe("incremental history search", () => {
  it("immediately selects the newest entry for an empty query", () => {
    const history = [entry("older"), entry("newest")];
    const state = startHistorySearch(createEditorState("draft", 2), history);

    expect(state.query.text).toBe("");
    expect(state.candidate.buffer.text).toBe("newest");
    expect(state.candidate.buffer.cursor).toBe("newest".length);
    expect(state.match).toEqual({start: "newest".length, end: "newest".length});
    expect(state.nextIndex).toBe(0);
    expect(state.seen).toEqual(new Set(["newest"]));
    expect(state.hasMatch).toBe(true);
  });

  it("matches case-sensitively and selects the last occurrence", () => {
    const newest = "Needle then Needle";
    const history = [entry("lower needle"), entry(newest)];
    const original = createEditorState();

    const lowercase = searchFor(original, history, "needle");
    expect(lowercase.candidate.buffer.text).toBe("lower needle");

    const uppercase = updateHistoryQuery(
      lowercase,
      history,
      TextBuffer.from("Needle"),
    );
    const start = newest.lastIndexOf("Needle");
    expect(uppercase.candidate.buffer.text).toBe(newest);
    expect(uppercase.match).toEqual({start, end: start + "Needle".length});
    expect(uppercase.candidate.buffer.cursor).toBe(start + "Needle".length);
  });

  it("skips duplicate displays while moving to older matches", () => {
    const history = [
      entry("target old"),
      entry("target duplicate"),
      entry("target duplicate"),
    ];
    const first = searchFor(createEditorState(), history, "target");
    const second = nextHistoryMatch(first, history);

    expect(first.candidate.buffer.text).toBe("target duplicate");
    expect(second.candidate.buffer.text).toBe("target old");
    expect(second.seen).toEqual(new Set(["target duplicate", "target old"]));

    const exhausted = nextHistoryMatch(second, history);
    expect(exhausted.hasMatch).toBe(false);
    expect(exhausted.candidate).toBe(second.candidate);
    expect(exhausted.match).toEqual(second.match);
  });

  it("restarts from the newest entry after the query changes", () => {
    const history = [entry("term old"), entry("term newest")];
    const original = createEditorState();
    const older = searchFor(original, history, "old");

    expect(older.candidate.buffer.text).toBe("term old");

    const restarted = updateHistoryQuery(
      older,
      history,
      TextBuffer.from("term"),
    );
    expect(restarted.candidate.buffer.text).toBe("term newest");
    expect(restarted.nextIndex).toBe(0);
    expect(restarted.seen).toEqual(new Set(["term newest"]));
  });

  it("keeps the last candidate when the edited query has no match", () => {
    const history = [entry("alpha result")];
    const matched = searchFor(createEditorState("draft"), history, "alpha");
    const unmatched = updateHistoryQuery(
      matched,
      history,
      TextBuffer.from("alpha missing"),
    );

    expect(unmatched.hasMatch).toBe(false);
    expect(unmatched.candidate).toBe(matched.candidate);
    expect(unmatched.match).toBeUndefined();
  });

  it("keeps the exact original editor when search has never matched", () => {
    const original: EditorState = {
      ...createEditorState("draft", 2),
      desiredColumn: 7,
      killRing: ["saved kill"],
      pastes: {nextId: 4, references: []},
    };
    const started = startHistorySearch(original, []);
    const unmatched = updateHistoryQuery(
      started,
      [entry("history")],
      TextBuffer.from("absent"),
    );

    expect(unmatched.hasMatch).toBe(false);
    expect(unmatched.candidate).toBe(original);
    expect(unmatched.original).toBe(original);
  });

  it("matches Chinese text on the last occurrence across multiple lines", () => {
    const needle = "\u4f60\u597d";
    const display = `first ${needle}\nsecond ${needle}`;
    const state = searchFor(createEditorState(), [entry(display)], needle);
    const start = display.lastIndexOf(needle);

    expect(state.candidate.buffer.text).toBe(display);
    expect(state.match).toEqual({start, end: start + needle.length});
    expect(state.candidate.buffer.cursor).toBe(start + needle.length);
  });

  it("copies paste references into the selected candidate", () => {
    const content = "first\nsecond";
    const display = pasteMarker(7, content);
    const reference = {id: 7, content, start: 0, end: display.length};
    const original: EditorState = {
      ...createEditorState("draft"),
      pastes: {nextId: 3, references: []},
    };
    const state = startHistorySearch(original, [entry(display, [reference])]);

    expect(state.candidate.pastes).toEqual({
      nextId: 8,
      references: [reference],
    });
    expect(state.candidate.pastes.references[0]).not.toBe(reference);
  });
});
