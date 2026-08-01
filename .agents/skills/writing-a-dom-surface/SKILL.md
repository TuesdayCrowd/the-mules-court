---
name: writing-a-dom-surface
description: Use when adding or changing anything in src/client/ui/ — a screen, overlay, sheet, badge, dock, toast, or any other player-visible DOM in this game.
---

# Writing a DOM surface

## Overview

Every player-visible surface in `src/client/ui/` is a factory returning one
`Surface`: `mount(parent)`, `update(state)`, `destroy()`. There is no framework, no
component base class, and no canvas. `src/client/ui/surface.ts` is the whole contract.

**A surface never reads the store.** One subscriber in `src/main.ts` pushes
`update(state)` to every mounted surface. A surface that reaches for state itself has
two sources of truth and will render a frame the rest of the table disagrees with.

## The shape

```ts
export function createConnectionDot(): Surface {
    const element = document.createElement('div');
    element.dataset.role = 'connection';        // test/CSS hook, never a class-name grep
    element.setAttribute('role', 'status');
    element.className = 'connection-dot';

    return {
        mount(parent) { parent.appendChild(element); },   // exactly ONE direct child
        update(state) { apply(element, state.connection); },
        destroy() { element.remove(); }
    };
}
```

## Rules that are load-bearing

| Rule | Why |
|---|---|
| `mount` appends **exactly one** element to `parent` | The pointer-events discipline in `ui.css` keys on the surface being a *direct child* of `#ui-root`. Nest freely inside it. |
| No ambient globals | `location`, `localStorage`, `matchMedia`, timers and the socket arrive through the factory's `deps`. Use the `Timers` interface from `surface.ts` so a test can fire a timeout instead of waiting. |
| `destroy()` must actually detach | Surfaces are re-created across screens. A listener left on `document` outlives its element. |
| Colour belongs to CSS | Expose `data-status` / `data-role` and let `tokens.css` colour it. Do not write hex into a `.ts` file outside `src/client/tokens/`. |
| Accessible name, not decoration | axe-core runs over **every** surface in `__tests__/axe.test.ts`. A control with no name fails the build. |

## Testing it

Name the file `<surface>.test.ts` beside the source, and **opt into a DOM on line 1**:

```ts
// @vitest-environment jsdom
```

Vitest defaults to Node here; Vitest 4 removed `environmentMatchGlobs`, so the
docblock is the only way. Use the shared fixtures in `ui/__fixtures__/dom.ts` —
`makeState`, `makeUiRootElement`, `fakeTimers`, `loadRealStyles` — rather than
hand-rolling a state object.

Then register the surface in `src/client/__tests__/axe.test.ts`. A new surface that
is not in that list is silently unaudited.

## Common mistakes

- **Reading `state` inside `mount`.** `mount` runs once; `update` runs on every push.
  Anything state-dependent belongs in `update`.
- **Appending two elements in `mount`.** Wrap them in one container.
- **Testing by CSS class.** Classes are styling and get renamed. Query `[data-role=…]`.
- **Assuming hover.** Phone-landscape is in scope; nothing may depend on hover.
- **Forgetting `loadRealStyles`** when the assertion is about layout or pointer-events
  — the discipline is tested against the real `ui.css`, not a stub.
