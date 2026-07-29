# MCP Seat Implementation Plan

> **For Claude:** Every task follows red → green → commit. Never write implementation before its failing test.

**Goal:** Build the MCP server that seats a model at a live table, matching `docs/plans/2026-07-28-mcp-seat-design.md`.

**Architecture:** One long-lived Bun process speaking MCP over stdio. It holds three WebSocket connections to the running game server, one per seat, and exposes seven tools — three public, four requiring an opaque per-seat handle. The referee routes turns on public information alone; each seat agent reads and plays through its own handle.

**Tech stack:** Bun, TypeScript 5.7 strict, `bun test`. One new runtime dependency, discussed below.

**Design reference:** `docs/plans/2026-07-28-mcp-seat-design.md`, cited as *Design §N*. The wire contract is `src/server/protocol.ts` — import it, never restate it.

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

**The one new dependency.** `@modelcontextprotocol/sdk` is the first runtime dependency this repo adds beyond Phaser, and the transport plan's "no new runtime dependencies" line was written before an MCP existed. Hand-rolling is possible — MCP is JSON-RPC over stdio — but the surface is wider than `protocol.ts`'s seven variants: an initialize handshake, capability negotiation, notifications, content blocks, and an error taxonomy. That is past the threshold `protocol.ts` names for taking a library. Stage 3 is where it lands; Stages 1 and 2 add nothing.

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

## Stage 3: The MCP surface

**Goal:** Seven tools over stdio, registered in `.mcp.json`.
**Success criteria:** Every seat-scoped tool refuses a call with no handle; no tool output contains a seed, an action log, or another seat's hand.
**Status:** Not Started

The redaction guard borrows the transport suite's technique: ban forbidden substrings from every tool result rather than asserting field by field, because a blunt guard catches the serialization mistake a precise one misses.

---

## Stage 4: A whole match

**Goal:** One test drives three MCP seats and a fourth scripted player to a winner.
**Success criteria:** The match ends with a `matchWinnerId`; no seat ever reads another's view.
**Status:** Not Started

This is the only test that proves the boundary holds under the real protocol rather than a stub, and it is the one to write before believing any of the rest.
