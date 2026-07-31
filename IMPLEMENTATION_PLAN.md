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
**Status**: **Complete.** Measured against a running server: 1,470,204 →
386,603 bytes of JS and CSS, a saving of 1,083,601 on every cold load.

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
**Status**: **Complete.** `layout/tableMetrics.ts` holds the fractions, floors
and `SEAT_COLOURS`; `hex()` went to `tokens/tokens.ts`, where the palette lives
and where a DOM table will reach for it on every value rather than the handful a
scene renders as text. `MEDALLION_GAP` is single-sourced from `tableLayout.ts`.
The event-name strings deliberately stayed in `Court.ts` — they are a Phaser
`EventEmitter` contract that a DOM table replaces with callbacks, so moving them
would be churn on something about to be deleted.

### What the hoist uncovered

Three things, none of which are the hoist's to fix. Recorded here because two
of them move pixels and are decisions for whoever owns the visual design.

1. **`MEDALLION_GAP` was declared twice** — `Court.ts` and `tableLayout.ts`,
   both `2`, each carrying a comment asking the reader to keep them in step by
   hand. Fixed as part of this stage; it was a duplication, not a judgment call.
2. **`CARD_ASPECT` named two different numbers.** `tableLayout.ts:26` is `0.75`
   (768×1024, the card back); the copy in `Court.ts` was `512/720 ≈ 0.711` (the
   portraits). The scene applied its portrait ratio to the seat chip's
   **card-back marker**, whose art is `card_back_2.png` at 768×1024 — so that
   marker is drawn about five per cent too narrow. Renamed to `PORTRAIT_ASPECT`
   so the mismatch is legible at the call site instead of hidden behind a name
   that read as correct. **Pixels unchanged; open.**
3. **Hand cards carry the same question in the other direction.**
   `tableLayout.ts` sizes the hand, the deck and the removed card at `0.75`, and
   `Court.ts:408` draws hand cards from a **portrait** (`0.711`), so those are
   stretched about five per cent wide. The comment at `tableLayout.ts:25`
   ("768×1024. Deck, removed card, and hand cards all keep it") is stale for the
   hand. The deck is fine — it draws the back. **Open.**

Items 2 and 3 are the same decision asked twice: does card art stretch to its
rect, or does the rect follow the art? A DOM table forces the answer anyway,
because `object-fit` has to be given a value. Worth settling in Stage 4 rather
than now.

## Stage 2b: Stop preloading an asset nothing draws

**Goal**: `Preloader.ts` fetched `card_front_3.png` — 294,720 bytes, larger than
the entire app bundle — as `TEXTURES.cardFront`, and nothing ever drew it. The
hand, the deck face and the chip reveal all render a portrait or the card back
directly, so the card frame UIX §12 chose has never been used.
**Success Criteria**: The built chunks no longer reference `card_front`, so no
browser fetches it. The asset and `CARD_FRONT_ASSET` stay, and
`portraits.test.ts` still pins the file's existence, so the unrealised design
intent survives where it is recorded.
**Tests**: Existing suites unedited; `grep card_front dist/assets/*.js` empty.
**Status**: **Complete.**

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
