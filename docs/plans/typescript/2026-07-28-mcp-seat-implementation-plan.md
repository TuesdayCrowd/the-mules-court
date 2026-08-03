# MCP Seat Implementation Plan

> **For Claude:** Every task follows red → green → commit. Never write implementation before its failing test.

**Goal:** Build the MCP server that seats a model at a live table, matching `docs/plans/typescript/2026-07-28-mcp-seat-design.md`.

**Architecture:** One long-lived Bun process speaking MCP over stdio. It holds three WebSocket connections to the running game server, one per seat, and exposes seven tools — three public, four requiring an opaque per-seat handle. The referee routes turns on public information alone; each seat agent reads and plays through its own handle.

**Tech stack:** Bun, TypeScript 5.7 strict, `bun test`. One new runtime dependency, discussed below.

**Design reference:** `docs/plans/typescript/2026-07-28-mcp-seat-design.md`, cited as *Design §N*. The wire contract is `src/server/protocol.ts` — import it, never restate it.

---

## Conventions

| Rule | Detail |
| --- | --- |
| Imports | Extensionless relative paths; engine access via `../game/engine` only |
| Indent | 4 spaces, matching existing source |
| Test runner | **`bun test`, as with `src/server/`.** Import `{ describe, expect, it }` from `'bun:test'` |
| Why not Vitest | Same reason the transport uses `bun test`: Vitest's workers run under Node, which cannot see the Bun globals a WebSocket client and the integration harness depend on. `vitest.config.ts` collects only `src/game/**` and `src/client/**`, so `src/mcp/` is already outside it |
| Typecheck | `bunx tsc --noEmit` before every commit — Vite never type-checks |
| Commits | GitButler only. `but diff` for IDs, then `but commit mcp-seat-design -m "…" --changes <ids>` |
| Rules | Read `own.legalPlays` and `own.legalTargets`. Never re-derive a rule |

**AGENTS.md is not edited until this merges.** `package.json` gains `test:mcp` in Stage 1 so the suite runs under `bun run test` rather than rotting outside the gate, but AGENTS.md's testing section still describes two runners. Correct it to three in the merge commit — not before, because a rejected design should leave no trace in the file every agent reads first.

**No new dependency, decided.** This plan first recommended `@modelcontextprotocol/sdk`, reasoning from the protocol's surface — an initialize handshake, capability negotiation, notifications, content blocks, an error taxonomy — and calling it past the threshold `protocol.ts` names for taking a library. Then the actual package was inspected: **17 transitive dependencies, 4.32 MB unpacked**, among them `express`, `hono`, `@hono/node-server`, `cors`, `express-rate-limit`, `jose` and `pkce-challenge`. That is an HTTP server stack and an OAuth implementation, present for the HTTP/SSE transport and remote-auth flows — none of which a **stdio** server ever reaches.

So the threshold argument reversed on the evidence, and reversed toward this repo's own precedent: one runtime dependency (`phaser`), and a hand-written wire parser in `protocol.ts` rather than a schema library. `rpc.ts` is the whole protocol layer. If it ever fights back, taking the SDK costs one `bun add` and a rewrite of that one file, because nothing above the transport depends on it.

**Tool descriptions state when to call, not just what they do.** A description reading "Blocks until one of the held seats holds the turn; call it again immediately after playing" produces a materially better call rate than "Waits for a turn". This costs nothing and belongs in the first draft.

---

## Stage 1: The pure core

**Goal:** The capability boundary, the turn router, and the fallback policy exist and are tested, with no socket and no MCP.
**Success criteria:** `bun test src/mcp` green; the public roster provably carries no handle; a handle resolves only its own seat.
**Status:** Complete — 39 tests across three files.

### Task 1: Seat registry — the capability table

**Files:** `src/mcp/seatRegistry.ts`, `src/mcp/seatRegistry.test.ts`

Owns what the MCP knows about each seat it holds, reachable only by handle: the `seatToken`, the `PlayerId`, the nickname, and the notebook. Mints 128-bit handles the way `seatTokens.ts` mints tokens, and exposes a separate public roster that carries neither handle nor token — the referee reads that one.

The load-bearing test is the negative: no value returned by the public roster may contain a handle or a seat token.

### Task 2: Turn router

**Files:** `src/mcp/turnRouter.ts`, `src/mcp/turnRouter.test.ts`

Pure. Given the held `PlayerId`s, a `currentPlayerId`, and the wire phase, decide `{ status, seat }` — `your_turn`, `waiting`, `round_over`, or `match_over`. This is what `await_turn` returns, and it must never carry a hand.

### Task 3: Heuristic fallback

**Files:** `src/mcp/fallbackPlay.ts`, `src/mcp/fallbackPlay.test.ts`

Given a `RedactedView`, choose a play from `own.legalPlays` and a target from `own.legalTargets` — lowest value, first legal target, guessing an unseen value when the card is an Informant. Exists so a stalled seat agent cannot freeze the table (*Design §6*).

---

## Stage 2: The seat client

**Goal:** Three sockets, claimed and resumed, delivering per-seat views.
**Success criteria:** An integration test boots a real server in-process, claims three seats, and receives three distinct `RedactedView`s.
**Status:** Complete — four tests, including a redaction cross-check across all three seats.

`seatClient.ts` wraps one WebSocket: `CLAIM_SEAT`, store the `SEAT_CLAIMED` token, hold the socket open, reconnect with `RESUME_SEAT`. Sockets stay open for the life of the match — a reconnect during a round-over re-arms the reveal deadline for every player (`room.ts:380`).

---

## Stage 3a: The tool surface, without MCP

**Goal:** All seven tools decided in one session object, testable against a fake seat.
**Success criteria:** Every seat-scoped tool refuses a call with no handle; `tableStatus` carries no hand; `joinMatch` is the only tool that returns one.
**Status:** Complete — 13 tests.

`session.ts` holds every decision the tool surface makes, so the MCP layer above it can be glue thin enough to review by reading — the split `Court` keeps with `buildRenderPlan` and `computeLayout`. That is also what let this stage land without taking the dependency named above: the whole surface is exercised against a fake seat, with no stdio and no SDK.

## Stage 3b: The MCP transport

**Goal:** `session.ts` exposed over stdio, registered in `.mcp.json`.
**Success criteria:** A real MCP client lists seven tools and drives a match through them.
**Status:** Complete — hand-rolled in `rpc.ts` + `tools.ts` + `main.ts`. `stdio.test.ts` spawns `main.ts` as a real subprocess and plays a match to a winner using nothing but `tools/call`.

*Design §7* is settled: the continuous loop. `DEFAULT_AWAIT_MS` is 90s, sized against the **two-minute automatic-backgrounding threshold** rather than the wall-clock limit — Claude Code's per-call limit defaults to ~28 hours and the stdio idle timeout to 30 minutes, so neither binds, but a main-conversation call passing two minutes is moved to a background task, which would pull the referee out of its own loop mid-match.

**What this stage caught.** `playCard` confirmed a move on an *event* ("a push arrived") rather than a *condition* ("the view advanced"). Any queued frame satisfied it, so `playCard` could return while the seat still held the turn — the referee looped, `await_turn` handed the same seat the same turn again, and `get_view` then reported no legal plays. Both `awaitTurn` and `playCard` are now condition-based, which also makes them safe to overlap on one seat. Regression tests in `session.test.ts`.

`rpc.ts` earns its own file for one rule: **a notification is never answered.** Replying to an id-less frame, even with an error, leaves a client reconciling a response it has no request for. Transport failures are JSON-RPC errors; tool failures are successful responses carrying `isError`.

---

## Stage 4: A whole match

**Goal:** One test drives three MCP seats and a fourth scripted player to a winner.
**Success criteria:** The match ends with a `matchWinnerId`; no seat ever reads another's view.
**Status:** Complete — `wholeMatch.test.ts`, ~1,700 assertions per run, ten consecutive clean runs.

This is the only test that proves the boundary holds under the real protocol rather than a stub, and it is the one to write before believing any of the rest. It earned that description immediately: it found a real product bug and a real test bug, both of the same kind.

**What it caught.** `session.signal()` routed turns from whichever seat's frame arrived first, so it could announce `your_turn` for p3 on p2's word — while `getView(h3)` still returned p3's previous frame, whose `own.legalPlays` is empty because that array is populated only for the viewer holding the turn. The seat was handed a turn with no legal move in it. Fixed by making each seat's own frame the only authority on its own turn, which makes signal and view the same commit by construction. A regression test in `session.test.ts` pins it.

The test's own first draft then made the mirror-image mistake, comparing `matchWinnerId` across seats at the instant `match_over` was first observed. That invariant is *eventual*, not instantaneous. It now reads the winner from the `MATCH_ENDED` broadcast and waits for each seat to converge, bounded.

**The lesson worth carrying into 3b.** Three sockets have no ordering guarantee at the consuming process's event loop. Any check or decision that spans two seats' frames is wrong unless it is either synchronised to one commit or explicitly written as convergence.
