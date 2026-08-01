---
name: designing-an-effect
description: Use when deciding whether a visual effect belongs in this game, when the table starts to feel noisy or templated, or when choosing where to spend visual boldness.
---

# Designing an effect

## Overview

This is a **deduction game**. A player's job is to hold public information in their head
and read the table. Every effect either helps them do that or competes with it — there
is no neutral decoration.

Technique lives in `svg-filters-and-gradients` and `easing-and-choreography`. This skill
is the judgment about when to use them.

## The test an effect has to pass

Ask, in order:

1. **What did this effect just tell the player?** "Your card was eliminated." "It is
   your turn." "The Mule is on the table." If the honest answer is "that we made an
   effect", cut it.
2. **Could a label have said it faster?** Often yes, and then the label wins. The
   protected badge does more work than any pulse would.
3. **Does it survive being seen 200 times?** A match is many rounds. Anything charming
   on turn one and tiresome by turn ten is a net loss — that is most bounce, most
   sparkle, and all screen shake.
4. **Does it delay a decision?** If the player is waiting on it, it is a cost.

## Spend boldness in one place

Pick **one** signature moment and let it be genuinely spectacular. Keep everything
around it quiet. A table where the deal, the reveal, the elimination and the token award
are all dramatic has no drama in it at all — the eye has nowhere to rest and no way to
rank what happened.

For this game the natural candidate is **The Mule turning face-up**: it is the one card
that ends a player's round by its own rule, it is the title of the game, and it happens
rarely enough to stay an event. The existing ripple beat already claims that role.
Before adding a second showpiece, ask what you are demoting.

## Take direction from the subject, not from the default

The setting is Asimov's Foundation: psychohistory, mentalics, a decaying empire, minds
converted without their knowledge. The palette is near-black with nebula red and purple
(`tokens.css`). That world suggests **interference, prediction, and quiet dread** —
signal degradation, probability fields, something moving behind the surface.

It does not suggest confetti, neon cyberpunk grids, or the bouncing-card idiom of a
casino app. When an effect could belong to any game, it is a default rather than a
choice. Reach for the subject's own vocabulary.

## The floor, always

- **`prefers-reduced-motion` respected** — route through `motionPlan()`, which already
  collapses non-informational beats and reads the preference at play time.
- **Nothing depends on hover.** Phone-landscape is in scope.
- **Nothing depends on colour alone.** Protected, eliminated and current-turn each carry
  a label or a shape as well as a hue; contrast is checked arithmetically in
  `tokens/contrast.test.ts`.
- **Nothing animates forever.** A permanent loop is a battery cost on a still table.
- **Meaning never rides on the effect.** A beat is decoration attached to something that
  already happened on the server. If the animation fails, the announcement still has to
  land — which is why `beats.ts` swallows step errors on purpose.

## Look at it

`bun run test:visual` drives real matches in a real browser and writes a PNG per
viewport. jsdom has no layout and no compositor, so **no unit test in this repo can see
an effect**. Two layout bugs shipped past a fully green suite and were obvious in a
screenshot. Capture, then actually look.

## Common mistakes

- **Adding effects to make the game feel finished.** Polish is precision in spacing,
  type and timing; it is rarely one more animation.
- **Decorating the thing the player is trying to read.** Never put motion or texture
  behind the card values, the seat names, or the discard row.
- **Matching a reference without matching the brief.** A gorgeous effect borrowed from a
  charting library or a landing page is still borrowed.
- **Shipping without removing one thing.** Build it, then cut the weakest element. It is
  almost always better after.
