/**
 * 通用选择面板控制器（规格 06 §2 面板范式的最小集）
 *
 * 权限对话框的选择状态机是 permission 专用（三段式/附言/input 选项）；
 * 这里是它的"平民版"：纯列表选择，给 /sessions 这类命令面板用。
 *
 * 键位：↑/↓ 移动（不回绕）、1-9 数字直选、Enter 确认、Esc 关闭。
 * 状态以 ref 为权威、useState 只作渲染镜像 —— 同一 tick 连续按键
 * 时闭包 state 会过期（04 踩过的坑，同一套解法）。
 */
import { useEffect, useRef, useState } from "react";
import type { Keystroke } from "../input/keybinding-router.js";

export interface PanelOption {
  value: string;
  label: string;
  description?: string;
}

export interface PanelRequest {
  /** 同一时刻至多一个面板；换面板时焦点清零 */
  id: number;
  title: string;
  options: PanelOption[];
  onSelect: (value: string) => void;
  onCancel: () => void;
}

export interface PanelView {
  title: string;
  options: PanelOption[];
  focusIndex: number;
}

export interface PanelController {
  view: PanelView | null;
  handleKey: (stroke: Keystroke) => boolean;
}

export function usePanelController(panel: PanelRequest | null): PanelController {
  const focusRef = useRef(0);
  const [focusIndex, setFocusIndexState] = useState(0);
  const setFocus = (v: number) => {
    focusRef.current = v;
    setFocusIndexState(v);
  };

  useEffect(() => {
    focusRef.current = 0;
    setFocusIndexState(0);
  }, [panel?.id]);

  if (!panel) return { view: null, handleKey: () => false };

  const options = panel.options;
  const clamp = (i: number) => Math.max(0, Math.min(options.length - 1, i));

  const handleKey = (stroke: Keystroke): boolean => {
    if (stroke.name === "escape") {
      panel.onCancel();
      return true;
    }
    if (stroke.name === "up") {
      setFocus(clamp(focusRef.current - 1));
      return true;
    }
    if (stroke.name === "down") {
      setFocus(clamp(focusRef.current + 1));
      return true;
    }
    if (stroke.name === "return") {
      if (options.length > 0) panel.onSelect(options[clamp(focusRef.current)].value);
      return true;
    }
    if (stroke.name === "text" && /^[1-9]$/.test(stroke.input) && !stroke.ctrl && !stroke.meta) {
      const idx = Number(stroke.input) - 1;
      if (idx < options.length) panel.onSelect(options[idx].value);
      return true;
    }
    // 面板打开期间吞掉其余可打印字符，防止漏进输入框
    return stroke.name === "text";
  };

  return {
    view: { title: panel.title, options, focusIndex: clamp(focusIndex) },
    handleKey,
  };
}
