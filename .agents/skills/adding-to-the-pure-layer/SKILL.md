---
name: adding-to-the-pure-layer
description: Use when editing src/client/layout, content, store or tokens, or when purity.test.ts fails with "imports server runtime", "uses document", or "uses window".
---

# Adding to the pure layer

## Overview

Four directories under `src/client/` are guaranteed loadable from a plain Node
process with no DOM and no socket: **`layout/`, `content/`, `store/`, `tokens/`**.
They hold the decisions — geometry, copy, state, palette — so the decisions can be
tested without a browser. `src/client/__tests__/purity.test.ts` enforces it.

Everything else lives in `ui/`. If your new code needs an element, it is not pure;
put the *decision* in a pure module and let the surface walk the result.

## What the gate forbids

| Banned in the four dirs | Pattern it matches |
|---|---|
| Phaser import | `from 'phaser'` |
| DOM member access | `document.<ident>`, `window.<ident>` |
| Bare web storage | `localStorage` not preceded by a dot |
| **Runtime** import from the server | `import … from '…/server/…'` without `type` |

## The two traps

**1. The test reads raw file text, comments included.**

A *comment* mentioning `window.something` fails the very test it is describing.
This is not a bug in the gate — it is why the check is cheap and unfoolable. Name
the injected interface instead of the global it wraps.

```ts
// ❌ fails: "cached from window.matchMedia"
// ✅ passes: "cached from the injected media-query dependency"
```

Note the `window.` rule requires an identifier character after the dot, precisely so
player-facing copy can end a sentence with the word "window." — `content/` legitimately
says *"This match is open in another window."*

**2. `import type` from the server is fine; a runtime import is not.**

The client bundles for a browser, the server runs under Bun. A runtime import drags
transport code into the game bundle and the failure is *a build that succeeds and a
page that does not*.

```ts
import type { BotDifficulty } from '../../server/protocol';   // ✅ erased at compile
import { CONFIG } from '../../server/config';                  // ❌ real code
```

There is **exactly one** allowlisted exception, `content/nickname.ts`, argued and
checked rather than waved through: `server/config.ts` has zero imports and touches
neither Bun nor `process`, and the alternative is a second copy of the nickname limit
that drifts until the client sends what the server refuses. Do not add a second
exception without the same argument.

## Getting a global in legitimately

Inject it. `store/` genuinely owns the socket and web storage — through injected
factories, never the bare global. The pattern throughout:

```ts
export interface Deps { readonly now: () => number; readonly reducedMotion: () => boolean; }
```

Read at call time rather than cached, so a test can change the answer between
assertions.

## Common mistakes

- **Moving the file to `ui/` to silence the gate.** If it holds a decision, that
  makes it untestable without jsdom. Inject instead.
- **`crypto.randomUUID` in `store/`.** It does not exist in a non-secure context
  (a phone on a LAN address). `store/ids.ts` already prefers it and falls back — use that.
- **Deriving a game rule in `store/`.** The server pushes a `RedactedView`; the client
  reads it. See the `changing-the-wire` skill.
