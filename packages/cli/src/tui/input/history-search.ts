import {createEditorState, type EditorState} from "./editor.js";
import {type HistoryEntry} from "./history-store.js";
import {TextBuffer} from "./text-buffer.js";

export interface HistorySearchState {
  original: EditorState;
  query: TextBuffer;
  candidate: EditorState;
  match?: {start: number; end: number};
  nextIndex: number;
  seen: ReadonlySet<string>;
  hasMatch: boolean;
}

function validNextPasteId(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function nextPasteId(state: HistorySearchState, entry: HistoryEntry): number {
  let nextId = Math.max(
    validNextPasteId(state.original.pastes.nextId),
    validNextPasteId(state.candidate.pastes.nextId),
  );
  const references = [
    ...state.original.pastes.references,
    ...state.candidate.pastes.references,
    ...entry.pastes,
  ];

  for (const reference of references) {
    if (!Number.isSafeInteger(reference.id) || reference.id <= 0) continue;
    nextId = reference.id >= Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : Math.max(nextId, reference.id + 1);
  }
  return nextId;
}

function candidateFromHistory(
  state: HistorySearchState,
  entry: HistoryEntry,
  cursor: number,
): EditorState {
  return {
    ...createEditorState(entry.display, cursor),
    pastes: {
      nextId: nextPasteId(state, entry),
      references: entry.pastes.map((reference) => ({...reference})),
    },
    killRing: [...state.original.killRing],
  };
}

export function startHistorySearch(
  original: EditorState,
  history: readonly HistoryEntry[],
): HistorySearchState {
  return nextHistoryMatch(
    {
      original,
      query: TextBuffer.from(),
      candidate: original,
      nextIndex: history.length - 1,
      seen: new Set<string>(),
      hasMatch: false,
    },
    history,
  );
}

export function updateHistoryQuery(
  state: HistorySearchState,
  history: readonly HistoryEntry[],
  query: TextBuffer,
): HistorySearchState {
  return nextHistoryMatch(
    {
      original: state.original,
      query,
      candidate: state.candidate,
      nextIndex: history.length - 1,
      seen: new Set<string>(),
      hasMatch: false,
    },
    history,
  );
}

export function nextHistoryMatch(
  state: HistorySearchState,
  history: readonly HistoryEntry[],
): HistorySearchState {
  const seen = new Set(state.seen);
  const query = state.query.text;
  const firstIndex = Math.min(state.nextIndex, history.length - 1);

  for (let index = firstIndex; index >= 0; index--) {
    const entry = history[index]!;
    if (seen.has(entry.display)) continue;

    const start = entry.display.lastIndexOf(query);
    if (start < 0) continue;

    const end = start + query.length;
    seen.add(entry.display);
    return {
      ...state,
      candidate: candidateFromHistory(state, entry, end),
      match: {start, end},
      nextIndex: index - 1,
      seen,
      hasMatch: true,
    };
  }

  return {
    ...state,
    nextIndex: -1,
    seen,
    hasMatch: false,
  };
}
