import {describe, expect, it, vi} from "vitest";
import {
  normalizeKeystroke,
  routeKeystroke,
  type InputKey,
  type Keystroke,
} from "../../src/tui/input/keybinding-router.js";

const key = (patch: Partial<InputKey> = {}): InputKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...patch,
});

describe("keybinding router", () => {
  it.each<{
    label: string;
    patch: Partial<InputKey>;
    name: Keystroke["name"];
  }>([
    {label: "up", patch: {upArrow: true}, name: "up"},
    {label: "down", patch: {downArrow: true}, name: "down"},
    {label: "left", patch: {leftArrow: true}, name: "left"},
    {label: "right", patch: {rightArrow: true}, name: "right"},
    {label: "home", patch: {home: true}, name: "home"},
    {label: "end", patch: {end: true}, name: "end"},
    {label: "return", patch: {return: true}, name: "return"},
    {label: "escape", patch: {escape: true}, name: "escape"},
    {label: "tab", patch: {tab: true}, name: "tab"},
    {label: "backspace", patch: {backspace: true}, name: "backspace"},
    {label: "delete", patch: {delete: true}, name: "delete"},
    {label: "page up", patch: {pageUp: true}, name: "page-up"},
    {label: "page down", patch: {pageDown: true}, name: "page-down"},
  ])("normalizes $label before printable input", ({patch, name}) => {
    expect(normalizeKeystroke("x", key(patch))).toMatchObject({
      input: "x",
      name,
    });
  });

  it("normalizes Ink escape without the spurious meta modifier", () => {
    expect(normalizeKeystroke("", key({escape: true, meta: true}))).toMatchObject({
      name: "escape",
      meta: false,
    });
  });

  it("preserves uppercase permission input", () => {
    expect(normalizeKeystroke("A", key({shift: true})).input).toBe("A");
  });

  it("preserves modifiers for non-Escape input", () => {
    expect(
      normalizeKeystroke("f", key({ctrl: true, shift: true, meta: true})),
    ).toMatchObject({
      name: "text",
      ctrl: true,
      shift: true,
      meta: true,
    });
  });

  it("stops after the first consumed layer", () => {
    const global = vi.fn(() => false);
    const permission = vi.fn(() => true);
    const editor = vi.fn(() => true);
    const consumed = routeKeystroke(
      normalizeKeystroke("y", key()),
      "permission",
      {global, permission, editor},
    );
    expect(consumed).toBe(true);
    expect(global).toHaveBeenCalledOnce();
    expect(permission).toHaveBeenCalledOnce();
    expect(editor).not.toHaveBeenCalled();
  });

  it("lets a consumed global binding shadow the active context", () => {
    const global = vi.fn(() => true);
    const historySearch = vi.fn(() => true);
    const consumed = routeKeystroke(
      normalizeKeystroke("c", key({ctrl: true})),
      "history-search",
      {global, historySearch},
    );
    expect(consumed).toBe(true);
    expect(global).toHaveBeenCalledOnce();
    expect(historySearch).not.toHaveBeenCalled();
  });

  it.each([
    ["permission", "permission"],
    ["history-search", "historySearch"],
    ["editor", "editor"],
  ] as const)("routes %s only to its active handler", (context, activeHandler) => {
    const handlers = {
      global: vi.fn(() => false),
      permission: vi.fn(() => false),
      historySearch: vi.fn(() => false),
      editor: vi.fn(() => false),
    };
    const consumed = routeKeystroke(
      normalizeKeystroke("x", key()),
      context,
      handlers,
    );
    expect(consumed).toBe(false);
    expect(handlers.global).toHaveBeenCalledOnce();
    expect(handlers[activeHandler]).toHaveBeenCalledOnce();
    for (const [name, handler] of Object.entries(handlers)) {
      if (name !== "global" && name !== activeHandler) {
        expect(handler).not.toHaveBeenCalled();
      }
    }
  });
});
