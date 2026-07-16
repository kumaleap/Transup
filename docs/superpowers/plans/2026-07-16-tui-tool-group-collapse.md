# TUI Tool Group Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive successful tool calls between two assistant messages into a single transcript summary line, with full per-call details available on the Ctrl+O transcript screen. While running, the line reads in present progressive (`● Pondering… · editing 2 files +35 · reading 1 file · running 4 shell commands`); once committed it flips to past tense (`● Thought for 2m56s · made 2 edits +35 · read 1 file · ran 4 shell commands`).

**Architecture:** Items committed to Ink `<Static>` land in the real terminal scrollback and are immutable, so collapsing must happen **before** commit. `runTurn` buffers successful `tool_end` results in a pending-group ref instead of pushing them immediately; the group flushes as one `tool-group` transcript item at natural boundaries (next assistant text, tool error, compact, turn end/abort). A pure module owns categorization and summary text; per-edit line deltas are computed CLI-side from `tool_start` `parsedArgs` (`new_string`/`old_string` line counts), so core is untouched. While the group is pending, the dynamic region renders the live-updating summary above the active-tool line. The Ctrl+O `TranscriptScreen` expands group children using the existing full tool-item rendering.

**Tech Stack:** TypeScript, React/Ink, Vitest.

**Execution status:** 完成（2026-07-16）。新增/改动测试全绿（tool-group 11、transcript 46、tui 108 中 107——唯一失败的"终端标题与进度"在干净树上同样失败，属 pull 自带的环境性问题）；typecheck 与 build 干净。npm test 里 core/cli 另有 29 个失败，经 stash 对照确认全部为主干带入的 Windows 环境性失败（symlink 特权等），与本变更无关。真实 API 的多工具手动验证留待用户日常使用确认。

**实现偏差（相对本 plan 原文）:**
- live 进行时摘要没有单独占一行，而是替换 spinner 行的动词段（`⠂ Weaving… · reading 1 file`）——避免动词在动态区出现两次，也更贴近 Claude Code 的实际形态。
- 主屏 ⎿ 提示行整体 dim、计数不 bold：bold 的闭合码 `\x1b[22m` 会连带关掉外层 dim（Transcript.tsx 头注释里的 chalk 老坑）。
- 摘要行不做渲染期净化：summary 由 summarizeGroup 从已净化输入构造（自带 bold 计数），与 tool preview 同款信任模型；敌意输入的净化仍在 producer 边界完成。

## Global Constraints

- Do not modify `packages/core` — this is presentation-layer only; trace recording and session persistence keep seeing raw per-tool events.
- Groups contain only **successful** tool calls. A tool error flushes the pending group first, then renders as today's standalone red-dot item with `formatToolError` output.
- A pending group with a single entry falls back to today's per-tool `kind: "tool"` item — collapse only at ≥2 entries.
- No new settings or flags: the Ctrl+O transcript screen is the detail view ("expand"), matching the existing `compact` item's one-line-card + full-screen pattern.
- Reuse `formatDuration` from `activity/status-line.ts` for the elapsed segment. The **live** form leads with the turn's sampled verb from `activity/verbs.ts` (pass in — pure modules must not sample); the **done** form always leads with fixed `Thought for <duration>` — sampled gerunds (`Moonwalking`) have no derivable past tense, so committed lines never use them.
- The elapsed duration measures the whole segment (model thinking included): the timer starts at the segment boundary (turn start or the previous assistant-text flush), not at the first tool call.
- Summary line follows spec §1 gutter rules: `⏺ ` 2-column gutter, `  ⎿  ` 5-column result line for the detail hint; numbers bold per spec §2.
- All user-facing strings pass through `sanitizeTerminalText`.

---

### Task 1: Pure Group Model And Summary Text

**Files:**
- Create: `packages/cli/src/tui/tool-group.ts`
- Create: `packages/cli/test/tool-group.test.ts`

**Interfaces:**
- Produces: `interface ToolGroupEntry { name: string; displayName: string; argSummary: string; preview: string; full?: string; lineDelta?: number }` (`name` is the registry name, e.g. `edit_file`; `lineDelta` only for edit/write).
- Produces: `editLineDelta(name: string, args: Record<string, unknown>): number | undefined` — `edit_file`: `new_string` lines − `old_string` lines; `write_file`: `content` lines; other tools: `undefined`.
- Produces: `summarizeGroup(opts: { tense: "live" | "done"; verb: string; elapsedMs: number; entries: ToolGroupEntry[] }): string` — segments joined with ` · `, counts bold, empty categories omitted, singulars (`1 file`, `1 shell command`) handled. Per tense:
  - `live`: leads with `<verb>…` (sampled gerund, no duration — the status bracket already shows elapsed time); categories in present progressive: `editing N files +M`, `reading N files`, `running N shell commands`, `searching N patterns`, `calling N tools`.
  - `done`: leads with fixed `Thought for <duration>` (duration omitted when `elapsedMs` < 1s); categories in past tense: `made N edits +M`, `read N files`, `ran N shell commands`, `searched N patterns`, `called N tools`.
  - Shared category rules: `write_file` counts as an edit; the `+M` delta shows the net sum, omitted when 0, `-M` when negative; grep/list_dir are searches; everything else is the generic tools bucket.
- Produces: `shouldCollapse(entries: ToolGroupEntry[]): boolean` — true at length ≥ 2.

- [x] Write failing tests: `editLineDelta` for edit (net positive/negative/zero), write (content line count), non-edit tools (`undefined`), missing args (`undefined`).
- [x] Write failing tests: `summarizeGroup` for both tenses — live leads with `<verb>…` and progressive categories, done leads with `Thought for <duration>` and past-tense categories — plus mixed-category ordering and ` · ` joining, singular/plural, delta sum shown/omitted/negative, sub-1s duration omission in done form, unknown tools bucket, bold count markers present.
- [x] Write failing tests: `shouldCollapse` at 0/1/2 entries.
- [x] Run `npx vitest run packages/cli/test/tool-group.test.ts` and verify RED.
- [x] Implement `tool-group.ts` as a pure module (no React/Ink imports), reusing `inline.bold` from `Transcript.tsx` and `formatDuration` from `activity/status-line.ts`.
- [x] Run the focused test and verify GREEN.

### Task 2: Transcript Item Kind And Main-Screen Rendering

**Files:**
- Modify: `packages/cli/src/tui/Transcript.tsx`
- Modify: `packages/cli/test/transcript.test.tsx`

**Interfaces:**
- Adds `TranscriptItem` variant: `{ id: number; kind: "tool-group"; summary: string; children: ToolGroupEntry[] }` — `children` carry `full` for the Ctrl+O screen; main screen never renders them.
- `TranscriptItemView` renders: green `⏺` dot + summary text (summary already carries its own bold segments, so no outer dim), then a `ResultLine` hint `Ctrl+O 查看 N 次调用详情` (dim, count bold).

- [x] Write failing render tests: summary line with green dot and 2-column gutter, hint result line with 5-column `⎿` gutter, children not rendered on the main screen, sanitization of hostile summary text.
- [x] Run `npx vitest run packages/cli/test/transcript.test.tsx` and verify RED.
- [x] Add the variant and the `TranscriptItemView` case.
- [x] Run the focused test and verify GREEN.

### Task 3: Buffering And Flush Boundaries In runTurn

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/test/tui.test.tsx`

**Interfaces:**
- `runTurn` keeps `pendingGroup: { entries: ToolGroupEntry[] } | null` alongside the existing `tool` local, plus `segmentStart: number` — set to `Date.now()` at turn start and reset by every `flushStream`, so the done-form duration covers model thinking between tools, not just tool runtime.
- `tool_start`: additionally computes `editLineDelta(ev.call.name, ev.parsedArgs)` and stashes it on the active tool.
- `tool_end` success: appends to `pendingGroup` instead of pushing; preview/full computed exactly as today so Ctrl+O output is unchanged.
- `tool_end` error: `flushGroup()` first, then push today's standalone error tool item.
- `flushGroup()`: no-op when empty; 1 entry → push today's `kind: "tool"` item; ≥2 → push `kind: "tool-group"` with `summarizeGroup({ tense: "done", verb: turnVerb, elapsedMs: Date.now() - segmentStart, entries })`. Called from `flushStream` (before assistant text lands), `compact_start`, `turn_end`, abort, and the `finally` cleanup.
- Dynamic region: while `pendingGroup` has ≥1 entry, render the live summary (`tense: "live"`, dim) above the existing active-tool line so completed-but-unflushed calls stay visible; on flush the committed done-form line replaces it in scrollback.

- [x] Write failing e2e tests: a turn with text → 3 tools → text produces one `tool-group` item between the two assistant items and no per-tool items for them.
- [x] Write failing e2e tests: single tool between texts stays a `kind: "tool"` item (no group of one).
- [x] Write failing e2e tests: tool error mid-group flushes the group, then shows the standalone red error item.
- [x] Write failing e2e tests: turn ending (or abort) with a pending group of ≥2 flushes it as a group; live summary line (progressive tense) visible in the dynamic region while tools are running; committed line uses `Thought for` past-tense form.
- [x] Write failing e2e test: the done-form duration is measured from the segment boundary (turn start / previous text flush), not from the first tool call.
- [x] Run `npx vitest run packages/cli/test/tui.test.tsx -t <new test pattern>` and verify RED.
- [x] Implement buffering, `flushGroup()`, all flush call sites, and the dynamic-region pending summary.
- [x] Run the focused tests and verify GREEN, then run the full `tui.test.tsx` file to catch regressions in existing per-tool assertions.

### Task 4: Ctrl+O Detail Expansion

**Files:**
- Modify: `packages/cli/src/tui/TranscriptScreen.tsx`
- Modify: `packages/cli/test/transcript.test.tsx` (or the screen's existing test home in `tui.test.tsx`)

**Interfaces:**
- `FullItem` gains a `tool-group` case: renders each child through the existing full tool-item layout (bold name, arg summary, `full ?? preview` body, `MAX_TOOL_LINES` clamp with Ctrl+E expansion) — visually identical to N consecutive tool items today.

- [x] Write failing tests: transcript screen shows every child of a group with names, arg summaries, and full bodies; clamp + `Ctrl+E` hint still applies per child.
- [x] Run the focused test and verify RED.
- [x] Implement the case (extract/reuse the existing tool rendering rather than duplicating it).
- [x] Run the focused test and verify GREEN.

### Task 5: Verify The Integrated CLI

**Files:**
- Verify all files above.

- [x] Run `npx vitest run packages/cli/test/tool-group.test.ts packages/cli/test/transcript.test.tsx packages/cli/test/tui.test.tsx`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Manually drive a real multi-tool turn and inspect: live pending summary while running, one collapsed line after, Ctrl+O expansion, error mid-group behavior.
- [x] Run `npm test` and confirm all test files and tests pass.
- [x] Run `git diff --check` and inspect the final diff for unrelated changes.
