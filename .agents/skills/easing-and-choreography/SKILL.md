---
name: easing-and-choreography
description: Use when motion in this game feels cheap, linear, floaty or simultaneous — dealing cards, revealing a hand, eliminating a seat, staggering a list — or when reaching for a tween or animation library.
---

# Easing and choreography

## Overview

What makes d3-flavoured motion feel expensive is not the drawing. It is **easing,
interpolation, and staggered timing**. All three are available with zero dependencies
through the Web Animations API and CSS.

Split the work the way this codebase already does: `src/client/store/motion.ts` is pure
and decides **what plays, in what order, for how long**; `src/client/ui/beats.ts` only
knows how to draw a step. A duration hardcoded in the drawing layer is a duration no
test can read.

## Easing: stop using `ease`

The browser defaults (`ease`, `ease-in-out`) are the visual equivalent of Times New
Roman. Name your curves once and reuse them.

| Curve | `cubic-bezier` | Where it belongs |
|---|---|---|
| Standard | `(0.2, 0, 0, 1)` | Anything entering or moving on screen |
| Decelerate | `(0, 0, 0, 1)` | Arrivals — a dealt card settling |
| Accelerate | `(0.3, 0, 1, 1)` | Exits — a discarded card leaving |
| Anticipate | `(0.68, -0.55, 0.27, 1.55)` | One accent per screen, never more |

Overshoot is the effect people mean by "juicy". It is also the fastest way to make an
interface feel childish, so spend it on the single most important moment — a Devotion
Token landing, the Mule turning face-up — and let everything else use Standard.

WAAPI takes these directly:

```ts
await el.animate(
  [{ transform: 'translateY(24px) scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }],
  { duration: 320, easing: 'cubic-bezier(0, 0, 0, 1)', fill: 'both' }
).finished;
```

## Stagger is the whole trick

Five cards animating together read as one block moving. The same five at 40 ms apart
read as *dealing*. Stagger costs one multiplication:

```ts
const STAGGER_MS = 40;
await Promise.all(cards.map((el, i) =>
  el.animate(ENTER, { duration: 320, delay: i * STAGGER_MS, easing: STANDARD, fill: 'both' }).finished
));
```

Keep total sequence length under roughly 500 ms. Stagger × count grows fast, and a
player waiting on choreography before they can act will hate it by round three. If the
count is unbounded, cap the delay: `Math.min(i, 6) * STAGGER_MS`.

## Choreograph in three phases

Borrowed from d3's enter/update/exit, and it maps onto a card table exactly:

1. **Exit first** — the discarded card leaves.
2. **Move second** — surviving elements slide to their new rects.
3. **Enter last** — the drawn card arrives into space that already exists.

Doing these simultaneously is what makes a table look like it is glitching rather than
moving. Sequence them and even short animations read as deliberate.

## Interpolation

Interpolate colour in a perceptual space or accept muddy midpoints:

```css
background: color-mix(in oklch, var(--color-nebula-purple), var(--color-nebula-red) 60%);
```

For numbers, WAAPI interpolates for you — prefer two keyframes and a good curve over
many keyframes approximating one. For anything on a path,
`offset-path`/`offset-distance` moves an element along an SVG path with no per-frame JS.

## Animate the cheap properties

`transform` and `opacity` composite on the GPU. `width`, `height`, `top`, `left`,
`margin` and `filter` trigger layout or paint every frame. A card that "flies" from the
deck should be positioned once and moved with `translate()`, never animated through
`left`.

## Reduced motion is not optional

`motionPlan()` already collapses non-informational beats when `reducedMotion` is set,
and reads the preference **at play time rather than caching it**. Route new motion
through it rather than checking `matchMedia` in a surface — and note that informational
beats still play, because they carry meaning a player would otherwise lose.

## Common mistakes

- **Adding a tween library.** `dependencies` is `{}`; WAAPI covers this.
- **`iterations: Infinity`.** Never resolves, and pins a frame loop awake.
- **Animating a live table element.** `table.ts` calls `replaceChildren()` on every
  state push. Beats draw into their own transient layer — see `animating-with-waapi`.
- **Easing an exit with a decelerate curve.** Things leaving should speed up.
- **Blocking input on choreography.** The player's next decision outranks your flourish.
