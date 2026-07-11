import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {
  createEditorState,
  prepareEditorSubmission,
  reduceEditor,
  type EditorAction,
  type EditorState,
} from "./editor.js";
import {
  editorActionForKeystroke,
  type Keystroke,
} from "./keybinding-router.js";
import {
  HistoryStore,
  type HistoryEntry,
} from "./history-store.js";
import {
  expandPasteReferences,
  type PasteRegistryState,
} from "./paste-registry.js";

export interface InputControllerOptions {
  active: boolean;
  onSubmit: (display: string, expanded: string) => void;
  onExit?: () => void;
  onHistoryEntry?: (draft: string) => void;
  onHistoryError?: (error: unknown) => void;
  historyPath?: string;
  historyStore?: HistoryStore;
  now?: () => number;
}

export interface InputViewState {
  value: string;
  cursor: number;
  active: boolean;
  footer?: string;
}

export interface InputController {
  view: InputViewState;
  handleGlobalKey: (stroke: Keystroke) => boolean;
  handleEditorKey: (stroke: Keystroke) => boolean;
  handlePaste: (text: string) => void;
  requestExit: () => void;
  setContentWidth: (width: number) => void;
}

type PendingPress =
  | {
      key: "Ctrl-C" | "Ctrl-D" | "Escape";
      expiresAt: number;
    }
  | undefined;

const DOUBLE_PRESS_MS = 800;
const EXIT_FLUSH_MS = 500;
const HISTORY_LIMIT = 100;

function monotonicNow(): number {
  return performance.now();
}

function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    v: 1,
    display: entry.display,
    pastes: entry.pastes.map((reference) => ({...reference})),
    timestamp: entry.timestamp,
  };
}

function sameHistoryPrompt(left: HistoryEntry, right: HistoryEntry): boolean {
  if (left.display !== right.display || left.pastes.length !== right.pastes.length) {
    return false;
  }
  return left.pastes.every((reference, index) => {
    const other = right.pastes[index];
    return other !== undefined &&
      reference.id === other.id &&
      reference.content === other.content &&
      reference.start === other.start &&
      reference.end === other.end;
  });
}

function historyEntryFromEditor(
  display: string,
  pastes: PasteRegistryState,
): HistoryEntry {
  return {
    v: 1,
    display,
    pastes: pastes.references.map((reference) => ({...reference})),
    timestamp: new Date().toISOString(),
  };
}

function registryForHistory(
  current: PasteRegistryState,
  entry: HistoryEntry,
): PasteRegistryState {
  const restored: PasteRegistryState = {
    nextId: 1,
    references: entry.pastes.map((reference) => ({...reference})),
  };
  return {
    nextId: nextPasteId(current, restored),
    references: restored.references,
  };
}

function nextPasteIdForHistory(
  current: number,
  history: readonly HistoryEntry[],
): number {
  let next = current;
  for (const entry of history) {
    for (const reference of entry.pastes) {
      next = reference.id >= Number.MAX_SAFE_INTEGER - 1
        ? Number.MAX_SAFE_INTEGER
        : Math.max(next, reference.id + 1);
    }
  }
  return next;
}

function nextPasteId(
  previous: PasteRegistryState,
  restored?: PasteRegistryState,
): number {
  let afterReferences = 1;
  for (const reference of restored?.references ?? []) {
    if (!Number.isSafeInteger(reference.id) || reference.id <= 0) continue;
    afterReferences = reference.id === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : Math.max(afterReferences, reference.id + 1);
  }
  const previousNext = Number.isSafeInteger(previous.nextId) && previous.nextId > 0
    ? previous.nextId
    : 1;
  const restoredNext =
    restored && Number.isSafeInteger(restored.nextId) && restored.nextId > 0
      ? restored.nextId
      : 1;
  return Math.max(previousNext, restoredNext, afterReferences);
}

function freshEditor(
  previous: EditorState,
  text = "",
  cursor = text.length,
  pastes?: PasteRegistryState,
): EditorState {
  return {
    ...createEditorState(text, cursor),
    killRing: previous.killRing,
    pastes: {
      nextId: nextPasteId(previous.pastes, pastes),
      references: pastes?.references.map((reference) => ({...reference})) ?? [],
    },
  };
}

export function useInputController(options: InputControllerOptions): InputController {
  const initialEditorRef = useRef<EditorState>(createEditorState());
  const historyStoreRef = useRef<HistoryStore | null>(null);
  if (historyStoreRef.current === null) {
    historyStoreRef.current = options.historyStore ?? new HistoryStore({
      filePath: options.historyPath,
    });
  }
  const [snapshot, setSnapshot] = useState({value: "", cursor: 0});
  const [footer, setFooter] = useState<string>();
  const optionsRef = useRef(options);
  const editorRef = initialEditorRef;
  const pasteIdFloorRef = useRef(editorRef.current.pastes.nextId);
  const contentWidthRef = useRef(80);
  const historyRef = useRef<HistoryEntry[]>([]);
  const historyIndexRef = useRef(0);
  const draftRef = useRef<EditorState | undefined>(undefined);
  const pendingRef = useRef<PendingPress>(undefined);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exitRequestedRef = useRef(false);
  const historyErrorReportedRef = useRef(false);
  const mountedRef = useRef(true);
  const previousActiveRef = useRef(options.active);

  optionsRef.current = options;

  const publish = useCallback((editor: EditorState) => {
    pasteIdFloorRef.current = Math.max(
      pasteIdFloorRef.current,
      editor.pastes.nextId,
    );
    const nextEditor = editor.pastes.nextId < pasteIdFloorRef.current
      ? {
          ...editor,
          pastes: {...editor.pastes, nextId: pasteIdFloorRef.current},
        }
      : editor;
    editorRef.current = nextEditor;
    setSnapshot({value: nextEditor.buffer.text, cursor: nextEditor.buffer.cursor});
  }, []);

  const clearPending = useCallback(() => {
    if (pendingTimerRef.current !== undefined) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = undefined;
    }
    pendingRef.current = undefined;
    setFooter(undefined);
  }, []);

  const reportHistoryError = useCallback((error: unknown) => {
    if (!mountedRef.current || historyErrorReportedRef.current) return;
    historyErrorReportedRef.current = true;
    optionsRef.current.onHistoryError?.(error);
  }, []);

  const rememberHistory = useCallback((entry: HistoryEntry): boolean => {
    const latest = historyRef.current[historyRef.current.length - 1];
    if (latest && sameHistoryPrompt(latest, entry)) {
      historyIndexRef.current = historyRef.current.length;
      draftRef.current = undefined;
      return false;
    }

    historyRef.current = [...historyRef.current, cloneHistoryEntry(entry)].slice(
      -HISTORY_LIMIT,
    );
    historyIndexRef.current = historyRef.current.length;
    draftRef.current = undefined;
    return true;
  }, []);

  const persistHistory = useCallback(
    (entry: HistoryEntry) => {
      void historyStoreRef.current!.append(entry).catch(reportHistoryError);
    },
    [reportHistoryError],
  );

  const requestExit = useCallback(() => {
    if (exitRequestedRef.current) return;
    exitRequestedRef.current = true;
    clearPending();

    let finished = false;
    const finish = () => {
      if (finished || !mountedRef.current) return;
      finished = true;
      if (exitTimerRef.current !== undefined) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = undefined;
      }
      optionsRef.current.onExit?.();
    };

    exitTimerRef.current = setTimeout(finish, EXIT_FLUSH_MS);
    void historyStoreRef.current!.flush().then(finish, (error) => {
      reportHistoryError(error);
      finish();
    });
  }, [clearPending, reportHistoryError]);

  const replaceEditor = useCallback(
    (
      text = "",
      cursor = text.length,
      pastes?: PasteRegistryState,
    ) => {
      publish(freshEditor(editorRef.current, text, cursor, pastes));
    },
    [publish],
  );

  const restoreEditor = useCallback(
    (editor: EditorState | undefined) => {
      if (!editor) {
        replaceEditor();
        return;
      }
      publish({
        ...editor,
        pastes: {
          nextId: Math.max(
            editorRef.current.pastes.nextId,
            editor.pastes.nextId,
          ),
          references: editor.pastes.references.map((reference) => ({...reference})),
        },
      });
    },
    [publish, replaceEditor],
  );

  const dispatch = useCallback(
    (action: EditorAction) => {
      const result = reduceEditor(editorRef.current, action);
      publish(result.state);
      return result;
    },
    [publish],
  );

  const submit = useCallback(() => {
    if (exitRequestedRef.current) return;
    const submitted = prepareEditorSubmission(editorRef.current);
    if (!submitted.display) return;

    const isExit = submitted.display === "exit" || submitted.display === "quit";
    const entry = historyEntryFromEditor(submitted.display, submitted.pastes);
    const remembered = isExit ? false : rememberHistory(entry);
    if (isExit) {
      historyIndexRef.current = historyRef.current.length;
      draftRef.current = undefined;
    }
    replaceEditor();
    optionsRef.current.onSubmit(
      submitted.display,
      expandPasteReferences(submitted.display, submitted.pastes.references),
    );
    if (remembered) persistHistory(entry);
  }, [persistHistory, rememberHistory, replaceEditor]);

  const armPending = useCallback(
    (
      key: Exclude<PendingPress, undefined>["key"],
      message: string,
      onFirst: () => void,
      onSecond: () => void,
    ) => {
      const now = (optionsRef.current.now ?? monotonicNow)();
      const pending = pendingRef.current;
      if (pending?.key === key && now <= pending.expiresAt) {
        clearPending();
        onSecond();
        return;
      }

      clearPending();
      onFirst();
      const next = {key, expiresAt: now + DOUBLE_PRESS_MS} as const;
      pendingRef.current = next;
      setFooter(message);
      pendingTimerRef.current = setTimeout(() => {
        if (pendingRef.current === next) {
          pendingRef.current = undefined;
          pendingTimerRef.current = undefined;
          setFooter(undefined);
        }
      }, DOUBLE_PRESS_MS);
    },
    [clearPending],
  );

  useEffect(() => {
    let cancelled = false;
    void historyStoreRef.current!.load().then((loaded) => {
      if (cancelled || !mountedRef.current) return;

      const session = historyRef.current;
      const previousIndex = historyIndexRef.current;
      const currentEntry = previousIndex < session.length
        ? session[previousIndex]
        : undefined;
      const disk = loaded.map(cloneHistoryEntry);
      if (
        disk.length > 0 &&
        session.length > 0 &&
        sameHistoryPrompt(disk[disk.length - 1]!, session[0]!)
      ) {
        disk.pop();
      }
      const allHistory = [...disk, ...session];
      const merged = allHistory.slice(-HISTORY_LIMIT);
      historyRef.current = merged;

      if (previousIndex === session.length) {
        historyIndexRef.current = merged.length;
      } else if (currentEntry) {
        const mergedIndex = merged.indexOf(currentEntry);
        historyIndexRef.current = mergedIndex >= 0 ? mergedIndex : merged.length;
      }

      const nextId = nextPasteIdForHistory(
        editorRef.current.pastes.nextId,
        allHistory,
      );
      pasteIdFloorRef.current = Math.max(pasteIdFloorRef.current, nextId);
      editorRef.current = {
        ...editorRef.current,
        pastes: {...editorRef.current.pastes, nextId: pasteIdFloorRef.current},
      };
    }).catch((error) => {
      if (!cancelled && mountedRef.current) reportHistoryError(error);
    });

    return () => {
      cancelled = true;
    };
  }, [reportHistoryError]);

  useEffect(() => {
    if (previousActiveRef.current !== options.active) {
      editorRef.current = {...editorRef.current, insertGroup: undefined};
      clearPending();
      previousActiveRef.current = options.active;
    }
  }, [clearPending, options.active]);

  useLayoutEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      if (pendingTimerRef.current !== undefined) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = undefined;
      }
        if (exitTimerRef.current !== undefined) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = undefined;
        }
      pendingRef.current = undefined;
      };
    },
    [],
  );

  const handleGlobalKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (exitRequestedRef.current) return true;
      if (!optionsRef.current.active || !(stroke.ctrl && stroke.input === "c")) return false;

      armPending(
        "Ctrl-C",
        "Press Ctrl-C again to exit",
        () => {
          historyIndexRef.current = historyRef.current.length;
          draftRef.current = undefined;
          replaceEditor();
        },
        requestExit,
      );
      return true;
    },
    [armPending, replaceEditor, requestExit],
  );

  const recallHistory = useCallback(
    (direction: "up" | "down"): boolean => {
      const history = historyRef.current;
      if (direction === "up") {
        if (history.length === 0 || historyIndexRef.current === 0) return false;
        if (historyIndexRef.current === history.length) {
          draftRef.current = editorRef.current;
        }
        const recalled = history[--historyIndexRef.current]!;
        replaceEditor(
          recalled.display,
          0,
          registryForHistory(editorRef.current.pastes, recalled),
        );
        return true;
      }

      if (historyIndexRef.current >= history.length) return false;
      const index = ++historyIndexRef.current;
      if (index === history.length) {
        restoreEditor(draftRef.current);
      } else {
        const recalled = history[index]!;
        replaceEditor(
          recalled.display,
          0,
          registryForHistory(editorRef.current.pastes, recalled),
        );
      }
      return true;
    },
    [replaceEditor, restoreEditor],
  );

  const handleEditorKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (exitRequestedRef.current) return true;
      if (!optionsRef.current.active) return false;

      const unmodified = !stroke.ctrl && !stroke.meta && !stroke.shift;
      const fusedReturn = unmodified
        ? stroke.input.match(/^([^\r\n]+)\r$/)
        : null;
      if (fusedReturn) {
        clearPending();
        const text = fusedReturn[1]!;
        const now = (optionsRef.current.now ?? monotonicNow)();
        if (text.endsWith("\\")) {
          const withoutBackslash = text.slice(0, -1);
          if (withoutBackslash) dispatch({type: "insert", text: withoutBackslash, now});
          dispatch({type: "newline", now});
        } else {
          dispatch({type: "insert", text, now});
          submit();
        }
        return true;
      }

      if (
        unmodified &&
        stroke.input.length > 1 &&
        (/\r|\n/.test(stroke.input) || stroke.input.length > 800)
      ) {
        clearPending();
        dispatch({
          type: "paste",
          text: stroke.input,
          now: (optionsRef.current.now ?? monotonicNow)(),
        });
        return true;
      }

      if (stroke.name === "escape") {
        if (!editorRef.current.buffer.text) {
          clearPending();
          return true;
        }
        armPending(
          "Escape",
          "Esc again to clear",
          () => undefined,
          () => {
            const draft = editorRef.current;
            const display = draft.buffer.text;
            if (display.trim()) {
              const entry = historyEntryFromEditor(display, draft.pastes);
              const remembered = rememberHistory(entry);
              optionsRef.current.onHistoryEntry?.(display);
              if (remembered) persistHistory(entry);
            } else {
              historyIndexRef.current = historyRef.current.length;
              draftRef.current = undefined;
            }
            replaceEditor();
          },
        );
        return true;
      }

      if (stroke.ctrl && stroke.input === "d" && !editorRef.current.buffer.text) {
        armPending(
          "Ctrl-D",
          "Press Ctrl-D again to exit",
          () => undefined,
          requestExit,
        );
        return true;
      }

      clearPending();
      const now = (optionsRef.current.now ?? monotonicNow)();

      if (stroke.name === "return" && !stroke.shift && !stroke.meta) {
        const buffer = editorRef.current.buffer;
        const previousCursor = buffer.moveLeft().cursor;
        if (
          buffer.cursor > 0 &&
          buffer.text.slice(previousCursor, buffer.cursor) === "\\"
        ) {
          dispatch({type: "delete", direction: "backward", now});
          dispatch({type: "newline", now});
        } else {
          submit();
        }
        return true;
      }

      const action = editorActionForKeystroke(stroke, contentWidthRef.current, now);
      if (!action) return false;

      const result = dispatch(action);
      if (
        action.type === "move" &&
        (action.direction === "up" || action.direction === "down") &&
        result.boundary
      ) {
        recallHistory(action.direction);
      }
      return true;
    },
    [
      armPending,
      clearPending,
      dispatch,
      persistHistory,
      recallHistory,
      rememberHistory,
      replaceEditor,
      requestExit,
      submit,
    ],
  );

  const handlePaste = useCallback(
    (text: string) => {
      if (exitRequestedRef.current || !optionsRef.current.active) return;
      clearPending();
      dispatch({
        type: "paste",
        text,
        now: (optionsRef.current.now ?? monotonicNow)(),
      });
    },
    [clearPending, dispatch],
  );

  const setContentWidth = useCallback((width: number) => {
    contentWidthRef.current = Math.max(
      2,
      Number.isFinite(width) ? Math.floor(width) : 2,
    );
  }, []);

  return {
    view: {...snapshot, active: options.active, footer},
    handleGlobalKey,
    handleEditorKey,
    handlePaste,
    requestExit,
    setContentWidth,
  };
}
