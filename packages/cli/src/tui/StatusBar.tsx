/**
 * 状态栏 —— 常驻输入框下方一行
 *
 * ◆ deepseek-chat · ~/workspace/Transup
 */
import React from "react";
import {Text} from "./runtime/index.js";
import { T } from "../theme.js";
import { sanitizeTerminalField } from "../terminal-sanitize.js";
import {abbreviateHome} from "./workspace-path.js";

export interface StatusBarProps {
  model: string;
  cwd: string;
}

export function StatusBar({model, cwd}: StatusBarProps) {
  const safeModel = sanitizeTerminalField(model);
  const safeCwd = abbreviateHome(sanitizeTerminalField(cwd));

  return (
    <Text wrap="truncate">
      <Text color={T.primary}>◆ {safeModel}</Text>
      <Text dimColor> · {safeCwd}</Text>
    </Text>
  );
}
