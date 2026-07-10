# TUI Input Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the component-local prompt input with a grapheme-safe, multiline, persistent input foundation using official Ink 7.1, project history, and incremental `Ctrl+R` search.

**Architecture:** Pure text, measurement, editor, paste, history, and search modules sit behind an App-level input controller. `App` owns the only Ink input and paste subscriptions and routes normalized keystrokes through one synchronous context router; `TextInput` and `PermissionDialog` become presentations. Filesystem history is isolated behind a serialized JSONL store.

**Tech Stack:** Node.js 26.5.0, TypeScript 6.0.3, React 19.2.7, Ink 7.1.0, string-width 8.2.2, Vitest 3.2.7, ink-testing-library 4.0.0.

## Global Constraints

- Work only on branch `feature/tui-input-foundation`.
- Use official Ink 7.1.0; do not copy, translate, or derive Claude's private renderer.
- Pin `.nvmrc` to `26.5.0`; root and CLI engines require Node `>=26`.
- Keep React at stable `19.2.7`, `@types/react` at `19.2.17`, and TypeScript at `6.0.3`.
- Preserve `onSubmit(display, expanded)` and `expandPastes -> expandFileRefs -> runTurn` semantics.
- Preserve `render(..., {exitOnCtrlC: false})` so the central router owns `Ctrl+C`.
- Persist history only to project-local `.transup/history.jsonl`, mode `0600`, with test path injection.
- Every implementation commit contains its tests, passes its targeted suite, typechecks, and uses a Conventional Commit message.
- Stage exact paths only; never add the user's untracked `docs/claude-code-interactions/` directory.

## File Map

- `packages/cli/src/tui/runtime/index.ts`: public renderer adapter and the only TUI input-hook import boundary.
- `packages/cli/src/tui/input/keybinding-router.ts`: Ink key normalization and deterministic context dispatch.
- `packages/cli/src/tui/input/text-buffer.ts`: immutable NFC/grapheme/word editing model.
- `packages/cli/src/tui/input/measured-text.ts`: terminal-cell wrapping and visual offset mapping.
- `packages/cli/src/tui/input/editor.ts`: pure readline actions, kill ring, yank-pop, undo, and visual movement.
- `packages/cli/src/tui/input/paste-registry.ts`: structured folded-paste references and range transforms.
- `packages/cli/src/tui/input/history-store.ts`: versioned JSONL load/append/compact/flush.
- `packages/cli/src/tui/input/history-search.ts`: pure history navigation and incremental search state.
- `packages/cli/src/tui/input/use-input-controller.ts`: synchronous App-level React lifecycle bridge.
- `packages/cli/src/tui/TextInput.tsx`: multiline input/search/footer presentation and cursor declaration.
- `packages/cli/src/tui/PermissionDialog.tsx`: permission presentation only.
- `packages/cli/src/tui/App.tsx`: root subscriptions, context selection, global commands, and controller integration.
- `packages/cli/test/tui-input/*.test.ts`: pure model, router, store, and controller tests.
- `packages/cli/test/tui.test.tsx`: end-to-end App contracts.

---

### Task 1: Upgrade The Supported Runtime

**Files:**
- Create: `.nvmrc`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/tsup.config.ts`
- Modify: `packages/cli/src/doctor.ts`
- Modify: `packages/cli/test/doctor.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: existing workspace scripts and `collectDoctorDiagnostics()`.
- Produces: Node 26 runtime contract; Ink 7.1 `usePaste`, `useCursor`, and `useBoxMetrics`; direct `string-width` dependency.

- [ ] **Step 1: Write the failing runtime-floor tests**

Add these cases to `packages/cli/test/doctor.test.ts` and update existing successful fixtures from Node 22 to Node 26:

```ts
it("rejects Node versions below 26", () => {
  const node = collectDoctorDiagnostics({
    env: {OPENAI_API_KEY: "test"},
    nodeVersion: "v25.9.0",
    cwd: "/repo",
    stdinIsTTY: true,
    settings: {},
  }).find((check) => check.name === "Node");

  expect(node).toEqual({
    name: "Node",
    status: "fail",
    detail: "v25.9.0 is below required >=26",
  });
});

it("accepts Node 26", () => {
  const node = collectDoctorDiagnostics({
    env: {OPENAI_API_KEY: "test"},
    nodeVersion: "v26.5.0",
    cwd: "/repo",
    stdinIsTTY: true,
    settings: {},
  }).find((check) => check.name === "Node");

  expect(node).toEqual({
    name: "Node",
    status: "ok",
    detail: "v26.5.0 satisfies >=26",
  });
});
```

- [ ] **Step 2: Run the targeted test and confirm the red state**

Run: `npx vitest run packages/cli/test/doctor.test.ts`

Expected: the Node 25 case fails because the current diagnostic accepts `>=20`.

- [ ] **Step 3: Apply the runtime and dependency upgrade**

Make these exact configuration changes:

```text
.nvmrc                                  26.5.0
package.json engines.node               >=26
packages/cli/package.json engines.node  >=26
packages/cli/package.json ink           ^7.1.0
packages/cli/package.json string-width  ^8.2.2
packages/cli/tsup.config.ts target       node26
doctor minimum/detail                   >=26
CI/release setup-node                    node-version-file: .nvmrc
```

Update the lockfile with:

```bash
npm install ink@7.1.0 string-width@8.2.2 -w transup
```

Do not change the TypeScript `ES2022` target; Node 26 already supplies the required `Intl.Segmenter` behavior.

- [ ] **Step 4: Verify under the pinned runtime**

Run:

```bash
source "$HOME/.nvm/nvm.sh"
nvm install 26.5.0
nvm use 26.5.0
node --version
npm run typecheck
npm test
npm run build
node packages/cli/dist/index.js --version
```

Expected: Node prints `v26.5.0`; 19 baseline test files and 102 baseline tests pass before later tests are added; build reports target `node26`; the packaged CLI prints its version.

- [ ] **Step 5: Commit the runtime upgrade**

```bash
git add .nvmrc package.json package-lock.json packages/cli/package.json packages/cli/tsup.config.ts packages/cli/src/doctor.ts packages/cli/test/doctor.test.ts .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "chore(tui): upgrade Ink to 7.1 and require Node 26"
```

---

### Task 2: Centralize Terminal Input Routing

**Files:**
- Create: `packages/cli/src/tui/runtime/index.ts`
- Create: `packages/cli/src/tui/input/keybinding-router.ts`
- Create: `packages/cli/src/tui/input/use-input-controller.ts`
- Create: `packages/cli/test/tui-input/keybinding-router.test.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/Banner.tsx`
- Modify: `packages/cli/src/tui/TextInput.tsx`
- Modify: `packages/cli/src/tui/PermissionDialog.tsx`
- Modify: `packages/cli/src/tui/StatusBar.tsx`
- Modify: `packages/cli/src/tui/Transcript.tsx`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: Ink `Key`, existing `onSubmit(display, expanded)`, `PermissionRequest.resolve`, and current code-unit editor behavior.
- Produces: `normalizeKeystroke(input, key)`, `routeKeystroke(stroke, context, handlers)`, `useInputController(options)`, and one root `useInput()` subscription.

- [ ] **Step 1: Write the failing pure router tests**

Create `packages/cli/test/tui-input/keybinding-router.test.ts` with table-driven coverage using this helper:

```ts
import {describe, expect, it, vi} from "vitest";
import {
  normalizeKeystroke,
  routeKeystroke,
  type InputKey,
} from "../../src/tui/input/keybinding-router.js";

const key = (patch: Partial<InputKey> = {}): InputKey => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  ...patch,
});

describe("keybinding router", () => {
  it("normalizes Ink escape without the spurious meta modifier", () => {
    expect(normalizeKeystroke("", key({escape: true, meta: true}))).toMatchObject({
      name: "escape",
      meta: false,
    });
  });

  it("preserves uppercase permission input", () => {
    expect(normalizeKeystroke("A", key({shift: true})).input).toBe("A");
  });

  it("stops after the first consumed layer", () => {
    const global = vi.fn(() => false);
    const permission = vi.fn(() => true);
    const editor = vi.fn(() => true);
    const consumed = routeKeystroke(
      normalizeKeystroke("y", key()),
      "permission",
      {global, permission, editor},
    );
    expect(consumed).toBe(true);
    expect(global).toHaveBeenCalledOnce();
    expect(permission).toHaveBeenCalledOnce();
    expect(editor).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the router test and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/keybinding-router.test.ts`

Expected: module resolution fails because `keybinding-router.ts` does not exist.

- [ ] **Step 3: Implement the adapter and deterministic router**

Use these public types in `keybinding-router.ts`:

```ts
export type InputContext = "permission" | "history-search" | "editor";

export interface InputKey {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageDown: boolean;
  pageUp: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export interface Keystroke {
  input: string;
  name: "text" | "up" | "down" | "left" | "right" | "home" | "end" |
    "return" | "escape" | "tab" | "backspace" | "delete" | "page-up" |
    "page-down";
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

export type KeyHandler = (stroke: Keystroke) => boolean;

export interface RouteHandlers {
  global: KeyHandler;
  permission?: KeyHandler;
  historySearch?: KeyHandler;
  editor?: KeyHandler;
}
```

`normalizeKeystroke()` must check named keys before text, normalize Alt/Meta into `meta`, preserve input case, and force `meta=false` for Escape. `routeKeystroke()` calls `global` first; if unconsumed, it calls only the handler for the supplied context.

`runtime/index.ts` re-exports `render`, `Box`, `Static`, `Text`, `useApp`, `useBoxMetrics`, `useCursor`, `useInput`, `usePaste`, `useStdout`, and the `DOMElement`/`Key` types from `ink`. Change every production Ink import in `packages/cli/src/index.ts` and `packages/cli/src/tui/` to this adapter; test-only `ink-testing-library` imports remain direct.

- [ ] **Step 4: Move current input state above conditional presentation**

Implement the initial controller contract without changing current visible behavior:

```ts
export interface InputControllerOptions {
  active: boolean;
  onSubmit: (display: string, expanded: string) => void;
}

export interface InputViewState {
  value: string;
  cursor: number;
  active: boolean;
  footer?: string;
}

export interface InputController {
  view: InputViewState;
  handleEditorKey: (stroke: Keystroke) => boolean;
}

export function useInputController(options: InputControllerOptions): InputController;
```

Move the existing synchronous `valueRef`, `cursorRef`, in-memory history, draft, paste map, and paste sequence into this App-level hook. Make `TextInput` accept `view` and render only. Remove `useInput()` from both `TextInput` and `PermissionDialog`.

In `App`, mount the sole `useInput()` and route in this exact order:

```ts
useInput((input, key) => {
  const stroke = normalizeKeystroke(input, key);
  routeKeystroke(stroke, permission ? "permission" : "editor", {
    global: handleGlobalKey,
    permission: handlePermissionKey,
    editor: inputController.handleEditorKey,
  });
});
```

`handlePermissionKey` must synchronously guard a request against double resolution, then map `y`/Enter, `n`/Escape, `a`, and uppercase `A` exactly. `handleGlobalKey` retains the existing running-turn abort/second-press exit behavior; idle double-press behavior arrives in Task 4.

- [ ] **Step 5: Add integration regressions for single dispatch and permission preservation**

Add TUI tests that type a draft, trigger a permission dialog through the existing mock provider, resolve it, and verify the draft/controller state did not reset. Also assert pressing `y` resolves permission without inserting `y` into the prompt after the dialog closes.

- [ ] **Step 6: Verify and commit the routing refactor**

Run:

```bash
npx vitest run packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

Expected: all router cases and the full baseline pass with exactly one `useInput()` call under `packages/cli/src/tui/`.

```bash
git add packages/cli/src/index.ts packages/cli/src/tui/runtime/index.ts packages/cli/src/tui/input/keybinding-router.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/App.tsx packages/cli/src/tui/Banner.tsx packages/cli/src/tui/TextInput.tsx packages/cli/src/tui/PermissionDialog.tsx packages/cli/src/tui/StatusBar.tsx packages/cli/src/tui/Transcript.tsx packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui.test.tsx
git commit -m "refactor(tui): centralize terminal input routing"
```

---

### Task 3: Integrate The Grapheme And Measurement Model

**Files:**
- Create: `packages/cli/src/tui/input/text-buffer.ts`
- Create: `packages/cli/src/tui/input/measured-text.ts`
- Create: `packages/cli/test/tui-input/text-buffer.test.ts`
- Create: `packages/cli/test/tui-input/measured-text.test.ts`
- Modify: `packages/cli/src/tui/input/use-input-controller.ts`
- Modify: `packages/cli/src/tui/TextInput.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: direct `string-width`, synchronous controller state, and `Keystroke`.
- Produces: immutable `TextBuffer`, `measureText(buffer, width)`, grapheme-safe basic editing, and wrapped row data.

- [ ] **Step 1: Write failing Unicode buffer tests**

Create tests for ASCII, `你`, `e\u0301`, `👍🏽`, `🇨🇳`, and `👨‍👩‍👧‍👦` using this contract:

```ts
import {describe, expect, it} from "vitest";
import {TextBuffer} from "../../src/tui/input/text-buffer.js";

describe("TextBuffer", () => {
  it.each(["你", "é", "👍🏽", "🇨🇳", "👨‍👩‍👧‍👦"])(
    "deletes %s as one grapheme",
    (value) => {
      const buffer = TextBuffer.from(`a${value}b`, 1 + value.length).deleteBackward();
      expect(buffer.text).toBe("ab");
      expect(buffer.cursor).toBe(1);
    },
  );

  it("normalizes across the insertion boundary and remaps the cursor", () => {
    const result = TextBuffer.from("e", 1).insert("\u0301");
    expect(result.text).toBe("é");
    expect(result.cursor).toBe(1);
  });

  it("clamps a cursor inside a surrogate pair to a boundary", () => {
    expect(TextBuffer.from("a😀b", 2).cursor).toBe(1);
  });
});
```

- [ ] **Step 2: Write failing measurement tests**

Use this row contract:

```ts
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
```

Tests must prove `ab你c` wraps without splitting `你`, hard newline rows are distinct, a ZWJ emoji has one offset boundary, and `offsetAt` chooses the nearest grapheme boundary on shorter rows.

- [ ] **Step 3: Run the model tests and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/text-buffer.test.ts packages/cli/test/tui-input/measured-text.test.ts`

Expected: imports fail because the model files do not exist.

- [ ] **Step 4: Implement `TextBuffer`**

Expose this complete public surface:

```ts
export class TextBuffer {
  readonly text: string;
  readonly cursor: number;

  static from(text?: string, cursor?: number): TextBuffer;
  withCursor(cursor: number): TextBuffer;
  insert(text: string): TextBuffer;
  replace(start: number, end: number, text: string): TextBuffer;
  deleteBackward(): TextBuffer;
  deleteForward(): TextBuffer;
  moveLeft(): TextBuffer;
  moveRight(): TextBuffer;
  lineStart(): number;
  lineEnd(): number;
  previousWordStart(): number;
  nextWordEnd(): number;
}
```

Cache module-level `Intl.Segmenter` instances. Normalize every replacement result as a whole, calculate the new cursor from the normalized raw prefix, and clamp toward the preceding grapheme boundary. Replace inserted tabs with four spaces.

- [ ] **Step 5: Implement measurement and integrate basic editing**

`measureText(buffer, width)` clamps normal editable width to at least two, calls `stringWidth(grapheme)` for each grapheme, creates a hard row for every newline, and wraps before overflow. A grapheme wider than the supplied width occupies one row by itself, preventing loops.

Replace code-unit movement/deletion in the controller with `TextBuffer`. Render rows from `MeasuredText`, using an inverse whole grapheme or inverse trailing space for the cursor. At a root width below five cells, render `…` and keep the model unchanged.

- [ ] **Step 6: Verify the Unicode behavior and commit**

Run:

```bash
npx vitest run packages/cli/test/tui-input/text-buffer.test.ts packages/cli/test/tui-input/measured-text.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

Expected: Unicode matrix passes; the existing paste/provider contract remains green.

```bash
git add packages/cli/src/tui/input/text-buffer.ts packages/cli/src/tui/input/measured-text.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/TextInput.tsx packages/cli/test/tui-input/text-buffer.test.ts packages/cli/test/tui-input/measured-text.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): integrate a grapheme-aware text model"
```

---

### Task 4: Integrate Multiline Readline Editing

**Files:**
- Create: `packages/cli/src/tui/input/editor.ts`
- Create: `packages/cli/test/tui-input/editor.test.ts`
- Modify: `packages/cli/src/tui/input/use-input-controller.ts`
- Modify: `packages/cli/src/tui/input/keybinding-router.ts`
- Modify: `packages/cli/src/tui/TextInput.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: `TextBuffer`, `measureText`, and normalized `Keystroke`.
- Produces: `createEditorState()`, `reduceEditor()`, readline actions, visual boundary effects, kill/yank, undo, newline, and 800ms double-press state.

- [ ] **Step 1: Write failing reducer tests**

Use these stable types in tests:

```ts
export type EditorAction =
  | {type: "insert"; text: string; now: number}
  | {type: "move"; direction: "left" | "right" | "up" | "down" | "line-start" | "line-end" | "word-left" | "word-right"; width: number}
  | {type: "delete"; direction: "backward" | "forward"; now: number}
  | {type: "kill"; target: "line-start" | "line-end" | "word-left" | "word-right"; now: number}
  | {type: "yank" | "yank-pop"; now: number}
  | {type: "newline"; now: number}
  | {type: "undo"; now: number};

export interface EditorResult {
  state: EditorState;
  boundary?: "top" | "bottom";
}
```

Test current-hard-line `Ctrl+A/E/K/U`, `Ctrl+K` newline joining, CJK word movement, visual up/down desired-column preservation, forward Delete, ten-entry kill-ring eviction, forward append/backward prepend accumulation, yank-pop invalidation, fifty-snapshot eviction, and 1000ms insert grouping.

- [ ] **Step 2: Run the reducer test and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/editor.test.ts`

Expected: module resolution fails because `editor.ts` does not exist.

- [ ] **Step 3: Implement the pure reducer**

Use this state shape:

```ts
export interface EditorState {
  buffer: TextBuffer;
  desiredColumn?: number;
  killRing: readonly string[];
  killChain?: {index: number};
  yank?: {start: number; end: number; ringIndex: number};
  undo: readonly EditorSnapshot[];
  insertGroup?: {lastAt: number; cursor: number};
}

export interface EditorSnapshot {
  text: string;
  cursor: number;
  desiredColumn?: number;
  killRing: readonly string[];
  killChain?: {index: number};
  yank?: {start: number; end: number; ringIndex: number};
}

export function createEditorState(text?: string, cursor?: number): EditorState;
export function reduceEditor(state: EditorState, action: EditorAction): EditorResult;
```

All branches return new objects. Any non-kill closes `killChain`; any action other than yank/yank-pop clears `yank`; cursor/non-insert operations close `insertGroup`. `up/down` first uses `measureText`; only an unchanged top/bottom position returns a boundary for history fallback.

- [ ] **Step 4: Map terminal keys and implement newline/submit rules**

Map Home/End, arrows, Backspace/Delete, `Ctrl+A/B/D/E/F/H/K/U/W/Y/_`, `Meta+B/D/F/Y`, and kitty `Ctrl+Shift+-` to reducer actions. Implement:

```text
Enter                 submit
Shift+Enter           newline
Meta+Enter            newline
backslash + Enter     remove backslash, insert newline
text\r fused SSH      insert text, then submit
text\\\r fused SSH    insert text without slash, then newline
```

Use a monotonic `now()` dependency defaulting to `performance.now()` so timer tests inject exact values.

- [ ] **Step 5: Add and test the double-press controller state**

The controller state is:

```ts
type PendingPress = {
  key: "Ctrl-C" | "Ctrl-D" | "Escape";
  expiresAt: number;
} | undefined;
```

Idle `Ctrl+C` clears input and arms `Press Ctrl-C again to exit`; empty-input `Ctrl+D` arms the same exit; second matching press within 800ms invokes `onExit`. Escape with input arms `Esc again to clear`, and the second press calls `onHistoryEntry(draft)` before clearing. Unrelated actions or expiry clear the footer and pending state.

- [ ] **Step 6: Verify and commit readline editing**

Run:

```bash
npx vitest run packages/cli/test/tui-input/editor.test.ts packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

Expected: model and App interaction suites pass; no timer remains after unmount.

```bash
git add packages/cli/src/tui/input/editor.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/input/keybinding-router.ts packages/cli/src/tui/TextInput.tsx packages/cli/test/tui-input/editor.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): integrate multiline readline editing"
```

---

### Task 5: Fold And Restore Official Ink Paste Events

**Files:**
- Create: `packages/cli/src/tui/input/paste-registry.ts`
- Create: `packages/cli/test/tui-input/paste-registry.test.ts`
- Modify: `packages/cli/src/tui/input/editor.ts`
- Modify: `packages/cli/src/tui/input/use-input-controller.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/test/tui-input/editor.test.ts`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: Ink 7.1 `usePaste`, `EditorState`, and `onSubmit(display, expanded)`.
- Produces: structured `PasteReference`, collision-safe expansion, serialized paste metadata, and one root paste subscription.

- [ ] **Step 1: Write failing structured-reference tests**

Use this exact public model:

```ts
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

export function normalizePaste(text: string): string;
export function pasteMarker(id: number, content: string): string;
export function insertPaste(
  display: string,
  cursor: number,
  state: PasteRegistryState,
  text: string,
): {display: string; cursor: number; state: PasteRegistryState};
export function transformPasteReferences(
  references: readonly PasteReference[],
  start: number,
  end: number,
  insertedLength: number,
): readonly PasteReference[];
export function expandPasteReferences(
  display: string,
  references: readonly PasteReference[],
): string;
```

Test CRLF/CR and tab normalization, one-line inline paste, multiline and >800 folding, `+N` as newline count, multiple references, edits before/through a marker, overlapping/invalid range rejection, same-looking literal marker safety, and next ID restoration.

- [ ] **Step 2: Run the paste tests and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/paste-registry.test.ts`

Expected: module resolution fails because `paste-registry.ts` does not exist.

- [ ] **Step 3: Implement paste ranges and include them in editor snapshots**

Add `pastes: PasteRegistryState` to `EditorState` and `EditorSnapshot`. Every edit calls `transformPasteReferences`; insertion at a marker start shifts it, insertion at its end leaves it before the new text, and any edit intersecting the open interval removes the reference. `expandPasteReferences` validates all ranges, then replaces them from highest `start` to lowest.

Before submission, apply `String.trim()` as an explicit range deletion on both ends so structured references shift or invalidate by the same rules as visible text. Expand only after that canonical display/reference pair is produced.

- [ ] **Step 4: Route official and fallback paste exactly once**

In `App`, add the only paste subscription:

```ts
usePaste(inputController.handlePaste, {
  isActive: !running && !permission,
});
```

The normal input handler must still accept multi-character chunks. Route a chunk containing embedded CR/LF or exceeding 800 units to `handlePaste`; route a shorter single-line chunk to editor insertion. Apply the single trailing-CR SSH exception before fallback paste classification.

- [ ] **Step 5: Exercise the real bracketed-paste channel**

Update the integration test to write:

```ts
stdin.write("\x1b[200~行1\n行2\n行3\x1b[201~");
```

Assert the transcript marker is `[Pasted text #1 +2 lines]`, raw lines do not flood the input, the provider receives all three lines, and immediate `\r` submits the updated synchronous state. Add a separate plain `stdin.write("单行批量")` fallback test.

- [ ] **Step 6: Verify and commit paste support**

Run:

```bash
npx vitest run packages/cli/test/tui-input/paste-registry.test.ts packages/cli/test/tui-input/editor.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

```bash
git add packages/cli/src/tui/input/paste-registry.ts packages/cli/src/tui/input/editor.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/App.tsx packages/cli/test/tui-input/paste-registry.test.ts packages/cli/test/tui-input/editor.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): fold and restore bracketed paste content"
```

---

### Task 6: Persist And Navigate Project Prompt History

**Files:**
- Create: `packages/cli/src/tui/input/history-store.ts`
- Create: `packages/cli/test/tui-input/history-store.test.ts`
- Modify: `packages/cli/src/tui/input/use-input-controller.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: display text and validated structured paste references.
- Produces: `HistoryEntry`, `HistoryStore.load/append/flush`, latest-100 in-memory navigation, draft restore, and optional `AppProps.historyPath`.

- [ ] **Step 1: Write failing JSONL store tests**

Use these exact types:

```ts
export interface HistoryEntry {
  v: 1;
  display: string;
  pastes: readonly PasteReference[];
  timestamp: string;
}

export interface HistoryStoreOptions {
  projectRoot?: string;
  filePath?: string;
  io?: HistoryIO;
}

export class HistoryStore {
  constructor(options?: HistoryStoreOptions);
  load(): Promise<readonly HistoryEntry[]>;
  append(entry: HistoryEntry): Promise<void>;
  flush(): Promise<void>;
}
```

Create isolated temporary directories per test and remove them in `afterEach`. Cover missing-file empty load, POSIX `0600`, oldest-to-newest newest-100 ordering, malformed/blank/unknown-version/schema-invalid skipping, Unicode and paste ranges, exact adjacent duplicate suppression, serialized concurrent appends, 200-entry/1MiB compaction, and injected write/sync/rename failures preserving the original.

- [ ] **Step 2: Run store tests and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/history-store.test.ts`

Expected: module resolution fails because `history-store.ts` does not exist.

- [ ] **Step 3: Implement schema validation and serialized mutation**

Define `HistoryIO` as the narrow promise-based methods used by the store (`mkdir`, `readFile`, `open`, `stat`, `rename`, `rm`, `chmod`). Supply a Node `fs/promises` adapter by default and inject throwing adapters in tests.

Maintain `private queue: Promise<void> = Promise.resolve()` and use this generic helper:

```ts
private enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = this.queue.then(operation);
  this.queue = result.then(() => undefined, () => undefined);
  return result;
}
```

Load, duplicate checks, append, and compaction are all chained through it, so an append requested while the initial load is pending cannot race that load. Compaction writes a same-directory `wx` temporary file, syncs, closes, renames, best-effort syncs the directory, and removes only the temporary path on failure.

- [ ] **Step 4: Integrate non-blocking load and synchronous memory history**

Add `historyPath?: string` to `AppProps`. The controller:

```text
mount             start load without blocking render
before load       Up/Down use session entries only
load complete     prepend disk entries, collapse merge-boundary duplicate, cap 100
submit            trim, synchronously append memory, cap 100, call App, enqueue disk
first Up          snapshot exact draft/editor/pastes
Down past newest  restore snapshot
storage error     call onHistoryError once, never cancel submit
normal exit       await flush for at most 500ms, then call Ink exit
```

Up/Down first attempt visual movement; they enter history only on top/bottom boundary. Recalled entries place the cursor at the start, matching the source interaction specification.

Expose `requestExit(): void` from the controller. Route `exit`, `quit`, idle double-press exit, and the second running `Ctrl+C` through this method. It synchronously marks exit pending, races `store.flush()` against a 500ms timer, and invokes the App-provided `onExit` exactly once regardless of flush success.

- [ ] **Step 5: Add restart and failure integration tests**

Render App with a temporary `historyPath`, submit a folded paste, unmount, render a second App with the same path, press Up, submit, and assert the provider receives restored full paste content. Inject a rejecting store/invalid path and assert the prompt still reaches the provider while one diagnostic appears.

- [ ] **Step 6: Verify and commit persistent history**

Run:

```bash
npx vitest run packages/cli/test/tui-input/history-store.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

```bash
git add packages/cli/src/tui/input/history-store.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/App.tsx packages/cli/test/tui-input/history-store.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): persist and navigate project prompt history"
```

---

### Task 7: Add Incremental Ctrl-R Search

**Files:**
- Create: `packages/cli/src/tui/input/history-search.ts`
- Create: `packages/cli/test/tui-input/history-search.test.ts`
- Modify: `packages/cli/src/tui/input/use-input-controller.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/TextInput.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: latest-100 in-memory `HistoryEntry[]`, editor snapshot, and history-search context routing.
- Produces: pure `HistorySearchState`, candidate/match range, accept/cancel/submit effects, and search footer/highlight.

- [ ] **Step 1: Write failing search-state tests**

Use this API:

```ts
export interface HistorySearchState {
  original: EditorState;
  query: TextBuffer;
  candidate: EditorState;
  match?: {start: number; end: number};
  nextIndex: number;
  seen: ReadonlySet<string>;
  hasMatch: boolean;
}

export function startHistorySearch(
  original: EditorState,
  history: readonly HistoryEntry[],
): HistorySearchState;
export function updateHistoryQuery(
  state: HistorySearchState,
  history: readonly HistoryEntry[],
  query: TextBuffer,
): HistorySearchState;
export function nextHistoryMatch(
  state: HistorySearchState,
  history: readonly HistoryEntry[],
): HistorySearchState;
```

Test that empty query immediately selects newest, matching is case-sensitive and uses the last occurrence, repeated `Ctrl+R` skips duplicate display values and moves older, query edit resets at newest, no-match keeps last candidate, never-matched keeps original, Chinese/multiline entries match, and paste references follow the candidate.

- [ ] **Step 2: Run search tests and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/history-search.test.ts`

Expected: module resolution fails because `history-search.ts` does not exist.

- [ ] **Step 3: Implement the pure state transitions**

Search from `history.length - 1` downward. For each unseen display containing the query, clone an editor candidate from the history entry, set the cursor to `lastIndexOf(query) + query.length`, and remember the span. On no match, set `hasMatch=false` without changing `candidate`. Query changes reset `seen` and `nextIndex`.

- [ ] **Step 4: Integrate the search context**

The controller enters search on `Ctrl+R` only while idle. While active:

```text
printable       append query and restart newest
Backspace       delete query grapheme; empty-before-delete cancels
Ctrl+R          next older distinct match
Escape/Tab      accept visible candidate without submit
Enter           accept candidate and submit
Ctrl+C          restore exact original snapshot
```

Mirror context state in a ref before returning from each handler so a following event in the same stdin batch uses the new context. `App` passes `history-search` to `routeKeystroke` while active.

- [ ] **Step 5: Render and test search feedback**

`TextInput` renders `search prompts: <query>` or `no matching prompt: <query>` below the input. Hide the normal inverse cursor during search and color only the matched span with `T.warn`. Add App integration cases for enter, escape, tab, cancel, repeat, no-match, persisted-history search, and permission/global priority.

- [ ] **Step 6: Verify and commit incremental search**

Run:

```bash
npx vitest run packages/cli/test/tui-input/history-search.test.ts packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
```

```bash
git add packages/cli/src/tui/input/history-search.ts packages/cli/src/tui/input/use-input-controller.ts packages/cli/src/tui/App.tsx packages/cli/src/tui/TextInput.tsx packages/cli/test/tui-input/history-search.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): add incremental Ctrl-R history search"
```

---

### Task 8: Declare Measured Terminal Cursor Placement

**Files:**
- Create: `packages/cli/test/fixtures/pty-input-app.tsx`
- Create: `packages/cli/test/tui-input/text-input.test.tsx`
- Create: `packages/cli/test/tui-input/pty-smoke.test.ts`
- Modify: `packages/cli/src/tui/TextInput.tsx`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: `MeasuredText.cursor`, Ink 7.1 `useBoxMetrics`, `useCursor`, `useStdout`, and ancestor Box refs.
- Produces: resize-aware wrap width, output-root-relative cursor coordinates, IME cursor declaration, narrow-terminal fallback, and PTY evidence.

- [ ] **Step 1: Write failing component coordinate tests**

Render a focused `TextInput` under nested boxes with deterministic widths. Assert first render uses injected/root fallback width, measured resize changes wrapping, search/inactive/narrow states hide the cursor, and the calculated point equals:

```ts
const x = root.left + inputArea.left + border.left + textInput.left + 2 + cursor.column;
const y = root.top + inputArea.top + border.top + textInput.top + cursor.row;
```

Mock only the adapter exports, not Ink internals, so the test freezes Transup's coordinate calculation.

- [ ] **Step 2: Run the component test and confirm the red state**

Run: `npx vitest run packages/cli/test/tui-input/text-input.test.tsx`

Expected: assertions fail because `TextInput` does not yet declare a terminal cursor or consume ancestor offsets.

- [ ] **Step 3: Implement measured width and cursor declaration**

Put refs on the App root, input-area box, border box, and TextInput root. Call `useBoxMetrics` for each tracked box and pass ancestor metrics into `TextInput`. Use `hasMeasured ? textInput.width : stdout.columns - 4` as the root-width source, then subtract prompt width two and cursor reserve one for wrapping.

During render call:

```ts
setCursorPosition(showCursor ? {x: absoluteX, y: absoluteY} : undefined);
```

Never call it from a passive effect. When any required ancestor is unmeasured, use the known fallback root origin only if the App root is at `(0, 0)`; otherwise hide the terminal cursor until the next measured render.

- [ ] **Step 4: Add bracketed-paste and cursor PTY smoke**

Create `packages/cli/test/fixtures/pty-input-app.tsx` as a self-contained Ink harness that mounts the production input controller/router/TextInput, writes `SUBMITTED:<expanded>` after submit, and requests exit after the callback. Use the system `script` command when present to launch that fixture through the workspace `tsx` binary, send bracketed paste followed by Enter, and assert the captured stream contains the folded marker, `SUBMITTED:` with full content, bracketed-paste enable/disable escapes, and a cursor-position escape. On macOS invoke `script -q /dev/null <command...>`; on Linux invoke `script -qefc "<quoted command>" /dev/null`. On hosts without a compatible `script`, mark only this test skipped with a reason string.

The test must have a bounded process timeout and terminate the child in cleanup so it cannot leave a running TUI session.

- [ ] **Step 5: Verify on Node 26 and commit cursor placement**

Run:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 26.5.0
npx vitest run packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-input/pty-smoke.test.ts packages/cli/test/tui.test.tsx
npm run typecheck
npm test
npm run build
node packages/cli/dist/index.js --version
git diff --check
```

Expected: all supported automated checks pass; the PTY test either passes or reports its explicit platform skip.

```bash
git add packages/cli/src/tui/TextInput.tsx packages/cli/src/tui/App.tsx packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-input/pty-smoke.test.ts packages/cli/test/tui.test.tsx
git commit -m "feat(tui): declare measured terminal cursor placement"
```

---

### Task 9: Final Requirement And Commit Audit

**Files:**
- Inspect: `docs/superpowers/specs/2026-07-10-tui-input-foundation-design.md`
- Inspect: all files changed since `60ed32c`

**Interfaces:**
- Consumes: completed implementation and commit history.
- Produces: fresh verification evidence and an audit suitable for Claude review.

- [ ] **Step 1: Run the full completion suite under Node 26**

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 26.5.0
npm ci
npm run typecheck
npm test
npm run build
node packages/cli/dist/index.js --version
```

Expected: clean install succeeds, all test files pass with zero failed tests, typecheck/build exit zero, and packaged CLI prints its version.

- [ ] **Step 2: Audit the input-hook and persistence invariants**

Run:

```bash
rg -n "useInput\(|usePaste\(" packages/cli/src/tui
rg -n "history.jsonl|0600|Ctrl\+R|useCursor|useBoxMetrics" packages/cli/src/tui packages/cli/test/tui-input
git diff --check main...HEAD
git status --short --branch
```

Expected: one `useInput()` and one `usePaste()` subscription, both rooted in App/runtime integration; all required features have source and tests; no whitespace errors; the only remaining untracked path is the user's `docs/claude-code-interactions/` directory.

- [ ] **Step 3: Audit atomic commits**

Run:

```bash
git log --reverse --format="%h %s" main..HEAD
git diff --stat main...HEAD
```

Expected: each commit has a Conventional Commit subject, contains the corresponding tests, and no commit includes `docs/claude-code-interactions/`.

- [ ] **Step 4: Request an independent code review and resolve findings**

Use `superpowers:requesting-code-review` with the design spec, this plan, `main` as base, and current `HEAD`. Apply valid findings through `superpowers:receiving-code-review`, rerun the complete suite, and use narrowly scoped `fix(tui): ...` commits for any corrections.
