# CLI Information Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Transup use its original invocation directory and reduce the startup banner and default footer to the information users need continuously.

**Architecture:** Resolve the invocation workspace once at CLI startup, preferring a valid `INIT_CWD` over npm workspace's changed `process.cwd()`, then restore the process cwd before workspace-dependent initialization. Pass that cwd explicitly into the TUI. Keep banner rendering and footer rendering independent, but share one home-directory abbreviation helper so both display the same path.

**Tech Stack:** TypeScript, Node.js process/fs/path APIs, React/Ink, Vitest.

## Global Constraints

- Work directly in the current checkout as requested; do not create a worktree.
- Preserve the pixel mascot and solid Transup green `#00D787` / ANSI 42.
- The banner must not display provider ID or session ID.
- The default footer must display only model and invocation workspace path.
- Preserve `/context` and `/cost` as on-demand commands.
- Remove the automatic-context warning from the default prompt screen because compaction is automatic.
- Preserve temporary permission-mode and user-configured custom status-line output.
- Do not change session persistence, tracing fields, provider behavior, or context-compaction logic.

---

### Task 1: Restore The Invocation Workspace

**Files:**
- Create: `packages/cli/src/invocation-cwd.ts`
- Create: `packages/cli/test/invocation-cwd.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**
- Produces: `restoreInvocationCwd(env?: NodeJS.ProcessEnv): string`.
- Behavior: tries `env.INIT_CWD` when non-empty; falls back to the current cwd if it cannot `chdir`; returns the effective cwd.

- [ ] Write tests that mock `process.cwd()` and `process.chdir()` for valid `INIT_CWD`, missing `INIT_CWD`, and invalid `INIT_CWD` fallback.
- [ ] Run `npx vitest run packages/cli/test/invocation-cwd.test.ts` and verify RED.
- [ ] Implement `restoreInvocationCwd()` with a guarded `process.chdir()`.
- [ ] Run the focused test and verify GREEN.
- [ ] Call it near the top of `index.ts`, before dotenv lookup and all workspace-dependent initialization; store the result as `workspaceCwd`.
- [ ] Use `workspaceCwd` for trust, project context, startup settings, trace cwd, and the `App` prop.

### Task 2: Simplify The Startup Banner

**Files:**
- Create: `packages/cli/src/tui/workspace-path.ts`
- Modify: `packages/cli/src/tui/banner-render.ts`
- Modify: `packages/cli/test/banner.test.ts`
- Modify: `packages/cli/src/tui/App.tsx`

**Interfaces:**
- Produces: `abbreviateHome(path: string): string`.
- Changes `BannerInfo` to retain `version`, `model`, `cwd`, and `mcpToolCount`; removes provider/session/resume fields.
- Adds required `cwd: string` to `AppProps`.

- [ ] Add failing banner assertions that provider ID, session text, and resume count are absent while model, abbreviated invocation cwd, and optional MCP count remain.
- [ ] Add focused home-abbreviation coverage through the banner/status tests.
- [ ] Run banner tests and verify RED.
- [ ] Implement `abbreviateHome()` and use it in banner path shortening.
- [ ] Remove provider/session/resume fields and rows from `BannerInfo` and `contentRows()`.
- [ ] Pass `props.cwd` rather than `process.cwd()` when creating the banner, status-line workspace payload, and terminal title.
- [ ] Run banner and TUI startup tests and verify GREEN.

### Task 3: Reduce The Default Footer

**Files:**
- Modify: `packages/cli/src/tui/StatusBar.tsx`
- Modify: `packages/cli/test/status-bar.test.tsx`
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- `StatusBar` consumes `{model: string; cwd: string}`.
- Renders `◆ <model> · <abbreviated cwd>` and no other default metadata.

- [ ] Replace the current status-bar test with failing assertions for sanitized model plus abbreviated cwd, and absence of provider, MCP, tokens, cache, context label, meter, and percentage.
- [ ] Run `npx vitest run packages/cli/test/status-bar.test.tsx` and verify RED.
- [ ] Remove token formatting and context-meter rendering from `StatusBar`; render only model and cwd.
- [ ] Remove the automatic-context warning from `App` while retaining internal context state for compaction and on-demand/custom status-line data.
- [ ] Update TUI startup assertions to expect the model and cwd footer without the context meter.
- [ ] Run status-bar, banner, and TUI startup tests and verify GREEN.

### Task 4: Verify The Integrated CLI

**Files:**
- Verify all files above.

- [ ] Run `npx vitest run packages/cli/test/invocation-cwd.test.ts packages/cli/test/banner.test.ts packages/cli/test/status-bar.test.tsx`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Render representative wide and 40-column banners and inspect alignment.
- [ ] Run `npm test` and confirm all test files and tests pass.
- [ ] Run `git diff --check` and inspect the final diff for unrelated changes.
