import {useCallback, useRef, useState} from "react";
import type {Keystroke} from "./keybinding-router.js";

export interface InputControllerOptions {
  active: boolean;
  onSubmit: (display: string, expanded: string) => void;
}

export interface InputViewState {
  value: string;
  cursor: number;
  active: boolean;
  footer?: string;
}

export interface InputController {
  view: InputViewState;
  handleEditorKey: (stroke: Keystroke) => boolean;
}

const PASTE_MARKER = /\[粘贴 #(\d+) · \d+ 行\]/g;

export function useInputController(options: InputControllerOptions): InputController {
  const [snapshot, setSnapshot] = useState({value: "", cursor: 0});
  const optionsRef = useRef(options);
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(0);
  const draftRef = useRef("");
  const pastesRef = useRef<Map<number, string>>(new Map());
  const pasteSequenceRef = useRef(0);

  optionsRef.current = options;

  const update = useCallback((value: string, cursor: number) => {
    valueRef.current = value;
    cursorRef.current = cursor;
    setSnapshot({value, cursor});
  }, []);

  const expandPastes = useCallback(
    (text: string) =>
      text.replace(PASTE_MARKER, (marker, id) => pastesRef.current.get(Number(id)) ?? marker),
    [],
  );

  const handleEditorKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (!optionsRef.current.active) return false;

      const value = valueRef.current;
      const cursor = cursorRef.current;

      if (stroke.name === "return") {
        const submitted = value.trim();
        if (!submitted) return true;
        historyRef.current.push(submitted);
        historyIndexRef.current = historyRef.current.length;
        draftRef.current = "";
        update("", 0);
        optionsRef.current.onSubmit(submitted, expandPastes(submitted));
        return true;
      }

      if (stroke.name === "up") {
        const history = historyRef.current;
        if (history.length === 0 || historyIndexRef.current === 0) return true;
        if (historyIndexRef.current === history.length) draftRef.current = value;
        const index = --historyIndexRef.current;
        const recalled = history[index];
        update(recalled, recalled.length);
        return true;
      }

      if (stroke.name === "down") {
        const history = historyRef.current;
        if (historyIndexRef.current >= history.length) return true;
        const index = ++historyIndexRef.current;
        const recalled = index === history.length ? draftRef.current : history[index];
        update(recalled, recalled.length);
        return true;
      }

      if (stroke.name === "left") {
        update(value, Math.max(0, cursor - 1));
        return true;
      }

      if (stroke.name === "right") {
        update(value, Math.min(value.length, cursor + 1));
        return true;
      }

      if (stroke.name === "backspace" || stroke.name === "delete") {
        if (cursor > 0) {
          update(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        }
        return true;
      }

      if (stroke.ctrl && stroke.input === "u") {
        update(value.slice(cursor), 0);
        return true;
      }

      if (stroke.ctrl && stroke.input === "a") {
        update(value, 0);
        return true;
      }

      if (stroke.ctrl && stroke.input === "e") {
        update(value, value.length);
        return true;
      }

      if (stroke.name !== "text" || !stroke.input || stroke.ctrl || stroke.meta) return false;

      if (/[\r\n]/.test(stroke.input)) {
        const full = stroke.input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = full.replace(/\n+$/, "").split("\n").length;
        const id = ++pasteSequenceRef.current;
        pastesRef.current.set(id, full);
        const marker = `[粘贴 #${id} · ${lines} 行]`;
        update(value.slice(0, cursor) + marker + value.slice(cursor), cursor + marker.length);
        return true;
      }

      update(
        value.slice(0, cursor) + stroke.input + value.slice(cursor),
        cursor + stroke.input.length,
      );
      return true;
    },
    [expandPastes, update],
  );

  return {
    view: {...snapshot, active: options.active},
    handleEditorKey,
  };
}
