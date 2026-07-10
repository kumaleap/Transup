import {useCallback, useRef, useState} from "react";
import type {Keystroke} from "./keybinding-router.js";
import {TextBuffer} from "./text-buffer.js";

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
  const bufferRef = useRef(TextBuffer.from());
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(0);
  const draftRef = useRef("");
  const pastesRef = useRef<Map<number, string>>(new Map());
  const pasteSequenceRef = useRef(0);

  optionsRef.current = options;

  const update = useCallback((buffer: TextBuffer) => {
    bufferRef.current = buffer;
    setSnapshot({value: buffer.text, cursor: buffer.cursor});
  }, []);

  const expandPastes = useCallback(
    (text: string) =>
      text.replace(PASTE_MARKER, (marker, id) => pastesRef.current.get(Number(id)) ?? marker),
    [],
  );

  const handleEditorKey = useCallback(
    (stroke: Keystroke): boolean => {
      if (!optionsRef.current.active) return false;

      const buffer = bufferRef.current;
      const value = buffer.text;
      const cursor = buffer.cursor;

      if (stroke.name === "return") {
        const submitted = value.trim();
        if (!submitted) return true;
        historyRef.current.push(submitted);
        historyIndexRef.current = historyRef.current.length;
        draftRef.current = "";
        update(TextBuffer.from());
        optionsRef.current.onSubmit(submitted, expandPastes(submitted));
        return true;
      }

      if (stroke.name === "up") {
        const history = historyRef.current;
        if (history.length === 0 || historyIndexRef.current === 0) return true;
        if (historyIndexRef.current === history.length) draftRef.current = value;
        const index = --historyIndexRef.current;
        const recalled = history[index];
        update(TextBuffer.from(recalled));
        return true;
      }

      if (stroke.name === "down") {
        const history = historyRef.current;
        if (historyIndexRef.current >= history.length) return true;
        const index = ++historyIndexRef.current;
        const recalled = index === history.length ? draftRef.current : history[index];
        update(TextBuffer.from(recalled));
        return true;
      }

      if (stroke.name === "left") {
        update(buffer.moveLeft());
        return true;
      }

      if (stroke.name === "right") {
        update(buffer.moveRight());
        return true;
      }

      if (stroke.name === "backspace" || stroke.name === "delete") {
        update(buffer.deleteBackward());
        return true;
      }

      if (stroke.ctrl && stroke.input === "u") {
        update(buffer.replace(0, cursor, ""));
        return true;
      }

      if (stroke.ctrl && stroke.input === "a") {
        update(buffer.withCursor(0));
        return true;
      }

      if (stroke.ctrl && stroke.input === "e") {
        update(buffer.withCursor(value.length));
        return true;
      }

      if (stroke.name !== "text" || !stroke.input || stroke.ctrl || stroke.meta) return false;

      if (/[\r\n]/.test(stroke.input)) {
        const full = stroke.input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const lines = full.replace(/\n+$/, "").split("\n").length;
        const id = ++pasteSequenceRef.current;
        pastesRef.current.set(id, full);
        const marker = `[粘贴 #${id} · ${lines} 行]`;
        update(buffer.insert(marker));
        return true;
      }

      update(buffer.insert(stroke.input));
      return true;
    },
    [expandPastes, update],
  );

  return {
    view: {...snapshot, active: options.active},
    handleEditorKey,
  };
}
