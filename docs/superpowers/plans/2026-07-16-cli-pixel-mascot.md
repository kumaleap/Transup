# CLI Pixel Mascot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the CLI banner's block-letter TRANSUP wordmark with a solid-green pixel mascot and simplify the banner to one centered column.

**Architecture:** Keep the existing in-source `LOGO` string array and bordered banner renderer. Remove the static tips/updates column, center the core session information in a compact 72-column banner, and use the existing `paint.primary` path for Transup green.

**Tech Stack:** TypeScript, Ink-compatible ANSI string rendering, Vitest.

## Global Constraints

- This phase changes only the CLI banner logo, column layout, and tests.
- Keep the mascot within the 42-column minimum inner width and use one-column-width terminal glyphs.
- Preserve the droplet outline, paired eye rings, pupils, and scalloped base.
- Render the logo through `paint.primary`, which is Transup green `#00D787` / ANSI 42.
- Remove the static tips and recent-updates column; keep version, greeting, tagline, model, invocation directory, and optional MCP status.
- Cap wide banners at 72 columns, use `columns - 1` below that cap, and skip the banner when fewer than 9 terminal columns are available.
- Do not add SVG, PNG, animation, dependencies, or unrelated theme changes in this phase.

---

### Task 1: Replace The Wordmark And Simplify The Banner

**Files:**
- Modify: `packages/cli/test/banner.test.ts`
- Modify: `packages/cli/src/tui/banner-render.ts`

**Interfaces:**
- Consumes: existing `renderBanner(info: BannerInfo, columns: number): string`.
- Produces: the same banner API with a new in-source pixel mascot.

- [ ] **Step 1: Write the failing regression test**

Add a focused test after the content test:

```ts
it("用像素吉祥物替换旧 TRANSUP 字标", () => {
  const out = stripAnsi(renderBanner(info, 100));
  expect(out).toContain("▄█████▄█████▄");
  expect(out).toContain("██ █ ███ █ ██");
  expect(out).toContain("▀█████▀█████▀");
  expect(out).toContain("▀██▀  ▀██▀  ▀██▀");
  expect(out).not.toContain("████ ███  ███  █  █ ████");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run packages/cli/test/banner.test.ts -t "用像素吉祥物替换旧 TRANSUP 字标"
```

Expected: FAIL because the current banner still contains the block-letter wordmark and does not contain the mascot eye rows.

- [ ] **Step 3: Replace the `LOGO` data with the mascot**

Change the comment and array in `packages/cli/src/tui/banner-render.ts` to:

```ts
/** transup CLI 像素吉祥物：水滴轮廓、双环眼睛与三段圆弧底座 */
const LOGO = [
  "              ▄▄▄              ",
  "          ▄██████████▄          ",
  "       ▄██▀          ▀██▄       ",
  "     ▄██                ██▄     ",
  "    ██    ▄█████▄█████▄    ██    ",
  "   ██     ██ █ ███ █ ██     ██   ",
  "   ██     ▀█████▀█████▀     ██   ",
  "    ██                    ██    ",
  "     ▀██▄              ▄██▀     ",
  "       ██▄  ▄██▄  ▄██▄  ▄██       ",
  "        ▀██▀  ▀██▀  ▀██▀        ",
];
```

Delete `TIPS`, `WHATS_NEW`, `rightColumn()`, and the two-column branch. Rename
`leftColumn()` to `contentRows()`, cap `MAX_WIDTH` at `72`, and render every
content row centered across the single inner column. Keep the mascot rows on
`paint.primary`; do not introduce a new color path. Truncate the title to
`W - 7` display cells before embedding it in the top border.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run packages/cli/test/banner.test.ts -t "用像素吉祥物替换旧 TRANSUP 字标"
```

Expected: 1 test passes and the remaining tests in the file are skipped by the name filter.

- [ ] **Step 5: Run banner regression coverage**

Run:

```bash
npx vitest run packages/cli/test/banner.test.ts
```

Expected: all ten banner tests pass, including the 39- and 59-column narrow
results, 72-column wide cap, tiny-terminal guard, long-version truncation,
absence of a middle divider, primary-green logo, and metadata sanitization.

- [ ] **Step 6: Run project verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: both commands exit with status 0 and Vitest reports no failed tests.

- [ ] **Step 7: Inspect the rendered banner manually**

Render a representative 100-column banner through the existing test/runtime path and confirm the mascot is centered, recognizable, unclipped, and entirely green after ANSI rendering. If a row exceeds the 42-column minimum inner width, shorten only its outer padding or silhouette width and rerun Steps 5 and 6.

- [ ] **Step 8: Commit the focused change**

```bash
git add packages/cli/src/tui/banner-render.ts packages/cli/test/banner.test.ts
git commit -m "feat(cli): add pixel mascot to startup banner"
```
