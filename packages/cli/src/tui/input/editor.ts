import {measureText} from "./measured-text.js";
import {
  insertPaste,
  transformPasteReferences,
  type PasteRegistryState,
} from "./paste-registry.js";
import {TextBuffer} from "./text-buffer.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

const KILL_RING_LIMIT = 10;
const UNDO_LIMIT = 50;
const INSERT_GROUP_WINDOW_MS = 1000;

export type EditorAction =
  | {type: "insert"; text: string; now: number}
  | {type: "paste"; text: string; now: number}
  | {
      type: "move";
      direction:
        | "left"
        | "right"
        | "up"
        | "down"
        | "line-start"
        | "line-end"
        | "word-left"
        | "word-right";
      width: number;
    }
  | {type: "delete"; direction: "backward" | "forward"; now: number}
  | {type: "kill"; target: "line-start" | "line-end" | "word-left" | "word-right"; now: number}
  | {type: "yank" | "yank-pop"; now: number}
  | {type: "newline"; now: number}
  | {type: "undo"; now: number};

export interface EditorSnapshot {
  text: string;
  cursor: number;
  pastes: PasteRegistryState;
  desiredColumn?: number;
  killRing: readonly string[];
  killChain?: {index: number};
  yank?: {start: number; end: number; ringIndex: number};
}

export interface EditorState {
  buffer: TextBuffer;
  pastes: PasteRegistryState;
  desiredColumn?: number;
  killRing: readonly string[];
  killChain?: {index: number};
  yank?: {start: number; end: number; ringIndex: number};
  undo: readonly EditorSnapshot[];
  insertGroup?: {lastAt: number; cursor: number};
}

export interface EditorResult {
  state: EditorState;
  boundary?: "top" | "bottom";
}

export function createEditorState(text = "", cursor = text.length): EditorState {
  return {
    buffer: TextBuffer.from(text, cursor),
    pastes: {nextId: 1, references: []},
    killRing: [],
    undo: [],
  };
}

function cloneChain(chain: EditorState["killChain"]): EditorState["killChain"] {
  return chain ? {...chain} : undefined;
}

function cloneYank(yank: EditorState["yank"]): EditorState["yank"] {
  return yank ? {...yank} : undefined;
}

function clonePastes(pastes: PasteRegistryState): PasteRegistryState {
  return {
    nextId: pastes.nextId,
    references: pastes.references.map((reference) => ({...reference})),
  };
}

function snapshot(state: EditorState): EditorSnapshot {
  return {
    text: state.buffer.text,
    cursor: state.buffer.cursor,
    pastes: clonePastes(state.pastes),
    desiredColumn: state.desiredColumn,
    killRing: [...state.killRing],
    killChain: cloneChain(state.killChain),
    yank: cloneYank(state.yank),
  };
}

function appendUndo(state: EditorState): readonly EditorSnapshot[] {
  return [...state.undo, snapshot(state)].slice(-UNDO_LIMIT);
}

function isSingleGrapheme(text: string): boolean {
  if (!text || /[\r\n]/.test(text)) return false;
  const segments = graphemeSegmenter.segment(text)[Symbol.iterator]();
  return !segments.next().done && segments.next().done === true;
}

function changed(before: TextBuffer, after: TextBuffer): boolean {
  return before.text !== after.text || before.cursor !== after.cursor;
}

function replaceRange(
  state: EditorState,
  start: number,
  end: number,
  text: string,
  rangeMode: "grapheme" | "exact" = "grapheme",
): {buffer: TextBuffer; pastes: PasteRegistryState} {
  const clampExact = (offset: number) => Math.max(
    0,
    Math.min(
      state.buffer.text.length,
      Number.isFinite(offset) ? Math.trunc(offset) : 0,
    ),
  );
  const first = rangeMode === "grapheme"
    ? state.buffer.withCursor(start).cursor
    : clampExact(start);
  const second = rangeMode === "grapheme"
    ? state.buffer.withCursor(end).cursor
    : clampExact(end);
  const rangeStart = Math.min(first, second);
  const rangeEnd = Math.max(first, second);
  const inserted = text.replace(/\t/g, "    ");
  const rawText =
    state.buffer.text.slice(0, rangeStart) +
    inserted +
    state.buffer.text.slice(rangeEnd);
  const buffer = TextBuffer.from(rawText, rangeStart + inserted.length);
  const references = transformPasteReferences(
    state.pastes.references,
    rangeStart,
    rangeEnd,
    inserted.length,
  );

  return {
    buffer,
    pastes: {
      nextId: state.pastes.nextId,
      references: references.map((reference) => ({
        ...reference,
        start: rawText.slice(0, reference.start).normalize("NFC").length,
        end: rawText.slice(0, reference.end).normalize("NFC").length,
      })),
    },
  };
}

export interface EditorSubmission {
  display: string;
  pastes: PasteRegistryState;
}

export function prepareEditorSubmission(state: EditorState): EditorSubmission {
  let prepared = state;
  const trailingStart = prepared.buffer.text.trimEnd().length;
  if (trailingStart < prepared.buffer.text.length) {
    prepared = {
      ...prepared,
      ...replaceRange(
        prepared,
        trailingStart,
        prepared.buffer.text.length,
        "",
        "exact",
      ),
    };
  }

  const trimmedStart = prepared.buffer.text.trimStart();
  const leadingEnd = prepared.buffer.text.length - trimmedStart.length;
  if (leadingEnd > 0) {
    prepared = {
      ...prepared,
      ...replaceRange(prepared, 0, leadingEnd, "", "exact"),
    };
  }

  return {
    display: prepared.buffer.text,
    pastes: clonePastes(prepared.pastes),
  };
}

function cleanOrdinaryAction(
  state: EditorState,
  patch: Partial<EditorState> = {},
): EditorState {
  return {
    ...state,
    ...patch,
    killChain: undefined,
    yank: undefined,
    insertGroup: undefined,
  };
}

function moveHorizontally(state: EditorState, action: Extract<EditorAction, {type: "move"}>) {
  const buffer = state.buffer;
  switch (action.direction) {
    case "left":
      return buffer.moveLeft();
    case "right":
      return buffer.moveRight();
    case "line-start":
      return buffer.withCursor(buffer.lineStart());
    case "line-end":
      return buffer.withCursor(buffer.lineEnd());
    case "word-left":
      return buffer.withCursor(buffer.previousWordStart());
    case "word-right":
      return buffer.withCursor(buffer.nextWordEnd());
    case "up":
    case "down":
      return buffer;
  }
}

function reduceMove(
  state: EditorState,
  action: Extract<EditorAction, {type: "move"}>,
): EditorResult {
  if (action.direction !== "up" && action.direction !== "down") {
    return {
      state: cleanOrdinaryAction(state, {
        buffer: moveHorizontally(state, action),
        desiredColumn: undefined,
      }),
    };
  }

  const measured = measureText(state.buffer, action.width);
  const desiredColumn = state.desiredColumn ?? measured.cursor.column;
  const rowDelta = action.direction === "up" ? -1 : 1;
  const targetRow = measured.cursor.row + rowDelta;
  const atBoundary = targetRow < 0 || targetRow >= measured.rows.length;
  const buffer = atBoundary
    ? state.buffer
    : state.buffer.withCursor(measured.offsetAt(targetRow, desiredColumn));

  return {
    state: cleanOrdinaryAction(state, {buffer, desiredColumn}),
    boundary: atBoundary ? (action.direction === "up" ? "top" : "bottom") : undefined,
  };
}

function killRange(
  buffer: TextBuffer,
  target: Extract<EditorAction, {type: "kill"}>["target"],
): {start: number; end: number; backward: boolean} {
  if (target === "line-start") {
    return {start: buffer.lineStart(), end: buffer.cursor, backward: true};
  }
  if (target === "word-left") {
    return {start: buffer.previousWordStart(), end: buffer.cursor, backward: true};
  }
  if (target === "word-right") {
    return {start: buffer.cursor, end: buffer.nextWordEnd(), backward: false};
  }

  const lineEnd = buffer.lineEnd();
  return {
    start: buffer.cursor,
    end:
      buffer.cursor === lineEnd && lineEnd < buffer.text.length
        ? lineEnd + 1
        : lineEnd,
    backward: false,
  };
}

function reduceKill(
  state: EditorState,
  action: Extract<EditorAction, {type: "kill"}>,
): EditorResult {
  const range = killRange(state.buffer, action.target);
  const killed = state.buffer.text.slice(range.start, range.end);
  if (!killed) {
    return {
      state: {
        ...state,
        desiredColumn: undefined,
        yank: undefined,
        insertGroup: undefined,
      },
    };
  }

  let killRing: readonly string[];
  let killChain: EditorState["killChain"];
  const chainIndex = state.killChain?.index;
  if (chainIndex !== undefined && state.killRing[chainIndex] !== undefined) {
    const accumulated = range.backward
      ? killed + state.killRing[chainIndex]
      : state.killRing[chainIndex] + killed;
    killRing = state.killRing.map((entry, index) =>
      index === chainIndex ? accumulated : entry,
    );
    killChain = {index: chainIndex};
  } else {
    killRing = [killed, ...state.killRing].slice(0, KILL_RING_LIMIT);
    killChain = {index: 0};
  }

  const replacement = replaceRange(state, range.start, range.end, "");

  return {
    state: {
      ...state,
      ...replacement,
      desiredColumn: undefined,
      killRing,
      killChain,
      yank: undefined,
      undo: appendUndo(state),
      insertGroup: undefined,
    },
  };
}

function reduceInsert(
  state: EditorState,
  action: Extract<EditorAction, {type: "insert"}>,
): EditorResult {
  const replacement = replaceRange(
    state,
    state.buffer.cursor,
    state.buffer.cursor,
    action.text,
  );
  const {buffer} = replacement;
  if (!changed(state.buffer, buffer)) {
    return {state: cleanOrdinaryAction(state, {desiredColumn: undefined})};
  }

  const groupable = isSingleGrapheme(action.text);
  const group = state.insertGroup;
  const continuesGroup =
    groupable &&
    group !== undefined &&
    state.buffer.cursor === group.cursor &&
    action.now >= group.lastAt &&
    action.now - group.lastAt <= INSERT_GROUP_WINDOW_MS;

  return {
    state: {
      ...state,
      ...replacement,
      desiredColumn: undefined,
      killChain: undefined,
      yank: undefined,
      undo: continuesGroup ? state.undo : appendUndo(state),
      insertGroup: groupable ? {lastAt: action.now, cursor: buffer.cursor} : undefined,
    },
  };
}

function reducePaste(
  state: EditorState,
  action: Extract<EditorAction, {type: "paste"}>,
): EditorResult {
  const inserted = insertPaste(
    state.buffer.text,
    state.buffer.cursor,
    state.pastes,
    action.text,
  );
  const buffer = TextBuffer.from(inserted.display, inserted.cursor);
  if (!changed(state.buffer, buffer)) {
    return {state: cleanOrdinaryAction(state, {desiredColumn: undefined})};
  }

  const pastes = buffer.text === inserted.display
    ? inserted.state
    : {
        nextId: inserted.state.nextId,
        references: inserted.state.references.map((reference) => ({
          ...reference,
          start: inserted.display.slice(0, reference.start).normalize("NFC").length,
          end: inserted.display.slice(0, reference.end).normalize("NFC").length,
        })),
      };

  return {
    state: {
      ...state,
      buffer,
      pastes,
      desiredColumn: undefined,
      killChain: undefined,
      yank: undefined,
      undo: appendUndo(state),
      insertGroup: undefined,
    },
  };
}

function reduceDelete(
  state: EditorState,
  action: Extract<EditorAction, {type: "delete"}>,
): EditorResult {
  const start = action.direction === "backward"
    ? state.buffer.moveLeft().cursor
    : state.buffer.cursor;
  const end = action.direction === "backward"
    ? state.buffer.cursor
    : state.buffer.moveRight().cursor;
  const replacement = replaceRange(state, start, end, "");
  const {buffer} = replacement;
  return {
    state: cleanOrdinaryAction(state, {
      ...replacement,
      desiredColumn: undefined,
      undo: changed(state.buffer, buffer) ? appendUndo(state) : state.undo,
    }),
  };
}

function reduceYank(
  state: EditorState,
  action: Extract<EditorAction, {type: "yank" | "yank-pop"}>,
): EditorResult {
  if (action.type === "yank") {
    const text = state.killRing[0];
    if (!text) return {state: cleanOrdinaryAction(state, {desiredColumn: undefined})};

    const start = state.buffer.cursor;
    const replacement = replaceRange(state, start, start, text);
    const {buffer} = replacement;
    return {
      state: {
        ...state,
        ...replacement,
        desiredColumn: undefined,
        killChain: undefined,
        yank: {start, end: buffer.cursor, ringIndex: 0},
        undo: appendUndo(state),
        insertGroup: undefined,
      },
    };
  }

  if (!state.yank || state.killRing.length === 0) {
    return {
      state: {
        ...state,
        desiredColumn: undefined,
        killChain: undefined,
        insertGroup: undefined,
      },
    };
  }

  const ringIndex = (state.yank.ringIndex + 1) % state.killRing.length;
  const replacement = replaceRange(
    state,
    state.yank.start,
    state.yank.end,
    state.killRing[ringIndex]!,
  );
  const {buffer} = replacement;
  return {
    state: {
      ...state,
      ...replacement,
      desiredColumn: undefined,
      killChain: undefined,
      yank: {start: state.yank.start, end: buffer.cursor, ringIndex},
      undo: changed(state.buffer, buffer) ? appendUndo(state) : state.undo,
      insertGroup: undefined,
    },
  };
}

function reduceUndo(state: EditorState): EditorResult {
  const previous = state.undo[state.undo.length - 1];
  if (!previous) return {state: cleanOrdinaryAction(state)};

  return {
    state: {
      buffer: TextBuffer.from(previous.text, previous.cursor),
      pastes: clonePastes(previous.pastes),
      desiredColumn: previous.desiredColumn,
      killRing: [...previous.killRing],
      killChain: undefined,
      yank: undefined,
      undo: state.undo.slice(0, -1),
      insertGroup: undefined,
    },
  };
}

export function reduceEditor(state: EditorState, action: EditorAction): EditorResult {
  switch (action.type) {
    case "insert":
      return reduceInsert(state, action);
    case "paste":
      return reducePaste(state, action);
    case "move":
      return reduceMove(state, action);
    case "delete":
      return reduceDelete(state, action);
    case "kill":
      return reduceKill(state, action);
    case "yank":
    case "yank-pop":
      return reduceYank(state, action);
    case "newline": {
      const replacement = replaceRange(
        state,
        state.buffer.cursor,
        state.buffer.cursor,
        "\n",
      );
      return {
        state: cleanOrdinaryAction(state, {
          ...replacement,
          desiredColumn: undefined,
          undo: appendUndo(state),
        }),
      };
    }
    case "undo":
      return reduceUndo(state);
  }
}
