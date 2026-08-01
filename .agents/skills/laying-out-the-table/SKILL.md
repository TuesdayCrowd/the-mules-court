---
name: laying-out-the-table
description: Use when changing table geometry, seat chips, the discard row, the deck, or anything in src/client/layout, or when adding a field to LayoutSpec, RenderPlan, SeatPlan or ChipSpec.
---

# Laying out the table

## Overview

Table geometry is **data, not drawing**. `computeLayout(input) → LayoutSpec` and
`buildRenderPlan(...) → RenderPlan` are pure functions in `src/client/layout/`,
tested under Node with no DOM. `src/client/ui/table.ts` walks the result and sets
`style.left/top/width/height`. Keep the scene glue thin enough to review by reading.

**Put the decision in the pure module.** A number computed inside `table.ts` is a
number no layout test can see.

## The failure this repo has shipped three times

`computeLayout` and `buildRenderPlan` can be *exactly right* while the renderer never
reads one of their fields — and no pure test can detect that, because a pure test only
ever exercises the pure layer.

`src/client/ui/tableContract.test.ts` is the guard: it greps `table.ts`'s source text
for every field the pure layer publishes.

**So: adding a field to `LayoutSpec` / `RenderPlan` / `SeatPlan` / `ChipSpec` means
adding it to `tableContract.test.ts` too** — either as a field the renderer must
mention, or in `NOT_DRAWN` with a reason. Never add a `NOT_DRAWN` entry without one;
an unexplained entry is how the guard rots into a list of things nobody checks.

## Sizing traps

- **`width: fit-content` still needs an explicit `height`.** A `fit-content` box with
  no height takes its line box's height, which drifts past the budget the spec
  reserved for it. `.tbl-seat-name-scrim` and `.tbl-chip-line` read `nameBandH` /
  `smallH` and set `style.height` directly, which is why those fields are *not* in
  `NOT_DRAWN`.
- **`fit-content` may only hug text that fits.** Both scrims carry an explicit
  `max-width` from `SeatPlan.rect.w`; a transform on inner text does not shrink the
  scrim around it.
- **The discard pile can reach eight, not seven.** `layout/discardCapacity.test.ts`
  drives thousands of real engine matches to prove it. The design document says seven
  and is wrong. Do not "correct" the reserve downward.

## What a pure test cannot see

Anything drawn *past* a rect is not a rect. Two bugs shipped straight through a green
suite that way — a hand flung to opposite corners, and a caption twice the width of the
card it captioned.

`bun run test:visual` drives real matches in a real browser and writes a PNG per
viewport (needs both dev servers up). It is a **capture harness, not an oracle**: it
fails only on what a machine can judge — a page error, a missing table, an empty
accessibility twin — and leaves the rest to eyes. Run it after any geometry change and
actually look at the output.

## Common mistakes

- **Re-deriving geometry in `table.ts`.** A historical bug hardcoded `seat.rect.y + 26`
  and `seat.rect.h - 16`; the offsets belong in the spec.
- **Adding a field and only updating `table.ts`.** The contract test greps source
  text, so it passes — until someone reads the spec and expects the field to matter.
- **Testing layout under jsdom.** jsdom has no layout engine. Assert on the returned
  spec, not on `getBoundingClientRect`.
