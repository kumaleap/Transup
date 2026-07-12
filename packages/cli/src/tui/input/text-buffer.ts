const graphemeSegmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
const wordSegmenter = new Intl.Segmenter(undefined, {granularity: "word"});

function clampOffset(offset: number, length: number): number {
  if (Number.isNaN(offset)) return 0;
  return Math.min(length, Math.max(0, Math.trunc(offset)));
}

function clampToGraphemeBoundary(text: string, offset: number): number {
  const candidate = clampOffset(offset, text.length);
  if (candidate === text.length) return candidate;

  let boundary = 0;
  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.index > candidate) break;
    boundary = segment.index;
  }
  return boundary;
}

function normalizeWithCursor(text: string, cursor: number): {text: string; cursor: number} {
  const rawCursor = clampOffset(cursor, text.length);
  const normalizedText = text.normalize("NFC");
  const normalizedPrefixLength = text.slice(0, rawCursor).normalize("NFC").length;

  return {
    text: normalizedText,
    cursor: clampToGraphemeBoundary(normalizedText, normalizedPrefixLength),
  };
}

interface WordSegment {
  start: number;
  end: number;
  isWordLike: boolean;
}

function wordSegments(text: string): WordSegment[] {
  return Array.from(wordSegmenter.segment(text), (segment) => ({
    start: segment.index,
    end: segment.index + segment.segment.length,
    isWordLike: segment.isWordLike ?? false,
  }));
}

export class TextBuffer {
  readonly text: string;
  readonly cursor: number;

  private constructor(text: string, cursor: number) {
    this.text = text;
    this.cursor = cursor;
  }

  static from(text = "", cursor = text.length): TextBuffer {
    const normalized = normalizeWithCursor(text, cursor);
    return new TextBuffer(normalized.text, normalized.cursor);
  }

  withCursor(cursor: number): TextBuffer {
    return TextBuffer.from(this.text, cursor);
  }

  insert(text: string): TextBuffer {
    return this.replace(this.cursor, this.cursor, text);
  }

  replace(start: number, end: number, text: string): TextBuffer {
    const first = clampToGraphemeBoundary(this.text, start);
    const second = clampToGraphemeBoundary(this.text, end);
    const rangeStart = Math.min(first, second);
    const rangeEnd = Math.max(first, second);
    const inserted = text.replace(/\t/g, "    ");
    const result = this.text.slice(0, rangeStart) + inserted + this.text.slice(rangeEnd);

    return TextBuffer.from(result, rangeStart + inserted.length);
  }

  deleteBackward(): TextBuffer {
    if (this.cursor === 0) return this;
    return this.replace(this.moveLeft().cursor, this.cursor, "");
  }

  deleteForward(): TextBuffer {
    if (this.cursor === this.text.length) return this;
    return this.replace(this.cursor, this.moveRight().cursor, "");
  }

  moveLeft(): TextBuffer {
    if (this.cursor === 0) return this;

    let previous = 0;
    for (const segment of graphemeSegmenter.segment(this.text)) {
      if (segment.index >= this.cursor) break;
      previous = segment.index;
    }
    return new TextBuffer(this.text, previous);
  }

  moveRight(): TextBuffer {
    if (this.cursor === this.text.length) return this;

    for (const segment of graphemeSegmenter.segment(this.text)) {
      const next = segment.index + segment.segment.length;
      if (next > this.cursor) return new TextBuffer(this.text, next);
    }
    return new TextBuffer(this.text, this.text.length);
  }

  lineStart(): number {
    return this.cursor === 0 ? 0 : this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  lineEnd(): number {
    const newline = this.text.indexOf("\n", this.cursor);
    return newline === -1 ? this.text.length : newline;
  }

  previousWordStart(): number {
    const segments = wordSegments(this.text);
    let index = segments.length - 1;
    while (index >= 0 && segments[index]!.start >= this.cursor) index--;

    while (index >= 0 && !segments[index]!.isWordLike) index--;
    if (index < 0) return 0;

    let start = segments[index]!.start;
    while (index > 0 && segments[index - 1]!.isWordLike) {
      index--;
      start = segments[index]!.start;
    }
    return start;
  }

  nextWordEnd(): number {
    const segments = wordSegments(this.text);
    let index = segments.findIndex((segment) => segment.end > this.cursor);

    while (index >= 0 && index < segments.length && !segments[index]!.isWordLike) index++;
    if (index < 0 || index >= segments.length) return this.text.length;

    let end = segments[index]!.end;
    while (index + 1 < segments.length && segments[index + 1]!.isWordLike) {
      index++;
      end = segments[index]!.end;
    }
    return end;
  }
}
