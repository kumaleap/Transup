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
  expandPasteReferences,
  type PasteRegistryState,
} from "./paste-registry.js";

export interface InputControllerOptions {
  active: boolean;
  onSubmit: (display: string, expanded: string) => void;
  onExit?: () => void;
  onHistoryEntry?: (draft: string) => void;
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
  setContentWidth: (width: number) => void;
}

type PendingPress =
  | {
      key: "Ctrl-C" | "Ctrl-D" | "Escape";
      expiresAt: number;
    }
  | undefined;

const DOUBLE_PRESS_MS = 800;

interface HistoryEntry {
  display: string;
  pastes: PasteRegistryState;
}

function monotonicNow(): number {
  return performance.now();
}

function clonePastes(pastes: PasteRegistryState): PasteRegistryState {
  return {
    nextId: pastes.nextId,
    references: pastes.references.map((reference) => ({...reference})),
  };
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
  const [snapshot, setSnapshot] = useState({value: "", cursor: 0});
  const [footer, setFooter] = useState<string>();
  const optionsRef = useRef(options);
  const editorRef = initialEditorRef;
  const contentWidthRef = useRef(80);
  const historyRef = useRef<HistoryEntry[]>([]);
  const historyIndexRef = useRef(0);
  const draftRef = useRef<EditorState | undefined>(undefined);
  const pendingRef = useRef<PendingPress>(undefined);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previousActiveRef = useRef(options.active);

  optionsRef.current = options;

  const publish = useCallback((editor: EditorState) => {
    editorRef.current = editor;
    setSnapshot({value: editor.buffer.text, cursor: editor.buffer.cursor});
  }, []);

  const clearPending = useCallback(() => {
    if (pendingTimerRef.current !== undefined) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = undefined;
    }
    pendingRef.current = undefined;
    setFooter(undefined);
  }, []);

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

  const dispatch = useCallback(
    (action: EditorAction) => {
      const result = reduceEditor(editorRef.current, action);
      publish(result.state);
      return result;
    },
    [publish],
  );

  const submit = useCallback(() => {
    const submitted = prepareEditorSubmission(editorRef.current);
    if (!submitted.display) return;

    historyRef.current.push({
      display: submitted.display,
      pastes: clonePastes(submitted.pastes),
    });
    historyIndexRef.current = historyRef.current.length;
    draftRef.current = undefined;
    replaceEditor();
    optionsRef.current.onSubmit(
      submitted.display,
      expandPasteReferences(submitted.display, submitted.pastes.references),
    );
  }, [replaceEditor]);

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
    if (previousActiveRef.current !== options.active) {
      editorRef.current = {...editorRef.current, insertGroup: undefined};
      clearPending();
      previousActiveRef.current = options.active;
    }
  }, [clearPending, options.active]);

  useLayoutEffect(
    () => () => {
      if (pendingTimerRef.current !== undefined) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = undefined;
      }
      pendingRef.current = undefined;
    },
    [],
  );

  const handleGlobalKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (!optionsRef.current.active || !(stroke.ctrl && stroke.input === "c")) return false;

      armPending(
        "Ctrl-C",
        "Press Ctrl-C again to exit",
        () => {
          historyIndexRef.current = historyRef.current.length;
          draftRef.current = undefined;
          replaceEditor();
        },
        () => optionsRef.current.onExit?.(),
      );
      return true;
    },
    [armPending, replaceEditor],
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
          recalled.display.length,
          recalled.pastes,
        );
        return true;
      }

      if (historyIndexRef.current >= history.length) return false;
      const index = ++historyIndexRef.current;
      if (index === history.length) {
        const draft = draftRef.current;
        replaceEditor(
          draft?.buffer.text,
          draft?.buffer.cursor,
          draft?.pastes,
        );
      } else {
        const recalled = history[index]!;
        replaceEditor(
          recalled.display,
          recalled.display.length,
          recalled.pastes,
        );
      }
      return true;
    },
    [replaceEditor],
  );

  const handleEditorKey = useCallback(
    (stroke: Keystroke): boolean => {
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
              historyRef.current.push({
                display,
                pastes: clonePastes(draft.pastes),
              });
              optionsRef.current.onHistoryEntry?.(display);
            }
            historyIndexRef.current = historyRef.current.length;
            draftRef.current = undefined;
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
          () => optionsRef.current.onExit?.(),
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
    [armPending, clearPending, dispatch, recallHistory, replaceEditor, submit],
  );

  const handlePaste = useCallback(
    (text: string) => {
      if (!optionsRef.current.active) return;
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
    setContentWidth,
  };
}
