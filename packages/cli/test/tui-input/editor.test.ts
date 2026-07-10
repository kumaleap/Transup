import {describe, expect, it} from "vitest";
import {
  createEditorState,
  reduceEditor,
  type EditorAction,
  type EditorState,
} from "../../src/tui/input/editor.js";

const apply = (state: EditorState, ...actions: EditorAction[]): EditorState =>
  actions.reduce((current, action) => reduceEditor(current, action).state, state);

const move = (
  direction: Extract<EditorAction, {type: "move"}>["direction"],
  width = 80,
): EditorAction => ({type: "move", direction, width});

const kill = (
  target: Extract<EditorAction, {type: "kill"}>["target"],
  now = 0,
): EditorAction => ({type: "kill", target, now});

describe("editor reducer", () => {
  it("uses hard-line boundaries for line start, line end, and line kills", () => {
    const text = "zero\none two\nthree";
    const middle = createEditorState(text, 8);

    expect(reduceEditor(middle, move("line-start")).state.buffer.cursor).toBe(5);
    expect(reduceEditor(middle, move("line-end")).state.buffer.cursor).toBe(12);

    const killedToEnd = reduceEditor(middle, kill("line-end")).state;
    expect(killedToEnd.buffer.text).toBe("zero\none\nthree");
    expect(killedToEnd.buffer.cursor).toBe(8);
    expect(killedToEnd.killRing[0]).toBe(" two");

    const killedToStart = reduceEditor(middle, kill("line-start")).state;
    expect(killedToStart.buffer.text).toBe("zero\n two\nthree");
    expect(killedToStart.buffer.cursor).toBe(5);
    expect(killedToStart.killRing[0]).toBe("one");
  });

  it("makes line-end kill join the next hard line when already at the end", () => {
    const state = reduceEditor(createEditorState("one\ntwo", 3), kill("line-end")).state;

    expect(state.buffer.text).toBe("onetwo");
    expect(state.buffer.cursor).toBe(3);
    expect(state.killRing).toEqual(["\n"]);
  });

  it("moves by CJK word-like segments across punctuation", () => {
    const text = "hello, 世界!";

    expect(reduceEditor(createEditorState(text, 5), move("word-right")).state.buffer.cursor).toBe(
      9,
    );
    expect(
      reduceEditor(createEditorState(text), move("word-left")).state.buffer.cursor,
    ).toBe(7);
  });

  it("preserves the desired visual column across short rows", () => {
    let state = createEditorState("abcd\nx\nwxyz", 4);

    state = reduceEditor(state, move("down", 10)).state;
    expect(state.buffer.cursor).toBe(6);
    expect(state.desiredColumn).toBe(4);

    state = reduceEditor(state, move("down", 10)).state;
    expect(state.buffer.cursor).toBe(11);
    expect(state.desiredColumn).toBe(4);

    state = reduceEditor(state, move("up", 10)).state;
    expect(state.buffer.cursor).toBe(6);
    expect(state.desiredColumn).toBe(4);

    state = reduceEditor(state, move("left", 10)).state;
    expect(state.desiredColumn).toBeUndefined();
  });

  it("reports history boundaries only when vertical movement cannot change rows", () => {
    const top = createEditorState("abc\ndef", 2);
    const topResult = reduceEditor(top, move("up", 10));
    expect(topResult.state).not.toBe(top);
    expect(topResult.state.buffer.cursor).toBe(2);
    expect(topResult.boundary).toBe("top");

    const middleResult = reduceEditor(top, move("down", 10));
    expect(middleResult.state.buffer.cursor).toBe(6);
    expect(middleResult.boundary).toBeUndefined();

    const bottom = createEditorState("abc\ndef", 6);
    const bottomResult = reduceEditor(bottom, move("down", 10));
    expect(bottomResult.state.buffer.cursor).toBe(6);
    expect(bottomResult.boundary).toBe("bottom");
  });

  it("deletes forward by one whole grapheme", () => {
    const family = "👨‍👩‍👧‍👦";
    const state = reduceEditor(createEditorState(`a${family}b`, 1), {
      type: "delete",
      direction: "forward",
      now: 0,
    }).state;

    expect(state.buffer.text).toBe("ab");
    expect(state.buffer.cursor).toBe(1);
  });

  it("keeps only the ten newest kill-ring entries", () => {
    let state = createEditorState("a b c d e f g h i j k", 0);

    for (let index = 0; index < 11; index++) {
      state = reduceEditor(state, kill("word-right", index)).state;
      state = reduceEditor(state, move("left")).state;
    }

    expect(state.killRing).toHaveLength(10);
    expect(state.killRing[0]).toBe(" k");
    expect(state.killRing[9]).toBe(" b");
  });

  it("appends forward kills and prepends backward kills", () => {
    const forward = apply(
      createEditorState("one two", 0),
      kill("word-right", 0),
      kill("word-right", 1),
    );
    expect(forward.buffer.text).toBe("");
    expect(forward.killRing).toEqual(["one two"]);

    const backward = apply(
      createEditorState("one two"),
      kill("word-left", 0),
      kill("word-left", 1),
    );
    expect(backward.buffer.text).toBe("");
    expect(backward.killRing).toEqual(["one two"]);
  });

  it("cycles yank-pop only while the yank chain remains valid", () => {
    let state: EditorState = {
      ...createEditorState(),
      killRing: ["new", "old"],
    };

    state = reduceEditor(state, {type: "yank", now: 0}).state;
    expect(state.buffer.text).toBe("new");

    state = reduceEditor(state, {type: "yank-pop", now: 1}).state;
    expect(state.buffer.text).toBe("old");

    state = reduceEditor(state, move("left")).state;
    expect(state.yank).toBeUndefined();

    const invalidated = reduceEditor(state, {type: "yank-pop", now: 2}).state;
    expect(invalidated.buffer.text).toBe("old");
  });

  it("evicts undo snapshots beyond fifty entries", () => {
    let state = createEditorState("x".repeat(51));

    for (let index = 0; index < 51; index++) {
      state = reduceEditor(state, {type: "delete", direction: "backward", now: index}).state;
    }
    expect(state.undo).toHaveLength(50);

    for (let index = 0; index < 50; index++) {
      state = reduceEditor(state, {type: "undo", now: 100 + index}).state;
    }
    expect(state.buffer.text).toBe("x".repeat(50));
    expect(state.undo).toHaveLength(0);
  });

  it("groups adjacent inserts through 1000ms and starts a new snapshot after it", () => {
    let state = createEditorState();
    state = reduceEditor(state, {type: "insert", text: "a", now: 0}).state;
    state = reduceEditor(state, {type: "insert", text: "b", now: 1000}).state;
    expect(state.undo).toHaveLength(1);

    state = reduceEditor(state, {type: "insert", text: "c", now: 2001}).state;
    expect(state.undo).toHaveLength(2);

    state = reduceEditor(state, {type: "undo", now: 2002}).state;
    expect(state.buffer.text).toBe("ab");
  });

  it("closes insert grouping after cursor movement", () => {
    const state = apply(
      createEditorState(),
      {type: "insert", text: "a", now: 0},
      move("left"),
      {type: "insert", text: "b", now: 1},
    );

    expect(state.buffer.text).toBe("ba");
    expect(state.undo).toHaveLength(2);
    expect(reduceEditor(state, {type: "undo", now: 2}).state.buffer.text).toBe("a");
  });

  it("restores kill, yank, and desired-column state from undo snapshots", () => {
    const original: EditorState = {
      ...createEditorState("abc", 1),
      desiredColumn: 7,
      killRing: ["saved"],
      killChain: {index: 0},
      yank: {start: 0, end: 1, ringIndex: 0},
    };
    const deleted = reduceEditor(original, {
      type: "delete",
      direction: "forward",
      now: 0,
    }).state;
    expect(deleted.killChain).toBeUndefined();
    expect(deleted.yank).toBeUndefined();

    const restored = reduceEditor(deleted, {type: "undo", now: 1}).state;
    expect(restored.buffer.text).toBe("abc");
    expect(restored.buffer.cursor).toBe(1);
    expect(restored.desiredColumn).toBe(7);
    expect(restored.killRing).toEqual(["saved"]);
    expect(restored.killChain).toEqual({index: 0});
    expect(restored.yank).toEqual({start: 0, end: 1, ringIndex: 0});
  });
});
