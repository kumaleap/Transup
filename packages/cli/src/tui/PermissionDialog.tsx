/**
 * 权限确认对话框（视图层）—— 状态与按键在 use-permission-controller
 *
 * 结构（对齐交互规格 04 §2 的骨架）：
 *   ◈ 标题 · 副标题(路径/工具名)          ← 粗体 + dim
 *   预览（diff / 命令 / 参数 JSON）        ← 外部渲染好的 ANSI 原样透传
 *   解释行（命中了哪条规则）/ 敏感路径警告
 *   问题 + 三段式选项（❯ 焦点、数字序号、input 选项内联值、附言展开）
 *   底部键位提示
 */
import React from "react";
import { Box, Text } from "./runtime/index.js";
import { T } from "../theme.js";
import type { PermissionDialogView } from "./permission/use-permission-controller.js";
import type { PermissionOption } from "./permission/types.js";

/** Top-and-bottom dashed frame used for file diff previews. */
const dashedEdges = {
  topLeft: "╌",
  top: "╌",
  topRight: "╌",
  left: "",
  right: "",
  bottomLeft: "╌",
  bottom: "╌",
  bottomRight: "╌",
};

function OptionRow({
  option,
  index,
  focused,
  editing,
}: {
  option: PermissionOption;
  index: number;
  focused: boolean;
  editing: PermissionDialogView["editing"];
}) {
  const pointer = focused ? "❯" : " ";
  const labelColor = focused ? T.primary : undefined;
  const inputEditing = focused && editing?.type === "input";
  const inputValue = inputEditing ? editing.value : option.input?.value;

  return (
    <Box flexDirection="column">
      <Text color={labelColor}>
        {pointer} {index + 1}. {option.label}
        {option.input && (
          <>
            <Text color={inputEditing ? T.warn : T.secondary}>{inputValue}</Text>
            {inputEditing && <Text color={T.warn}>▏</Text>}
            {!inputEditing && focused && <Text dimColor>（Tab 编辑）</Text>}
          </>
        )}
        {option.sessionShortcut && <Text dimColor> (shift+tab)</Text>}
      </Text>
      {focused && editing?.type === "feedback" && (
        <Text>
          {"    └ 附言: "}
          {editing.value ? (
            <Text color={T.warn}>{editing.value}</Text>
          ) : (
            <Text dimColor>{option.feedbackPlaceholder}</Text>
          )}
          <Text color={T.warn}>▏</Text>
        </Text>
      )}
    </Box>
  );
}

export function PermissionDialog({ view }: { view: PermissionDialogView }) {
  const { model, focusIndex, editing, queueLength } = view;
  const hasFeedback = model.options.some((o) => o.feedbackPlaceholder);
  const hasSession = model.options.some((o) => o.sessionShortcut);

  const hints = editing
    ? "Enter 提交 · Esc 收起"
    : [
        "↑↓ 选择",
        "数字直选",
        "Enter 确认",
        "Esc 取消",
        ...(hasFeedback ? ["Tab 附言"] : []),
        ...(hasSession ? ["Shift+Tab 会话级"] : []),
      ].join(" · ");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={T.warn} paddingX={1}>
      <Text>
        <Text color={T.warn} bold>
          ◈ {model.title}
        </Text>
        {model.subtitle && <Text dimColor> · {model.subtitle}</Text>}
        {queueLength > 1 && <Text dimColor>（还有 {queueLength - 1} 个待确认）</Text>}
      </Text>

      {model.previewKind === "diff" ? (
        <Box
          flexDirection="column"
          borderStyle={dashedEdges}
          borderLeft={false}
          borderRight={false}
          borderColor={T.border}
          borderDimColor
        >
          <Text>{model.preview}</Text>
        </Box>
      ) : (
        model.preview && <Text>{model.preview}</Text>
      )}
      {model.explanation && <Text dimColor>{model.explanation}</Text>}
      {model.warning && <Text color={T.warn}>{model.warning}</Text>}

      <Box marginTop={1} flexDirection="column">
        <Text color={T.warn}>{model.question}</Text>
        {model.options.map((option, i) => (
          <OptionRow
            key={option.value}
            option={option}
            index={i}
            focused={i === focusIndex}
            editing={editing}
          />
        ))}
      </Box>

      <Text dimColor>{hints}</Text>
    </Box>
  );
}
