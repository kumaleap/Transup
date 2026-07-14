/**
 * 权限对话框控制器 —— 状态 + 按键语义（视图渲染在 PermissionDialog.tsx）
 *
 * 键位（交互规格 04 §10 CustomSelect 的最小集）：
 *   ↑/↓        移动焦点（不回绕）
 *   1-9        数字直选（input 选项以预填值直接提交）
 *   Enter      选中焦点项
 *   Esc        = 选"否"（不带附言）
 *   Tab        焦点项可附言 → 展开附言输入；input 选项 → 进入编辑
 *   Shift+Tab  直选会话级选项（文件对话框约定）
 *
 * 编辑态（附言 / 前缀编辑）吞掉全部按键：Enter 提交、Esc 拒绝、
 * Tab 收起、Backspace 删字 —— 单行、光标恒在末尾的极简输入。
 *
 * 状态以 ref 为权威、useState 只作渲染镜像：按键事件可能在同一 tick
 * 连续到达（快速输入 + 回车），闭包里的 state 会过期，ref 不会。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Keystroke } from "../input/keybinding-router.js";
import { buildPermissionView } from "./options.js";
import type { PermissionOption, PermissionViewModel, ToolUseConfirm } from "./types.js";

export interface PermissionEditing {
  type: "feedback" | "input";
  value: string;
}

export interface PermissionDialogView {
  model: PermissionViewModel;
  focusIndex: number;
  editing: PermissionEditing | null;
  queueLength: number;
}

export interface PermissionController {
  view: PermissionDialogView | null;
  handleKey: (stroke: Keystroke) => boolean;
}

export function usePermissionController(
  confirm: ToolUseConfirm | null,
  queueLength: number,
  /** 对话框内容可用列数（终端宽度变化时 diff 预览要跟着重排） */
  width?: number,
): PermissionController {
  const focusRef = useRef(0);
  const editingRef = useRef<PermissionEditing | null>(null);
  const [focusIndex, setFocusIndexState] = useState(0);
  const [editing, setEditingState] = useState<PermissionEditing | null>(null);

  const setFocus = (v: number) => {
    focusRef.current = v;
    setFocusIndexState(v);
  };
  const setEditing = (v: PermissionEditing | null) => {
    editingRef.current = v;
    setEditingState(v);
  };

  const model = useMemo(
    () => (confirm ? buildPermissionView(confirm, width) : null),
    [confirm, width],
  );

  // 换了一个待确认项 → 焦点与编辑态清零
  useEffect(() => {
    focusRef.current = 0;
    editingRef.current = null;
    setFocusIndexState(0);
    setEditingState(null);
  }, [confirm?.id]);

  if (!confirm || !model) {
    return { view: null, handleKey: () => false };
  }

  const options = model.options;
  const clampFocus = (i: number) => Math.max(0, Math.min(options.length - 1, i));

  const settle = (option: PermissionOption, feedback?: string) => {
    if (option.kind === "allow") {
      confirm.resolve({ kind: "allow", updates: option.updates ?? [], feedback });
    } else {
      confirm.resolve({ kind: "deny", feedback });
    }
  };

  const selectOption = (option: PermissionOption, inputValue?: string) => {
    if (option.input) {
      const value = (inputValue ?? option.input.value).trim();
      if (!value) return; // 空前缀无意义，留在对话框
      confirm.resolve({ kind: "allow", updates: option.input.buildUpdates(value) });
      return;
    }
    settle(option);
  };

  const handleKey = (stroke: Keystroke): boolean => {
    const focused = options[clampFocus(focusRef.current)];
    const editingNow = editingRef.current;

    if (editingNow) {
      if (stroke.name === "escape") {
        setEditing(null);
        confirm.resolve({ kind: "deny" });
        return true;
      }
      if (stroke.name === "tab" && !stroke.shift) {
        setEditing(null);
        return true;
      }
      if (stroke.name === "return") {
        const text = editingNow.value.trim();
        if (editingNow.type === "feedback") settle(focused, text || undefined);
        else selectOption(focused, editingNow.value);
        return true;
      }
      if (stroke.name === "backspace") {
        setEditing({ ...editingNow, value: editingNow.value.slice(0, -1) });
        return true;
      }
      if (stroke.name === "text" && stroke.input && !stroke.ctrl && !stroke.meta) {
        const clean = stroke.input.replace(/[\r\n\x00-\x1f]/g, "");
        if (clean) setEditing({ ...editingNow, value: editingNow.value + clean });
        return true;
      }
      return true; // 编辑态吞掉其余按键，防泄漏到全局
    }

    if (stroke.name === "escape") {
      confirm.resolve({ kind: "deny" });
      return true;
    }
    if (stroke.name === "up") {
      setFocus(clampFocus(focusRef.current - 1));
      return true;
    }
    if (stroke.name === "down") {
      setFocus(clampFocus(focusRef.current + 1));
      return true;
    }
    if (stroke.name === "tab" && stroke.shift) {
      const session = options.find((o) => o.sessionShortcut);
      if (session) selectOption(session);
      return true;
    }
    if (stroke.name === "tab") {
      if (focused.input) setEditing({ type: "input", value: focused.input.value });
      else if (focused.feedbackPlaceholder) setEditing({ type: "feedback", value: "" });
      return true;
    }
    if (stroke.name === "return") {
      selectOption(focused);
      return true;
    }
    if (stroke.name === "text" && /^[1-9]$/.test(stroke.input) && !stroke.ctrl && !stroke.meta) {
      const idx = Number(stroke.input) - 1;
      if (idx < options.length) selectOption(options[idx]);
      return true;
    }
    // 其余可打印字符也吞掉 —— 对话框期间的误触不应有任何副作用
    return stroke.name === "text";
  };

  return {
    view: {
      model,
      focusIndex: clampFocus(focusIndex),
      editing,
      queueLength,
    },
    handleKey,
  };
}
