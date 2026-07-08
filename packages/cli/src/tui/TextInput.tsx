/**
 * 自研文本输入框 —— 不用 ink-text-input：
 * 我们要输入历史（↑/↓）和运行中禁用，自己写只有几十行且完全可控。
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  onSubmit: (value: string) => void;
  /** 任务运行中置 false：不接收按键、变暗提示 */
  active: boolean;
}

export function TextInput({ onSubmit, active }: Props) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  // history 游标：history.length 表示"正在编辑新输入"
  const [histIdx, setHistIdx] = useState(0);
  const [draft, setDraft] = useState("");

  useInput(
    (input, key) => {
      if (key.return) {
        const v = value.trim();
        if (!v) return;
        const h = [...history, v];
        setHistory(h);
        setHistIdx(h.length);
        setValue("");
        setCursor(0);
        setDraft("");
        onSubmit(v);
        return;
      }
      if (key.upArrow) {
        if (history.length === 0 || histIdx === 0) return;
        if (histIdx === history.length) setDraft(value); // 暂存未提交的输入
        const i = histIdx - 1;
        setHistIdx(i);
        setValue(history[i]);
        setCursor(history[i].length);
        return;
      }
      if (key.downArrow) {
        if (histIdx >= history.length) return;
        const i = histIdx + 1;
        setHistIdx(i);
        const v = i === history.length ? draft : history[i];
        setValue(v);
        setCursor(v.length);
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
        return;
      }
      if (key.ctrl && input === "u") {
        setValue(value.slice(cursor));
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      // 普通字符（含粘贴的多字符块）；过滤控制键组合
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        const clean = input.replace(/[\r\n]+/g, " ");
        setValue(value.slice(0, cursor) + clean + value.slice(cursor));
        setCursor(cursor + clean.length);
      }
    },
    { isActive: active },
  );

  if (!active) {
    return (
      <Box>
        <Text dimColor>❯ （任务运行中，Ctrl+C 中断）</Text>
      </Box>
    );
  }

  // 手动画光标：反色显示光标位置字符
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Box>
      <Text color="cyan">❯ </Text>
      <Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    </Box>
  );
}
