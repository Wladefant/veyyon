# ModalShell SPEC

Floating overlay chrome specification for Veyyon TUI surfaces.

Idle sessions display transcript and bottom composer; overlays float above the active session surface.

Source: `src/modes/terminal/components/chrome/modal-shell.ts` (rendering, footer chips, hit testing) and `src/modes/terminal/components/chrome/modal-geometry.ts` (sizing presets, card dimensions, chrome row reservation). Test: `packages/coding-agent/test/brand-conformance.test.ts`.

## Sizing presets

| Preset | width_pct | max_width | min_width | v_margin | h_pad | v_pad | footer_lines |
|---|---:|---:|---:|---:|---:|---:|---:|
| LARGE | 0.90 | 140 | 60 | 7 | 2 | 2 | 2 |
| MEDIUM | 0.60 | 120 | 44 | 4 | 2 | 1 | 2 |
| SETTINGS | 0.80 | 124 | 44 | 3 | 2 | 1 | 2 |

- `layoutModalCard` applies `sizingForArea(sizing, areaHeight, forceCompact?)` to every sizing it lays out. On an area of at most `24 + 2*v_pad` rows (`modalNeedsCompactPadding`), or when `forceCompact` is set, the card sets `h_pad=1` and `v_pad=0` and keeps `v_margin`. Above that height the padded card shows more body rows than the compact card one row shorter. LARGE is compact up to 28 rows, MEDIUM and SETTINGS up to 26.
- `computeModalDims`: preferred width = `area.w * width_pct`, clamped to `[min_width, min(area.w-4, max_width)]`; height = `max(area.h - 2*v_margin, min(area.h, 24 + 4*v_pad))`.
- Card is centered with blank underpaint.

## Rendering a card

1. `layoutModalCard(areaWidth, areaHeight, sizing, forceCompact?)` lays the card out on the area with the compact rule applied. It returns null when `w < 20` or `h < 6`; the caller then paints `emptyModalArea(areaWidth, areaHeight)` and clears its hit rectangles.
2. `planModalChrome(card, { shortcuts, hoveredShortcutId, tipCandidates, searchLine, minBodyRows })` reserves the chrome. When the card is too short for its chrome plus `minBodyRows` body rows, it sheds the tip gap, the tip, `v_pad` and the footer padding, in that order; chip rows are never shed. `maxBodyRows` is the number of body rows the card shows.
3. `renderModalShell(plan, content)` paints that plan. A body row past `maxBodyRows` is dropped.

A caller that sizes its body reads `maxBodyRows` from the plan it paints, so the body is sized against the chrome the card draws. A card with a body floor passes it as `minBodyRows` and fits its body to `maxBodyRows`, down to one row, instead of keeping the floor and losing the rows below it.

## Chrome anatomy

1. Title inset on top border (`─ Title ─`); leading decoration width = 2.
2. Close button `[x]` on top-right border.
3. Click outside card closes modal.
4. Optional search row and divider at top of body.
5. Body padding (`h_pad` / `v_pad`).
6. Optional tip line via `fitTipLine` when height ≥ 6.
7. Footer with centered chips, bold keys, and separator `SHORTCUT_SEP` (`  ·  `).
8. Optional breadcrumb suffix on title (`Settings › Label`).

## Disclosure

- Fold glyph is 2 columns (`foldCollapsedGlyph` / `foldExpandedGlyph`).
- Descriptions expand on demand without a permanent empty description band.

## Key handling

FilterFocused → Browse → close modal. Sub-pane Esc returns to Browse. Close button or click outside closes modal.

## Theme tokens

| Element | Token | Notes |
|---|---|---|
| Card border / box-drawing | `borderAccent` (ember `#F0862E` in titanium) | Structural borders, with one ember tick after the top-left corner |
| Title / chip keys | `accent` (silver) | Bold title and key tokens |
| Chip labels / tip | `muted` / `dim` | Secondary text |
| Close glyph | `accent` | Visible accent |
| Underpaint | black | Clear background padding |

## Hosting

Use `SelectorController.showModalSelector` or fullscreen overlay (`fullscreen: true`).

## Surfaces using ModalShell

Settings, session resume, model picker, extensions, copy, ask, plan-review, move, history, OAuth pickers, theme/thinking/queue selectors, and agent dashboard.

## Contract tests

`test/modal-shell.test.ts` validates sizing aborts, compact mode, tip gaps, footer wrapping, shortcut handling, and border geometry.
