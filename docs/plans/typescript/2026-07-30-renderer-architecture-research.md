# The Mule's Court — Renderer Architecture Research

**Date:** 2026-07-30
**Status:** Research complete. §12 records the decision; §13 lists what is still open.
**Scope:** Should the client stay a Phaser/DOM hybrid, become all-Phaser, or drop Phaser entirely?
**Depends on:** `docs/plans/typescript/2026-07-23-uix-design.md` — the design this questions
**Corrects:** UIX §6.3 and §8.5 (see §11)

---

## 1. The question

The client is a two-layer hybrid, recorded in UIX §2 and §2.5: Phaser draws the
table on a canvas, and every other surface — menu, lobby, action sheet, quick
reference, overlays — is real DOM above it. Interface rule 9 keeps the layers
apart: *"DOM anchors to the viewport, never to a canvas coordinate. The layers
share design tokens, not geometry."*

Two questions were asked, in order:

1. Should the frontend be **all Phaser**, retiring the DOM layer?
2. Should Phaser be **removed entirely**, rebuilding the table in HTML/CSS/TS?

They are not mirror images, and the answers are not symmetric.

## 2. Verdict

| Direction | Verdict |
| --- | --- |
| Hybrid → all Phaser | **Reject.** Not achievable, and undesirable where it is achievable |
| Hybrid → no Phaser | **Viable.** Smaller than it looks, gated on one visual effect |

The asymmetry is the finding. Moving *to* canvas is blocked by capabilities the
web platform does not give canvas at all — text entry, an accessibility tree,
focus order. Moving *off* canvas is blocked by one beat.

## 3. Method

Two parallel multi-agent research passes, eleven inventory dimensions between
them, three costed migration options per direction, and an adversarial
verification stage that tried to refute every blocker-or-major claim.

Findings below are marked **verified** (read in the source, or a command rerun
here) or **inferred**. Two caveats on the research itself, recorded so later
readers can weight it:

- The verification stage ran thinner than designed — roughly five of eight
  real verdicts per pass, the rest returning malformed output. Claims that
  reached a real verdict are marked as such.
- No postmortem was found of a team removing a JavaScript game engine in
  favour of DOM for a card game. The nearest evidence is the inverse: a team
  abandoning a DOM→Pixi migration after three weeks. Absence of a report is
  not evidence either way.

## 4. Why all-Phaser is not achievable

Not "expensive." Not achievable — three independent option designs each
concluded the framing cannot be satisfied.

### 4.1 Phaser's own escape hatch for UI is real HTML

`DOMElement` still ships in 4.2.1. Reading the source settles what it is:

- `DOMElement.js:16-80` — a literal `document.createElement('div')` placed in a
  sibling container, not a canvas-rendered abstraction.
- `DOMElementCSSRenderer.js:96-114` — its on-screen CSS transform is recomputed
  **every frame** from `camMatrix.multiply(srcMatrix, calcMatrix)`, i.e.
  camera-relative rather than viewport-relative.

So "all Phaser via `this.add.dom()`" removes no DOM. It keeps every HTML
element, adds per-frame camera-matrix bookkeeping, and does precisely what
interface rule 9 forbids. The docstring also caps nesting at one Container
level, pools every scene's elements into one shared global container, and
states the element *"cannot be enabled for input… you have to use the
`addListener` method"* — so it buys no input handling over the plain
`addEventListener` calls `src/client/ui/` already makes.

### 4.2 What the engine does not have

Verified by grepping the 4.2.1 source:

| Capability | Finding |
| --- | --- |
| Text input | **Zero.** No `InputText`, no `contentEditable`, no `createElement('input')` |
| Focus / tab order | `GameObject#tabIndex` exists, documented *"reserved for future use… not implemented"* |
| Accessibility | Engine-wide grep for `aria`/`role=`/`tabindex`/`a11y`: nothing but that dead property |
| Scroll clipping | `GeometryMask` is Canvas-renderer-only (`Mask.js:17-18`). Under WebGL a scroll clip needs a Filter Mask rendering to a `DynamicTexture` — a GPU render-to-texture for what `overflow-y: auto` gives free |
| Text quality | `resolution` defaults to `1`, not devicePixelRatio-aware; Phaser explicitly does not wait for web fonts |

### 4.3 Canvas has no accessibility tree, and this game is all text

The two browser APIs built to bridge that gap are gone or cosmetic:
`addHitRegion` was removed from the spec (its MDN page 404s), and
`drawFocusIfNeeded` draws a ring while exposing no name, role, or value —
it still requires a real element behind it. WHATWG issue #7490 remains open on
exactly this question.

The ecosystem has already answered it in practice. **PixiJS ships an official
`AccessibilitySystem` that works by overlaying real DOM `<div>`s aligned to
canvas object bounds.** The library whose entire purpose is canvas rendering
concluded canvas needs a DOM bridge to be accessible. Phaser has no equivalent,
so going all-Phaser means building that system rather than escaping the need
for it.

This matters more here than in most games. The Mule's Court is a deduction
game: its whole payload is text and numbers — card values, discard totals,
devotion tokens, hand contents, log narration. There is no non-textual fallback
to degrade to.

`src/client/ui/a11yTwin.ts` already exists as the answer, and its test asserts
an **exact shadow-element count** (`a11yTwin.test.ts:203-230`) specifically to
stop a second invisible DOM tree growing unchecked. All-Phaser means
deliberately doing the thing that guard rail exists to prevent: growing the twin
from a seat list plus hand proxies to a mirror of all thirteen surfaces — an
invisible, semantically weaker reconstruction of the DOM UI that already exists.

WCAG 2.2 has no games exemption (checked against the W3C Understanding page,
which does not mention games), and the European Accessibility Act has been
enforceable since 28 June 2025. This is a live compliance surface the current
design satisfies for free.

### 4.4 It would also cost performance and tests

- The render pump reaches true 0 fps idle **because DOM screens cost Phaser
  nothing**. A canvas nickname field's blinking caret cannot be expressed as a
  finite tween, so it either violates the documented *"nothing may animate
  forever"* invariant or the caret is dropped.
- Every migrated surface's motion would have to be folded into
  `Court.isAnimating()`, multiplying the false-negative bug class that freezes
  the table.
- The client suite is **50 files, 9,917 test LOC, 1,454 tests in 3.04 s**, none
  needing WebGL. `courtContract.test.ts` — the only test of the only Phaser
  scene — cannot instantiate Phaser at all; it reads the file **as raw text and
  regex-matches it**, a strategy its own docstring calls "crude" but "the right
  one."
- axe-core audits the DOM accessibility tree only. Every surface moved to
  canvas silently exits the project's sole automated accessibility gate.

### 4.5 Precedent points the same way

Phaser's own docs recommend DOM Elements for text-heavy UI. Board Game Arena
(800+ games, 10M+ registered players) and Lichess's `chessground` — the
highest-traffic real-time board UI on the web — both render via plain DOM/CSS
with custom diffing, and both cite that as a deliberate choice. Unity WebGL and
Godot's web export, the closest "all-engine" analogues, both needed years of
bolted-on and still-incomplete text-input and accessibility infrastructure.

## 5. Removing Phaser: the port surface

`Court.ts` is 1,135 lines. Read and classified:

| Bucket | LOC | Content |
| --- | --- | --- |
| (a) Phaser draw glue | ~900 | `create`/`draw`/`drawSeat`/`cardFaceLabel`/`attachCardGesture` — every call is `this.add.rectangle/image/text` or a tween |
| (b) Pure data in the wrong file | ~130 | `Court.ts:1006-1134` — event-name strings, `SEAT_COLOURS`, `hex()`, `CARD_ASPECT`, `RESIZE_DEBOUNCE_MS` |
| (c) Genuinely needs canvas/WebGL | **0** | — |

Two structural facts make bucket (a) mechanical rather than risky:

- **`LayoutSpec` and `RenderPlan` carry only `Rect`, number, string, boolean and
  colour-int** (`types.ts:11-137`, `renderPlan.ts:22-129`). No camera transform,
  no depth index, no atlas frame. `Court.ts` has zero `setDepth` calls.
  `position: absolute; left:{x}px; top:{y}px; width:{w}px; height:{h}px`
  reproduces the geometry field-for-field.
- **Every image is a discrete keyed texture, never an atlas.** `Preloader.ts:52-54`
  loops `CARD_CATALOG` calling `this.load.image`; `this.load.atlas` appears
  nowhere in the repo. `<img>` / `background-image` is a true 1:1 swap.

*Correction from verification:* `Court.ts` does not *only* position things from
the plan — it also selects fill and stroke colour, supplies text content, and
drives pulse state from the same data. Still mechanical; "positions rects"
undersells it slightly.

**Nothing under `src/client/` or `src/main.ts` imports Phaser as code.** The
~7,100 LOC DOM layer is untouched by this question. The real footprint is
~1,800 source LOC in `src/game/scenes/` plus the two policy modules.

## 6. The design overstates the WebGL dependency 3-to-1

The most consequential finding, and it survived adversarial verification at high
confidence. UIX §8.5 and §6.3 catalogue four GPU jobs. Grepping `src/game/` for
`Filter|grayscale|ColorMatrix|ParticleEmitter` returns **exactly one hit.**

| Design says | Code does |
| --- | --- |
| "Grayscale Filter, 50% dim" (§6.3, §8.2) | `beats.ts:94-108` — a tinted rectangle, alpha tween. No filter |
| "Match victory particles" (§8.5) | `beats.ts:202-217` — one image, one scale/alpha tween. Line 205 declines an emitter: *"the emitter can come later if it earns its keep"* |
| "Devotion-token award shimmer" (§8.5) | `beats.ts:190-200` — one image, one tween |
| "The Mule beat (displacement Filter)" (§8.5) | **True.** `beats.ts:132` — `camera.filters.internal.addDisplacement(TEXTURES.distortion, 0, 0)` |

Eight of nine beats are alpha/scale/position tweens. They port to the Web
Animations API mechanically — including the sequencing contract, where
`await element.animate(...).finished` replaces `tweenPromise()` one-for-one,
preserving interface rule 8. `src/client/store/motion.ts`, which plans the
beats, is already Phaser-independent and needs no porting at all.

This is a documentation gap, not a bug: the code chose the simplest primitive
that sufficed and said so. But it means the recorded visual ambition has been
overstating Phaser's real footprint, and any decision made from the design doc
alone would have been made on false premises.

## 7. What evaporates rather than ports

| Module | LOC | Why it does not port |
| --- | --- | --- |
| `renderPolicy.ts` + test | 409 | Exists because *"Phaser renders every frame, unconditionally… no dirty check anywhere in the path"* (its own words). The browser compositor has that dirty check |
| `inputPolicy.ts` + test | 54 | Exists because `MouseManager` binds to `window.top` and hit-tests canvas objects under DOM elements. There is no second hit-test layer in a DOM-only client |
| `a11yTwin.ts` + test | 403 | A shadow tree for canvas cards. Real elements are their own accessibility tree |

**866 LOC deleted, not migrated** — dead complexity rather than removed
capability. Verified via a real verdict: the claim that `renderPolicy.ts`'s
reason for existing cannot occur in a DOM client survived refutation at high
confidence, with one caveat worth keeping — the *policy* obligation ("nothing
may animate forever") does not vanish in spirit, it just becomes far cheaper to
satisfy, since an infinite CSS animation on a small element costs the
compositor a fraction of an infinite full-canvas WebGL redraw.

`axe.test.ts` would also cover the table **for the first time**. It covers zero
table content today, because canvas is invisible to it — and the twin standing
in for it was never itself run through axe.

## 8. The one real obstacle: the Mule's ripple

`beats.ts:127-144` warps **the actual rendered table**, because Phaser owns both
the content and the compositing surface. A DOM table does not grant a canvas
that access. The research initially conflated two distinct problems; they need
separating.

**Problem 1 — `filter: url(#displacement)` on live HTML is broken in WebKit.**
Real, and well documented (Smashing Magazine 2021; W3C svgwg#1142, still live in
2025), naming WebKit and iOS specifically. But **refuted as a blocker**: the
cited article's own workaround is to filter an SVG-native image rather than live
HTML, which works in Safari and is what production "liquid glass" libraries do.

**Problem 2 — obtaining an image of the live DOM table is the hard part.**
There is no cheap rasterize-DOM-to-texture API. `html2canvas` is slow, taints on
cross-origin images, and is a real new dependency. Reimplementing the table's
draw logic inside a canvas so it has something of its own to distort would
resurrect most of the ~900 LOC of glue, permanently duplicated.

So the achievable version is not "warp the table." It is **warp the Mule's
portrait — which is already an image — over a full-viewport wash and a
compositor-safe shudder on the table root.**

Whether that satisfies UIX §8.3's *"the dread is the point"* is an
art-direction call, not an engineering one. **It is the only real decision gate
in this document.**

## 9. Bundle, and a finding that outranks the architecture question

Measured from a real production build:

| Asset | Raw | Gzip |
| --- | --- | --- |
| `phaser-*.js` | 1,376,427 | 355,047 |
| `index-*.js` (the entire app) | 81,339 | 25,387 |
| `index-*.css` | 12,438 | 2,837 |

Phaser is 94.4% of shipped JavaScript. But the gzip column is **hypothetical**:

> `src/server/staticAssets.ts:54` returns `new Response(hit)` from `Bun.file`.
> Nothing in `src/server/` sets `Content-Encoding` or a `compress` option, and
> Bun does not compress automatically. **Players download the raw bytes.**

Verified here by grep and by rerunning the build. A client hitting `bun run
serve` or the compiled binary downloads ~1.46 MB of JavaScript where ~380 KB
would do.

This is independent of every architectural question in this document, is the
largest player-facing win found by either research pass, and `staticAssets.ts`
is the single policy file that owns it. It should be fixed regardless of what
happens to Phaser.

For scale: `public/assets/` is 8.1 MB of portrait and card art that a DOM
rewrite loads unchanged, and the compiled binary shrinks only ~1.8% without
Phaser, because Bun's runtime is what makes it large.

## 10. Cost

| Option | Deleted | Written | Estimate |
| --- | --- | --- | --- |
| Remove Phaser | ~2,611 LOC | ~1,310 LOC | Net −1,300 source LOC |
| Stay, and thin the seam | ~130 LOC | ~205 LOC | Under a day |

Removal is **reversible**. `LayoutSpec`, `RenderPlan`, `content/`, `store/` and
`tokens/` are provably Phaser-agnostic — `purity.test.ts` enforces it — and
survive either way. Re-adding a rendering layer later for one beat is a bounded
addition, not a rebuild. This is a revolving door, not a one-way one, and that
is the strongest single argument for being willing to try it.

## 11. Corrections this research forces on other documents

1. **UIX §6.3 and §8.2** describe the eliminated seat as a "grayscale Filter."
   It is a tinted rectangle with an alpha tween (`beats.ts:94-108`).
2. **UIX §8.5** lists `sparkle_pattern.png` as "Match victory particles" and
   `rainbow_gradient.png` as a shimmer. Both are single images with one tween
   (`beats.ts:202-217`, `190-200`). Only the `distortion_map.png` row is true.
3. **AGENTS.md** documents `Scale.RESIZE`, `input.windowEvents`, the render pump
   and the absolute-loader-path rule. All four are Phaser-specific and would
   stop being true under a removal.

## 12. Decision

**Remove Phaser**, staged, with the ripple treated as an accepted downgrade
until art direction says otherwise.

Sequenced so that the work which is identical under both futures happens first
and is never wasted:

| Stage | Work | Wasted if the decision reverses? |
| --- | --- | --- |
| 0 | Serve compressed responses | No — independent of renderer |
| 1 | Hoist `Court.ts:1006-1134` into the pure layer | No — step 1 of the *stay* plan too |
| 2 | Correct §6.3 / §8.5 (§11 above) | No |
| 3 | Build the DOM table against the same `LayoutSpec` | Yes |
| 4 | Port the eight non-ripple beats to WAAPI | Yes |
| 5 | Substitute the Mule beat; cut over in one PR | Yes |
| 6 | Delete the Phaser layer; drop the dependency | Yes |

Stage 5 cuts over in a single change deliberately. Shipping a period where a
DOM table coexists with Phaser beats would recreate the exact two-surface seam
`inputPolicy.ts` exists to patch.

## 13. Open questions

1. **Does the Mule beat survive as a portrait-warp plus table shudder?**
   Art-direction call. Blocks stage 5, nothing earlier.
2. **Task 34's real-device QA is still outstanding** (`2026-07-24-uix-qa-checklist.md`).
   A DOM table changes what that pass tests — several items are DOM/canvas seam
   bugs that would cease to exist, and the animation budget on low-end phones
   becomes the thing to measure instead.
3. **`courtContract.test.ts`'s field-presence technique is renderer-agnostic**
   (it greps source text) and should be repointed at the DOM table rather than
   deleted. That it transfers cleanly is argued, not yet demonstrated.
4. **The flip beat's 3D transform needs an isolated ancestor chain** — any
   parent with `overflow`, `opacity`, `filter` or `transform` flattens the 3D
   context, and the seat-chip structure is nested.
