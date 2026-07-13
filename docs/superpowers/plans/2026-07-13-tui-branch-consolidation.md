# TUI Branch Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the main-branch PTY smoke, merge the three outstanding TUI feature branches with their original ancestry, preserve their combined App, permission, visual, and streaming behavior, and merge the verified result into local `main`.

**Architecture:** Work on `integration/tui-branch-consolidation` in the existing `/Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation` worktree. Commit the PTY repair first, merge `message-visual`, then merge `streaming-activity`; resolve its known `App.tsx` conflict through an App-level RED/GREEN regression that proves visual tool summaries and streaming interruption behavior coexist. Merge `feature/tui-permission-dialogs` last so its core policy and queued controller can be reconciled against the already combined App, preserve the repaired PTY harness explicitly, then verify the complete branch under Node 26 before creating a final local-main merge commit and a clean deferred-capabilities worktree.

**Tech Stack:** Node.js 26.5.0, TypeScript 6.0.3, React 19.2.7, Ink 7.1.0, Vitest 3.2.7, ink-testing-library 4.0.0, Git worktrees.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-13-tui-branch-consolidation-design.md` exactly.
- Work only in `/Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation` until Task 6 explicitly moves to the primary checkout.
- Preserve the original commit identities of `9cc3797`, `82767dc`, and `f630e23` through real merge commits; do not rebase, squash, or cherry-pick them.
- Use Node `26.5.0` for every install, test, typecheck, build, and CLI smoke command.
- Do not implement cross-process history locking, thinking rendering, `Ctrl+O`, Todo, images, or additional interaction-study 02/03 behavior.
- Do not push `main`, force-update any ref, or delete any local or remote branch.
- Preserve the user's untracked `/Users/kuma/workspace/Transup/.claude/` directory and `/Users/kuma/workspace/Transup/packages/cli/test/fixtures/jsx-probe.tsx` file.
- Apply RED-GREEN-REFACTOR to every new regression; merge-only verification tasks reuse the tests already committed with their source branches.
- Stage exact paths and use Conventional Commit subjects for non-merge commits.

## File Map

- `packages/cli/test/fixtures/pty-input-app.tsx`: standalone Node 26/`tsx` PTY fixture; must have a valid JSX runtime.
- `packages/cli/test/tui-input/pty-smoke.test.ts`: macOS/Linux system-PTY contract and early-exit diagnostics.
- `packages/cli/src/tui/App.tsx`: shared visual/streaming integration point for tool and turn lifecycle events.
- `packages/cli/src/tui/PermissionDialog.tsx`: permission controller view plus the visual file-diff preview frame.
- `packages/cli/src/tui/permission/`: queued permission controller, view types, and per-tool option construction.
- `packages/core/src/permissions.ts`: UI-independent permission evaluation, modes, rules, and persistence updates.
- `packages/core/src/settings.ts`: layered settings and permission rule persistence.
- `packages/core/src/tools/registry.ts`: structured permission decisions, updated-input validation, and feedback flow.
- `packages/cli/test/tui.test.tsx`: production App behavior across provider events, tool execution, streaming, interruption, cursor, permission, paste, and history.
- `packages/cli/test/permission-options.test.ts`: permission view-model routing and update construction.
- `packages/core/test/permissions.test.ts`: policy ordering, rule matching, and mode behavior.
- `docs/superpowers/specs/2026-07-13-tui-branch-consolidation-design.md`: approved behavior and scope boundary.
- `docs/superpowers/plans/2026-07-13-tui-branch-consolidation.md`: execution record for this consolidation.

---

### Task 1: Repair And Diagnose The Real PTY Fixture

**Files:**
- Modify: `packages/cli/test/fixtures/pty-input-app.tsx:1`
- Modify: `packages/cli/test/tui-input/pty-smoke.test.ts:141-145`

**Interfaces:**
- Consumes: standalone workspace `tsx`, macOS/Linux `script`, `waitForOutput(child, getOutput, predicate)`, and `diagnostic(output)`.
- Produces: a PTY fixture that reaches Ink's ready state and an early-exit error containing the captured terminal output.

- [x] **Step 1: Install the exact locked dependencies under Node 26**

Run:

```bash
cd /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm ci
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH node --version
```

Expected: install exits zero without changing `package-lock.json`; Node prints `v26.5.0`.

- [x] **Step 2: Verify the existing macOS PTY RED outside the restricted sandbox**

Run outside the sandbox:

```bash
cd /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: FAIL because the fixture exits before ready. Running its emitted command directly reports `ReferenceError: React is not defined` at `pty-input-app.tsx:83`.

- [x] **Step 3: Give the standalone fixture a valid classic JSX binding**

Change the fixture import to:

```tsx
import React, {useCallback, useRef} from "react";
```

Do not change the production JSX configuration or Vitest transform to accommodate this standalone test process.

- [x] **Step 4: Include captured output in the early-exit error**

Replace the `onClose` error construction with:

```ts
const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
  cleanup();
  rejectOutput(
    new Error(
      `PTY fixture exited before it was ready (code=${code}, signal=${signal}); ` +
      `output=${diagnostic(getOutput())}`,
    ),
  );
};
```

This changes only test diagnostics. Keep the existing 4,000-character tail bound.

- [x] **Step 5: Verify the PTY GREEN and focused cursor suite**

Run outside the sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts packages/cli/test/tui-input/text-input.test.tsx
```

Expected: 2 files and 12 tests pass, including a real non-skipped PTY smoke.

Run in the worktree:

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check
```

Expected: both commands exit zero.

- [x] **Step 6: Commit the PTY repair**

```bash
git add packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/pty-smoke.test.ts
git commit -m "fix(test): repair standalone PTY fixture"
```

Expected: one commit containing only the fixture and its diagnostic test harness.

---

### Task 2: Merge The Message Visual Branch

**Files:**
- Merge: `origin/feature/tui-message-visual`
- Verify: `packages/cli/src/diff.ts`
- Verify: `packages/cli/src/highlight.ts`
- Verify: `packages/cli/src/theme.ts`
- Verify: `packages/cli/src/tui/App.tsx`
- Verify: `packages/cli/src/tui/PermissionDialog.tsx`
- Verify: `packages/cli/src/tui/Transcript.tsx`
- Verify: `packages/cli/src/tui/figures.ts`
- Test: `packages/cli/test/diff.test.ts`
- Test: `packages/cli/test/highlight.test.ts`
- Test: `packages/cli/test/transcript.test.tsx`
- Test: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: visual branch tip `9cc379735ddf5f5ac704f4a011c4a8c4e93c314b` and current integration branch.
- Produces: a merge commit in which `9cc3797` is an ancestor and message formatting APIs such as `summarizeToolCall()`, `summarizeToolResult()`, `formatToolError()`, and `pushError()` are available for Task 3.

- [x] **Step 1: Confirm the branch and clean pre-merge state**

```bash
git branch --show-current
git status --short --branch
git rev-parse origin/feature/tui-message-visual
```

Expected: current branch is `integration/tui-branch-consolidation`, the tracked worktree is clean, and the remote tip is `9cc379735ddf5f5ac704f4a011c4a8c4e93c314b`.

- [x] **Step 2: Merge the original visual branch with ancestry intact**

```bash
git merge --no-ff origin/feature/tui-message-visual -m "Merge branch 'feature/tui-message-visual' into integration/tui-branch-consolidation"
```

Expected: Git creates a merge commit without conflict; no file under the approved consolidation spec or plan is replaced by an older branch copy.

- [x] **Step 3: Verify the visual branch's focused suites on the current main base**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/diff.test.ts packages/cli/test/highlight.test.ts packages/cli/test/transcript.test.tsx packages/cli/test/tui.test.tsx
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check HEAD^1..HEAD
```

Expected: all selected tests and typecheck pass; the merge introduces no whitespace errors.

- [x] **Step 4: Verify ancestry and merge contents**

```bash
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b HEAD
git show --stat --oneline --summary HEAD
git status --short --branch
```

Expected: ancestry command exits zero, the merge shows the visual files and tests, and the worktree is clean.

---

### Task 3: Merge Streaming Activity With Combined App Semantics

**Files:**
- Merge: `origin/feature/tui-streaming-activity`
- Modify: `packages/cli/src/tui/App.tsx:tool_start,turn_end`
- Modify: `packages/cli/test/tui.test.tsx`
- Add through merge: `packages/cli/src/tui/activity/frames.ts`
- Add through merge: `packages/cli/src/tui/activity/line-commit.ts`
- Add through merge: `packages/cli/src/tui/activity/stall.ts`
- Add through merge: `packages/cli/src/tui/activity/status-line.ts`
- Add through merge: `packages/cli/src/tui/activity/verbs.ts`
- Add through merge: `packages/cli/test/tui-activity/*.test.ts`

**Interfaces:**
- Consumes: streaming branch tip `82767dcccc71435b639bb4f2477eb868f26fdf3f`, visual helpers `summarizeToolCall()` and `pushError()`, streaming `stallTrackerRef` and `activeToolRef`, and the existing `MockProvider`/`AbortableProvider` TUI harness.
- Produces: one merge commit where tool summaries, stall tracking, whole-line streaming, structured errors, and interruption flushing coexist.

- [x] **Step 1: Start the real streaming merge and confirm the known conflict**

```bash
git merge --no-commit --no-ff origin/feature/tui-streaming-activity
git status --short
```

Expected: the streaming activity modules and tests are staged; only `packages/cli/src/tui/App.tsx` remains unmerged.

- [x] **Step 2: Resolve the two conflict markers to the streaming-side behavior as a compilable RED baseline**

For `tool_start`, temporarily keep the streaming-side body:

```ts
case "tool_start":
  stallTrackerRef.current?.observeProgress(Date.now());
  flushStream();
  tool = {
    name: ev.call.name,
    argSummary: formatArgs(ev.parsedArgs),
    tail: [],
    streamed: false,
  };
  activeToolRef.current = tool;
  setActiveTool(tool);
  break;
```

For `turn_end`, temporarily keep the streaming-side body with partial-stream flushing and the interruption notice. Remove all conflict markers, then stage only `App.tsx` so Vitest can run:

```bash
git add packages/cli/src/tui/App.tsx
git diff --check --cached
```

Expected: the index is conflict-free and whitespace-clean, but visual tool summarization is absent by construction.

- [x] **Step 3: Add a failing App regression for visual tool summaries after streaming integration**

Add this test next to the existing tool and streaming App tests in `packages/cli/test/tui.test.tsx`:

```tsx
it("keeps user-facing tool summaries while streaming activity is integrated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "transup-tui-summary-"));
  const target = join(dir, "summary.txt");
  writeFileSync(target, "one\ntwo\n", "utf8");
  const provider = new MockProvider([
    {
      content: "",
      toolCalls: [{
        id: "read-summary",
        name: "read_file",
        args: JSON.stringify({path: target}),
      }],
    },
    {content: "summary done"},
  ]);
  const instance = render(makeApp(provider));
  await flush();

  instance.stdin.write("read the fixture");
  instance.stdin.write("\r");
  await vi.waitFor(
    () => expect(instance.lastFrame()).toContain("summary done"),
    {timeout: 10_000},
  );

  const frame = instance.lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
  expect(frame).toContain("Read(");
  expect(frame).not.toContain("read_file(");
  instance.unmount();
});
```

Use the existing `writeFileSync` import from the test file's `node:fs` import.

- [x] **Step 4: Strengthen the existing interruption regression against duplicate commits**

After the existing assertions for `部分输出`, `后半`, and the interruption notice, add:

```ts
expect(frame.match(/部分输出/g)).toHaveLength(1);
expect(frame.match(/已中断 · 接下来要我做什么\?/g)).toHaveLength(1);
```

This freezes the combined contract that `turn_end: aborted` flushes the partial stream once before the notice and the `finally` flush is empty.

- [x] **Step 5: Run the combined App test and verify RED**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/tui.test.tsx
```

Expected: the new tool-summary test fails because the temporary merge resolution renders `read_file(...)` instead of `Read(...)`; the existing streaming interruption cases still pass.

- [x] **Step 6: Implement the minimal combined `tool_start` handler**

Replace the temporary handler with:

```ts
case "tool_start": {
  stallTrackerRef.current?.observeProgress(Date.now());
  flushStream();
  const {displayName, argSummary} = summarizeToolCall(
    ev.call.name,
    ev.parsedArgs,
  );
  tool = {name: displayName, argSummary, tail: [], streamed: false};
  activeToolRef.current = tool;
  setActiveTool(tool);
  break;
}
```

Remove `formatArgs` from the `./format.js` import. The temporary streaming-side
`tool_start` handler is its only call site, so the combined handler makes the
import unused.

- [x] **Step 7: Implement the minimal combined `turn_end` handler**

Use this exact reason mapping:

```ts
case "turn_end":
  if (ev.reason === "max_iterations") {
    pushError("已达到单轮最大迭代次数，强制停止。");
  } else if (ev.reason === "aborted") {
    flushStream();
    info("已中断 · 接下来要我做什么?");
  } else if (ev.reason === "loop_detected") {
    pushError("检测到模型在重复相同的调用（循环空转），已强制停止本轮。");
  }
  break;
```

Retain `activeToolRef.current = null` in `finally` and in successful tool-end cleanup.

- [x] **Step 8: Verify GREEN across combined visual, streaming, cursor, and App suites**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/tui.test.tsx packages/cli/test/transcript.test.tsx packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-activity/frames.test.ts packages/cli/test/tui-activity/line-commit.test.ts packages/cli/test/tui-activity/stall.test.ts packages/cli/test/tui-activity/status-line.test.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check --cached
```

Expected: all selected tests and typecheck pass; staged merge content is whitespace-clean.

- [x] **Step 9: Complete the streaming merge commit**

```bash
git add packages/cli/src/tui/App.tsx packages/cli/test/tui.test.tsx
git commit -m "Merge branch 'feature/tui-streaming-activity' into integration/tui-branch-consolidation"
```

Expected: Git records a two-parent merge commit and exits the merge state.

- [x] **Step 10: Verify the visual and streaming tips are ancestors**

```bash
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b HEAD
git merge-base --is-ancestor 82767dcccc71435b639bb4f2477eb868f26fdf3f HEAD
git status --short --branch
```

Expected: both ancestry checks exit zero and the integration worktree is clean.

---

### Task 4: Merge Permission Dialogs With Combined App Semantics

**Files:**
- Merge: `feature/tui-permission-dialogs`
- Preserve from first parent: `packages/cli/test/fixtures/pty-input-app.tsx`
- Preserve from first parent: `packages/cli/test/tui-input/pty-smoke.test.ts`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/PermissionDialog.tsx`
- Modify: `packages/cli/src/tui/permission/options.ts`
- Modify: `packages/cli/src/tui/permission/types.ts`
- Modify: `packages/cli/test/permission-options.test.ts`
- Modify: `packages/cli/test/tui.test.tsx`
- Verify: `packages/core/src/permissions.ts`
- Verify: `packages/core/src/settings.ts`
- Verify: `packages/core/src/tools/registry.ts`

**Interfaces:**
- Consumes: permission tip `f630e234f024ba19eca5b4efda33d52ef0874468`, its parent PTY fix `9eda19ddfd1b03e5a10fbce137eaa945f0398c16`, the Task 3 visual/streaming App, and the Task 1 Darwin PTY bridge.
- Produces: one merge commit where structured permission evaluation, queued confirmations, controller-based dialog input, visual tool summaries/errors, streaming activity, and a real non-skipped PTY smoke coexist.

- [ ] **Step 1: Confirm the exact permission tip and clean pre-merge state**

```bash
git status --short --branch
git rev-parse feature/tui-permission-dialogs
git rev-parse origin/feature/tui-permission-dialogs
git merge-base origin/main feature/tui-permission-dialogs
```

Expected: the worktree is clean; both permission refs equal
`f630e234f024ba19eca5b4efda33d52ef0874468`; the merge base is
`1b8c76790583b28592c43af46ee62ace4a210114`.

- [ ] **Step 2: Start the real permission merge**

```bash
git merge --no-commit --no-ff feature/tui-permission-dialogs
git diff --name-only --diff-filter=U
```

Expected: the permission/core/settings files and tests enter the index, while
the shared App/dialog/PTY/test paths stop for explicit resolution. Do not
abort, rebase, squash, or replace the merge with a cherry-pick.

- [ ] **Step 3: Keep the repaired PTY harness instead of the permission branch's obsolete probe**

```bash
git restore --source=HEAD --staged --worktree packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/pty-smoke.test.ts
git add packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: Darwin execution still uses the bounded `/bin/cat` to
`/usr/bin/script` bridge and its exit marker; early fixture exit still includes
captured output; capability detection cannot silently skip a bridge that the
test can execute.

- [ ] **Step 4: Resolve App, dialog, and App-test conflicts to the combined contract**

Resolve conflict blocks without choosing either complete file. The resulting
`App.tsx` must retain the permission branch's `evaluatePermission()`,
`ToolUseConfirm[]` queue, `usePermissionController()`, permission-mode refs,
update persistence, queue recheck, Ctrl+C queue rejection, and single
`routeKeystroke()` path. It must also retain Task 3's exact event bodies:

```ts
case "tool_start": {
  stallTrackerRef.current?.observeProgress(Date.now());
  flushStream();
  const {displayName, argSummary} = summarizeToolCall(
    ev.call.name,
    ev.parsedArgs,
  );
  tool = {name: displayName, argSummary, tail: [], streamed: false};
  activeToolRef.current = tool;
  setActiveTool(tool);
  break;
}
```

```ts
case "turn_end":
  if (ev.reason === "max_iterations") {
    pushError("已达到单轮最大迭代次数，强制停止。");
  } else if (ev.reason === "aborted") {
    flushStream();
    info("已中断 · 接下来要我做什么?");
  } else if (ev.reason === "loop_detected") {
    pushError("检测到模型在重复相同的调用（循环空转），已强制停止本轮。");
  }
  break;
```

Keep `activeToolRef`, whole-line preview/flush, stall tracking, the activity
status line, structured visual tool results/errors, input metrics, one
production `useInput()`, and one production `usePaste()`.

Resolve `PermissionDialog.tsx` around the permission branch's
`PermissionDialogView` and three-section option rows. In `tui.test.tsx`, retain
both the Task 3 summary/interruption/activity regressions and the permission
branch's numeric selection, Esc denial, feedback, plan-mode, and queued-ask
tests. Remove obsolete assertions that require the old `y/n/a/A` dialog.

- [ ] **Step 5: Add RED coverage for the retained visual diff frame**

In the existing `edit_file` case in
`packages/cli/test/permission-options.test.ts`, add:

```ts
expect(view.previewKind).toBe("diff");
```

In the App test that opens an edit/write permission dialog, capture the frame
before selecting option `1` and add:

```ts
expect(frame).toContain("╌");
```

Run:

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/permission-options.test.ts packages/cli/test/tui.test.tsx
```

Expected: the new `previewKind` assertion fails because the permission branch's
view model does not yet distinguish diff previews. Existing Task 3 and
permission-controller cases must compile at this baseline.

- [ ] **Step 6: Add the minimal typed diff-preview adapter**

Add this optional field to `PermissionViewModel`:

```ts
previewKind?: "diff";
```

Set `previewKind: "diff"` in the `edit_file` and `write_file` view models only.
In `PermissionDialog.tsx`, retain the visual branch's `dashedEdges` constant and
render `model.preview` as follows:

```tsx
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
```

Do not restore the old `PermissionRequest` or `y/n/a/A` decision API.

- [ ] **Step 7: Verify permission, visual, streaming, input, and PTY behavior**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/core/test/permissions.test.ts packages/core/test/settings.test.ts packages/core/test/registry.test.ts packages/cli/test/permission-options.test.ts packages/cli/test/tui.test.tsx packages/cli/test/transcript.test.tsx packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-activity/frames.test.ts packages/cli/test/tui-activity/line-commit.test.ts packages/cli/test/tui-activity/stall.test.ts packages/cli/test/tui-activity/status-line.test.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check --cached
```

Run the real PTY case outside the restricted sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: all focused tests and typecheck pass; the PTY suite reports one pass
and zero skips; the staged merge is whitespace-clean.

- [ ] **Step 8: Complete the permission merge commit**

```bash
git diff --name-only --diff-filter=U
git commit -m "Merge branch 'feature/tui-permission-dialogs' into integration/tui-branch-consolidation"
```

Expected: no unmerged path remains and Git records a two-parent merge commit.

- [ ] **Step 9: Verify all outstanding source tips are ancestors**

```bash
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b HEAD
git merge-base --is-ancestor 82767dcccc71435b639bb4f2477eb868f26fdf3f HEAD
git merge-base --is-ancestor 9eda19ddfd1b03e5a10fbce137eaa945f0398c16 HEAD
git merge-base --is-ancestor f630e234f024ba19eca5b4efda33d52ef0874468 HEAD
git status --short --branch
```

Expected: every ancestry check exits zero and the integration worktree is clean.

---

### Task 5: Run The Complete Integration Gate And Independent Review

**Files:**
- Inspect: all paths changed from `origin/main` to `HEAD`
- Verify: `docs/superpowers/specs/2026-07-13-tui-branch-consolidation-design.md`

**Interfaces:**
- Consumes: completed PTY repair and all three feature merge commits.
- Produces: fresh verification and independent review evidence suitable for merging into local main.

- [ ] **Step 1: Run the full Node 26 completion suite**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run build
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH node packages/cli/dist/index.js --version
git diff --check origin/main...HEAD
```

Run the complete test suite outside the restricted sandbox so the real PTY
fixture can create its `tsx` IPC socket:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test
```

Expected: typecheck, every non-skipped test, build, version smoke, and diff check pass. The CLI reports `transup 0.1.0`.

- [ ] **Step 2: Run the real PTY smoke outside the restricted sandbox again**

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: one real PTY test passes with zero skips.

- [ ] **Step 3: Audit hook, cursor, and ancestry invariants**

```bash
rg -n "useInput\(|usePaste\(" packages/cli/src/tui
rg -n "useCursor|useBoxMetrics|activeToolRef|summarizeToolCall|visibleStreamLines" packages/cli/src/tui packages/cli/test
rg -n "evaluatePermission|usePermissionController|confirmQueue|PermissionDialogView" packages/cli/src/tui packages/core/src packages/cli/test packages/core/test
git branch -r --merged HEAD
git log --graph --decorate --oneline -20
git status --short --branch
```

Expected: one production input subscription and one paste subscription remain in `App.tsx`; cursor, combined activity, and queued permission integrations exist; all six remote TUI feature branches are listed as merged; the worktree is clean.

- [ ] **Step 4: Request independent requirement and code reviews**

Use `superpowers:requesting-code-review` twice:

1. requirement review against the approved design and this plan;
2. code review of `origin/main...HEAD`, prioritizing App event ordering, duplicate stream commits, permission policy/queue correctness, PTY process cleanup, and cursor regression risk.

Expected: no unresolved Critical or Important finding. Apply valid findings with new failing regressions and narrow `fix(tui): ...` or `fix(test): ...` commits, then repeat Steps 1-3.

---

### Task 6: Merge Into Local Main And Create The Deferred Worktree

**Files:**
- Merge: `integration/tui-branch-consolidation` into local `main`
- Create worktree: `/Users/kuma/workspace/Transup/.superpowers/worktrees/tui-deferred-capabilities`
- Create branch: `feature/tui-deferred-capabilities`

**Interfaces:**
- Consumes: independently reviewed integration tip and the primary checkout at `/Users/kuma/workspace/Transup`.
- Produces: a verified local main containing all six TUI branches and a clean deferred-capabilities worktree based on that main commit.

- [ ] **Step 1: Record the verified integration tip and confirm both worktrees are safe**

```bash
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation rev-parse HEAD
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation status --short --branch
git -C /Users/kuma/workspace/Transup status --short --branch
```

Expected: integration is clean; the primary checkout has no tracked changes. Preserve its user-owned untracked `.claude/` path.

- [ ] **Step 2: Move the primary checkout from the completed input branch to local main**

```bash
git -C /Users/kuma/workspace/Transup switch main
git -C /Users/kuma/workspace/Transup merge --ff-only origin/main
```

Expected: local main advances from `3980e96` to current `origin/main` without changing `.claude/`.

- [ ] **Step 3: Merge the verified integration branch into local main**

```bash
git -C /Users/kuma/workspace/Transup merge --no-ff integration/tui-branch-consolidation -m "Merge branch 'integration/tui-branch-consolidation'"
```

Expected: Git creates a local main merge commit containing the design, plan, PTY repair, and all three feature merge commits.

- [ ] **Step 4: Re-run the final main verification**

```bash
cd /Users/kuma/workspace/Transup
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run build
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH node packages/cli/dist/index.js --version
git diff --check origin/main...main
git branch -r --merged main
git status --short --branch
```

Run the complete main test suite outside the restricted sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test
```

Expected: verification passes; all six remote feature branches are merged into local main; only the pre-existing user `.claude/` path and `packages/cli/test/fixtures/jsx-probe.tsx` file may remain untracked.

- [ ] **Step 5: Create the isolated deferred-capabilities worktree from consolidated main**

```bash
git -C /Users/kuma/workspace/Transup worktree add /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-deferred-capabilities -b feature/tui-deferred-capabilities main
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-deferred-capabilities status --short --branch
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-deferred-capabilities merge-base --is-ancestor main HEAD
```

Expected: the new worktree is clean, its branch tip equals consolidated local main, and it contains none of the deferred implementations.

- [ ] **Step 6: Report local-only completion without changing remote state**

Record:

```bash
git -C /Users/kuma/workspace/Transup log --graph --decorate --oneline -24
git -C /Users/kuma/workspace/Transup branch -vv
git -C /Users/kuma/workspace/Transup worktree list
```

Expected: local main is ahead of `origin/main`; no push or branch deletion has occurred; integration and deferred worktrees are visible with their exact branches.
