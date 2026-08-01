---
name: changing-the-wire
description: Use when changing RedactedView, protocol messages, engine types or room state, or when the client misreports a rule, cards stop responding to clicks, or the two halves seem to disagree about a data shape.
---

# Changing the wire

## Overview

Three consumers share `src/game/engine/`'s types: the client, the server, and the
computer opponents. The seam is deliberately narrow.

- The server pushes a **`RedactedView`** — one seat's redacted picture of the match.
- The client sends back essentially one message, `PLAY_CARD`.
- **The interface holds no game state and derives no rule.** Anything the UI appears to
  decide, it read from the view. If you find yourself computing legality in
  `src/client/`, the field belongs in the view instead.

`RedactedView` is declared standalone precisely so a deck, a set-aside card, the seed
and other hands have nowhere to live in it. That is also what stops a computer opponent
cheating — a missing capability, not a rule.

## Restart the server, or you will debug the wrong thing

Both halves import the engine. Vite hot-reloads the client the instant an engine file
changes; an unwatched backend keeps running the engine it booted with. The two then
disagree about a shape, and **the symptoms look nothing like a version skew**:

- One added field presented first as *"cards stopped being clickable"* — a `TypeError`
  in the only handler that opens the action sheet, silent because a throw in a pointer
  handler goes nowhere a player can see.
- Then as a **rule being misreported**, with an unprotected opponent announced as
  protected.

`bun run dev:server` runs under `bun --watch` for exactly this reason. If you are
running the backend some other way and see either symptom, restart it before
investigating anything else.

## Redaction is the security boundary

Adding a field to `RedactedView` is adding it to *every* recipient — including a seat
that must not know it, and including the bots. Ask what the least-privileged seat may
see, and redact per seat rather than shipping the union and hiding it in the UI. A
field the client merely declines to render is a field in the page's memory.

## Persistence replays, it does not snapshot

Rooms persist `{seed, actionLog}` and rebuild by replaying actions through `reduce()`.
Consequences:

- **A mid-match server restart is safe** by design; clients reconnect with backoff and
  `RESUME_SEAT`.
- **Engine changes are retroactive.** Altering how an action resolves changes the
  replay of every stored room. There is no migration format to bump — the safety comes
  from the log being actions rather than state, so think about old logs before changing
  `reduce()`.
- **Nothing may consult a clock or `Math.random()` inside the engine.** Randomness is
  seeded; a wall-clock read breaks replay.

## Message shape

Client messages are a discriminated union in `src/server/protocol.ts` with type guards
beside them. Add the variant *and* its guard — `dispatch.ts` validates before the room
ever sees a message, and host-only messages (`START_MATCH`, `ADD_BOT`) are re-checked
server-side regardless of what the UI offers.

`PLAY_CARD` deliberately carries no `playerId`: the server supplies the seat from
whoever holds the turn, so a client cannot move for a seat it does not occupy. The
computer opponents make the same trade — `PolicyDecision` has no seat field. Preserve
that shape rather than validating an id.

## Common mistakes

- **Deriving legality client-side "just for the disabled state".** Put it in the view.
- **Adding a field to the view for one screen's convenience.** Every seat and every bot
  now receives it.
- **Trusting whichever socket frame arrived first** (MCP holds several seats). A seat's
  own frame is the only authority on that seat's turn.
