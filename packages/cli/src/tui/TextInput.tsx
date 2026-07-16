/** 输入框展示层；编辑状态与终端事件由 App 级 controller 持有。 */
import React, {useEffect, useRef} from "react";
import {
  Box,
  Text,
  useBoxMetrics,
  useCursor,
  useStdout,
  type DOMElement,
} from "./runtime/index.js";
import { T } from "../theme.js";
import { color } from "../ui.js";
import type {InputViewState} from "./input/use-input-controller.js";
import {measureText, type VisualRow} from "./input/measured-text.js";
import {TextBuffer} from "./input/text-buffer.js";

export interface LayoutMetrics {
  width: number;
  height: number;
  left: number;
  top: number;
  hasMeasured: boolean;
}

export interface CursorAncestorMetrics {
  appRoot: LayoutMetrics;
  inputArea: LayoutMetrics;
  border: LayoutMetrics;
}

interface Props {
  view: InputViewState;
  rootWidth?: number;
  ancestorMetrics?: CursorAncestorMetrics;
  onContentWidthChange?: (width: number) => void;
}

const PROMPT_WIDTH = 2;
const CURSOR_RESERVE = 1;
// 输入容器只有左右 padding；上下边线不占横向列，左右边线已关闭。
const OUTER_COLUMNS = 2;
const MIN_ROOT_WIDTH = PROMPT_WIDTH + 2 + CURSOR_RESERVE;

interface RowTextProps {
  buffer: TextBuffer;
  row: VisualRow;
  showCursor: boolean;
  match?: {start: number; end: number};
}

export function RowText({buffer, row, showCursor, match}: RowTextProps) {
  const matchStart = Math.max(row.start, match?.start ?? row.end);
  const matchEnd = Math.min(row.end, match?.end ?? row.start);
  if (matchStart < matchEnd) {
    return (
      <Text>
        {buffer.text.slice(row.start, matchStart)}
        <Text color={T.warn}>{buffer.text.slice(matchStart, matchEnd)}</Text>
        {buffer.text.slice(matchEnd, row.end)}
      </Text>
    );
  }

  if (!showCursor) return <Text>{buffer.text.slice(row.start, row.end)}</Text>;

  // 软件光标用自家 ANSI 反白而不是 <Text inverse>：Ink 的色码在非 TTY
  // 环境会被吞掉（测试里断言不到），自家色码始终输出
  const before = buffer.text.slice(row.start, buffer.cursor);
  if (buffer.cursor === row.end) {
    return (
      <Text>
        {before + color.inverse(" ")}
      </Text>
    );
  }

  const next = buffer.moveRight().cursor;
  return (
    <Text>
      {before + color.inverse(buffer.text.slice(buffer.cursor, next)) + buffer.text.slice(next, row.end)}
    </Text>
  );
}

function measuredCursorOrigin(
  ancestorMetrics: CursorAncestorMetrics | undefined,
  inputMetrics: LayoutMetrics,
): {x: number; y: number} | undefined {
  if (!inputMetrics.hasMeasured) return undefined;
  if (!ancestorMetrics) return undefined;

  const {appRoot, inputArea, border} = ancestorMetrics;
  const hasKnownRootOrigin =
    appRoot.hasMeasured || (appRoot.left === 0 && appRoot.top === 0);
  if (!hasKnownRootOrigin || !inputArea.hasMeasured || !border.hasMeasured) {
    return undefined;
  }

  return {
    x: appRoot.left + inputArea.left + border.left + inputMetrics.left,
    y: appRoot.top + inputArea.top + border.top + inputMetrics.top,
  };
}

export function TextInput({
  view,
  rootWidth,
  ancestorMetrics,
  onContentWidthChange,
}: Props) {
  const rootRef = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(rootRef);
  const {setCursorPosition} = useCursor();
  const {stdout} = useStdout();
  const fallbackWidth = Math.max(0, (stdout.columns ?? MIN_ROOT_WIDTH) - OUTER_COLUMNS);
  const availableWidth = rootWidth ?? (
    metrics.hasMeasured ? metrics.width : fallbackWidth
  );
  const contentWidth = Math.max(2, availableWidth - PROMPT_WIDTH - CURSOR_RESERVE);
  const footer = view.historySearch
    ? `${view.historySearch.hasMatch ? "search prompts" : "no matching prompt"}: ${view.historySearch.query}`
    : view.footer;
  const buffer = TextBuffer.from(view.value, view.cursor);
  const measured = measureText(buffer, contentWidth);
  const origin = measuredCursorOrigin(ancestorMetrics, metrics);
  const showTerminalCursor =
    view.active &&
    !view.historySearch &&
    availableWidth >= MIN_ROOT_WIDTH &&
    origin !== undefined;
  setCursorPosition(
    showTerminalCursor
      ? {
          x: origin.x + PROMPT_WIDTH + measured.cursor.column,
          y: origin.y + measured.cursor.row,
        }
      : undefined,
  );

  useEffect(() => {
    onContentWidthChange?.(contentWidth);
  }, [contentWidth, onContentWidthChange]);

  if (!view.active) {
    return (
      <Box ref={rootRef} width="100%">
        <Text dimColor>❯ working… (esc to interrupt)</Text>
      </Box>
    );
  }

  if (availableWidth < MIN_ROOT_WIDTH) {
    return (
      <Box ref={rootRef} width="100%" flexDirection="column">
        <Text>…</Text>
        {footer && <Text dimColor>{footer}</Text>}
      </Box>
    );
  }

  return (
    <Box ref={rootRef} width="100%" flexDirection="column">
      {measured.rows.map((row, index) => (
        <Box key={`${row.start}:${index}`}>
          <Text color={T.primary}>{index === 0 ? "❯ " : "  "}</Text>
          <RowText
            buffer={buffer}
            row={row}
            // 真实终端光标可用时交给它（原生闪烁）；反白软件光标只做兜底，
            // 两者叠加会变成一个不闪的实心块
            showCursor={
              !view.historySearch &&
              !showTerminalCursor &&
              measured.cursor.row === index
            }
            match={view.historySearch?.match}
          />
        </Box>
      ))}
      {footer && (
        <Box>
          <Text dimColor>{footer}</Text>
        </Box>
      )}
    </Box>
  );
}
