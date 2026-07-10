import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {
  createEditorState,
  reduceEditor,
  type EditorAction,
  type EditorState,
} from "./editor.js";
import {
  editorActionForKeystroke,
  type Keystroke,
} from "./keybinding-router.js";

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
  setContentWidth: (width: number) => void;
}

type PendingPress =
  | {
      key: "Ctrl-C" | "Ctrl-D" | "Escape";
      expiresAt: number;
    }
  | undefined;

const DOUBLE_PRESS_MS = 800;
const PASTE_MARKER = /\[粘贴 #(\d+) · \d+ 行\]/g;

function monotonicNow(): number {
  return performance.now();
}

function freshEditor(previous: EditorState, text = "", cursor = text.length): EditorState {
  return {
    ...createEditorState(text, cursor),
    killRing: previous.killRing,
  };
}

export function useInputController(options: InputControllerOptions): InputController {
  const initialEditorRef = useRef<EditorState>(createEditorState());
  const [snapshot, setSnapshot] = useState({value: "", cursor: 0});
  const [footer, setFooter] = useState<string>();
  const optionsRef = useRef(options);
  const editorRef = initialEditorRef;
  const contentWidthRef = useRef(80);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(0);
  const draftRef = useRef("");
  const pastesRef = useRef<Map<number, string>>(new Map());
  const pasteSequenceRef = useRef(0);
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
    (text = "", cursor = text.length) => {
      publish(freshEditor(editorRef.current, text, cursor));
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

  const expandPastes = useCallback(
    (text: string) =>
      text.replace(PASTE_MARKER, (marker, id) => pastesRef.current.get(Number(id)) ?? marker),
    [],
  );

  const submit = useCallback(() => {
    const submitted = editorRef.current.buffer.text.trim();
    if (!submitted) return;

    historyRef.current.push(submitted);
    historyIndexRef.current = historyRef.current.length;
    draftRef.current = "";
    replaceEditor();
    optionsRef.current.onSubmit(submitted, expandPastes(submitted));
  }, [expandPastes, replaceEditor]);

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
        () => replaceEditor(),
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
          draftRef.current = editorRef.current.buffer.text;
        }
        const recalled = history[--historyIndexRef.current];
        replaceEditor(recalled);
        return true;
      }

      if (historyIndexRef.current >= history.length) return false;
      const index = ++historyIndexRef.current;
      replaceEditor(index === history.length ? draftRef.current : history[index]);
      return true;
    },
    [replaceEditor],
  );

  const handleEditorKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (!optionsRef.current.active) return false;

      const fusedReturn = stroke.input.match(/^([^\r\n]+)\r$/);
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
            const draft = editorRef.current.buffer.text;
            if (draft.trim()) {
              historyRef.current.push(draft);
              historyIndexRef.current = historyRef.current.length;
              optionsRef.current.onHistoryEntry?.(draft);
            }
            draftRef.current = "";
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

      if (stroke.name === "text" && /[\r\n]/.test(stroke.input)) {
        const full = stroke.input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = full.replace(/\n+$/, "").split("\n").length;
        const id = ++pasteSequenceRef.current;
        pastesRef.current.set(id, full);
        dispatch({type: "insert", text: `[粘贴 #${id} · ${lines} 行]`, now});
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
    setContentWidth,
  };
}
