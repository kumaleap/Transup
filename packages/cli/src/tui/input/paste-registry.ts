export interface PasteReference {
  id: number;
  content: string;
  start: number;
  end: number;
}

export interface PasteRegistryState {
  nextId: number;
  references: readonly PasteReference[];
}

const FOLD_THRESHOLD = 800;

export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").normalize("NFC");
}

export function pasteMarker(id: number, content: string): string {
  const newlineCount = (content.match(/\n/g) ?? []).length;
  return `[Pasted text #${id} +${newlineCount} lines]`;
}

function cloneReference(reference: PasteReference): PasteReference {
  return {...reference};
}

function cloneReferences(
  references: readonly PasteReference[],
): readonly PasteReference[] {
  return references.map(cloneReference);
}

export function transformPasteReferences(
  references: readonly PasteReference[],
  start: number,
  end: number,
  insertedLength: number,
): readonly PasteReference[] {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(insertedLength) ||
    start < 0 ||
    end < start ||
    insertedLength < 0
  ) {
    return cloneReferences(references);
  }

  if (start === end && insertedLength === 0) {
    return cloneReferences(references);
  }

  const insertion = start === end;
  const delta = insertedLength - (end - start);
  const transformed: PasteReference[] = [];

  for (const reference of references) {
    if (insertion) {
      if (start <= reference.start) {
        transformed.push({
          ...reference,
          start: reference.start + insertedLength,
          end: reference.end + insertedLength,
        });
      } else if (start >= reference.end) {
        transformed.push(cloneReference(reference));
      }
      continue;
    }

    if (end <= reference.start) {
      transformed.push({
        ...reference,
        start: reference.start + delta,
        end: reference.end + delta,
      });
    } else if (start >= reference.end) {
      transformed.push(cloneReference(reference));
    }
  }

  return transformed;
}

function nextAvailableId(state: PasteRegistryState): number | undefined {
  const restoredNext = Number.isSafeInteger(state.nextId) && state.nextId > 0
    ? state.nextId
    : 1;
  let afterReferences = 1;
  for (const reference of state.references) {
    if (!Number.isSafeInteger(reference.id) || reference.id <= 0) continue;
    if (reference.id === Number.MAX_SAFE_INTEGER) return undefined;
    afterReferences = Math.max(afterReferences, reference.id + 1);
  }
  const candidate = Math.max(restoredNext, afterReferences);
  return Number.isSafeInteger(candidate) && candidate < Number.MAX_SAFE_INTEGER
    ? candidate
    : undefined;
}

export function insertPaste(
  display: string,
  cursor: number,
  state: PasteRegistryState,
  text: string,
): {display: string; cursor: number; state: PasteRegistryState} {
  const normalized = normalizePaste(text);
  const insertionPoint = Math.max(
    0,
    Math.min(display.length, Number.isFinite(cursor) ? Math.floor(cursor) : display.length),
  );
  const shouldFold = normalized.includes("\n") || normalized.length > FOLD_THRESHOLD;

  if (!shouldFold) {
    return {
      display:
        display.slice(0, insertionPoint) + normalized + display.slice(insertionPoint),
      cursor: insertionPoint + normalized.length,
      state: {
        nextId: state.nextId,
        references: transformPasteReferences(
          state.references,
          insertionPoint,
          insertionPoint,
          normalized.length,
        ),
      },
    };
  }

  const id = nextAvailableId(state);
  if (id === undefined) {
    return {
      display:
        display.slice(0, insertionPoint) + normalized + display.slice(insertionPoint),
      cursor: insertionPoint + normalized.length,
      state: {
        nextId: Number.isSafeInteger(state.nextId) && state.nextId > 0
          ? state.nextId
          : 1,
        references: transformPasteReferences(
          state.references,
          insertionPoint,
          insertionPoint,
          normalized.length,
        ),
      },
    };
  }
  const marker = pasteMarker(id, normalized);
  const references = [
    ...transformPasteReferences(
      state.references,
      insertionPoint,
      insertionPoint,
      marker.length,
    ),
    {
      id,
      content: normalized,
      start: insertionPoint,
      end: insertionPoint + marker.length,
    },
  ].sort((left, right) => left.start - right.start || left.id - right.id);

  return {
    display: display.slice(0, insertionPoint) + marker + display.slice(insertionPoint),
    cursor: insertionPoint + marker.length,
    state: {
      nextId: id + 1,
      references,
    },
  };
}

function isValidReference(
  display: string,
  reference: PasteReference,
): boolean {
  return (
    Number.isSafeInteger(reference.id) &&
    reference.id > 0 &&
    typeof reference.content === "string" &&
    Number.isSafeInteger(reference.start) &&
    Number.isSafeInteger(reference.end) &&
    reference.start >= 0 &&
    reference.end > reference.start &&
    reference.end <= display.length &&
    display.slice(reference.start, reference.end) ===
      pasteMarker(reference.id, reference.content)
  );
}

export function expandPasteReferences(
  display: string,
  references: readonly PasteReference[],
): string {
  const sorted = references.map(cloneReference).sort((left, right) =>
    left.start - right.start || left.end - right.end || left.id - right.id
  );
  const ids = new Set<number>();

  for (let index = 0; index < sorted.length; index++) {
    const reference = sorted[index]!;
    const previous = sorted[index - 1];
    if (
      !isValidReference(display, reference) ||
      ids.has(reference.id) ||
      (previous !== undefined && reference.start < previous.end)
    ) {
      return display;
    }
    ids.add(reference.id);
  }

  let expanded = display;
  for (const reference of [...sorted].reverse()) {
    expanded =
      expanded.slice(0, reference.start) +
      reference.content +
      expanded.slice(reference.end);
  }
  return expanded;
}
