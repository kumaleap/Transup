/**
 * 通用选择面板（视图）—— 圆角边框 + 标题 + 列表 + 键位提示
 *
 * 视觉语言与权限对话框一致（❯ 焦点指针、数字序号、dim 描述），
 * 但边框用品牌绿：面板是用户主动召唤的工具，不是需要警觉的询问。
 */
import React from "react";
import { Box, Text } from "../runtime/index.js";
import { T } from "../../theme.js";
import type { PanelView } from "./use-panel-controller.js";

const VISIBLE = 10;

export function Panel({ view }: { view: PanelView }) {
  const { title, options, focusIndex } = view;
  // 焦点滚动窗口：最多显示 VISIBLE 条，保证焦点行始终可见
  const start = Math.max(0, Math.min(focusIndex - (VISIBLE - 1), options.length - VISIBLE));
  const visible = options.slice(start, start + VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.primary} paddingX={1}>
      <Text color={T.primary} bold>
        {title}
      </Text>
      {options.length === 0 && <Text dimColor>（空）</Text>}
      {start > 0 && <Text dimColor>  ↑ 还有 {start} 条</Text>}
      {visible.map((option, i) => {
        const index = start + i;
        const focused = index === focusIndex;
        return (
          <Text key={option.value} color={focused ? T.primary : undefined}>
            {focused ? "❯" : " "} {index + 1}. {option.label}
            {option.description && <Text dimColor>  {option.description}</Text>}
          </Text>
        );
      })}
      {start + VISIBLE < options.length && (
        <Text dimColor>  ↓ 还有 {options.length - start - VISIBLE} 条</Text>
      )}
      <Text dimColor>↑↓ 选择 · 数字直选 · Enter 确认 · Esc 关闭</Text>
    </Box>
  );
}
