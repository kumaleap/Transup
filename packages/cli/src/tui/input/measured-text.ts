import stringWidth from "string-width";
import {TextBuffer} from "./text-buffer.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

export interface VisualRow {
  start: number;
  end: number;
  width: number;
  hardBreak: boolean;
}

export interface MeasuredText {
  rows: readonly VisualRow[];
  cursor: {row: number; column: number};
  offsetAt(row: number, column: number): number;
}

interface RowBoundary {
  offset: number;
  column: number;
}

interface InternalRow extends VisualRow {
  boundaries: RowBoundary[];
}

function editableWidth(width: number): number {
  return Math.max(2, Number.isFinite(width) ? Math.floor(width) : 2);
}

function nearestOffset(row: InternalRow, column: number): number {
  if (column === Number.POSITIVE_INFINITY) {
    return row.boundaries[row.boundaries.length - 1]!.offset;
  }

  const target = Number.isFinite(column) ? column : 0;
  let nearest = row.boundaries[0]!;
  let nearestDistance = Math.abs(target - nearest.column);

  for (const boundary of row.boundaries.slice(1)) {
    const distance = Math.abs(target - boundary.column);
    if (distance < nearestDistance) {
      nearest = boundary;
      nearestDistance = distance;
    }
  }
  return nearest.offset;
}

export function measureText(buffer: TextBuffer, width: number): MeasuredText {
  const maxWidth = editableWidth(width);
  const internalRows: InternalRow[] = [];
  let rowStart = 0;
  let rowWidth = 0;
  let boundaries: RowBoundary[] = [{offset: 0, column: 0}];

  const pushRow = (end: number, hardBreak: boolean) => {
    internalRows.push({start: rowStart, end, width: rowWidth, hardBreak, boundaries});
  };

  for (const segment of graphemeSegmenter.segment(buffer.text)) {
    const grapheme = segment.segment;
    const graphemeWidth = stringWidth(grapheme);

    if (grapheme === "\n") {
      pushRow(segment.index, true);
      rowStart = segment.index + grapheme.length;
      rowWidth = 0;
      boundaries = [{offset: rowStart, column: 0}];
      continue;
    }

    if (boundaries.length > 1 && rowWidth + graphemeWidth > maxWidth) {
      pushRow(segment.index, false);
      rowStart = segment.index;
      rowWidth = 0;
      boundaries = [{offset: rowStart, column: 0}];
    }

    rowWidth += graphemeWidth;
    boundaries.push({
      offset: segment.index + grapheme.length,
      column: rowWidth,
    });
  }

  pushRow(buffer.text.length, false);

  let cursor = {row: 0, column: 0};
  for (const [rowIndex, row] of internalRows.entries()) {
    const boundary = row.boundaries.find((candidate) => candidate.offset === buffer.cursor);
    if (boundary) cursor = {row: rowIndex, column: boundary.column};
  }

  const rows = internalRows.map(({boundaries: _boundaries, ...row}) => row);

  return {
    rows,
    cursor,
    offsetAt(row, column) {
      const rowIndex = Math.min(
        internalRows.length - 1,
        Math.max(0, Number.isNaN(row) ? 0 : Math.trunc(row)),
      );
      return nearestOffset(internalRows[rowIndex]!, column);
    },
  };
}
