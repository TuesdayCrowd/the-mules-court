# Renderer conversion — removing Phaser

Research: `docs/plans/2026-07-30-renderer-architecture-research.md`.
Decision recorded in §12 of that document; the staging below is its table, expanded.

The order is chosen so that everything before Stage 3 is worth doing **even if
the decision reverses**. Nothing is wasted until the DOM table is written.

---

## Stage 1: Serve compressed responses

**Goal**: Stop shipping ~1.46 MB of raw JavaScript where ~380 KB would do.
**Success Criteria**: A request carrying `Accept-Encoding: gzip` gets a
compressed body and a matching `Content-Encoding`; one without it still gets
the raw bytes. `__tests__/static.test.ts` passes **unedited** — the traversal
policy it guards is untouched.
**Tests**: A request with `Accept-Encoding: gzip` for a `.js` asset comes back
`Content-Encoding: gzip` and decompresses to the original bytes. A request
without the header comes back uncompressed. An already-small response is not
compressed. The shell fallback compresses too.
**Status**: Not Started

Independent of the renderer decision entirely. Listed first because it is the
largest player-facing win either research pass found.

## Stage 2: Hoist the pure layer out of `Court.ts`

**Goal**: `Court.ts:1006-1134` — event-name strings, `SEAT_COLOURS`, `hex()`,
`CARD_ASPECT`, the fractions and floors — moves beside `ChipSpec`/`PipSpec` in
the pure layout layer, where it was always data rather than drawing.
**Success Criteria**: `Court.ts` imports them; no behaviour changes; the pure
layer still passes `purity.test.ts` (no Phaser import may follow the constants
across).
**Tests**: Existing suites stay green unedited. The moved constants gain
coverage where they had none — `hex()` in particular is a pure function with no
test today.
**Status**: Not Started

Step 1 of the *stay* plan and Stage 0 of the *remove* plan. The same commit
either way.

## Stage 3: Correct the design record

**Goal**: UIX §6.3, §8.2 and §8.5 describe three GPU effects the code does not
have. Correct them to the tweens that actually ship.
**Success Criteria**: The design doc's shader table names one shader, not three,
and points at `beats.ts` line numbers.
**Tests**: None — prose.
**Status**: Not Started

## Stage 4: The DOM table

**Goal**: `src/client/ui/table.ts` — a `Surface` consuming the same
`LayoutSpec`/`RenderPlan` `Court.ts` consumes, drawn as absolutely-positioned
elements. Built dark, behind a flag, while Phaser still renders.
**Success Criteria**: Every field the pure layer computes is rendered; the
repointed field-presence test passes; `axe.test.ts` covers the table for the
first time.
**Tests**: `courtContract.test.ts`'s technique repointed at the new file (it
greps source text, so it is renderer-agnostic). Real DOM assertions under jsdom
for seat state, discard pips, hand cards, deck and banner. axe over the mounted
table.
**Status**: Not Started

## Stage 5: The beats, and the cutover

**Goal**: Port the eight non-ripple beats to the Web Animations API, substitute
the Mule beat, then swap `main.ts` from Phaser to DOM in one change.
**Success Criteria**: `motion.ts` is untouched (it is already renderer-agnostic).
`await element.animate(...).finished` preserves interface rule 8. No period ships
where a DOM table coexists with Phaser beats.
**Tests**: Each beat resolves its promise; the sequencing rule holds; reduced
motion collapses every beat to a fade.
**Status**: Not Started — **blocked on the art-direction call in research §13.1**

## Stage 6: Delete the Phaser layer

**Goal**: Remove `Court.ts`, `beats.ts`, `Boot.ts`, `Preloader.ts`,
`game/main.ts`, `renderPolicy.ts`, `inputPolicy.ts`, `a11yTwin.ts` and their
tests. Drop `phaser` from `package.json`.
**Success Criteria**: `bun run test`, `bunx tsc --noEmit` and `bun run build`
all pass; the built bundle no longer contains a Phaser chunk; AGENTS.md's
bootstrap, render-loop and input-policy sections are rewritten.
**Tests**: The full gate.
**Status**: Not Started
