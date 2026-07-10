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
