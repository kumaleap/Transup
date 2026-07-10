import {measureText} from "./measured-text.js";
import {TextBuffer} from "./text-buffer.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

const KILL_RING_LIMIT = 10;
const UNDO_LIMIT = 50;
const INSERT_GROUP_WINDOW_MS = 1000;

export type EditorAction =
  | {type: "insert"; text: string; now: number}
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
  desiredColumn?: number;
  killRing: readonly string[];
  killChain?: {index: number};
  yank?: {start: number; end: number; ringIndex: number};
}

export interface EditorState {
  buffer: TextBuffer;
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

function snapshot(state: EditorState): EditorSnapshot {
  return {
    text: state.buffer.text,
    cursor: state.buffer.cursor,
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

  return {
    state: {
      ...state,
      buffer: state.buffer.replace(range.start, range.end, ""),
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
  const buffer = state.buffer.insert(action.text);
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
      buffer,
      desiredColumn: undefined,
      killChain: undefined,
      yank: undefined,
      undo: continuesGroup ? state.undo : appendUndo(state),
      insertGroup: groupable ? {lastAt: action.now, cursor: buffer.cursor} : undefined,
    },
  };
}

function reduceDelete(
  state: EditorState,
  action: Extract<EditorAction, {type: "delete"}>,
): EditorResult {
  const buffer =
    action.direction === "backward"
      ? state.buffer.deleteBackward()
      : state.buffer.deleteForward();
  return {
    state: cleanOrdinaryAction(state, {
      buffer,
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
    const buffer = state.buffer.insert(text);
    return {
      state: {
        ...state,
        buffer,
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
  const buffer = state.buffer.replace(
    state.yank.start,
    state.yank.end,
    state.killRing[ringIndex]!,
  );
  return {
    state: {
      ...state,
      buffer,
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
      const buffer = state.buffer.insert("\n");
      return {
        state: cleanOrdinaryAction(state, {
          buffer,
          desiredColumn: undefined,
          undo: appendUndo(state),
        }),
      };
    }
    case "undo":
      return reduceUndo(state);
  }
}
