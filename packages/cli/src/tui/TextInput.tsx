/**
 * 自研文本输入框 —— 不用 ink-text-input：
 * 我们要输入历史（↑/↓）和运行中禁用，自己写只有几十行且完全可控。
 */
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { T } from "../theme.js";

interface Props {
  onSubmit: (value: string) => void;
  /** 任务运行中置 false：不接收按键、变暗提示 */
  active: boolean;
}

export function TextInput({ onSubmit, active }: Props) {
  // 按键事件可能在同一个 tick 内连续到达（快速输入、脚本化 stdin），
  // 此时 React 还没来得及重渲染，事件处理闭包里的 state 是上一帧的旧值
  // ——比如"输入文字后立刻回车"会读到空串而吞掉提交。
  // 所以逻辑上的"当前值"放在 ref（同步读写），state 只负责触发渲染。
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef("");
  const cursorRef = useRef(0);
  // 输入历史不参与渲染，纯 ref 即可。histIdx === history.length 表示"正在编辑新输入"
  const history = useRef<string[]>([]);
  const histIdx = useRef(0);
  const draft = useRef("");

  const set = (v: string, c: number) => {
    valueRef.current = v;
    cursorRef.current = c;
    setValue(v);
    setCursor(c);
  };

  useInput(
    (input, key) => {
      const value = valueRef.current;
      const cursor = cursorRef.current;
      if (key.return) {
        const v = value.trim();
        if (!v) return;
        history.current.push(v);
        histIdx.current = history.current.length;
        draft.current = "";
        set("", 0);
        onSubmit(v);
        return;
      }
      if (key.upArrow) {
        const h = history.current;
        if (h.length === 0 || histIdx.current === 0) return;
        if (histIdx.current === h.length) draft.current = value; // 暂存未提交的输入
        const i = --histIdx.current;
        set(h[i], h[i].length);
        return;
      }
      if (key.downArrow) {
        const h = history.current;
        if (histIdx.current >= h.length) return;
        const i = ++histIdx.current;
        const v = i === h.length ? draft.current : h[i];
        set(v, v.length);
        return;
      }
      if (key.leftArrow) {
        set(value, Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        set(value, Math.min(value.length, cursor + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
        return;
      }
      if (key.ctrl && input === "u") {
        set(value.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === "a") {
        set(value, 0);
        return;
      }
      if (key.ctrl && input === "e") {
        set(value, value.length);
        return;
      }
      // 普通字符（含粘贴的多字符块）；过滤控制键组合
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        const clean = input.replace(/[\r\n]+/g, " ");
        set(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
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
      <Text color={T.primary}>❯ </Text>
      <Text>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    </Box>
  );
}
