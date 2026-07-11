import type {EditorAction} from "./editor.js";

export type InputContext = "permission" | "history-search" | "editor";

export interface InputKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export interface Keystroke {
  input: string;
  name:
    | "text"
    | "up"
    | "down"
    | "left"
    | "right"
    | "home"
    | "end"
    | "return"
    | "escape"
    | "tab"
    | "backspace"
    | "delete"
    | "page-up"
    | "page-down";
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export type KeyHandler = (stroke: Keystroke) => boolean;

export interface RouteHandlers {
  global: KeyHandler;
  permission?: KeyHandler;
  historySearch?: KeyHandler;
  editor?: KeyHandler;
}

export function normalizeKeystroke(input: string, key: InputKey): Keystroke {
  if (input === "\x1f") {
    return {
      input: "_",
      name: "text",
      ctrl: true,
      shift: false,
      meta: false,
    };
  }

  const name: Keystroke["name"] = key.upArrow
    ? "up"
    : key.downArrow
      ? "down"
      : key.leftArrow
        ? "left"
        : key.rightArrow
          ? "right"
          : key.home
            ? "home"
            : key.end
              ? "end"
              : key.return
                ? "return"
                : key.escape
                  ? "escape"
                  : key.tab
                    ? "tab"
                    : key.backspace
                      ? "backspace"
                      : key.delete
                        ? "delete"
                        : key.pageUp
                          ? "page-up"
                          : key.pageDown
                            ? "page-down"
                            : "text";

  return {
    input,
    name,
    ctrl: key.ctrl,
    shift: key.shift,
    meta: name === "escape" ? false : key.meta,
  };
}

export function editorActionForKeystroke(
  stroke: Keystroke,
  width: number,
  now: number,
): EditorAction | undefined {
  switch (stroke.name) {
    case "up":
    case "down":
    case "left":
    case "right":
      return {type: "move", direction: stroke.name, width};
    case "home":
      return {type: "move", direction: "line-start", width};
    case "end":
      return {type: "move", direction: "line-end", width};
    case "backspace":
      return {type: "delete", direction: "backward", now};
    case "delete":
      return {type: "delete", direction: "forward", now};
    case "return":
      return stroke.shift || stroke.meta ? {type: "newline", now} : undefined;
    default:
      break;
  }

  if (stroke.ctrl && stroke.shift && stroke.input === "-") {
    return {type: "undo", now};
  }

  if (stroke.ctrl) {
    switch (stroke.input) {
      case "a":
        return {type: "move", direction: "line-start", width};
      case "b":
        return {type: "move", direction: "left", width};
      case "d":
        return {type: "delete", direction: "forward", now};
      case "e":
        return {type: "move", direction: "line-end", width};
      case "f":
        return {type: "move", direction: "right", width};
      case "h":
        return {type: "delete", direction: "backward", now};
      case "k":
        return {type: "kill", target: "line-end", now};
      case "u":
        return {type: "kill", target: "line-start", now};
      case "w":
        return {type: "kill", target: "word-left", now};
      case "y":
        return {type: "yank", now};
      case "_":
        return {type: "undo", now};
      default:
        return undefined;
    }
  }

  if (stroke.meta) {
    switch (stroke.input) {
      case "b":
        return {type: "move", direction: "word-left", width};
      case "d":
        return {type: "kill", target: "word-right", now};
      case "f":
        return {type: "move", direction: "word-right", width};
      case "y":
        return {type: "yank-pop", now};
      default:
        return undefined;
    }
  }

  if (stroke.name === "text" && stroke.input && !/[\r\n]/.test(stroke.input)) {
    return {type: "insert", text: stroke.input, now};
  }
  return undefined;
}

export function routeKeystroke(
  stroke: Keystroke,
  context: InputContext,
  handlers: RouteHandlers,
): boolean {
  if (handlers.global(stroke)) return true;

  const handler =
    context === "permission"
      ? handlers.permission
      : context === "history-search"
        ? handlers.historySearch
        : handlers.editor;
  return handler?.(stroke) ?? false;
}
