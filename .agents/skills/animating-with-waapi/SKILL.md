---
name: animating-with-waapi
description: Use when adding or changing motion in this game — a cinematic beat, a card reveal, an elimination flourish, a transition — or when editing src/client/ui/beats.ts or src/client/store/motion.ts.
---

# Animating with the Web Animations API

## Overview

There is no tween manager and no render loop. Motion is
`await element.animate(keyframes, options).finished` — a WAAPI `Animation` runs on the
compositor and resolves its own promise.

The work splits in two, and the split is the point:

| Where | What it owns |
|---|---|
| `src/client/store/motion.ts` | **What plays.** Staging order, durations, the reduced-motion collapse. Pure, Node-testable. |
| `src/client/ui/beats.ts` | **How to draw a step.** Nothing else. |

Adding a beat usually means editing `motion.ts` first and `beats.ts` second. A duration
hardcoded in `beats.ts` is a duration no test can read.

## The rule that breaks things silently

**Beats own their own transient layer. Never animate a live table element.**

`table.ts#draw()` rebuilds the table's DOM on every state update
(`planLayer.replaceChildren()`). An animation targeting a table element has its target
ripped out from under it mid-flight — and because the animation's promise never
rejects, the beat simply hangs or vanishes with no error anywhere.

Every element a beat creates is transient: appended to the `layer` the runner is handed
(never the table's own DOM), and removed when its animation finishes.

## Reduced motion

Never read `matchMedia` here. `reducedMotion`, `viewport` and `tableRoot` all arrive
through `BeatRunnerDeps`, **read at play time rather than cached** — a player can change
the setting mid-match. `motionPlan()` already collapses non-informational beats when it
is set; informational ones still play, because they carry meaning a player would
otherwise lose.

## A broken animation must never swallow the announcement

`run()` wraps each step in try/catch on purpose. The beat is decoration attached to
something that **already happened on the server**; if the decoration throws, the
announcement still has to surface. Do not "clean up" that try/catch.

## Do not restore the displacement filter

The Mule's `ripple` is deliberately not a literal port of the old Phaser version, which
warped the rendered table with a camera filter. A DOM table grants no such surface, and
the alternatives were all rejected in writing
(`docs/plans/2026-07-30-renderer-architecture-research.md` §8). The substitute — warp
the Mule's portrait, which is already an image, over a full-viewport wash and a
compositor-safe shudder on the table root — is the design, not a shortfall.
`shaders/distortion_map.png` stays unused by design; only `rainbow_gradient.png` and
`sparkle_pattern.png` are still loaded.

## Common mistakes

- **`repeat: -1` / `iterations: Infinity`.** An animation that never ends never resolves
  its promise, so anything awaiting it waits forever.
- **Animating a property that forces layout.** Prefer `transform` and `opacity`; they
  stay on the compositor.
- **Testing motion by waiting.** Inject timers and assert on the plan `motion.ts`
  returns. jsdom does not run WAAPI.
