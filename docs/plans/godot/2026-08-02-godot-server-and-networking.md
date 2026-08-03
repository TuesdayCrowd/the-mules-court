# GDScript Server + Networking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task-by-task.
> This is **Stage 4** of `2026-08-02-godot-full-rewrite-master-plan.md` (doc 6 of 9) — the critical path, per master §9. **Do not start until Stage 3 (`2026-08-02-gdscript-engine-port.md`) is corpus-green.** Every server bug that is not a transport bug is an engine bug wearing a socket, and there is no way to tell the two apart until the engine underneath is trusted.

**Date:** 2026-08-02
**Status:** Plan.
**Scope:** The authoritative game server (rooms, wire protocol, seat identity, persistence, rate limiting, config) in GDScript, plus the Godot client's socket half. Read alongside `2026-08-02-gdscript-engine-port.md` (doc 4, supplies `reduce()`/`view()`/`createMatch()`/`isMatchOver()`) and `2026-08-02-gdscript-ai-port.md` (doc 5, supplies `chooseBotPlay()`).

---

## 0. Why this document opens with a fork

Master plan §11 gate 5 puts a decision in front of this document before it can be executed: **build a full GDScript server, or keep the Bun one?** The master plan's default is the former; §1 below records the latter so choosing it costs the owner one conversation, not a rewrite of nine documents.

Everything from §2 onward plans the **default** — the full GDScript server. If the owner picks the alternative, most of doc 4 (engine) and doc 5 (AI) survive untouched (the offline-solo path in master §3.3 needs the GDScript engine regardless of which server design ships), and this document is replaced by a much shorter one: a GDScript client speaking the existing `protocol.ts` wire to the existing, unmodified Bun server.

---

## 1. THE FORK — full GDScript server vs. keep the Bun server

### Default: full GDScript server (this document, §2 onward)

Every subsystem in `src/server/` — protocol, room state machine, seat tokens, dispatch, persistence, rate limiting, config — is rewritten in GDScript and runs as a `--headless` Godot process. This is what "no TypeScript in the shipping product" (master §1) actually means for the transport layer, and it is what buys **offline solo without a subprocess** (master §3.3): the same GDScript room/reduce/view code that runs the dedicated server also runs in-process inside the client when there is no network, with no second implementation of the rules to keep honest.

**Cost, honestly stated:** `src/server/` is 3,331 LOC (master §4) — the single largest rewrite in the whole plan — and per master §9 it is the one with the *least* behavioural corpus to lean on. The conformance corpus (doc 3) proves the engine frame-for-frame; it says nothing about reconnection ordering, reaper TTL sweeps, token-bucket refill curves, or the host-race window, because those are properties of *time and connections*, not of `(seed, actionLog) → RedactedView`. Every one of those has to be re-pinned by a hand-written GDScript test that asserts the same behaviour the TS suite already asserts — this document's task sequence (§10) is built around doing exactly that, component by component, in the same order the TS server was built.

### Alternative: keep the Bun server, rewrite only client + engine-for-offline

A smaller, safer project: the Bun/TypeScript server in `src/server/` ships unchanged and continues to be the one production authority. The Godot client is a `WebSocketPeer`/`HTTPRequest` client of it — identical to §2–§3, §6, §9 below, since the wire is the same either way. The GDScript engine (doc 4) still gets built, but only to power the *offline solo* path locally on a device with no network (master §3.3's prize) — never as a second networked authority. Doc 5 (AI) is unaffected either way, since it only needs a `RedactedView` and an RNG stream, not a server.

What this alternative gives up: "no TypeScript left in the shipping product" becomes false — a deployment still needs a Bun runtime on the host, and the project keeps two languages in its critical path instead of one. What it buys: §4–§8 below (the biggest, least-corpus-backed rewrite in the whole plan) never has to happen, and every transport bug this repository has already found and fixed (AGENTS.md's `--watch` story, the host-race close, the reconnection-order bug) stays fixed in the implementation that fixed it.

**R1.1** This choice SHALL be made explicitly by the owner before any task in §10 begins, and recorded as a one-line addendum to this file's Status line (`Default chosen` / `Alternative chosen, see addendum`) — not inferred from which code happens to get written first.

---

## 2. No high-level `MultiplayerAPI` (master §3.2)

The single decision an agent with Godot's built-in multiplayer skills will fight, so it is repeated here at the point where the fighting happens: **never construct a `MultiplayerPeer`, never call `WebSocketMultiplayerPeer.new()`, never set `SceneTree.multiplayer_peer`.** One structural fact makes this easy to get wrong by accident: `WebSocketMultiplayerPeer` is not a separate legacy class sitting beside `WebSocketPeer` — it is *built on top of* `WebSocketPeer` [verified — godot-systems research §2, citing the post-4.0 `WebSocketClient`/`WebSocketServer` → `WebSocketPeer` refactor]. Picking "the WebSocket one" from a class list does not opt out of the high-level system by accident; only the bare `WebSocketPeer` class in §2.1 below does.

### 2.1 The argument, concisely

- **State ownership inversion.** `MultiplayerSynchronizer`/`MultiplayerSpawner` replicate a *live scene-tree graph* between peers — the server's copy of the game and the client's copy are both `Node` trees the framework keeps in sync. This project's actual model is the opposite: one authoritative `MatchState` mutated only by `reduce()` over an `actionLog`, and each client holding a `RedactedView` — a flat, per-seat-filtered snapshot, never a replicated object. Running both means maintaining two parallel truths for zero benefit.
- **RPC-authority is not seat-token auth.** `@rpc("authority")`/`set_multiplayer_authority()` key permission to "which peer owns this node," assigned by the `MultiplayerPeer`'s numeric peer id. This project's actual security boundary is a seat token validated per message (§4 below), independent of which socket happens to be attached. Using RPC-authority semantics as a stand-in for it would silently redefine what "authorized" means the day someone reaches for `@rpc` out of habit.
- **Prediction is undesirable here, not merely absent.** Godot ships no built-in client-side prediction or rollback — a `MultiplayerSynchronizer` setup still requires hand-written prediction/reconciliation code [verified — godot-systems research §2]. For a turn-based, deterministic-reducer card game there is nothing worth predicting past "wait for the server's next `STATE_UPDATE`" — the entire apparatus (spawners, synchronizers, replication configs, interpolation) is surface area bought for a feature this game does not want.
- **A second wire format for no reason.** `MultiplayerAPI` has its own binary RPC marshalling over Godot's `Variant` encoding. §3 below freezes the *existing* JSON protocol so the retiring TS MCP server (master §3.4) keeps working unmodified. Adopting the high-level stack would mean running two protocols side by side or rewriting a working, tested transport that has no reason to change.

**R2.1** No file under `godot/server/` or `godot/client/` SHALL reference `MultiplayerAPI`, `MultiplayerPeer`, `MultiplayerSynchronizer`, `MultiplayerSpawner`, `ENetMultiplayerPeer`, `WebSocketMultiplayerPeer`, or `@rpc`. Enforce this the same way `purity.test.ts` enforces the client's pure layer today: a text-search gate over `godot/server/` and `godot/client/store/` (doc 9 names the harness), failing the build if any of those tokens appear outside a comment explaining why not.

### 2.2 The client `WebSocketPeer` loop [verified — godot-systems research §1]

```gdscript
# client/socket.gd (autoload) — the accept/poll loop only; message handling is §9.
var _peer := WebSocketPeer.new()
var _state := WebSocketPeer.STATE_CLOSED

func connect_to(url: String) -> void:
    var err := _peer.connect_to_url(url)
    if err != OK:
        push_error("connect_to_url failed: %s" % err)
        return
    _state = WebSocketPeer.STATE_CONNECTING

func _process(_delta: float) -> void:
    if _state == WebSocketPeer.STATE_CLOSED:
        return
    _peer.poll()
    var ready := _peer.get_ready_state()
    if ready != _state:
        _state = ready
        _on_state_changed(ready)
    if ready == WebSocketPeer.STATE_OPEN:
        while _peer.get_available_packet_count() > 0:
            var packet := _peer.get_packet()
            _on_frame(packet.get_string_from_utf8())
```

`poll()` must run every frame — nothing happens without it [verified, same]. `get_ready_state()` returns one of `STATE_CONNECTING`/`STATE_OPEN`/`STATE_CLOSING`/`STATE_CLOSED` [verified, same]; there is no "on open" callback to hook, only a state to notice changing, which is why `_process` diffs it against the last-seen value rather than polling a signal.

### 2.3 `HTTPRequest` for `POST /api/rooms`, and its one caveat [verified — godot-systems research §1]

```gdscript
var http := HTTPRequest.new()
add_child(http)
http.request_completed.connect(_on_room_created)
var err := http.request(rooms_url, [], HTTPClient.METHOD_POST, "")
```

**Caveat, load-bearing:** an `HTTPRequest` node holds exactly one in-flight request; firing a second `request()` on the same node before `request_completed` fires either errors or cancels the first, depending on state — official guidance is one node per concurrent request [verified, same]. This project only ever has one room-creation request outstanding per menu screen, so the fix is structural rather than defensive: instantiate a fresh `HTTPRequest`, `add_child` it, fire the one request, `queue_free` it in the `request_completed` handler. Do not keep a singleton `HTTPRequest` autoload and reuse it across a "create" and a later "resync" call — that reintroduces the exact bug the caveat warns about the moment two screens race.

### 2.4 The gap the research did not cover: who serves `POST /api/rooms`?

`HTTPRequest`/`WebSocketPeer` in §2.2–§2.3 are both **client-side** tools — how the Godot client talks to a server. Under the default fork (§1), the *server* is also GDScript, and it must itself accept `POST /api/rooms` before any WebSocket exists to upgrade — the existing Bun server answers this over the same `Bun.serve` process that also handles the WS upgrade (transport research §8). **Neither research file identifies a first-party Godot server-side HTTP class.** `HTTPRequest`/`HTTPClient` are client-only; the only verified server-side primitive is `TCPServer` accepting raw connections, with `WebSocketPeer` exposing an `accept_stream()`-shaped promotion path referenced only in passing by the godot-systems research and not independently confirmed against 4.7 docs [uncertain/post-cutoff].

This is a real hole, not a rounding error — it sits directly on the critical path, because `scripts/hostSeat.ts` and the retiring TS MCP client (master §3.4) both expect `POST /api/rooms` to keep working against the new server. **Spike it before Stage 4 begins**, as an addition to master §11's five gates:

**R2.2 (Gate 6, new)** Before any task in §10 starts: prove a `TCPServer`-rooted accept loop can (a) accept a raw TCP connection, (b) read enough of the request to distinguish a WebSocket upgrade (an `Upgrade: websocket` header) from a bare HTTP request, (c) hand the former to `WebSocketPeer.accept_stream()` [uncertain/post-cutoff — confirm the exact method name and promotion contract against the installed 4.7.1 docs during this spike, not by assumption] and (d) hand-parse the latter as a fixed-shape `POST /api/rooms` — a first request line plus a `Content-Length: 0` body, needing no general HTTP parser, since this server exists to speak one wire, not to be a web server. Write a raw `HTTP/1.1 201 Created` response by hand (status line, `Content-Type: application/json`, `Content-Length`, the JSON body, `\r\n\r\n` framing) and close the connection — this endpoint takes no body and needs no keep-alive.

If the spike fails — if `WebSocketPeer` genuinely cannot be handed an already-accepted `TCPServer` stream in 4.7.1 — the fallback is to fold room creation into the WebSocket protocol itself as a new message type, which would mean the wire is *not* frozen (§3 breaks) and the retiring TS MCP client needs a compatibility shim. Do not discover this three tasks into §10; resolve it first.

---

## 3. The frozen wire (master §6.1)

The GDScript client and server SHALL speak the **exact** `ClientMessage`/`ServerMessage` union in `src/server/protocol.ts:46-102`, reproduced here in full so this document is a complete reference and not a pointer back into a TypeScript file a GDScript-only session may not open.

### 3.1 `ClientMessage` — the complete union (`protocol.ts:46-68`)

```ts
export type ClientMessage =
    | { type: 'CLAIM_SEAT'; matchId: MatchId; nickname: string }
    | { type: 'RESUME_SEAT'; matchId: MatchId; seatToken: SeatToken; nickname?: string }
    | { type: 'START_MATCH'; matchId: MatchId }
    | { type: 'ADD_BOT'; matchId: MatchId; seat: number; difficulty: BotDifficulty }
    | {
          type: 'PLAY_CARD';
          matchId: MatchId;
          cardInstanceId: CardInstanceId;
          target?: PlayerId;
          guess?: GuessValue;
          clientMsgId?: string;
      }
    | { type: 'END_MATCH'; matchId: MatchId }
    | { type: 'REQUEST_RESYNC'; matchId: MatchId }
    | { type: 'PING' };
```

### 3.2 `ServerMessage` — the complete union (`protocol.ts:70-102`)

```ts
export type ServerMessage =
    | {
          type: 'LOBBY_UPDATE';
          matchId: MatchId;
          hostSeat: PlayerId;
          canStart: boolean;
          seats: { seat: number; playerId: PlayerId | null; nickname: string | null; status: SeatStatus; difficulty: BotDifficulty | null }[];
      }
    | { type: 'SEAT_CLAIMED'; matchId: MatchId; seat: number; playerId: PlayerId; seatToken: SeatToken }
    | {
          type: 'STATE_UPDATE';
          view: RedactedView;
          nicknames: Record<PlayerId, string>;
          phase: 'active' | 'round_over' | 'ended';
          endReason?: 'won' | 'abandoned';
          winnerSeat?: PlayerId;
          paused: boolean;
          missingSeats: PlayerId[];
          revealDeadline?: number;
          serverTime: number;
      }
    | { type: 'MATCH_STARTED'; matchId: MatchId }
    | { type: 'MATCH_ENDED'; matchId: MatchId; reason: 'won' | 'abandoned'; winnerSeat?: PlayerId }
    | { type: 'ERROR'; code: ErrorCode; refId?: string }
    | { type: 'FATAL'; code: ErrorCode }
    | { type: 'PONG' };
```

`SeatStatus = 'open' | 'occupied' | 'disconnected' | 'computer'`. `BotDifficulty = 'novice' | 'adept' | 'master'`. `ErrorCode` is the thirteen literals at `protocol.ts:18-32` **plus** every `ValidationError['code']` from `src/game/engine` forwarded verbatim — a GDScript client needs doc 4's ported engine error-code list too, not just this file, to enumerate every code it might receive (confirmed example in the wild: `ROUND_NOT_IN_PROGRESS`, which appears only in `room.ts`, not in `protocol.ts`'s own local union).

**R3.1** Optional fields (`?`) SHALL be **omitted from the JSON entirely** when absent, never sent as `null`. Every dictionary-building GDScript function on both sides constructs its output by conditionally adding a key, never by adding a key with a `null` value — mirroring `room.ts:1160-1162`'s `...(condition ? {field} : {})` spread pattern. A GDScript client that checks `msg.has("revealDeadline")` rather than `msg.get("revealDeadline") != null` is the only form that agrees with the server either language sends.

### 3.3 The strict parser, ported

`parseClientMessage` (`protocol.ts:178-283`) never throws and enforces **exact keys** — an unexpected field fails the whole message as `MALFORMED`, not just the unexpected field. This is the security property doc 6's §2.4 spike must not compromise once room creation is folded into a hand-rolled HTTP response: **a lenient GDScript `JSON.parse_string` that shrugs at extra fields quietly widens the exact attack surface this strictness closes** (master §9). Port the structure, not just the behaviour:

```gdscript
# server/protocol.gd
const TARGET_CHARS := "1234"

static func has_exact_keys(obj: Dictionary, required: Array, optional: Array = []) -> bool:
    var allowed := {}
    for k in required: allowed[k] = true
    for k in optional: allowed[k] = true
    for k in required:
        if not obj.has(k):
            return false
    for k in obj.keys():
        if not allowed.has(k):
            return false
    return true

static func is_target(value) -> bool:
    return typeof(value) == TYPE_STRING and value.length() == 2 \
        and value[0] == "p" and TARGET_CHARS.find(value[1]) != -1

static func is_guess_value(value) -> bool:
    # The parentheses are load-bearing: GDScript's `and` binds tighter than
    # `or`, so `A or B and C` means `A or (B and C)`. Without them, a float 2.5
    # (TYPE_FLOAT) short-circuits true on the first disjunct and the range check
    # never runs — the exact 2.0-accepted/2.5-rejected boundary R3.3 mandates a
    # test for. Keep the grouping.
    return (typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT) \
        and int(value) == value and value >= 2 and value <= 8

static func is_card_instance_id(value) -> bool:
    # /^[a-z]+(-[a-z]+)*#\d+$/ — hand-rolled, no RegEx dependency needed for one shape.
    if typeof(value) != TYPE_STRING: return false
    var parts := value.split("#")
    if parts.size() != 2 or parts[1].is_empty(): return false
    for c in parts[1]:
        if not c.is_valid_int(): return false
    var slug_groups: PackedStringArray = parts[0].split("-")
    if slug_groups.is_empty(): return false
    for group in slug_groups:
        if group.is_empty(): return false
        for c in group:
            if c < "a" or c > "z": return false
    return true

static func parse_nickname(value, max_len: int):
    if typeof(value) != TYPE_STRING: return null
    var trimmed: String = value.strip_edges()
    if trimmed.is_empty() or trimmed.length() > max_len: return null
    for i in trimmed.length():
        var code := trimmed.unicode_at(i)
        if code <= 0x1f or code == 0x7f: return null
    return trimmed

static func parse_client_message(raw: String, max_nickname: int) -> Dictionary:
    var parsed = JSON.parse_string(raw)
    if typeof(parsed) != TYPE_DICTIONARY:
        return { "ok": false }
    if not parsed.has("type") or typeof(parsed["type"]) != TYPE_STRING:
        return { "ok": false }

    match parsed["type"]:
        "CLAIM_SEAT":
            if not has_exact_keys(parsed, ["type", "matchId", "nickname"]):
                return { "ok": false }
            if typeof(parsed["matchId"]) != TYPE_STRING:
                return { "ok": false }
            var nickname = parse_nickname(parsed["nickname"], max_nickname)
            if nickname == null:
                return { "ok": false }
            return { "ok": true, "msg": { "type": "CLAIM_SEAT", "matchId": parsed["matchId"], "nickname": nickname } }
        "PING":
            if not has_exact_keys(parsed, ["type"]):
                return { "ok": false }
            return { "ok": true, "msg": { "type": "PING" } }
        # RESUME_SEAT, START_MATCH, ADD_BOT, PLAY_CARD, END_MATCH, REQUEST_RESYNC
        # follow the identical shape, one case each, ported verbatim from
        # protocol.ts:203-278 — PLAY_CARD's is the widest (three optional keys,
        # each independently validated then independently included).
        _:
            return { "ok": false }
```

**R3.2** `JSON.parse_string` returning anything other than a `Dictionary` at the top level (an `Array`, a bare number, `null` on malformed input) SHALL be treated identically to a parse failure — matching `protocol.ts:186-188`'s `typeof parsed !== 'object' || Array.isArray(parsed)` check, which is there specifically so a top-level JSON array (`[...]`) does not pass `typeof === 'object'` and slip past the guard the way it would in a careless port.

**R3.3** `is_guess_value` mirrors `Number.isInteger` — a GDScript float arriving from `JSON.parse_string` as `2.0` must be accepted (JSON has no separate integer type, and every number decodes as a float in most JSON libraries); a `2.5` must be rejected. Write a test for `2.0`, `2.5`, `1`, `9`, `"2"` explicitly — this is the kind of boundary a hand-port silently gets wrong in either direction.

**R3.4 (redaction, master §6.2)** Port `FORBIDDEN_SUBSTRINGS` (`src/server/__tests__/integration.test.ts:71-78`) as a runtime guard on every outbound frame, not just a test fixture:

```gdscript
const FORBIDDEN_SUBSTRINGS := ["deckOrder", "setAsideFaceDown", "\"rng\"", "\"seed\"", "actionLog", "privateKnowledge", "tokenHash"]

static func assert_frame_is_clean(json_text: String) -> void:
    for needle in FORBIDDEN_SUBSTRINGS:
        assert(not json_text.contains(needle), "outbound frame leaked: " + needle)
```

Called on every `JSON.stringify()`'d outbound message before the socket sends it, in debug builds at minimum (a release build may compile this out for throughput, but Stage 4's own test suite must run every corpus match with it *on*). This is the compiler substitute master §6.2 names: GDScript's `Dictionary` gives no static guarantee a hand-assembled `STATE_UPDATE` payload didn't reach past `view()` into the raw `MatchState` the way TypeScript's `RedactedView` type does.

---

## 4. Seat identity

### 4.1 Minting [Crypto.generate_random_bytes verified — godot-systems research §8]

All three of `seatToken`, `matchId`, and the RNG `seed` are 128-bit CSPRNG hex strings from the same primitive (`seatTokens.ts:14-33`):

```gdscript
static func mint_hex128() -> String:
    var bytes := Crypto.new().generate_random_bytes(16)
    return bytes.hex_encode()
```

Kept as three separate call sites (`mint_token`, `mint_match_id`, `mint_seed`) even though they're the same function underneath, exactly as the TS side does — "because their sensitivity differs: a seatToken is handed to exactly one socket, a matchId is handed to every client, and a seed must never leave the server" (`seatTokens.ts:3-7`). **No secure-context caveat applies here** — this is the server process, not a browser page, and `Crypto.generate_random_bytes` has none of the `crypto.randomUUID` restrictions `src/client/store/ids.ts` exists to work around (§9.3).

### 4.2 Hashing and verification — the load-bearing gap the research did not close

Only `hashToken(token)` is ever persisted (`seatTokens.ts:36-38`, `persistence.ts:51`) — the raw token never touches disk. **Neither research file confirms a first-party GDScript SHA-256 primitive** [uncertain/post-cutoff]. Godot has historically exposed hashing through a `HashingContext` class (`start`/`update`/`finish`) and convenience `String`/`PackedByteArray` methods, but this was not independently verified against 4.7.1 in this research pass — confirm the exact API during Stage 4 Task 1 (§10) with a throwaway script before writing `seat_tokens.gd` against it, rather than assuming a signature.

`timingSafeEqual` (`seatTokens.ts:48-53`) has the same gap: no verified constant-time compare exists at the GDScript level. Do not substitute `==` on two `PackedByteArray`s or two hex `String`s and call it done — a short-circuiting equality check leaks a timing signal proportional to the matching prefix length, which is exactly what `timingSafeEqual` exists to prevent. Implement the comparison by hand, accumulating over the full length regardless of an early mismatch:

```gdscript
static func token_matches(presented: String, stored_hash: String) -> bool:
    var presented_hash := sha256_hex(presented)  # confirm sha256_hex's own primitive per the note above
    if presented_hash.length() != stored_hash.length():
        return false
    var diff := 0
    for i in presented_hash.length():
        diff |= presented_hash.unicode_at(i) ^ stored_hash.unicode_at(i)
    return diff == 0
```

**R4.1** `token_matches` SHALL always compare the full length of both hashes — the `for` loop above has no early return — even after `diff` has already gone non-zero, mirroring why `tokenMatches` hashes the presented value *before* any comparison rather than comparing raw tokens: the length check on hex-encoded, fixed-width SHA-256 output means the loop body never executes for a length mismatch, but once it starts, it finishes.

### 4.3 The host race (`seatTokens.ts`, `room.ts:291-319`)

`Room.create` mints the host's seat (index 0, `p1`) and its token **before any join link exists**. That raw token is returned in the `POST /api/rooms` HTTP `201` body — never over the WebSocket — and is the *only* seat token that ever crosses HTTP rather than `SEAT_CLAIMED`:

```json
{ "matchId": "<hex128>", "joinUrl": "<publicBaseUrl>/join/<matchId>", "hostSeat": "p1", "hostSeatToken": "<hex128>" }
```

**R4.2** The GDScript server's `POST /api/rooms` handler (§2.4) SHALL mint and hash the host token synchronously, inside the same request that creates the room record, before the response line is written — there is no join link, hence no possibility of a second party racing to claim seat 0, by construction rather than by locking.

Every other seat's token is minted inside `claim_seat`, sent exactly once inside `SEAT_CLAIMED`, and never repeated. `claim_seat` refuses `ROOM_FULL` once `phase == 'active'` or no seat has `token_hash == null`, and `MATCH_OVER` once `phase == 'ended'` (`room.ts:413-446`).

---

## 5. Room state machine

Phase: `lobby | active | ended` (`persistence.ts:41`).

### 5.1 Lobby → active

`start_match` refuses `CANNOT_START` unless `phase == 'lobby'` and `can_start()`; refuses `NOT_HOST` unless the caller's connection equals seat 0's bound connection (`room.ts:566-593`):

```gdscript
func can_start() -> bool:
    var claimed := seats.filter(func(s): return s.token_hash != null)
    if claimed.size() < 2 or claimed.size() > 4:
        return false
    for s in claimed:
        if s.conn == null and not s.bot:
            return false
    return true
```

On success: `player_ids` = claimed seats in index order; a fresh `seed` is minted (§4.1); `match = create_match(player_ids, seed, match_id)` (doc 4's ported constructor); `phase = 'active'`; persist (§7); broadcast `MATCH_STARTED`; push `STATE_UPDATE` to every connected seat; `schedule_bot_turn()`.

### 5.2 `commit_match_state` — the round/match transition, in the order that matters

Called after every successful `reduce()`, human or bot (`room.ts:1107-1126`):

```gdscript
func commit_match_state(state: Dictionary) -> void:
    match_state = state
    # Match-over checked BEFORE round-over — so an ordinary win can never arm a
    # timer that later fires into a decided match (room.ts:1099-1105).
    if is_match_over(state):
        transition_to_ended("won", state["matchWinnerId"])
    elif state["round"]["phase"] == "round-over":
        arm_reveal_timer()
    persist()
    push_state_to_connected_seats()
    if phase == "ended":
        broadcast_match_ended("won")
    schedule_bot_turn()
```

**R5.1** The `is_match_over` check SHALL run before the `round.phase == 'round-over'` check, never the reverse — this is the one-line invariant `room.ts:1099-1105`'s comment exists to protect, and getting it backwards produces a reveal timer that fires ten seconds into an already-decided match.

### 5.3 `arm_reveal_timer` / `advance_round`

```gdscript
func arm_reveal_timer() -> void:
    clear_reveal_timer()
    reveal_deadline = now_ms() + config.reveal_window_ms  # 10_000, fixed by design
    reveal_timer = get_tree().create_timer(config.reveal_window_ms / 1000.0)
    reveal_timer.timeout.connect(func(): enqueue(advance_round))
```

`advance_round` re-checks every precondition (active phase, `round-over`, not already match-over, not paused) before calling doc 4's `start_next_round(match)`, clears the timer, persists, pushes state, reschedules any bot turn — wrapped in a re-entrancy guard released even on early return (`room.ts:1037-1060`). **`now_ms()`/timer primitives are ordinary Godot scripting (`Time`, `SceneTreeTimer`) and were not independently re-verified against 4.7.1 in the research pass** [uncertain/post-cutoff, low-risk] — confirm signature during Stage 2's skeleton work, not here.

Every timer callback is re-entered through the room's own serialized `enqueue`, exactly like a client message (`room.ts:227` design reference) — **R5.2**: no timer callback (`reveal_timer`, `bot_timer`) SHALL mutate room state directly; every one SHALL go through `enqueue()`, so a reveal-timer fire and an in-flight `PLAY_CARD` can never interleave.

### 5.4 `ADD_BOT` and bot turn scheduling

`add_bot` (`room.ts:607-633`): host-only, lobby-only, target seat must be open. Mints+hashes a token like a human seat but never sends it; nickname from a fixed four-name list (`BOT_NICKNAMES`) or `Computer ${n}` fallback; `bot = true`; persists; broadcasts `LOBBY_UPDATE`. A bot seat counts as claimed for `can_start` and never ages out via the reaper (§7.3 explicitly skips bot seats).

```gdscript
func schedule_bot_turn() -> void:
    clear_bot_timer()
    if phase != "active" or match_state == null or paused:
        return
    if match_state["round"]["phase"] != "awaiting-play" or is_match_over(match_state):
        return
    var current_id = match_state["round"]["seatOrder"][match_state["round"]["currentPlayerIndex"]]
    var seat := find_seat_by_player_id(current_id)
    if seat == null or not seat.bot:
        return
    bot_timer = get_tree().create_timer(config.bot_think_ms / 1000.0)  # 1_200ms — pacing, not compute
    bot_timer.timeout.connect(func(): enqueue(func(): play_bot_turn(seat)))
```

`play_bot_turn` (`room.ts:985-1016`) re-checks every precondition (the world may have moved while queued), builds the bot's own `RedactedView` via doc 4's `view()`, asks doc 5's `choose_bot_play(view, difficulty)`. **R5.3** — the engine's own **stall-breaker**, ported from `firstLegalPlay` (`room.ts:172-181`), is the fallback when the AI's proposed move is refused by `reduce()`:

```gdscript
static func first_legal_play(view: Dictionary) -> Variant:
    var card_instance_id = view["own"]["legalPlays"][0] if view["own"]["legalPlays"].size() > 0 else null
    if card_instance_id == null:
        return null
    var targets: Array = view["own"]["legalTargets"].get(card_instance_id, [])
    if targets.is_empty():
        return { "cardInstanceId": card_instance_id }
    var is_informant := card_catalog_value(card_type_of(card_instance_id)) == INFORMANT_VALUE
    var play := { "cardInstanceId": card_instance_id, "target": targets[0] }
    if is_informant:
        play["guess"] = 2
    return play
```

A refused AI proposal logs an error (a policy that restates a rule is a bug worth shouting about) but never freezes the table — the fallback always plays *something* if one legal play exists.

### 5.5 `PLAY_CARD` — identity from the connection, never a payload field

```gdscript
func play_card(conn: Variant, msg: Dictionary) -> void:
    var seat := find_seat_by_conn(conn)
    if seat == null:
        send_error(conn, "NOT_YOUR_SEAT"); return
    if phase == "lobby":
        send_error(conn, "ROUND_NOT_IN_PROGRESS"); return
    if phase == "ended":
        send_error(conn, "MATCH_OVER"); return
    if paused:
        send_error(conn, "PAUSED"); return  # checked before reduce() and before actionLog is touched
    var action := { "type": "PLAY_CARD", "playerId": seat.player_id, "cardInstanceId": msg["cardInstanceId"] }
    if msg.has("target"): action["target"] = msg["target"]
    if msg.has("guess"): action["guess"] = msg["guess"]
    var result := reduce(match_state, action)
    if not result["ok"]:
        send_error_ref(conn, result["error"]["code"], msg.get("clientMsgId"))
        return
    commit_match_state(result["state"])
```

**R5.4** The acting seat SHALL come from `find_seat_by_conn(conn)` alone — never from a `playerId` field on the incoming message, because `PLAY_CARD` carries none (`protocol.ts` union, §3.1). A client cannot spoof a turn it does not hold because there is no field to spoof; this is the same property `changing-the-wire` documents for the TS server and it ports unchanged only if no GDScript task ever adds one "for convenience" to make testing easier.

**R5.5** `paused` SHALL be checked before `reduce()` runs, so a play attempted mid-pause never reaches the `actionLog` — matching `room.ts:640-686`'s ordering exactly. Reordering this after `reduce()` would let a paused table's stray message advance the persisted log while the client believes nothing happened.

---

## 6. `RESUME_SEAT` reconnection ordering (master §9)

This is the transport behaviour with the least corpus backing and the most subtle failure mode: get the order wrong and a reconnect shows a stale countdown, or lets a bot move into a screen the reconnecting human has not yet been sent. Port the five steps in this exact order (`room.ts:460-526`):

1. **Hash lookup across every seat**, not just the presenting connection's last-known seat: `seats.find(s => s.token_hash != null and token_matches(token, s.token_hash))`. No match → `sendFatal(conn, "BAD_TOKEN")`, close, return — every unresolvable token (wrong, empty, belonging to another room) gets the identical code.
2. **The host's one nickname chance**: if `nickname` is present, the seat currently has none, and `phase == 'lobby'` — adopt it and persist. Never a rename once set; never mid-match; this is the seat token's *only* write access to identity, deliberately, so the token itself never becomes an impersonation primitive.
3. **Eviction**: if the seat already has a live, *different* connection bound, send that old connection `FATAL{SEAT_TAKEN}` and close it — synchronously, before the new connection is bound. No persist needed for the rebind itself (`conn`/`disconnected_at` are transport-only, never part of the persisted `StoredSeat`).
4. **Rebind**: `seat.conn = conn; seat.disconnected_at = null`.
5. **Phase-dependent send, ordered exactly**:
   - **Lobby**: broadcast `LOBBY_UPDATE` to everyone. Done.
   - **Active/ended**, where the ordering obligation actually lives:
     ```gdscript
     var was_paused := paused
     # (rebind happened in step 4, above)
     var now_unpaused := was_paused and not paused

     # Re-arm the reveal timer BEFORE building any STATE_UPDATE — so THIS
     # seat's own repaint already carries the fresh revealDeadline, never a
     # deadline computed before this resume cleared the pause.
     if phase == "active" and now_unpaused and match_state != null \
             and match_state["round"]["phase"] == "round-over" and not is_match_over(match_state):
         arm_reveal_timer()

     if match_state != null:
         send(conn, build_state_update(seat))   # this seat sees its own position first

     if now_unpaused:
         push_state_to_connected_seats(seat)    # everyone else's "waiting for…" clears together
         schedule_bot_turn()                    # bots resume LAST — only after a human has seen the position
     ```

**R6.1** The reveal timer SHALL be re-armed before the resuming seat's own `STATE_UPDATE` is built, never after — reversing this sends a `revealDeadline` computed from a moment before the pause cleared, which reads to the reconnecting player as a countdown that was already running while their screen was blank.

**R6.2** `schedule_bot_turn()` SHALL be the last call in the active/ended branch, strictly after both `send(conn, …)` and `push_state_to_connected_seats(seat)` — a bot moving before the reconnecting human's client has painted the position it's reconnecting into is the specific bug this ordering exists to prevent (master §9).

**R6.3** `paused` is derived, not stored: it is `true` whenever any claimed, non-bot seat has no live connection. Recompute it from the seat list rather than maintaining a separate boolean that could drift from the seats it's supposed to summarize.

---

## 7. Persistence = replay (master §9), and zero-dependency

### 7.1 What gets stored: `{seed, actionLog}`, never a state snapshot

`persistence.ts:4-6`: "Storing `{seed, actionLog}` rather than a serialized `MatchState` keeps the storage schema independent of the engine's internal shape: a future field on `MatchState` needs no migration, only `reduce()` behaving as its own test suite already pins down." This reasoning transfers unchanged — arguably strengthened, since GDScript's `Dictionary` gives no compile-time schema at all to migrate.

```gdscript
# server/match_record.gd — shape only; see persistence.ts:64-78
# {
#   "matchId": String, "seed": String|null, "hostSeat": String,
#   "phase": String, "endReason": String|null, "winnerSeat": String|null,
#   "seats": Array[StoredSeat],       # {index, playerId, nickname, tokenHash, bot?, botDifficulty?} — hash only
#   "actionLog": Array[PlayCardAction],  # PLAY_CARD actions ONLY — round boundaries are never logged
#   "quarantined": bool, "createdAt": int, "updatedAt": int
# }
```

### 7.2 `replayMatch`, ported (`persistence.ts:230-249`)

```gdscript
static func replay_match(player_ids: Array, seed: String, match_id: String, action_log: Array) -> Variant:
    var state = create_match(player_ids, seed, match_id)   # doc 4
    for action in action_log:
        if state["round"]["phase"] == "round-over":
            if is_match_over(state):
                return null   # corrupt: actions logged past a decided match
            state = start_next_round(state)
        var result = reduce(state, action)
        if not result["ok"]:
            return null   # corrupt log
        state = result["state"]
    return state
```

**R7.1** `action_log` SHALL record `PLAY_CARD` actions only — round boundaries are re-derived by calling `start_next_round` whenever replay observes `round.phase == 'round-over'`, never logged as their own entries. This is what makes replay deterministic from the log alone: doc 2's RNG proof is what makes `start_next_round`'s re-derivation match the original round's deal exactly, which is why doc 6 explicitly inherits doc 2's determinism obligation (master §9) — **a GDScript engine that shuffles differently makes every persisted match unrecoverable**, and the failure surfaces three weeks later as "reconnect shows me the wrong hand," not as a test failure today.

**R7.2** `save()` SHALL run, in the same serialized room-queue step, **before** any broadcast — matching `persistence.ts:11-14`'s "a crash between acceptance and notification can only lose a broadcast, never create a divergence between the log and what players saw." `commit_match_state` (§5.2) already orders `persist()` before `push_state_to_connected_seats()`; do not reorder these for any reason, including "it's just a log flush."

### 7.3 Storage: `FileAccess` + `JSON`, not `godot-sqlite`

[verified — godot-systems research §7] `FileAccess` and `JSON` are both engine built-ins, needing no extension. The idiomatic zero-dependency mapping of the existing `bun:sqlite` table is **one JSON file per `matchId`**, under a configurable root (the `MULES_DB_PATH`-equivalent, §8.2):

```gdscript
static func save_record(root: String, record: Dictionary) -> void:
    var path := root.path_join(record["matchId"] + ".json")
    var f := FileAccess.open(path, FileAccess.WRITE)
    if f == null:
        push_error("save_record: could not open %s (err %s)" % [path, FileAccess.get_open_error()])
        return
    f.store_string(JSON.stringify(record))
    f.close()

static func load_record(root: String, match_id: String) -> Variant:
    var path := root.path_join(match_id + ".json")
    if not FileAccess.file_exists(path):
        return null
    var f := FileAccess.open(path, FileAccess.READ)
    var parsed = JSON.parse_string(f.get_as_text())
    f.close()
    return parsed if typeof(parsed) == TYPE_DICTIONARY else null   # a parse failure self-quarantines, like MatchStore.load()
```

**R7.3 (zero-dependency law)** `godot-sqlite` — a GDExtension wrapper requiring a compiled native binary shipped alongside the game [verified, same research] — is **not** an acceptable default. `bun:sqlite` was zero-dependency-compliant on the TS side only because it is a *Bun builtin*, not an added package; Godot has no equivalent builtin SQL store, and reaching for `godot-sqlite` to imitate the schema would violate the project law this repository states explicitly (AGENTS.md, "no runtime dependencies at all"). If a future load profile genuinely needs SQL query patterns the flat-file store cannot give cheaply, that is a deviation requiring the owner's explicit sign-off — not a default anyone should reach for while porting `persistence.ts`.

**R7.4** `listIds()`'s one privileged caller — the reaper, which must see *quarantined* rows too so it can eventually delete them — SHALL be reproduced as a directory scan (`DirAccess.open(root).get_files()`) filtered to `.json`, kept separate from `load_record`'s self-quarantining read path, exactly as `persistence.ts` keeps `listIds()` separate from `load()`.

---

## 8. Rate limiting, config, dispatch pipeline, dedicated server

### 8.1 Rate limiting — two independent, dependency-free primitives (`rateLimiter.ts`)

```gdscript
class TokenBucket:
    var capacity: float
    var refill_per_sec: float
    var tokens: float
    var last_refill_ms: int

    func _init(cap: float, refill: float, now_ms: int) -> void:
        capacity = cap; refill_per_sec = refill
        tokens = cap; last_refill_ms = now_ms

    func take(now_ms: int) -> bool:
        var elapsed_sec := (now_ms - last_refill_ms) / 1000.0
        tokens = min(capacity, tokens + elapsed_sec * refill_per_sec)
        last_refill_ms = now_ms
        if tokens < 1.0:
            return false
        tokens -= 1.0
        return true
```

Constructed per-connection as `TokenBucket.new(10, 5, now)` — **burst 10, refill 5/sec** (`config.ts:54-55`); every message type spends a token, `PING` included (`dispatch.ts` step 4). `IpLimiter` is a fixed 60-second window keyed by IP, capacity 30/minute, applied at the two load-generating surfaces: new socket accepts and `POST /api/rooms` — port `rateLimiter.ts`'s `Dictionary<ip, {windowStart, count}>` shape directly; a GDScript `Dictionary` keyed by `String` IP is the natural equivalent of the TS `Map`.

**R8.1** `now` SHALL be an injected parameter on every rate-limiting call in the test build, never a bare `Time.get_ticks_msec()` read from inside the class — matching `rateLimiter.ts`'s own injected-`now` discipline, which is what lets its tests assert exact refill curves without sleeping. `[uncertain/post-cutoff: Time.get_ticks_msec's exact semantics were not independently verified in the research pass — confirm during Stage 2's skeleton work, low risk given it is a monotonic millisecond counter by design intent]`

### 8.2 Config: env vars, the `--port` flag, layering (`config.ts`)

| Field | Default | Env var |
|---|---|---|
| `port` | 3000 | `MULES_PORT` |
| `public_base_url` | `http://localhost:3000` | `MULES_PUBLIC_BASE_URL` |
| `db_path` (root for §7.3's JSON files) | `mules-court-data` | `MULES_DB_PATH` |
| `static_root` | `null` (native client needs none) | `MULES_STATIC_ROOT` |
| `reveal_window_ms` | 10 000 | — (design constant) |
| `bot_think_ms` | 1 200 | — |
| `lobby_disconnect_grace_ms` | 60 000 | — |
| `lobby_ttl_ms` | 900 000 | — |
| `active_grace_ms` | 120 000 | — |
| `zero_conn_ttl_ms` | 600 000 | — |
| `retention_ms` | 3 600 000 | — |
| `sweep_interval_ms` | 60 000 | — |
| `message_burst` / `message_refill_per_sec` | 10 / 5 | — |
| `ip_connections_per_minute` | 30 | — |
| `max_nickname_length` | 24 | — |

`OS.get_environment("MULES_PORT")` reads the env var; `OS.get_cmdline_user_args()` reads flags after `--` (the dedicated-server research's own documented pattern for custom flags, §8.4 below) — `[uncertain/post-cutoff: neither call's exact signature was independently re-verified against 4.7.1 in this research pass; both are described in the research only in the context of feature-tag/headless detection, not port-flag parsing specifically — confirm during Stage 2]`.

**R8.2** `--port` SHALL remain the only accepted flag, and an unrecognized argument SHALL exit non-zero with a usage message — porting `config.ts:144-167`'s "a bad flag is a typo, not a crash, but silent-ignore was the exact failure being fixed" reasoning unchanged. A GDScript port that silently ignores `--prot=5000` reintroduces the identical bug the TS `USAGE` string exists to prevent.

**R8.3** Layering SHALL be environment first, then the CLI flag on top — a *named* `MULES_PUBLIC_BASE_URL` always outranks a URL *derived* from a `--port` flag, because a reverse proxy or domain is a deployment fact that moving the listen port does not invalidate (`config.ts:169-196`).

### 8.3 The dispatch pipeline — the eleven steps, restated for GDScript

Port `dispatch.ts:90-192`'s exact ordering, because the ordering *is* the security property, not an implementation detail:

1. **Frame size** — enforced by whatever accept-loop limit §2.4's spike settles on (the Bun equivalent is `maxPayloadLength: 4096`); a message dispatch function is never even called for an oversized frame.
2–3. **Parse + shape** — `parse_client_message` (§3.3). Failure → `ERROR{MALFORMED}`.
4. **Rate limit** — `bucket.take(now)`. Failure → `ERROR{RATE_LIMITED}`. `PING` is answered `PONG` right here, needing no seat and no room.
5. **Identity** — `PLAY_CARD`/`START_MATCH`/`ADD_BOT`/`END_MATCH`/`REQUEST_RESYNC` require `state.seat != null and msg.matchId == state.matchId`. Failure → `ERROR{NOT_YOUR_SEAT}`.
6. **Canonical pointer** — deliberately **not** checked here; `Room`'s own conn-keyed seat lookup inside `play_card`/`end_match`/`resync` already answers `NOT_YOUR_SEAT` for an evicted connection. Do not duplicate this check in the pipeline — the TS design's comment at `dispatch.ts:19-24` explains why duplicating it is a maintenance liability, not a safety improvement.
7. **One seat per connection** — `CLAIM_SEAT`/`RESUME_SEAT` with `state.seat != null` already → `ERROR{ALREADY_SEATED}`.
8. **Room lookup** — a registry miss (never-existed, expired, quarantined — all indistinguishable to the client) → `ERROR{ROOM_NOT_FOUND}`, uniformly.
9. **Host gate (simple form)** — `START_MATCH`/`ADD_BOT` with `state.seat != "p1"` → `ERROR{NOT_HOST}`. `END_MATCH`'s richer host-or-grace rule lives entirely inside `Room.end_match`, not here.
10–11. **Execute** — routed through `room.enqueue()`, wrapped in a `try`/error-signal-equivalent: any unexpected failure is logged and answered `ERROR{INTERNAL}` rather than propagating.

**R8.4** `dispatch_message` SHALL never leave a caller waiting indefinitely or crash the connection's own message loop on an internal error — the GDScript equivalent of "never rejects" is that every code path through this function ends in either a sent `ServerMessage` or a deliberate no-op (the `PING`-adjacent early returns), never a silent drop.

### 8.4 `--headless` and the dedicated-server export [verified — godot-systems research §3]

`--headless` forces a dummy display/audio driver on any Godot 4.x binary — no separate server build target is required. The **Dedicated Server** export preset mode goes further: it auto-forces `--headless` at runtime and sets `OS.has_feature("dedicated_server")`, and lets per-file resource stripping shrink the export.

```gdscript
func _ready() -> void:
    if OS.has_feature("dedicated_server"):
        _boot_as_server()
    else:
        _boot_as_client()
```

This is the one-project, two-artifacts shape master §3.1 draws: a single Godot 4.7.1 project exports both a playable client and `mules-court-server` from the same source tree, mirroring how `bun run compile` and `bun run serve` share `src/server/` today.

---

## 9. The client socket half

`src/client/store/socket.ts` (247 lines) is the reconnect/backoff/resume-seat state machine — the concept survives verbatim; only the socket primitive underneath changes.

### 9.1 The state machine, ported to an autoload

The TS module's own discipline is worth preserving exactly: **every ambient dependency is injected** (the socket constructor, timers, the jitter source) so the backoff schedule can be asserted rather than waited on in tests (`socket.ts:4-7`). Port that as a GDScript class taking its `Timers`-equivalent and RNG source as constructor arguments, not as an autoload reaching for global state internally — an autoload can still *own* one instance built with real dependencies, while the class itself stays testable.

```gdscript
# client/socket.gd
const BASE_DELAY_MS := 500     # long enough to ride out a server restart
const MAX_DELAY_MS := 8000     # past this a player has noticed the dot and will refresh
const JITTER_SPREAD := 0.5     # +-25%, so a room dropped by one restart doesn't return in lockstep

var _attempt := 0
var _stopped := false          # set by close(); a FATAL must stop retrying (SEAT_TAKEN's eviction
                                # loop is the failure mode this guards — two tabs evicting each other forever)

func _jittered(base: float, rand_source: Callable) -> int:
    return int(round(base * (1.0 - JITTER_SPREAD / 2.0 + rand_source.call() * JITTER_SPREAD)))

func _handshake() -> Variant:
    var seat := stored_seat.call()
    if seat == null:
        return null
    var msg := { "type": "RESUME_SEAT", "matchId": match_id, "seatToken": seat["seatToken"] }
    var nick := sendable_nickname.call()
    if nick != null:
        msg["nickname"] = nick
    return msg
```

**R9.1** `close()` (deliberate teardown) and a `FATAL`-driven stop SHALL be distinguishable in the ported state machine exactly as `stopped` distinguishes them in TS — `stopped = true` blocks auto-reconnect, but a later deliberate "take over here" action must still be able to call `connect()` again. Collapsing these into one permanent flag reintroduces the eviction-loop bug the TS comment at `socket.ts:151-158` names directly.

**R9.2** `onerror` SHALL remain a no-op that defers to `onclose` for the retry decision — browsers (and Godot's own `WebSocketPeer` state transitions) can surface both an error and a close for one drop; scheduling a retry from both would double-schedule. Godot's `poll()`-driven state diff (§2.2) naturally collapses this to one transition per drop, but a port that adds an explicit error signal handler must not also schedule a retry from it.

### 9.3 What evaporates, and why it evaporates rather than ports

- **`ids.ts`** — exists solely because `crypto.randomUUID` is secure-context-only in a browser (AGENTS.md's phone-testing section). `Crypto.generate_random_bytes` (§4.1) has no such restriction; the entire fallback-minter module has nothing to port.
- **`clipboard.ts`** — exists solely because `navigator.clipboard` is secure-context-only and needs a synchronous-during-gesture `execCommand` fallback for a non-secure LAN/phone context. `DisplayServer.clipboard_set(text)` [verified — godot-systems research §8] has neither restriction; the invite-link "Copy" button collapses to one call, no fallback path, no gesture-timing constraint.

Both are the same shape of regression-that-isn't: a browser-specific workaround the native client simply has no need for, because the constraint it worked around (a secure-context requirement) is a browser API surface, not a fact about copying text or generating random bytes.

---

## 10. Task sequence (Stage 4)

Sequenced so the pieces with no dependency on a live room (parsing, tokens, rate limiting) land first, and the ordering-sensitive pieces (RESUME_SEAT, persistence-as-replay) land once there's a room to test them against. Each task: write the failing GDScript test first (GUT or gdUnit4 per doc 9's gate 4 decision), run it red, implement, run it green, commit via the gitbutler skill.

- **Task 0 — §2.4's spike.** Prove the `TCPServer` accept loop can serve both a bare `POST /api/rooms` and a WebSocket upgrade on one port. This is not deferrable; every later task assumes it works. If it fails, stop and resolve the fallback (§2.4) before continuing.
- **Task 1 — `seat_tokens.gd`.** Confirm the SHA-256 primitive (§4.2's flagged gap) with a throwaway script, then implement `mint_hex128`, `hash_token`, `token_matches` (constant-time, R4.1). Tests: known-vector hash, equal-length mismatch, unequal-length mismatch, self-consistency (`token_matches(t, hash_token(t))` is always true).
- **Task 2 — `protocol.gd`'s shape guards.** `has_exact_keys`, `is_target`, `is_guess_value` (R3.3's `2.0`/`2.5` boundary), `is_card_instance_id`, `parse_nickname` (control-char rejection). Each gets its own test before `parse_client_message` exists to call it.
- **Task 3 — `parse_client_message`, all eight `ClientMessage` cases.** One test per case: the happy path, one missing-required-key failure, one extra-key failure (R3.1's exact-keys property), and — for `PLAY_CARD` and `RESUME_SEAT` — one test per optional field proving its *absence* omits the key rather than nulling it.
- **Task 4 — `assert_frame_is_clean` (R3.4).** Seven tests, one per forbidden substring, each asserting the guard fires on a deliberately-leaky fixture string.
- **Task 5 — `rate_limiter.gd`.** `TokenBucket` (burst/refill curve, injected `now`) and `IpLimiter` (window boundary, prune). Port `rateLimiter.ts`'s own test cases directly — they're pure arithmetic against an injected clock, the most 1:1-portable file in the whole subsystem.
- **Task 6 — `config.gd`.** `parse_port`'s range check, `parse_flags`'s unrecognized-argument failure (R8.2), `env_overrides`, `deployment_overrides`'s layering (R8.3). Test the port/URL-derivation interaction explicitly: `MULES_PORT` alone derives a URL; `MULES_PUBLIC_BASE_URL` alone overrides it; both together, the named URL wins.
- **Task 7 — `persistence.gd`'s file store (§7.3).** `save_record`/`load_record` round-trip; a corrupt JSON file self-quarantines rather than crashing the load; `list_ids` sees quarantined rows, `load_record` does not (R7.4).
- **Task 8 — `replay_match` (§7.2, R7.1).** Requires doc 4's `reduce`/`create_match`/`start_next_round` to exist and be corpus-green already (the Stage 3 gate this whole document opens by citing). Test: replaying a corpus match's `actionLog` from its `seed` reproduces the corpus's own final state exactly — this is where doc 2 and doc 4's determinism proofs get their first transport-level exercise.
- **Task 9 — `room.gd`'s skeleton: create, claim_seat, resume_seat (lobby only).** Host-race test (R4.2): two simulated `CLAIM_SEAT` attempts racing for seat 0 are structurally impossible to write, because seat 0 was never open — assert this by construction (seat 0's `token_hash` is non-null immediately after `create`), not by a race-timing test that could flake.
- **Task 10 — `start_match`, `commit_match_state`, `arm_reveal_timer`, `advance_round` (R5.1, R5.2).** Drive one full corpus match (doc 3) through the room layer end-to-end and assert every `STATE_UPDATE` frame matches the corpus's recorded per-seat views — this is the point where doc 3's corpus starts proving the *transport*, not just the engine.
- **Task 11 — `add_bot`, `schedule_bot_turn`, `play_bot_turn`, `first_legal_play` fallback (R5.3).** Requires doc 5's `choose_bot_play`. Test the fallback path explicitly by injecting a bot policy stub that always proposes an illegal move, and asserting `first_legal_play` recovers the table rather than freezing it.
- **Task 12 — `resume_seat`'s active/ended branch, the full five-step order (§6, R6.1–R6.3).** The highest-value test in this document: simulate a pause (drop a non-bot seat mid-round-over), assert no `STATE_UPDATE` reaches anyone, then resume, and assert in order — the resuming seat's own frame carries the fresh `revealDeadline`, then everyone else's frame, then (only then) a bot's turn fires if it was a bot's turn.
- **Task 13 — the reaper (`sweep`, per-config TTLs, R7.4's `list_ids`).** Port `roomRegistry.ts`'s live-room `sweep()` and cold-record `sweepCold` TTL math with an injected clock; no `sleep` anywhere in this test file, matching the TS suite's own discipline.
- **Task 14 — the client socket autoload (§9), against a real GDScript server from Tasks 0–13.** Reconnect-with-backoff, `RESUME_SEAT` handshake on reopen, the `stopped` vs. deliberate-close distinction (R9.1).
- **Task 15 — the master-plan Stage-4 done-condition itself:** two Godot client instances and one unmodified TS MCP seat (master §3.4 — no porting needed) sit at one table created via Task 0's HTTP path; the server cannot distinguish which client is which; a mid-match server restart recovers by replay (Task 8) with every connected seat reconnecting cleanly through Task 12's ordering.

---

## Definition of done for Stage 4

- Every task in §10 is green under a headless GUT/gdUnit4 run (doc 9 §3's decision), with no `sleep` in any test — every clock is injected.
- The full conformance corpus (doc 3) replays through `room.gd` end-to-end (Task 10), not just through the bare engine (Stage 3) — proving the *transport* agrees with the recorded per-seat `STATE_UPDATE` frames, not only that `reduce()` does.
- `assert_frame_is_clean` (R3.4) runs against every corpus match's full frame sequence with zero hits.
- Two Godot clients and one unmodified TS MCP seat sit at one table; the server cannot tell which client is which (Task 15) — this is master §14's own v1.0 criterion, satisfied here rather than deferred to doc 7.
- A mid-match server restart recovers by replay with no divergence — kill the process between two `PLAY_CARD` messages in a running test match and assert the rebuilt room's state equals what it would have been without the restart.
- §1's fork decision is recorded in this file's Status line, made by the owner, not inferred from whichever half got built first.

**Only when this is green does doc 7 (the client UI) begin** building against a server it can actually trust to hold a room together across a reconnect — which is the whole reason master §7's stage table gates Stage 5 behind this one.
