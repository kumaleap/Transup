# TUI Input Foundation Cross-Device Handoff

Date: 2026-07-10

Status: Tasks 1-4 implemented; Task 4 formal review and Tasks 5-9 remain

Estimated remaining agent time: 7-10 hours; 4-6 hours is the best case

## Purpose

This document is the durable handoff for continuing the first TUI input
foundation phase on another computer. It records the exact implementation
checkpoint, completed behavior, remaining work, verification evidence, and
resume commands. The design specification and implementation plan remain the
authoritative requirements:

- `docs/superpowers/specs/2026-07-10-tui-input-foundation-design.md`
- `docs/superpowers/plans/2026-07-10-tui-input-foundation.md`
- `docs/claude-code-interactions/01-输入系统.md`

The checkboxes in the implementation plan are the original execution template,
not the current status. Use this handoff and the commit history for status.

## Repository Checkpoint

```text
Repository:                git@github.com:kumaleap/Transup.git
Feature branch:            feature/tui-input-foundation
Base commit:               3980e96
Implementation checkpoint: 7a647361b4b8ddc36beef3598d3396b4a3496d49
Checkpoint subject:        feat(tui): integrate multiline readline editing
```

On the other computer, use the newest remote tip of
`origin/feature/tui-input-foundation`. The product implementation through Task
4 ends at `7a64736`; later commits may contain this handoff or narrowly scoped
review fixes.

Commit history through the implementation checkpoint:

```text
60ed32c docs: specify the TUI input foundation
e87d810 docs: plan the TUI input foundation implementation
f736329 chore(tui): upgrade Ink to 7.1 and require Node 26
03723cd docs: 补充 Claude Code 交互细节研究文档
958d2a5 fix(tui): align terminal width measurement with Ink
df18c2c refactor(tui): centralize terminal input routing
5df669f feat(tui): integrate a grapheme-aware text model
7a64736 feat(tui): integrate multiline readline editing
```

`03723cd` is an external documentation commit. Preserve it. Do not rewrite or
drop it while reorganizing the implementation commits.

## Fixed Technical Decisions

- Use official Ink `7.1.0`. Do not copy, translate, or AI-rewrite Claude's
  private Ink renderer.
- Use Node.js `26.5.0`, React `19.2.7`, TypeScript `6.0.3`, and
  `string-width` `8.2.2`.
- Keep all Ink imports behind `packages/cli/src/tui/runtime/index.ts`.
- Keep exactly one production `useInput()` subscription and eventually one
  production `usePaste()` subscription, both rooted at App integration.
- Preserve `render(..., {exitOnCtrlC: false})`; the central router owns
  `Ctrl+C`.
- Persist prompt history only to project-local `.transup/history.jsonl`.
- Implement persistent history and incremental `Ctrl+R` search in this phase.
- Use TDD for every task: add a requirement-related failing test, observe RED,
  implement GREEN, then run targeted and repository checks.
- Each implementation task gets an atomic Conventional Commit containing its
  tests. Stage exact paths only.

## Completed Work

Tasks 1-3 have completed their independent task reviews. Task 4 has complete
implementation and verification evidence but still needs its independent
task-scoped review.

### Task 1: Runtime Baseline

- `.nvmrc` pins `26.5.0`.
- Root and CLI package engines require Node `>=26`.
- CI and release workflows consume `.nvmrc`.
- The CLI build target is `node26`.
- Ink is `7.1.0`; React is `19.2.7`; TypeScript is `6.0.3`.
- Direct `string-width@8.2.2` is aligned with Ink's renderer semantics.
- Doctor rejects Node 25 and accepts Node 26.
- Width regressions cover keycaps, Hangul jamo, and Devanagari spacing marks.

### Task 2: Central Input Routing

- Production Ink imports go through the local runtime adapter.
- Exactly one production `useInput()` subscription remains in `App.tsx`.
- `TextInput` and `PermissionDialog` are presentation-only.
- The App-level controller owns input state across permission rendering.
- Permission mapping is preserved: `y`/Enter -> `yes`, `n`/Escape -> `no`,
  `a` -> `session`, and `A` -> `always`.
- Ink's spurious Escape Meta flag is normalized.
- Consumed input does not reach lower-priority contexts.
- Same-tick text followed by Enter uses synchronous controller state.
- Component-local history and paste state survive permission presentation.

### Task 3: Grapheme And Measurement Model

- Immutable `TextBuffer` keeps the cursor on grapheme boundaries while exposing
  UTF-16 offsets for compatibility.
- Whole-result NFC normalization remaps the cursor through normalized prefixes.
- Editing is safe for CJK, combining marks, emoji modifiers, flags, and ZWJ
  emoji.
- `MeasuredText` uses `string-width@8.2.2` and models hard lines, soft wraps,
  visual rows, nearest offsets, and desired columns.
- Roots narrower than five cells render `…` without discarding editor state.

### Task 4: Multiline Readline Editing

Implementation is complete in `7a64736`. A task-scoped formal review is still
required before starting Task 5.

- Pure `EditorState` / `EditorAction` reducer.
- Hard-line Home/End and `Ctrl+A`/`Ctrl+E`.
- Grapheme-safe Backspace and forward Delete.
- Visual Up/Down with desired-column preservation; history fallback occurs
  only at visual top/bottom boundaries.
- Word movement through `Meta+B`/`Meta+F`.
- Kill operations through `Ctrl+K`, `Ctrl+U`, `Ctrl+W`, and `Meta+D`.
- Ten-entry kill ring with forward append and backward prepend.
- `Ctrl+Y` yank and `Meta+Y` yank-pop.
- Fifty-entry undo history; adjacent printable insertions group for 1000 ms.
- `Ctrl+_` and kitty `Ctrl+Shift+-` undo.
- Shift+Enter, Meta+Enter, and backslash+Enter multiline entry.
- SSH-coalesced `text\r` insertion/submission and `text\\\r` newline behavior.
- 800 ms double-press behavior for idle `Ctrl+C`, empty `Ctrl+D`, and Escape.
- Exact Escape draft preservation, footer feedback, and timer cleanup on edits,
  context changes, and unmount.

Task 4 actually touched these eight paths:

```text
packages/cli/src/tui/App.tsx
packages/cli/src/tui/TextInput.tsx
packages/cli/src/tui/input/editor.ts
packages/cli/src/tui/input/keybinding-router.ts
packages/cli/src/tui/input/use-input-controller.ts
packages/cli/test/tui-input/editor.test.ts
packages/cli/test/tui-input/keybinding-router.test.ts
packages/cli/test/tui.test.tsx
```

The authoritative Task 4 plan lists only six of those paths. `App.tsx` and
`keybinding-router.test.ts` are actual scope deviations: they were used for App
integration and direct coverage of the expanded mapping, but the handoff does
not pre-approve them. The independent reviewer must decide whether both extra
paths were necessary to satisfy Task 4 and record that verdict.

Recorded verification at `7a64736` under Node `26.5.0`:

```text
Focused Task 4: 3 files passed, 81/81 tests
Full repository: 24 files passed, 202/202 tests
Typecheck: passed
Build: target node26, ESM build passed
git diff check: clean
```

This evidence describes the checkpoint run. Run the baseline again after
switching computers; do not treat recorded output as fresh verification.

The fake-timer investigation concluded that the controller's 800 ms timeout is
cleared synchronously. Ink schedules an unrelated `setImmediate` after
unmount, so the focused test intentionally fakes only `setTimeout` and
`clearTimeout`. Do not add a production workaround for Ink's immediate.

Recorded Task 4 TDD evidence for the reconstructed implementer report:

- `editor.test.ts` was created before `editor.ts`; the initial intended RED was
  module resolution failure. The exact interrupted command output was not
  retained and must not be reconstructed as an observed count.
- Reducer GREEN was 13/13; reducer plus router GREEN was 62/62.
- Controller/App integration reached 17/18 before the unmount timer assertion
  produced a focused RED (`expected 1 to be 0`). Scoping fake timers to
  `setTimeout`/`clearTimeout` produced focused GREEN (1 passed, 17 skipped).
- Review added a whitespace-only Escape draft regression first: RED observed
  zero history callback calls; the narrow fix produced GREEN (1 passed, 18
  skipped).
- The first Task 4 typecheck produced two `TS2554` and three `TS2322` errors in
  React 19 ref declarations. Initializing and widening those refs produced
  final typecheck GREEN.

## Immediate Resume Step: Review Task 4

Do not start Task 5 until a task-scoped review finds no Critical or Important
defects. The `.superpowers/` directory is ignored and will not transfer through
Git, so regenerate the brief and diff package on the other computer:

```bash
/Users/kuma/.codex/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/task-brief \
  docs/superpowers/plans/2026-07-10-tui-input-foundation.md \
  4

/Users/kuma/.codex/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/review-package \
  5df669f \
  7a64736
```

If that plugin version is different on the other computer, locate the active
`subagent-driven-development/scripts/` directory first and run the equivalent
scripts from it.

The original ignored `.superpowers/sdd/task-4-report.md` also does not transfer.
Use the Completed Work and Task 4 sections of this tracked handoff as the
implementer report. If the reviewer harness requires the conventional local
path, reconstruct `.superpowers/sdd/task-4-report.md` from those sections and
fresh Node 26 verification, clearly labeling it as reconstructed. Do not invent
RED/GREEN output that is not recorded here.

Review inputs:

```text
.superpowers/sdd/task-4-brief.md
.superpowers/sdd/review-5df669f..7a64736.diff
docs/superpowers/handoffs/2026-07-10-tui-input-foundation.md
docs/superpowers/plans/2026-07-10-tui-input-foundation.md
docs/superpowers/specs/2026-07-10-tui-input-foundation-design.md
```

Review priorities:

- Kill/yank/yank-pop and undo state transitions.
- Up/Down history fallback only at measured visual boundaries.
- Double-press timers and exact Escape draft preservation.
- No premature persistence, search, or structured-paste implementation.
- The necessity of the unplanned `App.tsx` and
  `keybinding-router.test.ts` changes.

The reviewer must return separate `Spec Compliance` and `Task Quality`
verdicts, classify findings as Critical/Important/Minor, and list any
`Cannot verify from diff` items. The coordinating agent must resolve those
items from source, tests, and fresh commands rather than treating them as an
approval.

Resolve valid Critical or Important findings in a narrowly scoped
`fix(tui): ...` commit, rerun Task 4 verification, and review the fix before
continuing.

## Remaining Tasks

### Task 5: Official Paste And Structured References

Planned commit:

```text
feat(tui): fold and restore bracketed paste content
```

- Add `input/paste-registry.ts` and pure tests.
- Replace regex-only identity with structured `{id, content, start, end}`
  references.
- Keep marker-like literal user text literal.
- Shift ranges for edits before markers; invalidate only references intersected
  by edits.
- Include paste state in editor undo snapshots.
- Add the sole root `usePaste()` subscription.
- Exercise real `\x1b[200~...\x1b[201~` bracketed-paste sequences.
- Preserve fallback multi-character chunks and the SSH trailing-CR exception.
- Render `[Pasted text #N +M lines]`, where `M` is the newline count.

Start with this RED command:

```bash
npx vitest run packages/cli/test/tui-input/paste-registry.test.ts
```

### Task 6: Persistent Project History

Planned commit:

```text
feat(tui): persist and navigate project prompt history
```

- Add `input/history-store.ts` and optional `AppProps.historyPath` injection.
- Store version-one JSONL at `<cwd>/.transup/history.jsonl`.
- Use file mode `0600` and owner-only parent permissions where supported.
- Serialize load, duplicate checks, append, and compaction through one promise
  queue.
- Return the newest 100 valid entries in oldest-to-newest order.
- Skip malformed, blank, unknown-version, and invalid-schema lines.
- Compact above 200 valid entries or 1 MiB through temp-file sync, close,
  atomic rename, and best-effort directory sync.
- Update in-memory history synchronously; history I/O failure must not block
  prompt submission.
- Normal exit waits at most 500 ms for `flush()`.

### Task 7: Incremental Ctrl+R Search

Planned commit:

```text
feat(tui): add incremental Ctrl-R history search
```

- Empty query immediately selects the newest entry.
- Use case-sensitive substring matching and the last occurrence in a match.
- Repeated `Ctrl+R` walks older distinct display values.
- Query changes restart from newest.
- No match keeps the previous candidate or the exact original draft.
- Escape/Tab accepts the visible candidate; Enter accepts and submits.
- `Ctrl+C` restores the exact original state before idle double-exit handling.
- Backspace on an already empty query cancels.
- Render `search prompts: <query>` or `no matching prompt: <query>`.

### Task 8: Real Cursor And PTY Smoke

Planned commit:

```text
feat(tui): declare measured terminal cursor placement
```

- Use Ink 7.1 `useBoxMetrics()` and `useCursor()`.
- Sum parent-relative ancestor offsets into output-root-relative coordinates.
- Call `setCursorPosition()` during render, not from a passive effect.
- Hide the cursor while inactive, searching, too narrow, or not safely
  measured.
- Add focused coordinate tests and a bounded production-input PTY smoke test.
- Verify bracketed-paste enable/disable and cursor-position escape output.

### Task 9: Final Audit

- Run a clean Node 26 install, typecheck, full tests, build, and packaged CLI
  smoke.
- Confirm exactly one production `useInput()` and one production `usePaste()`.
- Run `superpowers:requesting-code-review` against the design, plan,
  `origin/main`,
  and final branch tip.
- Resolve all valid Critical and Important findings with atomic
  `fix(tui): ...` commits.
- Audit Conventional Commit subjects, exact changed paths, and whitespace.

The branch-history audit has one documented exception: `03723cd` is a
pre-existing, standalone documentation commit containing
`docs/claude-code-interactions/`. Apply the plan's "do not stage that directory"
constraint to implementation commits; preserve this documentation commit
instead of rewriting history to remove it.

## Remaining-Time Estimate

```text
Task 4 formal review       0.5-1.0 h
Task 5 structured paste   1.0-1.5 h
Task 6 persistent history 2.0-3.0 h
Task 7 Ctrl+R search      1.0-1.5 h
Task 8 cursor and PTY     1.5-2.5 h
Task 9 final audit        0.5-1.5 h
```

The reliable planning range is 7-10 hours. A 4-6 hour finish is possible only
when all implementations and reviews pass on the first attempt. History
failure paths and cross-platform PTY behavior are the main uncertainties; the
upper range can reach 10-12 hours if either produces Important review findings.

## Resume On Another Computer

First inspect the existing checkout:

```bash
cd /path/to/Transup
git status --short --branch
```

If it has unrelated local changes or an uncertain branch state, do not
automatically stash, reset, or force-switch it. Use the separate-clone path
below. If it is clean and the local feature branch already exists, run this
block as one unit; `&&` prevents a failed switch from merging into the previous
branch:

```bash
git fetch --prune origin \
  refs/heads/feature/tui-input-foundation:refs/remotes/origin/feature/tui-input-foundation
git switch feature/tui-input-foundation && \
  git merge --ff-only origin/feature/tui-input-foundation
```

If the checkout is clean but the local feature branch does not exist, use this
mutually exclusive block instead of the preceding switch/merge block:

```bash
git fetch --prune origin \
  refs/heads/feature/tui-input-foundation:refs/remotes/origin/feature/tui-input-foundation
git switch --track -c feature/tui-input-foundation \
  origin/feature/tui-input-foundation
```

Then prepare and verify the runtime:

```bash
source "$HOME/.nvm/nvm.sh"
nvm install 26.5.0
nvm use 26.5.0
node --version
npm ci
git status --short --branch
npm run typecheck
npm test
npm run build
node packages/cli/dist/index.js --version
```

Separate-clone path for any uncertain existing checkout:

```bash
cd /path/to/parent
git clone --branch feature/tui-input-foundation \
  git@github.com:kumaleap/Transup.git Transup-input-foundation
cd Transup-input-foundation
git status --short --branch
```

Expected Node output is `v26.5.0`. The expected implementation-checkpoint
baseline is 24 test files and 202 tests. Counts will increase after later tasks.

Before editing, confirm:

```bash
git branch --show-current
git rev-parse HEAD
git status --porcelain
git log --oneline --decorate -12
```

The branch must be `feature/tui-input-foundation`, and the working tree should
be clean. The exact tip may be newer than `7a64736` because this handoff is a
separate documentation commit.

## Environment Notes

- The shell that created this handoff defaulted to Node `22.22.0`; the project
  commands are valid only after switching to `.nvmrc` (`26.5.0`).
- In the managed sandbox, `/etc/hosts` localhost mappings may be unavailable.
  Vitest can then fail before collection with `getaddrinfo ENOTFOUND localhost`.
  This is an environment failure, not a valid feature RED.
- Do not change repository Vitest configuration to work around that sandbox.
  Run the tests in the normal local shell/outside the restricted sandbox.
- `.superpowers/` is ignored and contains local review artifacts only.
- `.transup/` is ignored because it will contain project-local runtime history.

## Parallel-Agent Rules

Parallelize independent pure-module work, read-only audits, and review. Do not
allow multiple writers to overlap `App.tsx`, `editor.ts`, or
`use-input-controller.ts`; use one integration writer for those shared paths.
After every agent result, inspect the diff and run the relevant verification
from the coordinating agent. Never accept an agent's success report as test
evidence by itself.

Tasks 5-8 have a real dependency chain: history consumes structured paste
references, search consumes persisted history, and cursor/PTY coverage consumes
paste and search states. Parallel agents can prepare tests, audit requirements,
and review completed diffs, but the shared integration edits should proceed in
task order.

## Atomic Commit Rules

For every remaining task:

1. Read the task section and generate its task brief.
2. Write the failing tests and observe a requirement-related RED.
3. Implement only that task and reach GREEN.
4. Run the task's targeted tests, `npm run typecheck`, `npm test`, and
   `npm run build` under Node 26.
5. Stage only the intended paths and create the atomic task commit with its
   planned Conventional Commit subject.
6. Generate the review package from the task's pre-implementation base commit
   to the new task commit, so the package contains the implementation.
7. Run the independent task review and resolve Critical/Important findings in
   separate, narrow `fix(tui): ...` commits. Add a regression test where
   applicable and run the focused tests covering each fix before committing it.
8. Regenerate and re-review the package after every fix until approved.
9. After the final fix and clean review, rerun the task's targeted suite,
   `npm run typecheck`, `npm test`, and `npm run build` under Node 26.
10. Verify the worktree and commit contents before starting the next task.

Do not squash the task commits before Claude reviews the branch. The commit
boundaries are part of the review contract.

## Claude Review Entry Points

Give Claude these tracked documents and comparisons:

```text
docs/superpowers/specs/2026-07-10-tui-input-foundation-design.md
docs/superpowers/plans/2026-07-10-tui-input-foundation.md
docs/superpowers/handoffs/2026-07-10-tui-input-foundation.md
docs/claude-code-interactions/01-输入系统.md
git log --reverse --format="%h %s" origin/main..HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
```

Review order should be task commits first, then the whole branch against the
design. Preserve each atomic boundary until all findings are resolved.
