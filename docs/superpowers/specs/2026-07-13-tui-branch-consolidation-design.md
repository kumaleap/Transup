# TUI Branch Consolidation Design

Date: 2026-07-13

Status: Approved for written-spec review

## Context

Three completed feature branches are already ancestors of `origin/main`:

- `origin/feature/tui-input-foundation`
- `origin/feature/tui-message-format`
- `origin/feature/tui-cursor-placement`

Two branches still contain commits that are not in `origin/main`:

- `origin/feature/tui-message-visual` at `9cc3797`
- `origin/feature/tui-streaming-activity` at `82767dc`

Each outstanding branch merges cleanly into the current main branch by itself.
Merging both branches exposes two semantic conflicts in
`packages/cli/src/tui/App.tsx`: tool-start handling and turn-end handling. The
current main branch also has a real macOS PTY smoke failure because its fixture
uses JSX in a standalone `tsx` process without a compatible React binding.

## Goal

Merge every existing TUI feature branch into `main` while preserving branch
ancestry, retain the behavior contributed by both outstanding branches, repair
the PTY smoke, and finish with fresh Node 26 verification of the combined tree.

## Scope

This consolidation includes:

- repairing the standalone PTY fixture and its early-exit diagnostics;
- merging `origin/feature/tui-message-visual` with a real merge commit;
- merging `origin/feature/tui-streaming-activity` with a real merge commit;
- resolving shared `App.tsx` behavior without dropping either branch's intent;
- adding integration regressions for the combined tool, streaming, interruption,
  error, and cursor behavior;
- merging the verified integration branch into the local `main` branch; and
- creating a clean follow-up worktree for the deferred capabilities after the
  consolidation is complete.

## Non-Goals

The following previously deferred capabilities do not block this consolidation
and must not be implemented in this branch:

- cross-process prompt-history ownership or disk locking;
- thinking-message rendering;
- `Ctrl+O` transcript or verbose mode;
- the Todo panel;
- the image pipeline;
- full reproduction of every behavior documented in interaction studies 02 and
  03; and
- unrelated provider, engine, packaging, or theme work.

They will be handled in a separate
`feature/tui-deferred-capabilities` worktree based on the consolidated main
branch.

## Git Strategy

Work occurs in `/Users/kuma/workspace/Transup-integration` on
`integration/tui-branch-consolidation`, based on `origin/main` at or after
`1b8c767`.

The two outstanding remote branches are merged, not rebased or cherry-picked.
This preserves their original commit identities and makes both remote tips
ancestors of the final main branch. The visual branch is merged first, followed
by the streaming branch. The second merge is expected to stop at the known
`App.tsx` conflict so the combined behavior can be implemented and reviewed
explicitly.

After all verification passes, the integration branch is merged into the local
`main` branch. Pushing `main` or deleting local/remote feature branches is not
part of this design because those operations change shared remote state.

## PTY Repair

The PTY test launches `packages/cli/test/fixtures/pty-input-app.tsx` through the
workspace `tsx` executable rather than through Vitest's transform. The fixture
must therefore use a JSX runtime that is valid in that standalone execution
path.

The repair must:

- make the fixture start under Node 26 and the system `script` PTY driver;
- retain bracketed-paste enable and disable assertions;
- retain the cursor-position escape assertion;
- retain full-content submission after a folded multiline paste; and
- include captured stdout/stderr in the error raised when the fixture exits
  before it reaches the ready state.

The existing failing macOS PTY test is the RED case. It must pass outside the
restricted sandbox before the consolidation is accepted.

## Conflict Resolution

### Tool Start

The merged handler must perform all of the following in order:

1. record progress in the streaming stall tracker;
2. flush any completed assistant stream into the transcript;
3. derive the visual tool name and argument summary through
   `summarizeToolCall()`;
4. create the shared active-tool state;
5. assign the same state to the local turn variable and `activeToolRef`; and
6. publish it through `setActiveTool()`.

This keeps message-visual's user-facing summaries and streaming-activity's
stall/activity lifecycle.

### Turn End

The merged handler must preserve reason-specific behavior:

- `max_iterations` and `loop_detected` remain structured error transcript
  entries supplied by the visual branch;
- `aborted` first flushes any partial assistant text exactly once, then appends
  the interruption notice supplied by the streaming branch; and
- normal completion adds no synthetic error or interruption entry.

The final `finally` block remains responsible for clearing `activeToolRef`, the
rendered active tool, controller state, and running state.

## Combined Behavior Invariants

The consolidation must retain these existing contracts:

- one production `useInput()` and one production `usePaste()` subscription;
- App-root and input-area metrics continue to reach `TextInput` for terminal
  cursor placement;
- tool titles use message-visual's summarized display names and arguments;
- tool progress continues to reset stall detection;
- only complete streamed lines appear in the dynamic preview;
- the final incomplete line is included when the stream is flushed;
- interrupted partial text is committed once and precedes the interruption
  notice;
- structured API, compact, max-iteration, and loop errors retain visual error
  formatting; and
- permission and input-controller routing behavior does not regress.

## Testing Strategy

Implementation follows RED-GREEN-REFACTOR for every new regression.

Focused verification covers:

- PTY early-exit diagnostics and the real macOS PTY flow;
- message formatting, Markdown, diff, and transcript unit suites;
- spinner frames, verbs, stall tracking, status formatting, and line commit;
- App tool-start integration with summarized names and active activity state;
- interruption ordering and duplicate prevention;
- structured turn-end errors;
- terminal cursor coordinate and visibility behavior; and
- the existing permission, history, paste, and input-routing scenarios.

The completion gate under Node `26.5.0` is:

```bash
npm run typecheck
npm test
npm run build
node packages/cli/dist/index.js --version
git diff --check
```

The PTY test must also run in a normal macOS environment outside the restricted
sandbox. No failing or unexpectedly skipped test is accepted.

## Integration Result

The accepted local main branch must satisfy all of the following:

- both outstanding remote feature tips are ancestors of `main`;
- all five TUI feature branches appear under `git branch -r --merged main`;
- the worktree is free of unintended tracked or untracked changes;
- full verification passes under Node 26; and
- the deferred-capabilities worktree starts clean from the consolidated main
  commit without carrying implementation changes from this integration branch.
