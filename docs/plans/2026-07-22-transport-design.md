# The Mule's Court — Transport Design

**Date:** 2026-07-22
**Status:** Approved. Ready for implementation planning.
**Scope:** The WebSocket server that wraps the game engine.
**Depends on:** `docs/plans/2026-07-22-engine-architecture-design.md`

---

## 1. Scope

The engine is built, tested, and merged-ready. This design covers only the layer around it:

- the WebSocket message protocol,
- seat identity without user accounts,
- the room lifecycle,
- reconnection and pause,
- the trust boundary and per-message validation,
- persistence and crash recovery.

The engine already enforces every rule of the game. The transport enforces everything the engine cannot: who is allowed to speak for a seat.

### Fixed decisions

| Decision | Choice |
| --- | --- |
| Runtime | Bun, using `Bun.serve` with native WebSockets, self-hosted |
| Joining | Private rooms via a shareable link. No accounts, no matchmaking |
| Disconnects | Hold the seat and pause the match; resume on reconnect |
| Round advance | A flat **5-second** timer after every round end |
| Persistence | `bun:sqlite`, storing `{seed, actionLog}` rather than a state snapshot |

---

## 2. Architecture

One Bun process holds `Map<matchId, Room>` in memory. Each `Room` owns a `MatchState`, a seat table, and a serialization queue.

**Room creation is HTTP, not WebSocket.** `POST /api/rooms` mints the host's seat token server-side and returns it in the response, before the join link exists. Every other interaction is a WebSocket message.

That split exists for one reason. When host status is granted to whoever claims seat 0 first, any invitee's script can win that race and seize control of the room. Creating the room over HTTP hands host status to the creator before anyone else knows the room's ID, so there is no race to win.

Two principles run through everything below:

**Prefer deleting a field to adding a check.** `PLAY_CARD` carries no `playerId`; the acting identity comes from the connection. `CLAIM_SEAT` carries no seat index; the server assigns the lowest open seat. Neither spoofing nor out-of-range probing is a validation someone must remember, because neither has a field to attack.

**Every view is unicast.** `view()` returns different bytes for every player. Publishing one payload to a room would hand each player somebody else's hand. Bun's `ws.publish()` is used only for the three messages that carry no hidden information.

---

## 3. Message protocol

```ts
type PlayerId  = string;   // server-allocated 'p1'..'pN' by seat index, never client-chosen
type SeatToken = string;   // >=128-bit random, opaque to the client
type MatchId   = string;   // >=128-bit random, non-sequential
```

### HTTP

```
POST /api/rooms  {}
  -> 201 { matchId, joinUrl, hostSeat: 'p1', hostSeatToken }
```

The only place a seat token is delivered outside an open WebSocket.

### Client to server

```ts
type ClientMessage =
  | { type: 'CLAIM_SEAT';    matchId: MatchId; nickname: string }   // no seat index — server assigns
  | { type: 'RESUME_SEAT';   matchId: MatchId; seatToken: SeatToken }
  | { type: 'START_MATCH';   matchId: MatchId }                 // host only; 2-4 seats claimed
  | { type: 'PLAY_CARD';     matchId: MatchId;
      cardInstanceId: CardInstanceId;
      target?: PlayerId;
      guess?: CardTypeId;
      clientMsgId?: string }                                    // echo only; never authorises or orders
  | { type: 'END_MATCH';     matchId: MatchId }                 // host, or any seat after the grace period
  | { type: 'REQUEST_RESYNC'; matchId: MatchId }
  | { type: 'PING' };
```

`PLAY_CARD` has no `playerId`, permanently. The server builds the engine's `PlayCardAction.playerId` from `ws.data.seat` alone.

### Server to client

```ts
type ServerMessage =
  | { type: 'LOBBY_UPDATE';  matchId; hostSeat; canStart;
      seats: { seat: number; playerId: PlayerId | null; nickname: string | null;
               status: 'open' | 'occupied' | 'disconnected' }[] }   // broadcast
  | { type: 'SEAT_CLAIMED';  matchId; seat; playerId; seatToken }   // once, this socket only
  | { type: 'MATCH_STARTED'; matchId }                              // broadcast
  | { type: 'STATE_UPDATE';                                          // UNICAST
      view: RedactedView;                    // view(match, ws.data.seat)
      nicknames: Record<PlayerId, string>;   // transport-owned, NEVER inside view
      phase: 'active' | 'round_over' | 'ended';
      endReason?: 'won' | 'abandoned';
      winnerSeat?: PlayerId;
      paused: boolean;
      missingSeats: PlayerId[];
      revealDeadline?: number;               // epoch ms, present only while round_over
      serverTime: number }
  | { type: 'MATCH_ENDED';   matchId; reason: 'won' | 'abandoned'; winnerSeat? }  // broadcast
  | { type: 'ERROR';         code: ErrorCode; refId?: string }
  | { type: 'FATAL';         code: ErrorCode }                       // sent, then socket closed
  | { type: 'PONG' };
```

`LOBBY_UPDATE`, `MATCH_STARTED`, and `MATCH_ENDED` are the only broadcasts. Each is viewer-invariant: seat occupancy and lifecycle signals, carrying no card.

Nicknames sit **beside** `view`, never inside it. `RedactedView` is produced by the engine, and the engine has no concept of a name — seats are `p1..pN`. Folding a display name into engine output would put presentation data inside the authoritative game state and break the replay guarantee, since `{seed, actionLog}` reconstructs a match that never knew anyone's name.

Error codes cover the transport (`MALFORMED`, `ROOM_NOT_FOUND`, `SEAT_TAKEN`, `ROOM_FULL`, `ALREADY_SEATED`, `BAD_TOKEN`, `NOT_YOUR_SEAT`, `NOT_HOST`, `PAUSED`, `MATCH_OVER`, `RATE_LIMITED`, `INTERNAL`) and forward the engine's own `ValidationError` codes verbatim. Engine codes are safe to forward: they name rules, never cards.

Validation is a hand-written switch over the union, roughly 50 lines. A schema library would earn its dependency at fifteen or twenty variants; at eight it would not.

---

## 4. Seat identity

**Issue.** The host's token is minted at room creation over HTTPS. Every other seat's token is minted the first time `CLAIM_SEAT` succeeds on an open connection, and delivered by `SEAT_CLAIMED` to that socket alone. Tokens are 128-bit random values from `crypto.getRandomValues`, stored as SHA-256 hashes so a leaked database hands out nothing.

**Store.** The client writes `{seat, seatToken}` to `localStorage` under `mules-court:${matchId}` the moment it arrives.

**Present.** On any later load of the same match, a client holding a token sends `RESUME_SEAT` and never `CLAIM_SEAT`. A client without one sends `CLAIM_SEAT`, which can only ever take a currently open seat.

**One seat per connection.** The server rejects any `CLAIM_SEAT` or `RESUME_SEAT` with `ALREADY_SEATED` when `ws.data.seat` is already bound. Every candidate design originally enforced one-seat-per-tab through `localStorage`, which a script never runs — a single raw socket could have claimed the entire table.

**One live connection per token.** A new connection presenting a valid token evicts the old one: the old socket receives `FATAL{SEAT_TAKEN}` and closes, and `room.seats[seat].conn` is repointed in the same tick. Every subsequent message re-checks that `room.seats[ws.data.seat].conn` is *this* connection, so a message already in flight from an evicted socket is refused rather than racing the new one.

A second tab in the same browser reads the same stored token, so it resumes the seat and evicts the first tab — a clear outcome, not a race. Gaining a *second* seat would require deliberately clearing storage, which only ever yields a seat that was already open.

**No rotation, no recovery.** Tokens live as long as the room. Losing local storage permanently loses that seat for that match; the only remedy is the host abandoning the room. That is the accepted price of having no accounts.

An unresolvable token always returns the same `FATAL{BAD_TOKEN}`, whether it never existed, belongs to another match, or belonged to a room since expired. Distinguishing those cases would build an enumeration oracle.

---

## 5. Room lifecycle

Room fields: `phase: 'lobby' | 'active' | 'ended'`, `paused` (recomputed as `missingSeats.length > 0`, never toggled independently), `endReason`, `winnerSeat`. The engine's own `round.phase` and `matchWinnerId` live inside `MatchState` and are never mirrored into separately mutable transport flags — that duplication is what let two audited designs drift out of sync with `isMatchOver()`.

| # | Transition | Trigger |
| --- | --- | --- |
| 1 | → `lobby` | `POST /api/rooms`; mints host seat and token |
| 2 | `lobby` → `lobby` | `CLAIM_SEAT` on an open seat |
| 3 | seat drops in lobby | Seat marked disconnected, token reserved; released to open after `lobbyDisconnectGraceMs` |
| 4 | host absent in lobby | After the grace period, any connected seat may dissolve the room |
| 5 | `lobby` → `active` | `START_MATCH` from the host with 2–4 seats claimed and connected |
| 6 | `lobby` → `ended` | No `START_MATCH` within `lobbyTTL` |
| 7 | `active` → paused | Any occupied seat's socket closes |
| 8 | paused → unpaused | That seat's own `RESUME_SEAT`; no one may resume for another |
| 9 | round ends | `reduce()` returns `round-over` **and** `!isMatchOver` — arms the 5s timer |
| 10 | next round dealt | Timer fires, re-checking round phase, `!isMatchOver`, and `!paused` |
| 11 | `active` → `ended('won')` | The same `reduce()` that ended the round set `matchWinnerId` |
| 12 | `active` → `ended('abandoned')` | Host at any time, or any connected seat once **any** seat has been missing past `activeGraceMs` |
| 13 | `active` → `ended('abandoned')` | Reaper: zero connected sockets beyond a hard TTL |
| 14 | `ended` → removed | Reaper, after the retention window |

Transition 12 applies to *any* missing seat, not only the host. A non-host laptop dying is at least as common, and every candidate design left it with no resolution at all — three attentive players stuck forever because the wrong seat vanished.

---

## 6. Round advancement

A finished round holds for a flat **5 seconds**, then the next hand is dealt.

```
reduce() returns round-over
  → persist, push STATE_UPDATE{ phase:'round_over', revealDeadline }
  → arm 5s timer            (only when !isMatchOver)
  → timer fires             (re-check round-over, !isMatchOver, !paused)
  → startNextRound()        (inside try/finally releasing the advance lock)
  → persist, push STATE_UPDATE{ phase:'active' }
```

**A match-winning round never arms the timer.** `reduce()` can set `round.phase = 'round-over'` and `matchWinnerId` in the same call, and `startNextRound()` throws when the match is decided. Treating the two as independent conditionals arms a timer that later throws inside a socket handler — crashing the process and every other room in it. This is ordinary gameplay, not an attack: it fires the first time anybody wins. Match-over therefore takes unconditional precedence, and `!isMatchOver(match)` is a precondition of arming, not a sibling branch.

**A disconnect restarts the countdown rather than resuming it.** A player who drops at second four would otherwise return to a showdown that vanishes immediately.

`revealDeadline` is a server timestamp. The client counts toward it but decides nothing from it; a throttled background tab or a modified client must not be able to skip the showdown everyone else is reading.

There is no skip control. A host-only skip was considered and cut: at five seconds it saves nothing, and it would add a host-gated message, a rate-limit surface, and a race against the timer.

---

## 7. Reconnection

1. The client reads its stored token and sends `RESUME_SEAT` as its first message.
2. The server resolves the token. Unresolvable tokens get `FATAL{BAD_TOKEN}`. A token whose seat already holds a live connection evicts that connection first.
3. The server binds `ws.data`, subscribes the socket to the room topic, clears the seat from `missingSeats`, and recomputes `paused`.
4. If this was the last missing seat during a round-over, the countdown restarts at a full five seconds.
5. The server sends one `STATE_UPDATE` built fresh from live state — a complete repaint, never a cached snapshot.
6. If `missingSeats` is now empty, every other seat receives a fresh `STATE_UPDATE` too, so all the "waiting for…" banners clear together.

**A server restart needs no special case.** Rooms rebuild from `{seed, actionLog}` with every seat marked missing and `paused` true, which is indistinguishable from everybody having disconnected at once. The first `RESUME_SEAT` then runs the flow above unchanged. Crash recovery and ordinary reconnection are the same code path, so neither can rot while the other is exercised.

While paused, `PLAY_CARD` is refused with `ERROR{PAUSED}` before `validateAction` or `reduce` is called and before `actionLog` is touched.

`REQUEST_RESYNC` re-sends the same `STATE_UPDATE` and changes nothing, giving a client a cheap escape from a suspected missed push.

---

## 8. The validation pipeline

Every inbound message runs these in order. Any failure stops the pipeline and touches no game state.

1. **Frame limits.** `maxPayloadLength` of 4 KB, and `permessage-deflate` disabled outright rather than capped, so an oversized frame and a compression bomb both die below user code.
2. **Parse.** `JSON.parse` inside `try/catch`; a throw yields `MALFORMED` and drops the message without closing the socket.
3. **Shape.** Hand-written type guards per variant. Unknown types, missing fields, and unexpected fields all yield `MALFORMED`. `target` and `guess` are additionally checked against closed enums. `nickname` is the protocol's only free text and the only thing one player can put on another's screen: trim it, cap it at 24 characters, reject control characters and anything that is empty after trimming, and render it as text rather than markup.
4. **Rate limit.** A per-connection token bucket applied to *every* message type, plus a per-IP limit on new connections and room lookups. Limiting only `PLAY_CARD` leaves every other type floodable.
5. **Identity.** Read `ws.data.seat` and nothing else. An unbound connection gets `NOT_YOUR_SEAT` regardless of payload.
6. **Canonical pointer.** `room.seats[ws.data.seat].conn` must be this connection, closing the eviction race.
7. **One seat per connection.** `CLAIM_SEAT` and `RESUME_SEAT` are refused when a seat is already bound.
8. **Room and phase gates.** `ROOM_NOT_FOUND`, `ROOM_FULL`, `PAUSED`, `MATCH_OVER`.
9. **Host gate.** `START_MATCH` and `END_MATCH` compare against `room.hostSeat` server-side.
10. **Engine call.** Wrapped in `try/catch`; a throw becomes `ERROR{INTERNAL}` and a server log, never an uncaught exception inside a socket handler.
11. **Commit.** Apply match-over precedence, append to `actionLog`, persist synchronously, then build and send one `STATE_UPDATE` per seat in an explicit loop.

Replayed messages need no dedup logic. Because a room's pipeline is fully serialized, a resent `PLAY_CARD` simply fails engine validation the second time, since the state has already moved.

---

## 9. Persistence and recovery

One `bun:sqlite` table stores `matchId`, `seed`, `hostSeat`, `seatMap` (with hashed tokens), `actionLog`, `phase`, `endReason`, and timestamps.

Storing `{seed, actionLog}` rather than a serialized `MatchState` keeps the storage schema independent of the engine's internal shape. A future field on `MatchState` needs no migration; it needs only `reduce()` to behave as its own test suite already pins down.

Writes happen inside the same queued step that ran the engine call, before the broadcast. A crash between acceptance and notification therefore loses a broadcast, never a divergence between what the log says and what players saw.

Recovery replays `createMatch(playerIds, seed, matchId)` and folds `actionLog` through `reduce()`. Rooms rebuild lazily on first touch, so a restart with many rooms does not stall the server before it can accept connections. A replay that fails validation indicates a corrupt log and is quarantined for inspection rather than crashing the boot.

A sweep every few minutes expires stale lobbies, forces long-abandoned matches to `ended`, and deletes rooms past their retention window.

**The action log is as sensitive as the seed.** Together they reconstruct every hidden hand in the match. Treat the database as secret material, not as convenience storage.

---

## 10. Concurrency

Every message for a room — not only `PLAY_CARD` — runs through that room's own promise chain:

```ts
class Room {
    private queue: Promise<void> = Promise.resolve();

    enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
        const result = this.queue.then(fn);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
```

The engine is synchronous and `bun:sqlite` is synchronous, so nothing genuinely awaits today. The queue exists so that stays safe when it stops being true. An async logger or a networked store added later would otherwise reintroduce a race silently, with no compiler and no test to catch it. Fifteen lines buys an invariant that is directly testable.

Rooms hold independent chains, so a busy room cannot block a quiet one. The reveal timer routes through the same `enqueue`, so round advancement has no unserialized path of its own.

---

## 11. File layout

```
src/server/
  index.ts          Bun.serve entrypoint: HTTP handler, WS open/message/close. Wiring only
  protocol.ts       Message unions, ErrorCode, hand-written type guards
  room.ts           Room class: state, seat table, enqueue(), transitions
  roomRegistry.ts   Map<matchId, Room>, creation, lookup, the reaper sweep
  seatTokens.ts     Minting, hashing, lookup, one-live-connection enforcement
  dispatch.ts       The validation pipeline of section 8, in order
  persistence.ts    bun:sqlite store and the replay rebuild
  rateLimiter.ts    Per-connection and per-IP token buckets
  config.ts         Every tunable in one place
  __tests__/        See below
```

---

## 12. Testing strategy

Vitest, as with the engine, and again without mocks. A real server on an ephemeral port and real WebSocket clients test the actual thing; a mocked socket would test the mock.

1. `protocol.test.ts` — table-driven validation of every message variant against valid, malformed, wrong-typed, and extra-field inputs. Asserts a `playerId` on `PLAY_CARD` is rejected.
2. `seatTokens.test.ts` — minting, hashing, one-seat-per-connection, eviction, and the uniform `BAD_TOKEN` response across every unresolvable case.
3. `room.test.ts` — each transition in section 5 driven directly, including those a client cannot trigger (grace expiry, reaper).
4. `roundAdvance.test.ts` — with `revealWindowMs` shrunk to milliseconds: the timer deals the next round; **a match-winning round never arms it**; a pause restarts rather than resumes it; a throw inside `startNextRound` still releases the lock.
5. `dispatch.test.ts` — one test per pipeline step proving it rejects and that no state changed.
6. `integration.test.ts` — real sockets: create a room over HTTP, seat four clients, play a full match, and assert after **every** push that no client received another seat's hand, the deck, the seed, or a raw `MatchState`.
7. `reconnect.test.ts` — drop mid-round, verify others see paused, reconnect, verify the repaint matches a fresh `view()`. Restart the server and prove the rebuilt room serves the same views.
8. `abuse.test.ts` — the closed exploits of section 13, each as an executable attack asserting it fails.

Suite 6 is the one that matters most. It is the transport's equivalent of the engine's leak fuzzer, and like that one it must assert presence as well as absence: a projection that returned nothing would pass an absence-only test.

---

## 13. Exploits closed

Each was found by an auditor against a candidate design and is closed by construction here.

| Attack | Closed by |
| --- | --- |
| An ordinary match win crashes the process | Match-over precedence; `!isMatchOver` is a precondition of arming the timer |
| Race to claim seat 0 and seize host | Host minted over HTTP before the link exists |
| Unserialized seat-claim races | Every message type routes through one per-room queue |
| One socket claims every seat | Server-side one-seat-per-connection, independent of the client |
| Out-of-range seat index probe | `CLAIM_SEAT` has no seat field |
| Seat spoofing via `playerId` | `PLAY_CARD` has no `playerId` field |
| Evicted socket still acts as its seat | Canonical connection pointer re-checked per message |
| Flooding non-gameplay message types | Rate limiting applied before every handler |
| Room resident forever | Generalized grace period plus a zero-connection reaper |
| Advance lock leaks on an engine throw | `try/finally` around `startNextRound` |
| `room.phase` drifts from `isMatchOver()` | Set in the same synchronous step `reduce()` returns |
| Compression bomb | `permessage-deflate` disabled entirely |
| Prototype pollution via a client string key | `playerId` always server-allocated from a fixed pool |
| Room-code brute forcing | 128-bit non-sequential `matchId`, per-IP limits |
| Token enumeration oracle | One `BAD_TOKEN` for every unresolvable case |

---

## 14. Open questions

1. **Host transfer.** A host who vanishes currently dissolves the lobby or leaves the match abandonable. Promoting a successor is a product decision, not a security one.
2. **Fixed or flexible seat count.** The design lets the host start with whatever 2–4 seats are filled. Fixing the count at creation would make the join link's advertised size clearer.
3. **Spectators.** Undefined. A spectator needs a view more redacted than any seat's, holding no `own.hand`, and must never receive a seat's projection.
4. **Retention.** Defaults are short and purely operational. Keeping finished matches longer would enable a results or history page.
5. **Tunables.** Every number here is a starting point: grace periods, TTLs, rate limits, the 4 KB cap. Only playtesting settles them. The 5-second reveal window is already decided.

---

## 15. Risks

- **One process is a real ceiling.** Per-room queues bound ordering, not CPU. A pathological synchronous engine call stalls every room in the process. Scaling past one process needs room affinity or externalized state, which is out of scope.
- **Losing local storage loses the seat permanently.** No accounts means no recovery path beyond the host abandoning the match.
- **Collusion is out of reach.** Two seats driven by one person is a property of link-only joining, and no protocol change here prevents it.
- **Unified errors cost clarity.** Closing the enumeration oracle means a mistyped link and an expired room look identical to an honest player.
- **Synchronous writes sit in the critical path.** Fine at this scale; it would need batching if room count ever grew enough to matter.
