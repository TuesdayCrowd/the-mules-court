# The Mule's Court — MCP Seat Design

**Date:** 2026-07-28
**Status:** Decided. §7 settled in favour of the continuous loop.
**Scope:** An MCP server that lets a language model occupy seats at a live table.
**Depends on:** `docs/plans/typescript/2026-07-22-transport-design.md`

---

## 1. Scope

A human alone cannot play this game. The engine accepts two to four players, the
transport seats them over WebSocket, and neither offers an opponent. This design
covers the piece that supplies one: an MCP server holding three seats, so a
single person can play a four-player match against a model.

It covers the tool surface, the information boundary between seats, the runtime
loop that drives a match, and failure handling. It does not touch the engine,
the transport, or the client. Nothing in this design may change a rule.

### Fixed decisions

| Decision | Choice |
| --- | --- |
| Seats held | Three, against one human, for a four-player match |
| Room creation | The human hosts in the browser; the MCP only joins |
| Isolation | An opaque handle per seat, one agent context per seat |
| Runtime | Bun, stdio transport, in this repo at `src/mcp/` |
| Rules | Read from `RedactedView`. Never re-derived |

---

## 2. The problem worth solving

The Mule's Court is a deduction game. Every card is a question about what an
opponent holds, and the whole tension lives in not knowing.

One mind holding three hands destroys that. An Informant guess becomes a
certainty, a Mayor Indbur comparison is decided before it is played, and the
human plays alone while three seats move with perfect knowledge. The game does
not become hard; it stops existing.

So the design problem is not the protocol adapter, which is thin. It is the
information boundary between the three seats, and that boundary is the reason
for nearly every decision below.

---

## 3. Architecture

Three participants, and the split between them is the design:

```
referee context          MCP process (stdio, long-lived)        Bun server :3000
     |                            |                                    |
     |  await_turn()              |   three WebSockets, one per seat    |
     |--------------------------->|----------------------------------->|
     |  <- { seat: "p3" }         |<--- STATE_UPDATE (unicast) ---------|
     |     public only            |                                     |
     |                            |                                     |
     |  dispatch seat p3's agent, handing it p3's handle                 |
     |         |                  |                                     |
     |         |  get_view(h3)    |                                     |
     |         |----------------->|  p3's RedactedView                  |
     |         |  play_card(h3,…) |                                     |
     |         |----------------->|------ PLAY_CARD ------------------->|
```

**The referee never reads a view.** It learns only whose turn it is, which every
player already knows — `currentPlayerId` sits in every `RedactedView`. It then
hands the turn to that seat's agent and waits. A referee that called `get_view`
would collapse the three seats back into one mind, so it has no reason to hold
that information and never asks for it.

**The MCP process holds the sockets.** One process, three connections, open for
the life of the match. Each socket receives its own unicast `STATE_UPDATE`, so
redaction is the server's existing work rather than something this layer
performs.

### Why a handle

`seatTokens.ts` already treats a token as the authority to act as a seat, and
`view(match, viewerId)` is the only function whose output may reach a client.
This design extends that boundary one layer outward rather than inventing a new
one. When the MCP claims a seat it mints an opaque handle and returns it once.
Every seat-scoped tool requires a handle and serves exactly that seat.

An agent given `h3` cannot read p2's hand, because reading p2's hand requires
`h2` and it does not have one. The isolation is a missing capability, not a rule
someone must remember — the same trade the transport makes when it deletes
`playerId` from `PLAY_CARD` instead of validating it.

**The residual assumption, stated plainly.** The referee must hold all three
handles to hand them out, so isolation between the seats is enforced while
isolation from the referee is disciplined. Single-use turn tickets would close
this, at the cost of a second credential kind and an expiry rule. The gap is
narrow — the referee gains nothing by looking, and its own transcript would show
it had — so this design accepts it and names it here rather than paying for
machinery no one needs.

---

## 4. Tool surface

Seven tools. Three are public, four are seat-scoped.

**Public — safe for the referee.**

| Tool | Returns |
| --- | --- |
| `join_match({ matchId, nicknames, serverUrl? })` | `[{ seat, handle, nickname }]`, once |
| `await_turn({ timeoutMs? })` | `{ status, seat?, turnNumber, phase }` |
| `table_status()` | Seat roster, nicknames, phase, and the tail of `publicLog` |

`await_turn` blocks until one of the held seats holds the turn, then returns its
`PlayerId` and nothing else. It returns `waiting` on timeout so the caller
re-enters rather than hanging. `table_status` carries `publicLog`, which is
public by construction, and exists so the referee can narrate the match to the
human without touching a hand.

**Seat-scoped — a handle is required.**

| Tool | Returns |
| --- | --- |
| `get_view({ handle })` | That seat's `RedactedView`, plus nicknames |
| `play_card({ handle, cardInstanceId, target?, guess? })` | `{ ok }` or an `ErrorCode` |
| `read_notebook({ handle })` | That seat's accumulated notes |
| `write_notebook({ handle, text })` | Acknowledgement |

`play_card` mirrors the wire message exactly, down to `guess` naming a value
from two to eight rather than a character. The engine already publishes
`own.legalPlays` and `own.legalTargets`, so a seat agent chooses among answers
the engine computed. It never decides whether a play is legal.

### The notebook

A seat needs to accumulate deductions across a round the way a person does:
who dodged a guess, who discarded high, who has been quiet. The notebook is a
per-seat scratchpad stored in the MCP process and reached through the same
handle, so one seat's read of the table stays invisible to the others.

It buys a second property worth more than it looks. Because a seat's memory
lives in the MCP rather than in a model context, interrupting the referee costs
nothing — no seat forgets anything, and resuming is free.

---

## 5. Driving a match

The referee loops: `await_turn`, dispatch that seat's agent, let it play, block
again. The human plays in the browser and the table answers.

Rounds need no help. `room.ts` advances them on a server timer
(`revealWindowMs`), re-entered through the same queue as any client message, so
a seat that does nothing at round end is behaving correctly. There is no
acknowledgement to forget and no way to hang the table by staying silent.

Two cautions come from the same file:

- **Hold the sockets open.** A reconnect during a round-over re-arms the reveal
  deadline for everyone (`room.ts:380`), so a seat that reconnects per turn
  quietly stretches the reveal window for the human.
- **Stay under the bucket.** `messageBurst` is 10 with a refill of 5 per second.
  Three seats on separate sockets sit far below it, and a resync storm is the
  only way to approach it.

---

## 6. Failure handling

**A stalled seat.** If a seat agent errors or returns nothing playable, the MCP
falls back to a heuristic play drawn from `legalPlays` — the lowest-value legal
card at a legal target. A dull move beats a frozen table, and the human is told
it happened.

**A dropped socket.** The MCP stores each `seatToken` and reconnects with
`RESUME_SEAT`, exactly as the browser client does. Tokens live in process memory
only, never on disk: the match is ephemeral and a persisted seat token is a
credential with no expiry.

**A rejected play.** `ERROR` codes come back verbatim from the engine, and they
name rules rather than cards. The seat agent sees the code, re-reads its view,
and plays again.

---

## 7. Decided: the continuous loop

The referee runs a whole match in one turn — `await_turn` → dispatch → play →
`await_turn`, for as long as the match lasts. The human plays in the browser and
never has to address the terminal.

Handing the floor back after each catch-up was the alternative, and was
rejected. Both use the same seven tools and the same seat agents, differing only
in whether the referee re-enters its own loop, so this settles one constant and
one prompt rather than any structure.

**The constant is `DEFAULT_AWAIT_MS` in `session.ts`, and it is ninety
seconds.** The binding constraint is not the obvious one. Claude Code's per-call
wall-clock limit defaults to about 28 hours, and the idle timeout for a stdio
server to 30 minutes; neither is close. What bites first is **automatic
backgrounding**, which moves a main-conversation tool call to a background task
once it passes two minutes. That is right for a long build and wrong for a
turn-based game, because it would pull the referee out of its own loop
mid-match. So the target is "comfortably under two minutes" rather than "as long
as possible": a human who thinks for more than ninety seconds costs one extra
re-entry, and that is the cheap failure.

**What makes the continuous loop affordable is that interrupting it is
lossless.** Each seat's notebook lives in the MCP process rather than in a model
context (§4), so breaking in to ask a question and resuming afterwards costs
nothing — no seat forgets its read of the table. Without that property this
would be a much worse trade, since talking to a running referee is otherwise an
interruption rather than a turn.

---

## 8. Placement and testing

`src/mcp/` in this repo, importing `../server/protocol` so the wire contract
cannot drift into a second copy. Registered through `.mcp.json`, which does not
yet exist.

Tests follow the existing split. The pure parts — handle registry, notebook
store, turn router, the heuristic fallback — run under `bun test`, since the MCP
is Bun-native for the same reason `src/server/` is. One integration test boots a
real server in-process, claims three seats, and drives a match to a winner,
which is the only test that proves the redaction boundary holds under a real
protocol rather than a stub.

Two invariants the suite must protect:

- No seat-scoped tool ever answers without a handle.
- No tool output contains a seed, an action log, or a hand belonging to another
  seat. The transport suite already bans forbidden substrings from client
  frames; this borrows the technique.
