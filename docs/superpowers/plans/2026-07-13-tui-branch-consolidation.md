# TUI Branch Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the main-branch PTY smoke, merge all six outstanding TUI feature branches with their original ancestry, preserve the combined visual, streaming, permission, REPL-shell, status-panel, and core-mechanics behavior, and merge the verified result into local `main`.

**Architecture:** Work on `integration/tui-branch-consolidation` in the existing `/Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation` worktree. The PTY, visual, streaming, and permission checkpoints are complete; permission policy is additionally hardened by three reviewed fix waves. Continue the strict stack with separate `--no-ff` merges of exact 05, 06, and 07 tips, preserving each layer's App/input contracts and reviewing each checkpoint before advancing. Run the full Node 26 gate and broad independent review, then create one final local-main merge commit without pushing, deleting branches, creating the deferred-capabilities worktree, or performing release work.

**Tech Stack:** Node.js 26.5.0, TypeScript 6.0.3, React 19.2.7, Ink 7.1.0, Vitest 3.2.7, ink-testing-library 4.0.0, Git worktrees.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-13-tui-branch-consolidation-design.md` exactly.
- Work only in `/Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation` until Task 9 explicitly moves to the primary checkout.
- Preserve the original commit identities of `9cc3797`, `82767dc`, `f630e23`, `2d9e177`, `4e9f5fa`, and `4f6d30f` through real merge commits; do not rebase, squash, or cherry-pick them.
- Use Node `26.5.0` for every install, test, typecheck, build, and CLI smoke command.
- Preserve 05's limited Ctrl+O transcript screen, but do not implement full verbose mode, transcript search, alt-screen rendering, virtual scrolling, mouse support, cross-process history locking, thinking rendering, Todo, images, interaction-study 01 autocomplete, or additional interaction-study 02/03 behavior.
- Do not configure real-provider API testing, migrate the repository, publish a release, create/tag v0.1.0, or begin M6 in this plan.
- Do not push `main`, force-update any ref, or delete any local or remote branch.
- Preserve the user's untracked `/Users/kuma/workspace/Transup/.claude/` directory and `/Users/kuma/workspace/Transup/packages/cli/test/fixtures/jsx-probe.tsx` file.
- Do not switch, unlock, edit, or remove `/Users/kuma/workspace/Transup/.claude/worktrees/tui-permission-dialogs`; it is the user's clean locked 07 worktree.
- Apply RED-GREEN-REFACTOR to every new regression; merge-only verification tasks reuse the tests already committed with their source branches.
- Stage exact paths and use Conventional Commit subjects for non-merge commits.

## File Map

- `packages/cli/test/fixtures/pty-input-app.tsx`: standalone Node 26/`tsx` PTY fixture; must have a valid JSX runtime.
- `packages/cli/test/tui-input/pty-smoke.test.ts`: macOS/Linux system-PTY contract and early-exit diagnostics.
- `packages/cli/src/tui/App.tsx`: shared visual/streaming integration point for tool and turn lifecycle events.
- `packages/cli/src/tui/PermissionDialog.tsx`: permission controller view plus the visual file-diff preview frame.
- `packages/cli/src/tui/permission/`: queued permission controller, view types, and per-tool option construction.
- `packages/cli/src/tui/Layout.tsx`: 05 slotted layout and root/bottom cursor-metric anchors.
- `packages/cli/src/tui/TranscriptScreen.tsx`: 05 limited Ctrl+O full-output screen and 07 compact-summary expansion.
- `packages/cli/src/tui/terminal/`: TTY-gated title, progress, notification, and writer side channels.
- `packages/cli/src/tui/panel/`: 06 generic selection view/controller and panel input ownership.
- `packages/cli/src/tui/statusline.ts`: bounded status-line command process and JSON contract.
- `packages/cli/src/tui/use-status-line.ts`: debounced and cancellable status-line lifecycle.
- `packages/core/src/permissions.ts`: UI-independent permission evaluation, modes, rules, and persistence updates.
- `packages/core/src/agent/`: 07 compact-summary and progress-event propagation.
- `packages/core/src/session/store.ts`: 06/07 session switching, first-prompt labels, and interruption detection.
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

- [x] **Step 1: Confirm the exact permission tip and clean pre-merge state**

```bash
git status --short --branch
git rev-parse feature/tui-permission-dialogs
git rev-parse origin/feature/tui-permission-dialogs
git merge-base origin/main feature/tui-permission-dialogs
```

Expected: the worktree is clean; both permission refs equal
`f630e234f024ba19eca5b4efda33d52ef0874468`; the merge base is
`1b8c76790583b28592c43af46ee62ace4a210114`.

- [x] **Step 2: Start the real permission merge**

```bash
git merge --no-commit --no-ff feature/tui-permission-dialogs
git diff --name-only --diff-filter=U
```

Expected: the permission/core/settings files and tests enter the index, while
the shared App/dialog/PTY/test paths stop for explicit resolution. Do not
abort, rebase, squash, or replace the merge with a cherry-pick.

- [x] **Step 3: Keep the repaired PTY harness instead of the permission branch's obsolete probe**

```bash
git restore --source=HEAD --staged --worktree packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/pty-smoke.test.ts
git add packages/cli/test/fixtures/pty-input-app.tsx packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: Darwin execution still uses the bounded `/bin/cat` to
`/usr/bin/script` bridge and its exit marker; early fixture exit still includes
captured output; capability detection cannot silently skip a bridge that the
test can execute.

- [x] **Step 4: Resolve App, dialog, and App-test conflicts to the combined contract**

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

- [x] **Step 5: Add RED coverage for the retained visual diff frame**

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

- [x] **Step 6: Add the minimal typed diff-preview adapter**

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

- [x] **Step 7: Verify permission, visual, streaming, input, and PTY behavior**

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

- [x] **Step 8: Complete the permission merge commit**

```bash
git diff --name-only --diff-filter=U
git commit -m "Merge branch 'feature/tui-permission-dialogs' into integration/tui-branch-consolidation"
```

Expected: no unmerged path remains and Git records a two-parent merge commit.

- [x] **Step 9: Verify the first three feature tips and permission parent are ancestors**

```bash
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b HEAD
git merge-base --is-ancestor 82767dcccc71435b639bb4f2477eb868f26fdf3f HEAD
git merge-base --is-ancestor 9eda19ddfd1b03e5a10fbce137eaa945f0398c16 HEAD
git merge-base --is-ancestor f630e234f024ba19eca5b4efda33d52ef0874468 HEAD
git status --short --branch
```

Expected: every ancestry check exits zero and the integration worktree is clean.

- [x] **Step 10: Close authorization review findings with regression-backed fix waves**

Review and repair the complete permission boundary after the merge, including
shell wrapper/assignment/interpreter parsing, lexical versus canonical file
rules, sensitive-path safety, truthful persistent options, dangling symlinks,
`missing/../existing-link`, and POSIX carriage-return semantics.

Recorded commits:

```text
6ddec39 fix(permissions): harden authorization boundaries
1c23647 fix(permissions): close remaining authorization bypasses
a4c0f43 fix(permissions): preserve execution path semantics
```

Final focused verification under Node 26 passed 46/46 tests. The expanded
permission/App gate passed 208/208 tests, typecheck exited zero, and the real
macOS PTY passed 1/1 with zero skips. The final independent security review
reported no Critical or Important finding. Full evidence is recorded in
`.superpowers/sdd/task-4-report.md`.

---

### Task 5: Merge 05 REPL Shell With Combined App Semantics

**Files:**
- Merge: exact tip `2d9e17701567e7ff7b3aea773d7f30732e7c2116`
- Add through merge: `packages/cli/src/tui/Layout.tsx`
- Add through merge: `packages/cli/src/tui/TranscriptScreen.tsx`
- Add through merge: `packages/cli/src/tui/terminal/`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/Transcript.tsx`
- Modify: `packages/cli/src/tui/permission/options.ts`
- Modify: `packages/cli/src/tui/permission/use-permission-controller.ts`
- Modify: `packages/cli/src/tui/input/keybinding-router.ts`
- Modify: `packages/cli/src/tui/runtime/index.ts`
- Modify: `packages/cli/test/tui.test.tsx`
- Test: `packages/cli/test/terminal.test.ts`

**Interfaces:**
- Consumes: reviewed permission baseline `a4c0f43`, 05 tip `2d9e177`, visual `formatToolError()`/`summarizeToolResult()`, streaming `activeToolRef` and whole-line preview, queued permission controller, typed `previewKind: "diff"`, and cursor metric refs.
- Produces: a two-parent merge retaining 05's layout, terminal effects, limited transcript screen, raw `TranscriptItem.full`, and width-aware permission previews without weakening visual, streaming, cursor, or authorization behavior.

- [x] **Step 1: Confirm the strict stack and clean merge baseline**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse feature/tui-repl-shell
git rev-parse origin/feature/tui-repl-shell
git rev-list --count f630e234f024ba19eca5b4efda33d52ef0874468..2d9e17701567e7ff7b3aea773d7f30732e7c2116
git merge-base --is-ancestor f630e234f024ba19eca5b4efda33d52ef0874468 2d9e17701567e7ff7b3aea773d7f30732e7c2116
```

Expected: the integration worktree is clean; both 05 refs equal `2d9e177`; 05
is exactly two commits ahead of permission tip `f630e23`; the ancestry check
exits zero.

- [x] **Step 2: Start the real 05 merge**

```bash
git merge --no-commit --no-ff 2d9e17701567e7ff7b3aea773d7f30732e7c2116
git diff --name-only --diff-filter=U
```

Expected: Git stages the 05 layout, transcript, terminal, and tests and stops
on shared App/permission integration paths. Do not abort, rebase, squash,
cherry-pick, or replace this with a direct 07 merge.

- [x] **Step 3: Resolve shared files to the combined 04+05 contract**

The resolved `App.tsx` must use `Layout` slots and retain all of the following:

- successful tool results use
  `summarizeToolResult(ev.call.name, ev.content, streamed)`;
- tool errors use `formatToolError(ev.content)`;
- every completed tool transcript item also stores `full: ev.content`;
- `activeToolRef`, stall tracking, whole-line streaming preview, interruption
  flush ordering, permission queue/controller, and cursor root/bottom refs
  remain connected;
- the transcript screen owns normal keys while open and a permission ask returns
  to the prompt screen; and
- production contains exactly one `useInput()` and one `usePaste()`.

In `permission/options.ts`, pass terminal width into edit/write preview
rendering while retaining `previewKind: "diff"`. Preserve all three Task 4
authorization fix commits; do not restore the 05 branch's older permission
source or option semantics. Inspect auto-merged `Transcript.tsx`,
`use-permission-controller.ts`, and `tui.test.tsx` semantically even if they are
not listed as unmerged.

Stage only resolved shared paths:

```bash
git add packages/cli/src/tui/App.tsx packages/cli/src/tui/Transcript.tsx packages/cli/src/tui/permission/options.ts packages/cli/src/tui/permission/use-permission-controller.ts packages/cli/test/tui.test.tsx
git diff --name-only --diff-filter=U
```

Expected: no unmerged path remains.

- [x] **Step 4: Verify the focused 05 integration gate**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/terminal.test.ts packages/cli/test/tui.test.tsx packages/cli/test/transcript.test.tsx packages/cli/test/permission-options.test.ts packages/core/test/permissions.test.ts packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-activity/frames.test.ts packages/cli/test/tui-activity/line-commit.test.ts packages/cli/test/tui-activity/stall.test.ts packages/cli/test/tui-activity/status-line.test.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check --cached
```

Run the real PTY case outside the restricted sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: terminal/App/transcript/permission/activity/input suites pass,
typecheck exits zero, staged content is whitespace-clean, and PTY reports one
pass with zero skips. Any integration regression is first frozen with a failing
test, then fixed narrowly before repeating this gate.

- [x] **Step 5: Commit and review the 05 checkpoint**

```bash
git diff --name-only --diff-filter=U
git commit -m "Merge branch 'feature/tui-repl-shell' into integration/tui-branch-consolidation"
git merge-base --is-ancestor 2d9e17701567e7ff7b3aea773d7f30732e7c2116 HEAD
git rev-list --parents -n 1 HEAD
git status --short --branch
```

Expected: the merge commit has two parents, exact 05 tip is an ancestor, the
worktree is clean, and an independent Task 5 review reports both spec
compliance and code quality approved with no Critical or Important finding.

Recorded result: merge `8554240`, focused 246/246, typecheck clean, real PTY
1/1 with zero skips, and independent review approved with no Critical or
Important finding. Minor tracked for final review: `TranscriptScreen.FullItem`
does not render `error` or future `bash-input` items even though the screen
count includes them.

---

### Task 6: Merge 06 Status And Panels With Routing Semantics

**Files:**
- Merge: exact tip `4e9f5fa80dfccf05e6aab2dbad677e2924545e0d`
- Add through merge: `packages/cli/src/tui/statusline.ts`
- Add through merge: `packages/cli/src/tui/use-status-line.ts`
- Add through merge: `packages/cli/src/tui/context-grid.ts`
- Add through merge: `packages/cli/src/tui/cost-summary.ts`
- Add through merge: `packages/cli/src/tui/panel/`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/input/keybinding-router.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/core/src/settings.ts`
- Test: `packages/cli/test/statusline.test.ts`
- Test: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- Consumes: reviewed 05 checkpoint, 06 tip `4e9f5fa`, `SessionStore.list(sessionDir)`, App engine/history refs, terminal/transcript screen state, and permission controller input ownership.
- Produces: a two-parent merge with bounded status-line execution, context/cost summaries, panel routing, and `/sessions` switching while preserving all earlier contracts.

- [x] **Step 1: Confirm the exact 06 layer**

```bash
git status --short --branch
git rev-parse feature/tui-status-panels
git rev-parse origin/feature/tui-status-panels
git rev-list --count 2d9e17701567e7ff7b3aea773d7f30732e7c2116..4e9f5fa80dfccf05e6aab2dbad677e2924545e0d
git merge-base --is-ancestor 2d9e17701567e7ff7b3aea773d7f30732e7c2116 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d
```

Expected: both 06 refs equal `4e9f5fa`; 06 is exactly two commits ahead of 05;
the prior checkpoint is clean and the ancestry check exits zero.

- [x] **Step 2: Merge 06 with a separate real merge commit in progress**

```bash
git merge --no-commit --no-ff 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d
git diff --name-only --diff-filter=U
```

Expected: 06 status/panel files and tests enter the index. Resolve any shared
App/router/settings/test conflicts against the integration invariants; do not
replace this checkpoint with 07's descendant tip.

- [x] **Step 3: Enforce combined input, session, and process behavior**

The resolved input priority must be exactly:

```text
permission > panel > transcript > history-search > editor
```

Verify `/sessions` constructs and reads its store with `props.sessionDir`, then
switches history, engine, session id, and context state together. Preserve
single `useInput()`/`usePaste()` subscriptions. Status-line commands receive the
documented JSON on stdin, debounce by 300ms, time out after 5s, cancel stale
work without mutating App state, and silently discard non-zero or empty output.
The exit summary remains passed through `onExitStats` and printed only after
`waitUntilExit()` returns.

Stage only resolved shared paths that Git reports as unmerged:

```bash
git add packages/cli/src/tui/App.tsx packages/cli/src/tui/input/keybinding-router.ts packages/cli/src/index.ts packages/core/src/settings.ts packages/cli/test/tui.test.tsx
git diff --name-only --diff-filter=U
```

Expected: no unmerged path remains. Paths that merged cleanly remain in Git's
existing merge index without being restaged broadly.

- [x] **Step 4: Verify the focused 06 integration gate**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/cli/test/statusline.test.ts packages/cli/test/tui.test.tsx packages/core/test/settings.test.ts packages/cli/test/terminal.test.ts packages/cli/test/transcript.test.tsx packages/cli/test/permission-options.test.ts packages/core/test/permissions.test.ts packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-activity/frames.test.ts packages/cli/test/tui-activity/line-commit.test.ts packages/cli/test/tui-activity/stall.test.ts packages/cli/test/tui-activity/status-line.test.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check --cached
```

Expected: statusline/App/settings/terminal/transcript/permission/activity/input
suites pass, typecheck exits zero, and the staged merge is whitespace-clean.
Add a RED integration regression first if a conflict exposes an uncovered
behavioral loss.

- [x] **Step 5: Commit and review the 06 checkpoint**

```bash
git diff --name-only --diff-filter=U
git commit -m "Merge branch 'feature/tui-status-panels' into integration/tui-branch-consolidation"
git merge-base --is-ancestor 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d HEAD
git rev-list --parents -n 1 HEAD
git status --short --branch
```

Expected: the merge commit has two parents, exact 06 tip is an ancestor, the
worktree is clean, and an independent Task 6 review approves both spec and code
quality with no Critical or Important finding.

Recorded result: merge `6567506`, process-tree/atomic-transition fix `49e6bd0`,
and exit/permission-priority fix `99367b7`. The final focused gate passed
271/271, typecheck and diff-check were clean, and final re-review approved spec
and code quality with no Critical or Important finding. Residual platform risk:
real descendant termination was exercised on macOS/POSIX; the Windows
`taskkill /T /F` path matches the existing bash-tool pattern but was not run on
this host.

---

### Task 7: Merge 07 Core Mechanics Without Regressing Prior Layers

**Files:**
- Merge: exact tip `4f6d30f9f364c2ab7f083b8f1bf014811eb2b549`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/Transcript.tsx`
- Modify: `packages/cli/src/tui/TranscriptScreen.tsx`
- Modify: `packages/core/src/agent/engine.ts`
- Modify: `packages/core/src/agent/subagent.ts`
- Modify: `packages/core/src/agent/tool-runner.ts`
- Modify: `packages/core/src/session/store.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/cli/test/tui.test.tsx`
- Test: `packages/core/test/engine.test.ts`
- Test: `packages/core/test/session.test.ts`
- Test: `packages/core/test/subagent.test.ts`
- Test: `packages/core/test/streaming.test.ts`

**Interfaces:**
- Consumes: reviewed 06 checkpoint, 07 tip `4f6d30f`, App transcript and panel state, `compact_end`, tool progress channels, and session-store helpers.
- Produces: a two-parent merge with compact UX, resume notices/labels, and stable read-only/subagent progress while retaining 01-06 behavior.

- [ ] **Step 1: Confirm the exact 07 layer**

```bash
git status --short --branch
git rev-parse feature/tui-core-mechanics
git rev-parse origin/feature/tui-core-mechanics
git rev-list --count 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d..4f6d30f9f364c2ab7f083b8f1bf014811eb2b549
git merge-base --is-ancestor 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d 4f6d30f9f364c2ab7f083b8f1bf014811eb2b549
```

Expected: both 07 refs equal `4f6d30f`; 07 is exactly two commits ahead of 06;
the worktree is clean and the ancestry check exits zero.

- [ ] **Step 2: Merge 07 as the final stacked checkpoint**

```bash
git merge --no-commit --no-ff 4f6d30f9f364c2ab7f083b8f1bf014811eb2b549
git diff --name-only --diff-filter=U
```

Expected: core-mechanics source/tests enter the index. Resolve App/transcript
and engine/session conflicts without dropping visual summaries, streaming
ordering, authorization, layout, terminal, panel, or session-switch behavior.

- [ ] **Step 3: Verify compact, resume, and progress composition**

The normal screen shows the compact boundary but not its full summary; the
Ctrl+O transcript screen expands that summary. Automatic and manual compaction
share the same `compact_end.summary` path. Resumed or selected interrupted
sessions show the notice without automatically spending tokens. First-prompt
labels skip system injection and honor the selected session directory.
Read-only and subagent progress stays ordered `tool_start -> progress* ->
tool_end`, and no progress path bypasses the existing tool/permission lifecycle.

- [ ] **Step 4: Add mutation-backed regressions for the real subagent bridge and parallel progress channels**

In `packages/core/test/subagent.test.ts`, use the existing `MockProvider` and
`createTaskTool()` to exercise the real task tool rather than a custom probe:

```ts
it("真实 task 工具把子 agent 的工具调用透出为进度", async () => {
  const provider = new MockProvider([
    {
      content: "",
      toolCalls: [{id: "s1", name: "list_dir", args: '{"path":"."}'}],
    },
    {content: "结论完成"},
  ]);
  const progress: string[] = [];

  const result = await createTaskTool(provider).execute(
    {description: "检查当前目录"},
    (chunk) => progress.push(chunk),
  );

  expect(progress).toEqual(["→ list_dir .\n"]);
  expect(result).toContain("结论完成");
});
```

In `packages/core/test/streaming.test.ts`, import `z` from `zod` and add this
two-call engine regression:

```ts
it("并行只读调用各自缓冲进度，并按调用顺序输出事件", async () => {
  let secondStarted = false;
  let firstObservedSecond = false;
  const first = {
    name: "first_probe",
    description: "first",
    schema: z.object({}),
    readOnly: true,
    async execute(_args: object, onProgress?: (chunk: string) => void) {
      onProgress?.("first-start\n");
      await new Promise((resolve) => setTimeout(resolve, 25));
      firstObservedSecond = secondStarted;
      onProgress?.("first-end\n");
      return "first-done";
    },
  };
  const second = {
    name: "second_probe",
    description: "second",
    schema: z.object({}),
    readOnly: true,
    async execute(_args: object, onProgress?: (chunk: string) => void) {
      secondStarted = true;
      onProgress?.("second-only\n");
      return "second-done";
    },
  };
  class ParallelProvider implements Provider {
    readonly id = "mock";
    readonly model = "m";
    private step = 0;
    async *stream(): AsyncIterable<ProviderEvent> {
      if (this.step++ === 0) {
        yield {
          type: "message_done",
          content: "",
          toolCalls: [
            {id: "t1", name: "first_probe", args: "{}"},
            {id: "t2", name: "second_probe", args: "{}"},
          ],
        };
      } else {
        yield {type: "message_done", content: "完成", toolCalls: []};
      }
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "transup-parallel-progress-"));
  const engine = new AgentEngine({
    provider: new ParallelProvider(),
    canUseTool: allow,
    session: new SessionStore("parallel", dir),
    tools: [first, second],
  });
  const events: AgentEvent[] = [];
  for await (const event of engine.runTurn("并行运行")) events.push(event);

  expect(firstObservedSecond).toBe(true);
  expect(
    events
      .filter((ev) =>
        ev.type === "tool_start" ||
        ev.type === "tool_progress" ||
        ev.type === "tool_end",
      )
      .map((ev) => {
        if (ev.type === "tool_start") return `start:${ev.call.id}`;
        if (ev.type === "tool_progress") {
          return `progress:${ev.call.id}:${ev.chunk.trim()}`;
        }
        return `end:${ev.call.id}`;
      }),
  ).toEqual([
    "start:t1",
    "progress:t1:first-start",
    "progress:t1:first-end",
    "end:t1",
    "start:t2",
    "progress:t2:second-only",
    "end:t2",
  ]);
});
```

Stage only these tests. Prove RED by temporarily restoring the two production
implementations to their 06 versions while leaving the merge index intact:

```bash
git add packages/core/test/subagent.test.ts packages/core/test/streaming.test.ts
git restore --worktree --source=4e9f5fa80dfccf05e6aab2dbad677e2924545e0d packages/core/src/agent/subagent.ts packages/core/src/agent/tool-runner.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/core/test/subagent.test.ts packages/core/test/streaming.test.ts
```

Expected RED: the real task-tool progress assertion and the buffered read-only
progress/order assertion fail for the 06 implementations. Restore the 07 merge
versions from the index and verify GREEN:

```bash
git restore --worktree packages/core/src/agent/subagent.ts packages/core/src/agent/tool-runner.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/core/test/subagent.test.ts packages/core/test/streaming.test.ts
```

Expected GREEN: both files pass, `firstObservedSecond` proves actual concurrent
start, and the event sequence proves per-call buffered progress is emitted only
between that call's start/end pair.

Stage only resolved shared paths:

```bash
git add packages/cli/src/tui/App.tsx packages/cli/src/tui/Transcript.tsx packages/cli/src/tui/TranscriptScreen.tsx packages/core/src/agent/engine.ts packages/core/src/agent/subagent.ts packages/core/src/agent/tool-runner.ts packages/core/src/session/store.ts packages/cli/test/tui.test.tsx packages/core/test/engine.test.ts packages/core/test/session.test.ts
git diff --name-only --diff-filter=U
```

Expected: no unmerged path remains.

- [ ] **Step 5: Verify the focused 07 integration gate**

```bash
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm test -- packages/core/test/engine.test.ts packages/core/test/session.test.ts packages/core/test/subagent.test.ts packages/core/test/streaming.test.ts packages/cli/test/tui.test.tsx packages/cli/test/statusline.test.ts packages/cli/test/terminal.test.ts packages/cli/test/transcript.test.tsx packages/cli/test/permission-options.test.ts packages/core/test/permissions.test.ts packages/core/test/settings.test.ts packages/core/test/registry.test.ts packages/cli/test/tui-input/keybinding-router.test.ts packages/cli/test/tui-input/text-input.test.tsx packages/cli/test/tui-activity/frames.test.ts packages/cli/test/tui-activity/line-commit.test.ts packages/cli/test/tui-activity/stall.test.ts packages/cli/test/tui-activity/status-line.test.ts
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
git diff --check --cached
```

Run the real PTY smoke outside the restricted sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test -- packages/cli/test/tui-input/pty-smoke.test.ts
```

Expected: all focused core/CLI suites pass, typecheck exits zero, staged content
is whitespace-clean, and PTY reports 1/1 with zero skips. Add a RED regression
before any integration fix not already covered by the source branch tests.

- [ ] **Step 6: Commit and review the 07 checkpoint**

```bash
git diff --name-only --diff-filter=U
git commit -m "Merge branch 'feature/tui-core-mechanics' into integration/tui-branch-consolidation"
git merge-base --is-ancestor 4f6d30f9f364c2ab7f083b8f1bf014811eb2b549 HEAD
git rev-list --parents -n 1 HEAD
git status --short --branch
```

Expected: the merge commit has two parents, exact 07 tip is an ancestor, the
worktree is clean, and an independent Task 7 review approves both spec and code
quality with no Critical or Important finding.

---

### Task 8: Run The Complete Integration Gate And Independent Review

**Files:**
- Inspect: all paths changed from `origin/main` to `HEAD`
- Verify: `docs/superpowers/specs/2026-07-13-tui-branch-consolidation-design.md`

**Interfaces:**
- Consumes: completed PTY repair, six feature merge checkpoints, three permission hardening commits, and clean Task 5-7 reviews.
- Produces: fresh verification and independent review evidence suitable for merging into local main.

- [ ] **Step 1: Run the full Node 26 completion suite**

```bash
git status --short --branch
git fetch origin
git merge --no-ff origin/main -m "Merge remote-tracking branch 'origin/main' into integration/tui-branch-consolidation"
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

Expected: upstream is already an ancestor or is incorporated locally before
verification. Typecheck, every non-skipped test, build, version smoke, and diff
check pass. The CLI reports `transup 0.1.0`. If a newly fetched upstream commit
causes conflicts, resolve them on the integration branch, repeat the affected
focused gates, and include that resolution in both independent reviews.

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
rg -n "TranscriptScreen|useStatusLine|usePanelController|compact_end|wasInterrupted|firstPrompt" packages/cli/src packages/core/src packages/cli/test packages/core/test
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b HEAD
git merge-base --is-ancestor 82767dcccc71435b639bb4f2477eb868f26fdf3f HEAD
git merge-base --is-ancestor f630e234f024ba19eca5b4efda33d52ef0874468 HEAD
git merge-base --is-ancestor 2d9e17701567e7ff7b3aea773d7f30732e7c2116 HEAD
git merge-base --is-ancestor 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d HEAD
git merge-base --is-ancestor 4f6d30f9f364c2ab7f083b8f1bf014811eb2b549 HEAD
git branch -r --merged HEAD
git log --graph --decorate --oneline -32
git status --short --branch
```

Expected: one production input subscription and one paste subscription remain in `App.tsx`; cursor, combined activity, queued permission, transcript, panel, status-line, compact, resume, and progress integrations exist; all nine remote TUI feature branches are listed as merged; the worktree is clean.

- [ ] **Step 4: Request independent requirement and code reviews**

Use `superpowers:requesting-code-review` twice:

1. requirement review against the approved design and this plan;
2. code review of `origin/main...HEAD`, prioritizing App event ordering, duplicate stream commits, permission policy/queue correctness, PTY process cleanup, cursor regression risk, transcript ownership/raw output, status-line cancellation, panel input priority, session switching, compact summary placement, resume detection, and progress ordering.

Expected: no unresolved Critical or Important finding. Apply valid findings with new failing regressions and narrow `fix(tui): ...` or `fix(test): ...` commits, then repeat Steps 1-3.

---

### Task 9: Merge The Reviewed Integration Into Local Main

**Files:**
- Merge: `integration/tui-branch-consolidation` into local `main`

**Interfaces:**
- Consumes: independently reviewed integration tip and the primary checkout at `/Users/kuma/workspace/Transup`.
- Produces: a verified local main containing all nine TUI branches without changing remote state or starting deferred work.

- [ ] **Step 1: Record the verified integration tip and confirm both worktrees are safe**

```bash
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation rev-parse HEAD
git -C /Users/kuma/workspace/Transup/.superpowers/worktrees/tui-branch-consolidation status --short --branch
git -C /Users/kuma/workspace/Transup status --short --branch
```

Expected: integration is clean; the primary checkout has no tracked changes. Preserve its user-owned untracked `.claude/` path.

- [ ] **Step 2: Move the primary checkout from the completed input branch to local main**

```bash
git -C /Users/kuma/workspace/Transup fetch origin
git -C /Users/kuma/workspace/Transup merge-base --is-ancestor origin/main integration/tui-branch-consolidation
git -C /Users/kuma/workspace/Transup switch main
git -C /Users/kuma/workspace/Transup merge --ff-only origin/main
```

Expected: current `origin/main` is already an ancestor of the independently
reviewed integration tip, then local main advances to that same upstream tip
without changing `.claude/` or any remote ref. If the ancestry check fails,
stop before switching branches, merge the new upstream tip on the integration
branch, and repeat all of Task 8 before returning here.

- [ ] **Step 3: Merge the verified integration branch into local main**

```bash
git -C /Users/kuma/workspace/Transup merge --no-ff integration/tui-branch-consolidation -m "Merge branch 'integration/tui-branch-consolidation'"
```

Expected: Git creates a local main merge commit containing the design, plan, PTY repair, and all six feature merge checkpoints.

- [ ] **Step 4: Re-run the final main verification**

```bash
cd /Users/kuma/workspace/Transup
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run typecheck
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH npm run build
PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:$PATH node packages/cli/dist/index.js --version
git diff --check origin/main...main
git merge-base --is-ancestor 9cc379735ddf5f5ac704f4a011c4a8c4e93c314b main
git merge-base --is-ancestor 82767dcccc71435b639bb4f2477eb868f26fdf3f main
git merge-base --is-ancestor f630e234f024ba19eca5b4efda33d52ef0874468 main
git merge-base --is-ancestor 2d9e17701567e7ff7b3aea773d7f30732e7c2116 main
git merge-base --is-ancestor 4e9f5fa80dfccf05e6aab2dbad677e2924545e0d main
git merge-base --is-ancestor 4f6d30f9f364c2ab7f083b8f1bf014811eb2b549 main
git branch -r --merged main
git status --short --branch
```

Run the complete main test suite outside the restricted sandbox:

```bash
env PATH=/Users/kuma/.nvm/versions/node/v26.5.0/bin:/usr/local/bin:/usr/bin:/bin /Users/kuma/.nvm/versions/node/v26.5.0/bin/npm test
```

Expected: verification passes; all nine remote TUI feature branches are merged into local main; only the pre-existing user `.claude/` path and `packages/cli/test/fixtures/jsx-probe.tsx` file may remain untracked.

- [ ] **Step 5: Report local-only completion without changing remote state**

Record:

```bash
git -C /Users/kuma/workspace/Transup log --graph --decorate --oneline -24
git -C /Users/kuma/workspace/Transup branch -vv
git -C /Users/kuma/workspace/Transup worktree list
```

Expected: local main is ahead of `origin/main`; no push, force-update, branch deletion, deferred-worktree creation, release operation, or repository migration has occurred; the integration and protected user worktrees retain their exact branches.
