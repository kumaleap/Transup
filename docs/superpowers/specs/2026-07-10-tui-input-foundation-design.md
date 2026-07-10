# TUI Input Foundation Design

Date: 2026-07-10
Status: Self-reviewed and approved for implementation

## Context

Transup currently has a small, component-local input implementation in
`packages/cli/src/tui/TextInput.tsx`. It stores history and pasted text only for
the lifetime of that React component, moves the cursor by UTF-16 code units,
and shares terminal input with independent `useInput()` subscribers in the app
and permission dialog. This is enough for the existing smoke tests, but it does
not provide reliable CJK/emoji editing, multiline visual movement, durable
history, or incremental history search.

The interaction research in `docs/claude-code-interactions/01-输入系统.md`
describes a much broader input system. This design implements only the first
dependency layer needed by later work. It uses public Ink APIs and observable
terminal conventions. It does not copy, translate, or derive code from
Claude's private renderer.

## Goals

The first input-foundation phase will provide:

1. An immutable text buffer whose cursor is always on a grapheme boundary.
2. Terminal-column measurement for CJK, emoji, combining marks, logical lines,
   soft wrapping, and visual vertical movement.
3. A pure editor reducer with common readline/Emacs movement, deletion,
   kill/yank, multiline entry, and undo.
4. One priority-aware keybinding router for the application, permission dialog,
   normal editing, and history search.
5. Bracketed paste through official Ink, plus folded references for large or
   multiline pastes.
6. Project-local persistent prompt history in `.transup/history.jsonl`.
7. Incremental `Ctrl+R` substring search with draft restoration and repeated
   match traversal.
8. An Ink adapter that renders a stable multiline input and delegates all
   editing behavior to the pure model.

## Non-goals

This phase will not add autocomplete, Vim mode, image or voice paste, external
editor integration, bash mode or permission-mode cycling, configurable user keybindings,
mouse selection, alternate-screen rendering, transcript virtualization, or a
custom React renderer. Empty-input Escape message selection is also deferred.
Those features can build on the interfaces introduced here without changing
the text model or history format.

## Runtime Baseline

- Node.js 26.5.0 in `.nvmrc`; package engine requirement `>=26`.
- GitHub Actions and the bundle target use Node 26.
- Ink 7.1.0.
- React 19.2.7 and `@types/react` 19.2.17.
- TypeScript 6.0.3.
- `string-width` 8.2.2 as a direct CLI dependency for terminal-cell width.

Ink remains behind `packages/cli/src/tui/runtime/index.ts`. Application code
imports terminal hooks and primitives from that adapter rather than depending
on additional renderer internals. The adapter initially re-exports official
Ink behavior, which keeps a future renderer experiment isolated and reversible.

## Architecture

```text
Ink input and paste events
        |
        v
KeybindingRouter ---- reserved global > permission > history-search > editor
        |
        v
EditorAction reducer (pure)
        |
        +--> TextBuffer          grapheme-safe immutable edits
        +--> MeasuredText        terminal width, wrapping, visual positions
        +--> PasteRegistry       folded display references and expansion
        +--> HistorySearchState  query, match, original draft
        |
        v
App-level InputController ---- synchronous state and lifecycle
        |
        +--> HistoryStore append/load/compact
        +--> App onSubmit(display, expanded)
        |
        v
TextInput presentation ---- render display text and cursor
```

Pure modules do not import React, Ink, the agent engine, or the filesystem.
Filesystem persistence does not import React or Ink. The React adapter owns
lifecycle wiring only.

## Components

### Runtime adapter

`packages/cli/src/tui/runtime/index.ts` is the only local module allowed to
re-export Ink's input-facing hooks and layout primitives. It establishes the
renderer boundary without creating a custom renderer in this phase.

### TextBuffer

`input/text-buffer.ts` stores normalized text and a UTF-16 cursor offset. The
offset is an external compatibility coordinate, but every constructor and
operation clamps it to a valid grapheme boundary. `Intl.Segmenter` with
`granularity: "grapheme"` supplies segmentation under the Node 26 baseline.

The immutable API covers insert, replace, backward/forward deletion, grapheme
movement, logical-line bounds, and word bounds. After every mutation, the whole
result is NFC-normalized. The cursor is remapped by NFC-normalizing the raw
prefix through the intended cursor and using that prefix length, then clamped
to a boundary in the normalized result. This handles composition that crosses
an insertion boundary, such as inserting a combining acute accent after `e`.
A delete operation never leaves half of a surrogate pair, combining sequence,
emoji modifier sequence, flag, or ZWJ emoji.

Word operations use `Intl.Segmenter` with `granularity: "word"`. A word is a
segment whose `isWordLike` flag is true. Backward word movement skips adjacent
non-word segments, then moves to the start of the preceding contiguous run of
word-like segments; forward movement skips non-word segments, then moves to the
end of the next contiguous word-like run. CJK word-like segments participate in
the same rule, while whitespace and punctuation are separators.

### MeasuredText

`input/measured-text.ts` maps grapheme boundaries to terminal cells and visual
rows for a supplied content width. It calls the direct `string-width` 8.2.2
dependency for each grapheme and reserves one cell at the end of an input row
for a visible cursor. The minimum supported editable content width is two cells so a
single wide grapheme always fits. When the measured component is narrower than
the prompt plus two content cells plus the cursor reserve, the presentation
renders a one-cell truncation indicator and hides the declared cursor; the
model remains editable and no text is discarded.

Hard newlines create logical rows. Soft wrapping occurs before a grapheme that
would exceed the row width. Vertical movement preserves the desired visual
column across repeated up/down actions and resolves to the nearest grapheme
boundary when a target row is shorter. Measurement also exposes cursor
coordinates and the visible row slices required for rendering.

### Editor reducer

`input/editor.ts` owns an immutable `EditorState` and a closed `EditorAction`
union. The reducer supports:

- printable insertion and explicit paste insertion;
- left/right by grapheme and `Ctrl+B`/`Ctrl+F` aliases;
- visual up/down, with a result indicating when history navigation may take
  over at the top or bottom boundary;
- line start/end with Home/End and `Ctrl+A`/`Ctrl+E`;
- word movement with `Meta+B`/`Meta+F`;
- backward/forward delete with Backspace, Delete, `Ctrl+H`, and `Ctrl+D`;
- kill to line end/start and kill previous/next word with `Ctrl+K`, `Ctrl+U`,
  `Ctrl+W`, and `Meta+D`;
- a ten-entry kill ring, consecutive-kill accumulation, `Ctrl+Y` yank, and
  `Meta+Y` yank-pop;
- newline insertion through Shift+Enter, Meta+Enter, or backslash+Enter;
- submission through unmodified Enter;
- undo through `Ctrl+_` and `Ctrl+Shift+-`, with at most fifty snapshots.
  Adjacent printable insertions are one undo transaction while they remain at
  adjacent offsets and arrive within 1000 milliseconds. Paste, cursor movement,
  deletion, newline, mode/context change, or a longer delay closes the
  transaction. The controller passes a monotonic timestamp into the pure
  reducer so this rule is deterministic in tests.

`Ctrl+A`, `Ctrl+E`, `Ctrl+K`, and `Ctrl+U` operate on hard logical lines, not
soft-wrapped visual rows. `Ctrl+K` deletes to the hard-line end, or deletes the
newline and joins the next line when already at that end. `Ctrl+U` deletes from
the hard-line start to the cursor without deleting the preceding newline.

Consecutive kill actions accumulate into one ring entry. Forward kills append
to that entry and backward kills prepend; any non-kill action ends accumulation.
Yank-pop is valid only immediately after yank or yank-pop, and every other
action ends that chain. Undo snapshots include text, cursor, paste references,
kill/yank state, and the desired visual column.

The reducer does not submit, access history, write files, or interpret Ink key
objects. The key router translates terminal events into actions.

### Keybinding router

`input/keybinding-router.ts` normalizes Ink input/key pairs into a stable
keystroke. It has one always-active reserved/global layer and at most one active
interaction context. Built-in dispatch priority is:

1. reserved application-global dispatch such as `Ctrl+C`;
2. permission dialog;
3. history search;
4. active editor.

Within a context, the last binding in an explicit ordered binding array wins;
resolution never depends on React effect registration timing. Alt and Meta normalize to
the same modifier, except that Escape is normalized as Escape rather than an
Ink-reported Meta key. Reserved application controls cannot be shadowed by
context bindings. Only one mounted component subscribes to Ink's `useInput()`;
other components receive commands or register context handlers. A handler
returns whether it consumed the event, and a consumed event is never sent to a
lower-priority context. Context changes are mirrored synchronously so two input
events in one stdin batch cannot reach different logical states accidentally.
This removes event races between `App`, `TextInput`, and `PermissionDialog`.

The reserved `Ctrl+C` dispatcher is context-aware rather than one unconditional
exit action. During a running turn or permission request it preserves the
current abort behavior; during history search it cancels search and restores
the original draft; in an idle editor it enters the double-press exit behavior
defined below. A second `Ctrl+C` after an already-requested turn abort exits.

The permission context preserves the current exact mapping:

- `y` and Enter resolve `yes`;
- `n` and Escape resolve `no`;
- lowercase `a` resolves `session`;
- uppercase `A` resolves `always`.

Keystroke normalization therefore preserves printable input case even when it
normalizes modifier names.

The controller also implements the 800-millisecond double-press primitive from
the interaction specification:

- idle `Ctrl+C` arms an exit message and a second press exits; the first press
  also clears non-empty input;
- `Ctrl+D` is forward-delete when input is non-empty, but uses the same
  double-press exit behavior when empty;
- Escape with non-empty input arms `Esc again to clear`; a second press saves
  the exact draft and structured paste references to history when its trimmed
  text is non-empty, then clears it; Escape with empty input is a no-op because
  the message selector is outside this phase;
- history search keeps its explicit single-press `Ctrl+C` cancellation rule;
- any unrelated action or expiry clears the pending double-press state.

The pending action is rendered in the input footer rather than appended to the
conversation transcript.

### PasteRegistry

`input/paste-registry.ts` assigns monotonically increasing IDs and stores the
full normalized paste content together with its marker range in the display
buffer. A paste is folded when it has more than one
logical line or more than 800 UTF-16 code units. The visible marker is stable
and locale-neutral:

```text
[Pasted text #3 +12 lines]
```

The registry expands only validated structured references, never regex matches
alone. Each reference has `id`, `content`, `start`, and `end`; the display slice
at that range must equal the marker derived from the same record, and ranges
must not overlap. Ordinary user text that happens to look like a marker remains
literal even when the ID exists elsewhere. Editing before a marker shifts its
range. Editing through a marker removes that reference, leaving the edited
display characters literal. History entries carry these records, so recall and
`Ctrl+R` can restore and submit the full content after a process restart. Tabs
normalize to four spaces and CRLF/CR normalize to LF before storage.

Official Ink paste events are the primary paste signal and are not duplicated
onto Ink's input channel. A terminal that does not expose bracketed paste still
uses the sole input subscription: an unmodified multi-character chunk that
contains CR/LF or exceeds 800 UTF-16 code units is normalized and routed as one
paste action; a shorter single-line chunk is one ordinary insertion action.
CR/LF inside a classified fallback paste action is content and cannot trigger
submit. This fallback does not use timers or a second stdin listener. Enter received
after a paste is routed only after the synchronous model ref has incorporated
that paste.

There is one explicit SSH coalescing exception: an unmodified chunk containing
exactly one trailing CR and no other CR/LF is split into its text prefix plus an
Enter action. The prefix is inserted synchronously before Enter submits. If the
prefix ends in a backslash, the backslash is removed and a newline is inserted
instead. Any chunk with an embedded newline or multiple newline characters
remains paste content and does not submit.

### HistoryStore

`input/history-store.ts` persists versioned entries to
`<project>/.transup/history.jsonl`, where `<project>` is the CLI working
directory captured at application startup. The application accepts a history
path override for isolated tests.

The version-one JSON line has this exact shape:

```ts
interface HistoryLineV1 {
  v: 1;
  display: string;
  pastes: Array<{
    id: number;
    content: string;
    start: number;
    end: number;
  }>;
  timestamp: string;
}
```

`timestamp` is an ISO-8601 UTC string. Paste IDs are unique positive safe
integers, ranges are UTF-16 offsets, and records are serialized by ascending
`start` then ID. The marker's
`+N lines` value is the number of newline characters, meaning the additional
lines after the first. Expanded content is derived from `display` and `pastes`
rather than duplicated in the file. After restoration, the next paste ID is
one greater than the maximum ID across loaded history and current state.

Input is trimmed with the existing `String.trim()` behavior before submission.
Empty submissions and `exit`/`quit` control commands are not persisted. Slash
commands and ordinary prompts are persisted. An entry that is exactly equal to
the latest entry in both `display` and paste records is not appended. On startup
the store reads the newest 100 valid entries and returns them oldest-to-newest,
skips blank, malformed, unknown-version, or schema-invalid lines, and never
executes data from the file.

The directory and file are created with owner-only permissions where the
platform supports POSIX modes. Append opens the file with mode `0600`. A single
per-store promise queue serializes duplicate checks, appends, and compaction.
When the file has more than 200 valid entries or exceeds 1 MiB, compaction runs
in that same queue: it writes the newest 100 entries to a same-directory
temporary file, syncs and closes it, renames it atomically, and best-effort
syncs the directory. Temporary files are removed after failed compaction
without touching the original history. `flush()` resolves when the queue is
drained. Normal application exit awaits it for at most 500 milliseconds, then
exits even if storage is unavailable; external process termination retains
normal filesystem best-effort semantics.

History reads and writes are best-effort at the UI boundary. A load failure
starts with empty history. An append/compaction failure does not block prompt
submission and is reported once through the existing informational transcript
path. Pure store methods still reject with the underlying error so they can be
tested and diagnosed. The controller updates its in-memory history
synchronously before invoking the submit callback, then enqueues disk I/O, so
immediate Up or `Ctrl+R` sees the just-submitted entry. The in-memory list is
always capped to its newest 100 entries.

Initial disk loading does not block rendering. Before it completes, navigation
and search use the current in-memory session entries. On completion, loaded
oldest-to-newest entries are prepended to session entries, exact adjacent
duplicates at the merge boundary are collapsed, and current editor/search
state is never overwritten. Later navigation/search operations see the merged
newest 100 entries across disk history and entries submitted in this process.

### History navigation and Ctrl+R

`input/history-search.ts` contains pure navigation and search state. Normal
Up/Down history traversal activates only when visual cursor movement cannot
move farther in that direction. Entering history saves the current draft and
paste registry; returning past the newest item restores them.

`Ctrl+R` snapshots the current editor state, then searches the in-memory history
newest-to-oldest by case-sensitive substring against display text. The initial
empty query immediately selects the newest entry. A match immediately replaces
the main editor content and selects the last occurrence by placing the cursor
at its end. Repeated `Ctrl+R` finds the next older entry with a distinct
`display` value. Editing the query restarts from newest. A late initial history
load is merged for future search actions but cannot mutate a search action that
has already completed.

When a query has no match, the editor keeps the last matched candidate; if the
search has never matched, it keeps the original draft. The footer changes to
the no-match label. Escape or Tab accepts exactly the candidate currently shown,
including the original draft in the never-matched case. Backspace on an already
empty query cancels and restores the original snapshot.

While search is active:

- printable characters extend the query;
- Backspace removes one query grapheme, or cancels when already empty;
- `Ctrl+R` advances to the next match;
- Escape or Tab accepts the current match without submitting;
- Enter accepts and submits;
- `Ctrl+C` cancels and restores the exact original text, cursor, and paste data.

The footer renders `search prompts: <query>` or
`no matching prompt: <query>`. The matched span in the main input uses the
existing warning color and the normal editor cursor is hidden during search.

### Input controller and TextInput integration

An App-level `useInputController` hook is the lifecycle adapter around the pure
modules. A ref is the synchronous source of truth for terminal events; React
state is a render snapshot. This preserves the existing guarantee that a text
chunk immediately followed by Enter submits the updated value. Keeping the
controller above the conditional input/permission presentation also preserves
the draft, cursor, paste records, undo state, and history position while a
permission request temporarily replaces the visible input box.

The controller loads history once on mount without blocking initial rendering.
Submissions clear the editor synchronously, invoke the application callback,
and append history asynchronously. It exposes history errors through the
existing informational transcript callback. When inactive, the editor context
is disabled and the presentation renders the existing working message.

`TextInput.tsx` becomes a presentation component. It keeps a stable full-width
container and displays hard and soft wrapped rows. Ink 7.1 `useBoxMetrics()`
provides the measured root width after layout. The ref is on the TextInput root
inside the parent's border and padding, so those outer columns are already
excluded. The text wrap width is
`rootWidth - promptWidth(2) - cursorReserve(1)`. Before measurement,
`stdout.columns - outerBorder(2) - outerPadding(2) - promptWidth(2) -
cursorReserve(1)` supplies the fallback; tests can inject the root width
directly. The cursor
is inverse-rendered at the measured grapheme, or as an inverse space at end of
input. Ink 7.1 `useCursor()` also declares the corresponding terminal cursor
position so IME pre-edit text and assistive tools follow the insertion point.
Because `useBoxMetrics()` positions are parent-relative while `useCursor()` is
output-root-relative, the adapter sums the public metrics of the tracked input
ancestors before adding the measured prompt, visual row, and visual column. It
never passes a nested box's `left`/`top` directly as an absolute position. No
rendered row may exceed the measured content width.

`App.tsx` owns the controller, the single input subscription, the single paste
subscription, and active context selection. The permission dialog becomes a
presentation component whose decisions are invoked by the router; a request is
marked resolved synchronously before its callback runs. Existing
`onSubmit(display, expanded)` semantics, slash commands, task cancellation, and
transcript rendering remain compatible.

## Error Recovery

- Invalid cursor offsets are clamped; they do not throw during interactive use.
- Invalid history lines are skipped independently, so one damaged line cannot
  discard later valid prompts.
- A missing or unreadable history file produces an empty in-memory history.
- A failed append or compaction never rolls back a submitted prompt.
- Unknown paste references remain literal text instead of disappearing.
- A late history load cannot overwrite newer input or an active search result.
- Unmount invalidates pending loads and double-press timers, preventing state
  updates after teardown; normal controlled exit also flushes the write queue.
- Official Ink retains responsibility for raw-mode and bracketed-paste terminal
  cleanup; Transup does not install a competing stdin listener.

## Testing Strategy

Every implementation commit contains its relevant tests and leaves the full
repository passing.

### Pure model tests

- segmentation and deletion for ASCII, Chinese, combining accents, skin-tone
  emoji, flags, and ZWJ family emoji;
- insertion and cursor clamping around every grapheme boundary;
- terminal widths and wrapping at narrow, exact, and overflow boundaries;
- visual up/down movement across hard lines, soft wraps, and wide characters;
- all editor actions, kill-ring accumulation/yank-pop, undo, and newline rules;
- key normalization, stable context priority, consume behavior, synchronous
  context changes, Escape-with-Meta normalization, uppercase `A`, and reserved
  dispatch;
- paste marker generation, literal-marker safety, range transforms, expansion,
  and serialization;
- history navigation draft restoration and search state transitions.

### Filesystem tests

- first append creates `.transup/history.jsonl` with mode `0600` on POSIX;
- load ordering, 100-entry cap, malformed-line skipping, schema validation,
  duplicate suppression, and paste round-tripping;
- compaction preserves the newest 100 entries and leaves the old file intact
  when writing, syncing, or renaming fails;
- missing directories, read-only targets, and injected I/O failures do not
  block the UI-facing submit path.

### Ink integration tests

- ordinary typing immediately followed by Enter submits current text;
- CJK/emoji cursor movement and deletion do not split graphemes;
- idle `Ctrl+C`/`Ctrl+D` and Escape follow the 800ms double-press contracts;
- multiline paste folds visually and expands for the provider;
- persisted history survives unmount/remount;
- Up/Down preserve and restore drafts;
- `Ctrl+R` query, repeat, accept, submit, no-match, and cancel semantics;
- permission context consumes its keys without editing the hidden prompt;
- global `Ctrl+C` cancels a running turn, cancels active search, and follows the
  idle double-press exit contract.

The bracketed-paste integration test sends the real
`\x1b[200~...\x1b[201~` sequence so it exercises `usePaste()`, plus a separate
plain multi-character fallback test. A packaged CLI PTY smoke test runs where a
system PTY driver is available and asserts bracketed-paste submission plus
cursor escape output. Unsupported PTY hosts report an explicit skip; manual
macOS terminal verification remains part of final release evidence because the
testing library cannot validate IME placement.

Tests use isolated temporary project directories and deterministic input widths.
They avoid wall-clock polling where observable frame conditions can be awaited.
The repository completion command remains `npm run typecheck && npm test && npm
run build`, followed by a packaged CLI smoke check under Node 26.

## Migration And Atomic Commits

The implementation is split into independently reviewable commits. Each
feature is integrated when introduced so the final commit is not a bulk merge:

1. `docs: specify the TUI input foundation`
2. `chore(tui): upgrade Ink to 7.1 and require Node 26`
3. `refactor(tui): centralize terminal input routing`
4. `feat(tui): integrate a grapheme-aware text model`
5. `feat(tui): integrate multiline readline editing`
6. `feat(tui): fold and restore bracketed paste content`
7. `feat(tui): persist and navigate project prompt history`
8. `feat(tui): add incremental Ctrl-R history search`
9. `feat(tui): declare measured terminal cursor placement`

If implementation evidence shows two adjacent steps cannot compile
independently, the boundary may move, but unrelated behavior will not be
combined and every commit will include its own tests.

## Acceptance Criteria

The phase is complete when all of the following hold:

- typing, editing, submitting, permission decisions, and cancellation retain
  their current application behavior, except for the documented English paste
  marker, forward-Delete correction, double-press clear/exit behavior,
  multiline editing, and new history/search behavior;
- grapheme-safe editing and measured visual movement pass the Unicode matrix;
- multiline/large paste is folded for display and expanded for execution;
- prompts persist across process restarts in project-local history;
- Up/Down navigation and incremental `Ctrl+R` work with restored paste data;
- no overlapping Ink input subscriber can consume the same contextual key;
- history corruption or I/O failure cannot prevent a prompt from running;
- typecheck, all tests, build, and packaged CLI smoke checks pass on Node 26;
- each commit is atomic, has a Conventional Commit message, and can be reviewed
  or reverted without relying on later unrelated changes.
