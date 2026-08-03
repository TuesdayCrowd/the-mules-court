---
name: svg-filters-and-gradients
description: Use when building rich visuals for this game — glow, bloom, nebula texture, warp, shimmer, grain, holographic or foil card treatments — or when tempted to add a graphics library to get them.
---

# SVG filters and gradients

## Overview

This project has **zero runtime dependencies** (`"dependencies": {}`). d3, three.js, GSAP
and pixi are all off the table unless the user explicitly decides to end that — say so
and let them choose; do not quietly add the first one.

You do not need them. SVG filters plus modern CSS reach effects people assume require
WebGL, and they composite on the GPU. The client currently uses **no** gradients,
filters or blend modes — the richness comes from a background PNG and flat tokens — so
this is open headroom, not a crowded field.

## SVG filters apply to HTML

The key move: define a filter once in a hidden inline `<svg>`, then reference it from
ordinary CSS on ordinary elements.

```html
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <filter id="fx-bloom" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="6" result="glow"/>
    <feColorMatrix in="glow" type="matrix" result="hot"
      values="1.4 0 0 0 0  0 0.6 0 0 0  0 0 1.6 0 0  0 0 0 1 0"/>
    <feMerge><feMergeNode in="hot"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</svg>
```

```css
.tbl-card--mule { filter: url(#fx-bloom); }
```

**Always set `x/y/width/height` on the filter.** The default region is 110% and clips
any blur that reaches past it — a glow with a hard rectangular edge is this mistake.

## The primitives worth knowing

| Primitive | Use it for |
|---|---|
| `feTurbulence type="fractalNoise"` | Nebula, smoke, grain, energy fields. Procedural — no texture to load. |
| `feDisplacementMap` | Warping one layer by another. This is real distortion, not a fake. |
| `feGaussianBlur` + `feColorMatrix` + `feMerge` | Bloom. Blur, push the channels hot, merge under the original. |
| `feComposite operator="arithmetic"` | Precise layer math when `feMerge` is too blunt. |
| `feDropShadow` | One-primitive glow when you do not need colour control. |

## CSS that carries its own weight here

The table sits on near-black (`--color-bg: #000000`), which makes additive blending the
natural tool:

```css
.fx-shimmer {
  mix-blend-mode: screen;          /* black contributes nothing; light adds */
  background: conic-gradient(from var(--angle),
    var(--color-nebula-purple), var(--color-nebula-red), var(--color-nebula-purple));
}

@property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
```

`@property` is what makes a gradient animatable at all — without the registration the
browser cannot interpolate the custom property and the sweep snaps. Interpolate colour
in a perceptual space (`color-mix(in oklch, …)`) so a purple→red ramp does not pass
through mud.

Also cheap and underused here: `backdrop-filter` (frost behind a sheet), `mask-image`
with a gradient (fade an edge without a PNG), and `text-shadow` layered three deep for
a readable glow on light-on-dark type.

## The performance rule that is specific to this project

**Nothing may animate forever.** A filter animated in a `requestAnimationFrame` loop
pins a permanent frame loop for a turn-based card game, which is exactly the waste this
codebase deleted its Phaser render pump to remove.

Consequences:

- Prefer **CSS/WAAPI animations with a finite duration**, which run off the main thread
  and stop on their own.
- SVG filter *attributes* (`baseFrequency`, `scale`) are not CSS properties, so WAAPI
  cannot animate them. If you must, drive them with `setAttribute` inside a finite
  animation and stop — never an unconditional rAF.
- A static `feTurbulence` is rasterized once. An animated one re-renders every frame,
  and on a phone that is the most expensive thing on the page.

## Do not restore the ripple filter

The Mule's `ripple` beat deliberately does **not** distort the live table, and
`docs/plans/typescript/2026-07-30-renderer-architecture-research.md` §8 records why. If you reach
for `feDisplacementMap` on the table root, read that first — the decision was argued,
not overlooked. Warping the Mule's portrait, which is already an image, is the design.

## Common mistakes

- **Adding a library for one effect.** Check this file's first paragraph again.
- **Forgetting the filter region**, then blaming the blur radius.
- **`mix-blend-mode` on an element with no stacking context** — it blends against the
  wrong backdrop. Give the parent `isolation: isolate`.
- **Colour in a `.ts` file.** Palette lives in `styles/tokens.css`, mirrored in
  `src/client/tokens/`, with a drift test between them.
- **Skipping `prefers-reduced-motion`.** See the `designing-an-effect` skill.
