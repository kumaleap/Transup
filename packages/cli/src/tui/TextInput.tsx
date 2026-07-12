/** 输入框展示层；编辑状态与终端事件由 App 级 controller 持有。 */
import React, {useEffect, useRef} from "react";
import {Box, Text, useBoxMetrics, useStdout, type DOMElement} from "./runtime/index.js";
import { T } from "../theme.js";
import type {InputViewState} from "./input/use-input-controller.js";
import {measureText, type VisualRow} from "./input/measured-text.js";
import {TextBuffer} from "./input/text-buffer.js";

interface Props {
  view: InputViewState;
  rootWidth?: number;
  onContentWidthChange?: (width: number) => void;
}

const PROMPT_WIDTH = 2;
const CURSOR_RESERVE = 1;
const OUTER_COLUMNS = 4;
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

  const before = buffer.text.slice(row.start, buffer.cursor);
  if (buffer.cursor === row.end) {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
      </Text>
    );
  }

  const next = buffer.moveRight().cursor;
  return (
    <Text>
      {before}
      <Text inverse>{buffer.text.slice(buffer.cursor, next)}</Text>
      {buffer.text.slice(next, row.end)}
    </Text>
  );
}

export function TextInput({view, rootWidth, onContentWidthChange}: Props) {
  const rootRef = useRef<DOMElement | null>(null);
  const metrics = useBoxMetrics(rootRef);
  const {stdout} = useStdout();
  const fallbackWidth = Math.max(0, (stdout.columns ?? MIN_ROOT_WIDTH) - OUTER_COLUMNS);
  const availableWidth = rootWidth ?? (metrics.hasMeasured ? metrics.width : fallbackWidth);
  const contentWidth = Math.max(2, availableWidth - PROMPT_WIDTH - CURSOR_RESERVE);
  const footer = view.historySearch
    ? `${view.historySearch.hasMatch ? "search prompts" : "no matching prompt"}: ${view.historySearch.query}`
    : view.footer;

  useEffect(() => {
    onContentWidthChange?.(contentWidth);
  }, [contentWidth, onContentWidthChange]);

  if (!view.active) {
    return (
      <Box ref={rootRef} width="100%">
        <Text dimColor>❯ working… (ctrl+c to interrupt)</Text>
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

  const buffer = TextBuffer.from(view.value, view.cursor);
  const measured = measureText(buffer, contentWidth);

  return (
    <Box ref={rootRef} width="100%" flexDirection="column">
      {measured.rows.map((row, index) => (
        <Box key={`${row.start}:${index}`}>
          <Text color={T.primary}>{index === 0 ? "❯ " : "  "}</Text>
          <RowText
            buffer={buffer}
            row={row}
            showCursor={!view.historySearch && measured.cursor.row === index}
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
