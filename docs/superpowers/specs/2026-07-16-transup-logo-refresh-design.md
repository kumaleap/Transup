# Transup Logo Refresh Design

**Date:** 2026-07-16
**Status:** Approved for implementation planning

## Goal

Replace Transup's current terminal wordmark with a mascot mark based on the
provided reference image. Establish a reusable brand source asset and keep the
CLI presentation consistent with Transup's established solid green theme.

## Scope

The change covers two related outputs:

1. A transparent, production-ready vector brand mark with a matching raster
   export.
2. A compact terminal character-art interpretation used in the CLI startup
   banner.

The work also applies the already established minimal Transup palette to the
current branch so the new logo is rendered in one solid brand color rather
than the branch's older cyan-to-purple gradient.

The work does not add a wordmark, slogan treatment, animation, application
icon bundle, social banner, or website layout.

## Visual Direction

The logo will be redrawn geometrically rather than generated or automatically
traced from the raster reference. This keeps paths clean and makes the mark
stable at both small and large sizes.

The following features define the mark and must remain recognizable:

- A rounded triangular or droplet-shaped outer contour.
- Three rounded lobes along the lower edge.
- Two connected circular eye rings centered inside the body.
- Two solid circular pupils.
- Rounded line caps and joins throughout.

The asset will use exactly one visible color:

- Transup brand green: `#00D787`.

The background is transparent. The mark contains no gradient, shadow, glow,
texture, lighting effect, white fill, border color, or embedded text.

## Brand Assets

The canonical source will be:

- `assets/brand/transup-mark.svg`

The SVG will use a square `viewBox`, centered geometry, and enough internal
padding to avoid clipping at rounded stroke edges. Its paths and basic shapes
will be deterministic and editable. The green value will be declared once and
reused by the visible geometry where practical.

A matching transparent PNG will be exported to:

- `assets/brand/transup-mark.png`

The PNG will be square, high resolution, use an alpha channel, and preserve
the same padding and proportions as the SVG. It is intended for consumers that
cannot display SVG, including repository, package, or future product surfaces.

## CLI Banner Adaptation

The current seven-line block-letter `TRANSUP` logo in
`packages/cli/src/tui/banner-render.ts` will be replaced by a compact character
art mascot. The terminal version will prioritize recognition over literal
curve fidelity.

Constraints:

- Fit within the existing 36-column wide banner left column.
- Remain legible in a monospaced terminal without relying on font ligatures.
- Preserve the outer droplet silhouette, paired eyes, pupils, and scalloped
  base.
- Render every logo row with `paint.primary` only.
- Avoid Unicode characters whose display width is ambiguous in common
  terminals.
- Continue to work in both the wide two-column and narrow single-column banner
  layouts.

The banner title `transup v<version>` and existing product tagline remain.
Runtime metadata is limited to the model, original invocation workspace, and
optional MCP tool count. Provider and session identifiers are omitted.

## Theme Alignment

The CLI theme will follow the previously established minimal palette:

- Primary: `#00D787` / ANSI 256 color 42.
- Secondary UI: neutral gray.
- Frame and divider UI: darker neutral gray.
- Success, warning, and danger colors remain semantic and appear only when
  required by status.

The logo and tagline will no longer use cyan-purple gradient helpers. Removing
unused gradient helpers is in scope only when they have no remaining consumers.
No unrelated component styling will be changed.

## Testing And Verification

Automated coverage will verify:

- The banner includes distinctive rows or features from the new mascot rather
  than the old `TRANSUP` block wordmark.
- All rendered banner lines keep their expected display width in narrow and
  wide layouts.
- The logo uses the primary paint path and no gradient helper.
- Existing banner content, including version, tagline, model, original
  invocation directory, and optional MCP information, remains present.
- Provider and session identifiers are absent from the banner.
- Type checking and the relevant CLI test suite pass.

Asset verification will confirm:

- The SVG parses successfully and has a square view box.
- All visible SVG colors are `#00D787`.
- The PNG has square dimensions, an alpha channel, transparent corners, and
  non-empty centered artwork.
- A rendered PNG preview matches the approved reference structure without
  clipping, fringe pixels, gradients, or background fill.

## Error And Compatibility Considerations

The CLI does not load the SVG or PNG at runtime, so a missing image asset cannot
break startup rendering. The terminal logo remains an in-source string array,
matching the current architecture and avoiding runtime filesystem or image
protocol dependencies.

If a terminal cannot display the selected box-drawing characters consistently,
tests will favor conservative one-column-width block and line characters. The
existing ANSI color fallback behavior remains responsible for reduced-color
terminals.

## Acceptance Criteria

The work is complete when the repository contains the transparent SVG and PNG
brand assets, the CLI banner shows the recognizable mascot in solid Transup
green, the old block wordmark and cyan-purple logo gradient are absent from the
startup banner, relevant tests and type checking pass, and the raster preview
has been visually inspected.
