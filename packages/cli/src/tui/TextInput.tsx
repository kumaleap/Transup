/** 输入框展示层；编辑状态与终端事件由 App 级 controller 持有。 */
import React from "react";
import {Box, Text} from "./runtime/index.js";
import { T } from "../theme.js";
import type {InputViewState} from "./input/use-input-controller.js";

interface Props {
  view: InputViewState;
}

export function TextInput({view}: Props) {
  if (!view.active) {
    return (
      <Box>
        <Text dimColor>❯ working… (ctrl+c to interrupt)</Text>
      </Box>
    );
  }

  // 手动画光标：反色显示光标位置字符
  const before = view.value.slice(0, view.cursor);
  const at = view.value[view.cursor] ?? " ";
  const after = view.value.slice(view.cursor + 1);

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
