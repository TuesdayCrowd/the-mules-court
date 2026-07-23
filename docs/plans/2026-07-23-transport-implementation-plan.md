# Transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Every task follows red → green → commit. Never write implementation before its failing test.

**Goal:** Build the WebSocket server that wraps the finished game engine, matching `docs/plans/2026-07-22-transport-design.md`.

**Architecture:** One Bun process. `Bun.serve` handles one HTTP route (`POST /api/rooms`) and upgrades everything else to WebSockets. A `Room` owns a `MatchState`, a four-slot seat table, and a promise-chain serialization queue; a registry maps `matchId → Room` and runs the reaper. Every gameplay push is a per-seat unicast built from `view()`. Persistence is `{seed, actionLog}` in `bun:sqlite`, replayed through `reduce()` on recovery.

**Tech Stack:** Bun 1.3 (`Bun.serve`, `bun:sqlite`, `bun test`), TypeScript 5.7 strict. No new runtime dependencies.

**Design reference:** `docs/plans/2026-07-22-transport-design.md`, cited below as *Design §N*. Read a section before implementing against it. The engine surface is `src/game/engine/index.ts` — import **only** from that barrel.

---

## Conventions (read before Task 1)

| Rule | Detail |
| --- | --- |
| Imports | Extensionless relative paths; engine access via `../game/engine` barrel only |
| Indent | 4 spaces, matching existing source |
| Test runner | **Server tests run under `bun test`, not Vitest.** Import `{ describe, it, expect }` from `'bun:test'` |
| Engine tests | Untouched, still Vitest. `bun run test` runs both suites |
| Typecheck | `bunx tsc --noEmit` before every commit — Vite never type-checks |
| Commits | **GitButler only.** `but diff` for IDs, then `but commit server/transport -m "…" --changes <ids>`. Never `git commit`. The branch `server/transport` already exists; there is no `but mark` in this CLI — always pass `--changes` explicitly |
| Randomness & time | Allowed here (unlike the engine): `node:crypto` randomness, `Date.now()`, `setTimeout`. The engine purity guard only scans `src/game/engine/` and stays green |
| Secrets | Raw seat tokens exist only in a `SEAT_CLAIMED` / room-creation response. Persist and compare **hashes** only. The seed and `actionLog` never appear in any server→client message |

**Why two test runners.** Vitest executes test workers under **Node** (its banner says `node-v26.5.0`), and Node cannot load `bun:sqlite` or see the `Bun` global — verified empirically before this plan was written: `bun test` runs `Bun.serve` websockets + `bun:sqlite` cleanly; `import('bun:sqlite')` under Node fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. *Design §12* says "Vitest, as with the engine"; that assumption does not survive the Bun-native APIs the design itself mandates. The design's real requirement — a real server on an ephemeral port, real WebSocket clients, no mocks — is preserved unchanged under `bun test`.

**Two deliberate deviations from the design letter, both documented here:**

1. **Broadcasts are loops, not `ws.publish()`.** *Design §2* allows Bun's pub/sub for the three viewer-invariant messages. We instead send every message — broadcast or unicast — through one explicit per-seat loop over `SeatConnection`s. Identical bytes still reach every seat; `Room` stays socket-agnostic and directly testable without a running server; and there is no topic that could ever accidentally carry a view. Strictly safer than the design, never weaker.
2. **One added error code, `CANNOT_START`.** *Design §5* transition 5 requires 2–4 seats claimed **and connected**, but *Design §3*'s error list has no code for a premature `START_MATCH`. Overloading an existing code would lie to the client.

**Dependency-injection seam.** `Room` takes a `RoomDeps` object whose fields default to the real engine functions and real clock. Tests override single fields (`startNextRound` that throws once; a fake `now`). This is explicit dependencies, not mocking: the defaults are the production functions, and only tests that need to force an unreachable state override them.

---

## Stage 1: Harness, protocol, and leaf modules

**Goal:** `bun test src/server` runs; the message protocol is fully typed and guarded; tokens, config, and rate limiting exist as dependency-free modules.
**Success criteria:** Both test suites green side by side; every `ClientMessage` variant has valid/malformed/extra-field coverage; a `playerId` on `PLAY_CARD` is rejected.
**Status:** Not Started

### Task 1: Server test harness

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Create: `src/server/__tests__/harness.test.ts`

**Step 1: Install Bun's type declarations**

```bash
bun add -d @types/bun
```

**Step 2: Fence the runners apart.** In `vitest.config.ts`, change the include to:

```ts
include: ['src/game/**/*.test.ts']
```

Without this, Vitest collects `src/server/**` and its Node workers crash on `bun:sqlite`.

**Step 3: Split the scripts** in `package.json`:

```json
"test": "bun run test:engine && bun run test:server",
"test:engine": "bunx vitest run",
"test:server": "bun test src/server",
"test:watch": "bunx vitest"
```

**Step 4: Write the harness test** at `src/server/__tests__/harness.test.ts`. It proves the three Bun-native facilities the whole layer depends on, and starts deliberately red:

```ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('server test harness', () => {
    it('runs under the Bun runtime, not Node', () => {
        expect(typeof Bun).toBe('object');
        expect(1 + 1).toBe(3); // deliberately red; fix after the fail is observed
    });

    it('opens an in-memory bun:sqlite database', () => {
        const db = new Database(':memory:');
        db.run('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
        db.run('INSERT INTO t (id, n) VALUES (?, ?)', ['a', 1]);
        expect((db.query('SELECT n FROM t WHERE id = ?').get('a') as { n: number }).n).toBe(1);
        db.close();
    });

    it('serves a WebSocket with per-socket data and an ephemeral port', async () => {
        // One type argument only: the second generic is Bun's route-path string
        // literal type and must be left to default — `{}` fails tsc (TS2344).
        const server = Bun.serve<{ tag: string }>({
            port: 0,
            fetch(req, srv) {
                if (srv.upgrade(req, { data: { tag: 'x' } })) return;
                return new Response('http');
            },
            websocket: {
                perMessageDeflate: false,
                maxPayloadLength: 4096,
                message(ws, raw) {
                    ws.send(JSON.stringify({ echo: String(raw), tag: ws.data.tag }));
                }
            }
        });
        const ws = new WebSocket(`ws://localhost:${server.port}/`);
        const got = new Promise<string>(resolve => (ws.onmessage = e => resolve(String(e.data))));
        await new Promise<void>(resolve => (ws.onopen = () => resolve()));
        ws.send('hi');
        expect(JSON.parse(await got)).toEqual({ echo: 'hi', tag: 'x' });
        ws.close();
        server.stop(true);
    });
});
```

**Step 5: Run, confirm exactly one FAIL** (`expected 2 to be 3`): `bun run test:server`. A pass here would mean nothing was collected.

**Step 6: Fix the assertion to `toBe(2)`; confirm 3 pass.**

**Step 7: Prove isolation both ways.** `bun run test:engine` — all engine suites pass, zero server files collected. `bunx tsc --noEmit` — clean (this also proves `@types/bun` coexists with the DOM lib).

**Step 8: Commit**

```bash
but diff
but commit server/transport -m "Add Bun-native server test harness beside Vitest" --changes <ids>
```

---

### Task 2: Config

**Files:**
- Create: `src/server/config.ts`
- Test: `src/server/__tests__/config.test.ts`

Every tunable from *Design §5, §6, §8, §14.5* in one object. No other file may hold a numeric literal for any of these.

```ts
export interface TransportConfig {
    readonly port: number;
    readonly publicBaseUrl: string;          // joinUrl prefix
    readonly dbPath: string;                 // ':memory:' in tests
    readonly revealWindowMs: number;         // 5000 — fixed by design
    readonly lobbyDisconnectGraceMs: number; // 60_000
    readonly lobbyTtlMs: number;             // 15 * 60_000
    readonly activeGraceMs: number;          // 120_000
    readonly zeroConnTtlMs: number;          // 10 * 60_000
    readonly retentionMs: number;            // 60 * 60_000
    readonly sweepIntervalMs: number;        // 60_000
    readonly maxPayloadLength: number;       // 4096
    readonly messageBurst: number;           // 10 — token bucket capacity
    readonly messageRefillPerSec: number;    // 5
    readonly ipConnectionsPerMinute: number; // 30 — new sockets + room lookups + room creates
    readonly maxNicknameLength: number;      // 24
}

export const DEFAULT_CONFIG: TransportConfig = { /* the values above, port 3000, publicBaseUrl 'http://localhost:3000', dbPath 'mules-court.sqlite' */ };

export function makeConfig(overrides: Partial<TransportConfig> = {}): TransportConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}
```

Test: `makeConfig()` returns the defaults; `makeConfig({ revealWindowMs: 20 })` overrides one field and no other. Red → green → typecheck → commit.

---

### Task 3: Protocol types and guards

**Files:**
- Create: `src/server/protocol.ts`
- Modify: `src/game/engine/index.ts` (one line — see below)
- Test: `src/server/__tests__/protocol.test.ts`

Transcribe the unions from *Design §3* exactly. Import `GuessValue`, `PlayerId`, `CardInstanceId`, `ValidationError`, `RedactedView` as types from `../game/engine`. **First**, add `GuessValue` to the barrel's type re-export list in `src/game/engine/index.ts` — `types.ts` defines it but the barrel currently omits it. A one-line, additive, type-only change committed with this task; it keeps the barrel-only convention intact.

```ts
export type ErrorCode =
    | 'MALFORMED' | 'ROOM_NOT_FOUND' | 'SEAT_TAKEN' | 'ROOM_FULL' | 'ALREADY_SEATED'
    | 'BAD_TOKEN' | 'NOT_YOUR_SEAT' | 'NOT_HOST' | 'CANNOT_START' | 'PAUSED'
    | 'MATCH_OVER' | 'RATE_LIMITED' | 'INTERNAL'
    | ValidationError['code'];          // engine codes forwarded verbatim — they name rules, never cards

export type SeatStatus = 'open' | 'occupied' | 'disconnected';

export type ClientMessage = /* the 7 variants of Design §3, verbatim */;
export type ServerMessage = /* the 8 variants of Design §3, verbatim; STATE_UPDATE carries
                               view, nicknames, phase, endReason?, winnerSeat?, paused,
                               missingSeats, revealDeadline?, serverTime */;

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false };
export function parseClientMessage(raw: string, maxNickname: number): ParseResult;
```

**Guard rules (Design §8 step 3), each one a test row:**

- Hand-written switch over `type`. Unknown type, missing field, wrong-typed field, **or any unexpected extra field** → `{ ok: false }`. Write one `hasExactKeys(obj, required, optional)` helper and use it in every variant — extra-field rejection is what makes `PLAY_CARD.playerId` and `CLAIM_SEAT.seat` structurally impossible, which is *Design §2*'s "prefer deleting a field to adding a check" enforced at the boundary.
- `target` must match `^p[1-4]$` (the server-allocated pool — closes the prototype-pollution row of *Design §13*). `guess` must be an **integer** 2–8. `cardInstanceId` must be a string shaped `slug#n`; deeper legality belongs to the engine.
- `nickname`: trim; reject empty-after-trim, longer than `maxNickname`, or containing control characters (`/[\u0000-\u001f\u007f]/`). The trimmed value is what the parse returns — the only free text in the protocol.
- `clientMsgId`: optional string ≤ 64 chars; echoed in `ERROR.refId` only, never used for ordering or auth.

**Test:** table-driven — an array of `{ name, raw, ok }` rows covering: every variant's happy path; every variant with one extra field (**assert `PLAY_CARD` with `playerId` is rejected**, the named case from *Design §12.1*); `target: 'p5'`, `'P1'`, `'__proto__'`, `{}`; `guess: 1`, `9`, `'2'`, `2.5`; nickname empty, 25 chars, `'a\u0000b'`, `'  ok  '` (accepted, trimmed to `'ok'`); `null`, `[]`, `42`, `'"PING"'` (a bare string is not an object); valid JSON that is not an object. Also assert `parseClientMessage` never throws on any row — wrap the malformed rows in a `expect(() => …).not.toThrow()` sweep.

Red → green → typecheck → commit.

---

### Task 4: Seat tokens

**Files:**
- Create: `src/server/seatTokens.ts`
- Test: `src/server/__tests__/seatTokens.test.ts`

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function mintToken(): string;          // 32 hex chars = 128 bits (Design §4)
export function mintMatchId(): string;        // same shape, non-sequential (Design §13)
export function mintSeed(): string;           // same shape; as sensitive as the actionLog (Design §9)
export function hashToken(token: string): string;                    // sha256 hex
export function tokenMatches(presented: string, storedHash: string): boolean;  // hash then timingSafeEqual
```

**Test:** 1000 minted tokens are unique, 32 lowercase hex chars; `hashToken` is stable and 64 hex chars; `tokenMatches(t, hashToken(t))` true; false for a different token, for `''`, and for garbage input of any length (no throw on odd-length input — `tokenMatches` must hash the *presented* value, never parse it). Red → green → typecheck → commit.

---

### Task 5: Rate limiter

**Files:**
- Create: `src/server/rateLimiter.ts`
- Test: `src/server/__tests__/rateLimiter.test.ts`

```ts
export class TokenBucket {
    constructor(capacity: number, refillPerSec: number, now: () => number = Date.now);
    take(): boolean;
}
export class IpLimiter {
    constructor(perMinute: number, now: () => number = Date.now);
    take(ip: string): boolean;
    prune(): void;      // called by the reaper sweep; drops idle IPs
}
```

Injectable `now` so tests never sleep. **Test:** a bucket of capacity 10 grants 10 immediately and refuses the 11th; advancing the fake clock 200 ms at 5/s grants exactly one more; `IpLimiter` counts per-IP independently; `prune()` forgets an IP whose window has fully passed (assert the internal map shrinks — expose `size` for the test). Applied to **every** message type later, per *Design §8 step 4* — the limiter itself is policy-free. Red → green → typecheck → commit.

---

## Stage 2: Persistence and replay

**Goal:** `{seed, actionLog}` round-trips through SQLite and rebuilds the exact live `MatchState`.
**Success criteria:** A scripted match, persisted and replayed, deep-equals its live state; a corrupt log quarantines instead of throwing; no raw token ever reaches a row.
**Status:** Not Started

### Task 6: MatchStore and replayMatch

**Files:**
- Create: `src/server/persistence.ts`
- Test: `src/server/__tests__/persistence.test.ts`

One table (*Design §9*):

```sql
CREATE TABLE IF NOT EXISTS matches (
    matchId     TEXT PRIMARY KEY,
    seed        TEXT,               -- NULL until START_MATCH
    hostSeat    TEXT NOT NULL,
    phase       TEXT NOT NULL,      -- 'lobby' | 'active' | 'ended'
    endReason   TEXT,
    winnerSeat  TEXT,
    seats       TEXT NOT NULL,      -- JSON: [{index, playerId, nickname, tokenHash}] — hashes ONLY
    actionLog   TEXT NOT NULL,      -- JSON: PlayCardAction[]
    quarantined INTEGER NOT NULL DEFAULT 0,
    createdAt   INTEGER NOT NULL,
    updatedAt   INTEGER NOT NULL
);
```

```ts
export interface StoredSeat { index: number; playerId: PlayerId; nickname: string; tokenHash: string; }
export interface MatchRecord { /* one field per column, seats/actionLog as parsed values */ }

export class MatchStore {
    constructor(dbPath: string);       // ':memory:' in tests
    save(record: MatchRecord): void;   // synchronous upsert — sits in the commit path by design (§9)
    load(matchId: string): MatchRecord | null;   // null for quarantined rows too
    quarantine(matchId: string): void;
    delete(matchId: string): void;
    listIds(): string[];
    close(): void;
}

export function replayMatch(
    playerIds: readonly PlayerId[], seed: string, matchId: string,
    actionLog: readonly PlayCardAction[]
): MatchState | null;
```

**The replay subtlety — this is the task's one trap.** `MatchState.actionLog` records only `PLAY_CARD` actions; round boundaries are **not** logged, because `startNextRound` is deterministic from the state itself. The fold must re-derive them:

```ts
let state = createMatch(playerIds, seed, matchId);
for (const action of actionLog) {
    if (state.round.phase === 'round-over') {
        if (isMatchOver(state)) return null;        // actions after a decided match: corrupt
        state = startNextRound(state);              // deterministic — rng threads from state
    }
    const result = reduce(state, action);
    if (!result.ok) return null;                    // corrupt log — caller quarantines
    state = result.state;
}
return state;
```

A log that *ends* at round-over is left there: the rebuilt room re-arms the reveal timer through the ordinary resume flow (*Design §7*), and because `startNextRound` is deterministic, the next deal is identical whether it happens before or after a crash.

**Test:**
1. Lobby round-trip: save → load deep-equals; `load` of an unknown id is null.
2. Replay determinism: drive a real match ~15 legal plays (reuse the engine directly: `createMatch` with a fixed seed, pick moves via `computeLegalPlays`/`computeLegalTargets` from the barrel), crossing at least one round boundary; persist `{seed, actionLog}`; `replayMatch` deep-equals the live `MatchState` — including `rng`, `players[].tokens`, and `lastStartedRound`.
3. Corrupt log: append a duplicated action → `replayMatch` returns null; `quarantine()` then makes `load` return null; `listIds` still lists it (the reaper must eventually delete it).
4. Secrets: `JSON.stringify` of every saved row contains the token **hash** and never a raw minted token (mint one, hash it, assert the mint is absent from the serialized row).

Red → green → typecheck → commit.

---

## Stage 3: The Room

**Goal:** The full room lifecycle of *Design §5–§7* driven directly against the class, no sockets.
**Success criteria:** Every numbered transition in *Design §5* has a test; the four round-advance rules of *Design §12.4* pass.
**Status:** Not Started

### Task 7: Room core — seats, lobby, eviction

**Files:**
- Create: `src/server/room.ts`
- Test: `src/server/__tests__/room.test.ts`

The shapes every later task builds on:

```ts
export interface SeatConnection {           // index.ts adapts ServerWebSocket to this
    send(json: string): void;
    close(): void;
}

interface Seat {
    readonly index: number;                  // 0..3
    readonly playerId: PlayerId;             // `p${index + 1}` — fixed pool, never client-chosen
    nickname: string | null;
    tokenHash: string | null;                // null = open
    conn: SeatConnection | null;
    disconnectedAt: number | null;
}

export interface RoomDeps {                  // defaults are the real engine + real clock
    createMatch?, reduce?, startNextRound?, view?, isMatchOver?, now?: () => number;
}

export class Room {
    static create(config, store, deps?): { room: Room; hostSeatToken: string };  // HTTP path (Design §2)
    static rebuild(config, store, record, deps?): Room | null;  // replayMatch; every seat missing; paused

    enqueue<T>(fn: () => T | Promise<T>): Promise<T>;           // the 15-line chain of Design §10

    claimSeat(conn, nickname): void;      // SEAT_CLAIMED unicast + LOBBY_UPDATE broadcast, or ERROR
    resumeSeat(conn, token): { evictedConn?: SeatConnection };
    handleClose(conn): void;
    startMatch(conn): void;
    playCard(conn, msg): void;
    endMatch(conn): void;
    resync(conn): void;
    sweep(now): 'keep' | 'delete';        // transitions 3, 6, 13, 14 — Task 10 wires it
}
```

`Room` performs **all** sends itself: unicast via `seat.conn.send`, "broadcast" as the same bytes looped over connected seats. Seat status is derived, never stored: `open` (no tokenHash), `occupied` (conn bound), `disconnected` (tokenHash, no conn). `paused` is recomputed as `missingSeats().length > 0` (*Design §5*) — never a settable flag.

**This task implements:** `create` (host seat 0/`p1` minted before any join, closing the host race of *Design §13*), `claimSeat` (lowest open seat; `ROOM_FULL` when none; token minted, hash stored, raw token sent once), `resumeSeat` (hash lookup; **uniform `FATAL{BAD_TOKEN}`** for every unresolvable case; eviction: old conn gets `FATAL{SEAT_TAKEN}` then close, pointer repointed same tick), `handleClose`, `enqueue`, and lobby-phase `sweep` (transition 3: a disconnected lobby seat past `lobbyDisconnectGraceMs` reverts to open — tokenHash cleared, old token dead; transition 6: lobby past `lobbyTtlMs` → ended).

**Test with a recording connection** (a real object, not a mock of anything):

```ts
class RecordingConn implements SeatConnection {
    sent: ServerMessage[] = [];
    closed = false;
    send(json: string) { this.sent.push(JSON.parse(json)); }
    close() { this.closed = true; }
}
```

Required cases: creation yields host at seat 0 with a token whose hash is stored; two claims land on seats 1 and 2 in order; claim into a full room → `ROOM_FULL`; `LOBBY_UPDATE` broadcast after every claim shows correct statuses and `canStart` (true only with ≥2 claimed **and** all connected); resume with a wrong token, an empty token, and another room's token all produce byte-identical `FATAL{BAD_TOKEN}`; resume evicts — old conn receives `FATAL{SEAT_TAKEN}` and is closed, new conn owns the seat; a message-era check: after eviction `seats[i].conn === newConn`; lobby grace expiry reopens the seat via `sweep` with a fake `now`, and the stale token now resumes to `BAD_TOKEN`; `enqueue` serializes — two enqueued fns that record entry/exit never interleave (make the first `await` a timer).

Red → green → typecheck → commit.

---

### Task 8: Room gameplay — start, play, pause, end

**Files:**
- Modify: `src/server/room.ts`
- Test: extend `src/server/__tests__/room.test.ts`

**`startMatch`:** claimed seats all connected and 2–4 of them, else `ERROR{CANNOT_START}` (host gating is dispatch's job, Task 11, but Room re-checks phase). `playerIds` = claimed seats in index order. `seed = mintSeed()`, `createMatch(playerIds, seed, matchId)`, phase → `active`, **persist, then** broadcast `MATCH_STARTED` and unicast one `STATE_UPDATE` per seat.

**`playCard`:** build the engine action from the seat alone — `{ type: 'PLAY_CARD', playerId: seat.playerId, cardInstanceId, target, guess }` (*Design §3*: the acting identity comes from the connection, permanently). `reduce`; on `!ok` reply `ERROR{engine code, refId: clientMsgId}` and touch nothing. On ok, run **the commit sequence, whose order is load-bearing** (*Design §6, §8 step 11, §13 rows 1 and 11*):

```
state = result.state
if isMatchOver(state):         phase='ended', endReason='won', winnerSeat=state.matchWinnerId,
                               cancel any reveal timer       // match-over precedence — never arm
else if round is 'round-over': armRevealTimer()              // !isMatchOver is already true here by
                                                             // ordering, not by a sibling if — and
                                                             // arming FIRST is what puts revealDeadline
                                                             // into the pushes below
persist()                                                    // BEFORE any send (Design §9)
push one STATE_UPDATE per connected seat                     // each carries revealDeadline when armed
if phase=='ended':             broadcast MATCH_ENDED
```

Arming before the push is safe: the tick completes before any timer can fire, and `advanceRound` routes through `enqueue` anyway. Design §6's sketch lists "persist, push, arm" — but its own `STATE_UPDATE{ phase:'round_over', revealDeadline }` requires the deadline to exist at build time, so compute-deadline-first is the only order that satisfies §6's payload.

**`buildStateUpdate(seat)`:** `view: view(match, seat.playerId)` — the **only** source of game data; `nicknames` beside the view, never in it; `phase` mapped `ended` / `round_over` / `active`; `paused`; `missingSeats` (playerIds); `revealDeadline` only while a timer is armed; `serverTime: now()`.

**`handleClose` in active phase:** mark seat missing, cancel the reveal timer (a disconnect restarts, never resumes — *Design §6*), push `STATE_UPDATE` to the remaining seats showing `paused: true`.

**`resumeSeat` in active phase (Design §7 order):** bind, clear from missing, recompute paused; **if now unpaused and the round is over, re-arm the timer at the full window first** (so the repaint below carries the fresh `revealDeadline`); then send this seat one fresh `STATE_UPDATE`; if now unpaused, push to everyone.

**`endMatch`:** allowed for the host always; for any connected seat when active and **any** seat has been missing past `activeGraceMs` (transition 12 — the non-host laptop case the design calls out); for any connected seat in a lobby whose host has been missing past `lobbyDisconnectGraceMs` (transition 4). Otherwise `ERROR{NOT_HOST}`. Result: `ended('abandoned')`, timer cancelled, persist, `MATCH_ENDED` broadcast (+ final `STATE_UPDATE`s when a match exists).

**`resync`:** rebuild and resend this seat's current `LOBBY_UPDATE` or `STATE_UPDATE`; changes nothing.

**Required cases:** a 3-seat start deals `['p1','p2','p3']` and every seat's first `STATE_UPDATE.view.own.playerId` matches its seat; a legal play moves the turn and pushes N distinct views (assert each view's `own.hand` differs); an illegal play returns the engine's code verbatim with `refId` echoed and `actionLog` length unchanged; `PLAY_CARD` while paused → `ERROR{PAUSED}` **before** `reduce` (assert `actionLog` untouched — *Design §7*); disconnect mid-round pauses everyone; resume repaints with a view deep-equal to a fresh `view()` call; non-host `endMatch` before grace → `NOT_HOST`, after grace (fake clock) → abandoned; host `endMatch` immediate; every `STATE_UPDATE` batch persists before the first `send` (RecordingStore that stamps order).

Red → green → typecheck → commit.

---

### Task 9: Round advancement

**Files:**
- Modify: `src/server/room.ts` (the timer internals)
- Test: `src/server/__tests__/roundAdvance.test.ts`

```ts
private armRevealTimer(): void {
    // preconditions, not siblings: phase==='active' && round-over && !isMatchOver && !paused
    this.revealDeadline = this.deps.now() + this.config.revealWindowMs;
    this.revealTimer = setTimeout(() => void this.enqueue(() => this.advanceRound()), ms);
}

private advanceRound(): void {
    if (this.advancing) return;
    this.advancing = true;
    try {
        // re-check everything — the world may have moved while queued (Design §6)
        if (phase !== 'active' || round.phase !== 'round-over' || isMatchOver || paused) return;
        this.match = this.deps.startNextRound(this.match);
        this.revealDeadline = null;
        this.persist();
        this.pushStateToAll();
    } finally {
        this.advancing = false;              // Design §13: the lock survives an engine throw
    }
}
```

**Test with `revealWindowMs: 20`** (*Design §12.4* — all four are mandatory):
1. A finished, non-winning round arms the timer; ~40 ms later every seat holds a `STATE_UPDATE` with `phase: 'active'`, `view.turnNumber` reset to `1`, `view.roundResult` null, and a freshly dealt one-card `own.hand` (`RedactedView` has **no** round counter — a restarted `turnNumber` is the wire-visible new-round signal); and the interim `round_over` push carried a `revealDeadline` ≈ its `serverTime + 20`.
2. **A match-winning round never arms it.** Build a match one token short (drive real rounds with a chosen seed, or assemble a `MatchState` at `tokens = tokensToWin - 1` and let one real `reduce` win it): the winning push says `phase: 'ended'`, and 40 ms of waiting produces no further push and no throw — this is *Design §13* row 1, the ordinary-win crash.
3. A disconnect at ~10 ms cancels; reconnect re-arms at the full window (total elapsed > 20 ms from reconnect, not from round end).
4. `deps.startNextRound` overridden to throw once: the error surfaces as a logged `INTERNAL`, the queue keeps serving (a subsequent `resync` works), and `advancing` is false again.

Red → green → typecheck → commit.

---

### Task 10: Room registry and reaper

**Files:**
- Create: `src/server/roomRegistry.ts`
- Test: `src/server/__tests__/roomRegistry.test.ts`

```ts
export class RoomRegistry {
    constructor(config, store, deps?);
    createRoom(): { matchId, joinUrl, hostSeat: 'p1', hostSeatToken };   // Design §3 HTTP response
    get(matchId): Room | null;      // in-memory, else lazy rebuild from the store (Design §9)
    sweep(): void;                  // delegates Room.sweep per room + deletes past retention
    startSweeping() / stop();
}
```

Lazy rebuild: `get` on a cold id loads the record; `phase === 'lobby'` rebuilds a seat table with no match; `active` rebuilds via `replayMatch` (null → `quarantine`, return null); rebuilt rooms start with every claimed seat missing and `paused: true` — indistinguishable from mass disconnect, which is exactly *Design §7*'s restart-needs-no-special-case.

**Test:** create → get returns the same instance; cold get rebuilds from a store shared by a previous registry instance (this is the crash-recovery unit test); a corrupt log quarantines and `get` returns null thereafter; sweep drives: transition 6 (stale lobby → ended), 13 (active room, all seats disconnected past `zeroConnTtlMs` with a fake clock → `ended('abandoned')`), 14 (ended past `retentionMs` → gone from map **and** store); a quarantined row is deleted once past retention. Red → green → typecheck → commit.

---

## Stage 4: Dispatch

**Goal:** *Design §8*'s eleven-step pipeline as one ordered function, each step independently provable.
**Success criteria:** One test per step showing rejection **and** that no state changed.
**Status:** Not Started

### Task 11: The validation pipeline

**Files:**
- Create: `src/server/dispatch.ts`
- Test: `src/server/__tests__/dispatch.test.ts`

```ts
export interface ConnectionState {          // lives in ws.data
    readonly ip: string;
    readonly bucket: TokenBucket;
    seat: PlayerId | null;                  // bound by CLAIM/RESUME success only
    matchId: string | null;
    conn: SeatConnection;                   // assigned in websocket.open(), which always precedes message()
}

export function dispatchMessage(
    registry: RoomRegistry, config: TransportConfig, state: ConnectionState, raw: string
): Promise<void>;
```

Order, exactly (*Design §8* — step 1, frame size, lives in `Bun.serve` config and is asserted in Task 15):

2. `parseClientMessage` → `ERROR{MALFORMED}`, socket stays open.
3. (inside step 2 — the guards.)
4. `state.bucket.take()` — **before** any switch on type, so every variant is limited → `ERROR{RATE_LIMITED}`.
   `PING` → `PONG` here; it needs no room.
5. Identity: `PLAY_CARD` / `START_MATCH` / `END_MATCH` / `REQUEST_RESYNC` with `state.seat === null` or a `matchId` ≠ `state.matchId` → `ERROR{NOT_YOUR_SEAT}`. Read `state.seat` and nothing from the payload.
6. Canonical pointer: room found, and `room.seats[seat].conn !== state.conn` → refuse `NOT_YOUR_SEAT` — the evicted-socket race (*Design §4*).
7. `CLAIM_SEAT` / `RESUME_SEAT` with `state.seat` already bound → `ERROR{ALREADY_SEATED}`.
8. Room and phase gates: `registry.get` miss → `ROOM_NOT_FOUND` (uniform for never-existed and expired — the enumeration stance of *Design §4*); claim into non-lobby → `ROOM_FULL` / `MATCH_OVER`; play into lobby → `ROUND_NOT_IN_PROGRESS`; anything into ended → `MATCH_OVER`; play while paused → `PAUSED`.
9. Host gate: `START_MATCH` from a non-host seat → `NOT_HOST` (`END_MATCH`'s richer rule lives in `Room.endMatch`).
10–11. The room command, inside `room.enqueue`, inside `try/catch` → a throw logs and replies `ERROR{INTERNAL}`, never an uncaught exception in a socket handler.

On `CLAIM_SEAT`/`RESUME_SEAT` success, dispatch binds `state.seat`/`state.matchId` — the only writer.

**Test:** drive `dispatchMessage` with `RecordingConn`s and a real registry/store. One test per step: malformed JSON; a shape failure; the 11th rapid message → `RATE_LIMITED` (and a bucket with capacity 1 proves even `REQUEST_RESYNC` is limited); unbound `PLAY_CARD`; a stale conn after eviction sends `PLAY_CARD` → refused **and** `actionLog` unchanged; second `CLAIM_SEAT` on one connection → `ALREADY_SEATED`; unknown `matchId` → `ROOM_NOT_FOUND`; non-host `START_MATCH` → `NOT_HOST`; `deps.reduce` overridden to throw → `ERROR{INTERNAL}` and the next message still dispatches. Every rejection case also asserts room state is untouched (log length, phase, seat table). Red → green → typecheck → commit.

---

## Stage 5: The server, and the adversarial suites

**Goal:** Real sockets against a real server; the design's exploit table as executable attacks.
**Success criteria:** A full 4-player match over WebSockets with a leak assertion after **every** push; restart recovery; all of *Design §13* refused.
**Status:** Not Started

### Task 12: Bun.serve wiring

**Files:**
- Create: `src/server/index.ts`
- Modify: `package.json` (add `"serve": "bun src/server/index.ts"`)

```ts
export interface RunningServer { server: Bun.Server<ConnectionState>; registry: RoomRegistry; stop(): void; }
// Bun.Server takes exactly one required generic (the WebSocketData type) — bare `Bun.Server` fails tsc (TS2314)
export function startServer(config: TransportConfig): RunningServer;

if (import.meta.main) startServer(makeConfig());     // self-contained runnable
```

`fetch`: `POST /api/rooms` (per-IP limited) → `201 { matchId, joinUrl, hostSeat: 'p1', hostSeatToken }` — the only token delivery outside a socket (*Design §2*); any other HTTP path attempts `server.upgrade(req, { data: connectionState })` with the IP from `server.requestIP(req)`; otherwise 404. **The `ServerWebSocket` does not exist inside `fetch`**, so the `ConnectionState` passed to `upgrade` carries everything except `conn`; the `websocket.open(ws)` handler is `conn`'s one producer: `ws.data.conn = { send: json => ws.send(json), close: () => ws.close() }`. `open` always fires before the first `message`, so dispatch may treat `conn` as present. `websocket`: `perMessageDeflate: false` (disabled outright, not capped — *Design §8 step 1*), `maxPayloadLength: config.maxPayloadLength`, `open` as above, `message` → `dispatchMessage`, `close` → route to the seat's room `handleClose` via `enqueue`. `stop()` closes the sweeper, the store, and `server.stop(true)`.

Wiring only — no logic beyond adapting `ServerWebSocket` to `SeatConnection`. Verify by running Task 13's first test; no dedicated unit suite. `bunx tsc --noEmit`, commit.

---

### Task 13: Integration — a full match over real sockets

**Files:**
- Create: `src/server/__tests__/integration.test.ts`
- Create: `src/server/__tests__/testClient.ts`

`TestClient`: a thin real-WebSocket wrapper — `connect(url)`, `send(msg)`, an inbox of parsed `ServerMessage`s, `raw` frames kept beside them, `nextOfType(type)` with a timeout. `chooseMove(view)`: take the first of `view.own.legalPlays`; look up its `EffectDef` via `CARD_CATALOG`/`cardTypeOf`/`EFFECT_DEFS` (all on the barrel); targets = alive, unprotected players other than self; `requiresTarget` with none legal → omit target (the fizzle rule); PRINCE with no legal opponent → target self; `requiresGuess` → attach `guess: 2` **only when a target was attached** — the engine's `validateAction` computes `guessApplies = requiresGuess && legalTargets.length > 0` and rejects a guess on a fizzled Informant with `GUESS_NOT_ALLOWED`, which would stall the play loop.

**The suite (Design §12.6 — "the one that matters most"):** create a room over HTTP, seat four clients, `START_MATCH`, then loop: whichever client's `STATE_UPDATE` shows `currentPlayerId === own.playerId` plays `chooseMove` until `MATCH_ENDED` (cap ~500 plays; the 5 s reveal window shrunk via `revealWindowMs: 25` — build the server with `makeConfig` overrides).

**After every received frame, for every client, assert:**
- *Absence:* the raw frame contains none of `"deckOrder"`, `"setAsideFaceDown"`, `"rng"`, `"seed"`, `"actionLog"`, `"privateKnowledge"`, `"tokenHash"`; no other client's `seatToken`; and no card-instance id currently in another client's hand (each client tracks its own hand from its latest view; the orchestrator cross-checks).
- *Presence:* `view.own.playerId` is this client's; while alive mid-round, `own.hand` is non-empty; when it holds the turn, `legalPlays` is non-empty; `nicknames` names every claimed seat. A projection that returned nothing must fail this half (*Design §12*).
- After any client plays a PRIEST-effect card (`han-pritcher`/`bail-channis`) with a target, its next `STATE_UPDATE` contains a `revealed` entry for that target — peek **presence** over the wire.

Also assert: `MATCH_ENDED.winnerSeat` matches the final views' `matchWinnerId`; every round boundary push carried `phase: 'round_over'` with a `revealDeadline`; and the server survives the win (a `PING` afterward gets a `PONG`). Red (fails on the unwired server until Task 12 lands) → green → typecheck → commit.

---

### Task 14: Reconnection and crash recovery

**Files:**
- Create: `src/server/__tests__/reconnect.test.ts`

File-backed store (`dbPath` in a temp dir via `node:fs mkdtempSync`).

1. **Drop and resume:** 3 clients mid-round; hard-close one socket; the others' next `STATE_UPDATE` has `paused: true` and the seat in `missingSeats`; a `PLAY_CARD` from a connected client → `ERROR{PAUSED}`; reconnect with the stored token → first push is a complete repaint whose `own.hand` and `publicLog` match the pre-drop view; everyone's banners clear together (all clients receive `paused: false` pushes).
2. **Countdown restart:** disconnect during `round_over`, reconnect, assert a fresh full-window `revealDeadline` (later than the original).
3. **Server restart:** play several turns, `stop()` the whole server, `startServer` again on the same `dbPath` (port 0 → new port); all clients `RESUME_SEAT` with their stored tokens; assert each client's rebuilt view deep-equals its pre-restart view on `own.hand`, `players` (tokens, discards), `currentPlayerId`, `turnNumber` — and the match then **plays on to completion**. Same code path as case 1, per *Design §7*.
4. `REQUEST_RESYNC` returns a push identical to the previous one and `actionLog` is unchanged.

Red → green → typecheck → commit.

---

### Task 15: The abuse suite

**Files:**
- Create: `src/server/__tests__/abuse.test.ts`

Every row of *Design §13* not already pinned above, as a real attack over real sockets, each asserting refusal **and** unchanged state:

| Attack | Assertion |
| --- | --- |
| Invitee races for host | Two sockets claim instantly after room creation; both get seats ≥ 1; their `START_MATCH` → `NOT_HOST`; the HTTP creator's works |
| Parallel claim race | Two sockets `CLAIM_SEAT` simultaneously → distinct seats, one `SEAT_CLAIMED` each, no duplicate `playerId` |
| One socket, whole table | Second `CLAIM_SEAT` on a bound socket → `ALREADY_SEATED`; seat count unchanged |
| Seat-index probe | `CLAIM_SEAT` with a `seat` field → `MALFORMED` (extra field) |
| `playerId` spoof | `PLAY_CARD` with `playerId` → `MALFORMED`; a correct-shape play for another seat's turn → `NOT_YOUR_TURN` |
| Evicted socket plays on | Resume from a second socket, then the first sends `PLAY_CARD` → refused, log unchanged |
| Non-gameplay flood | 50 rapid `REQUEST_RESYNC` → `RATE_LIMITED` appears; the room still answers the seat's next in-budget message |
| Oversized frame | An 8 KB frame → server closes the socket (Bun's `maxPayloadLength`); server still serves others |
| Compression bomb | The upgrade response carries no `Sec-WebSocket-Extensions: permessage-deflate` even when the client offers it |
| Prototype pollution | `target: "__proto__"` → `MALFORMED`; `nickname: "__proto__"` accepted as text, `({} as any).polluted` stays undefined, and the nickname renders back in `LOBBY_UPDATE` verbatim |
| Room brute force | Sequential fake `matchId` lookups → uniform `ROOM_NOT_FOUND`, then `RATE_LIMITED` by the IP limiter |
| Token oracle | `RESUME_SEAT` with (a) random hex, (b) a token from a *different* room, (c) a token from an expired room → three byte-identical `FATAL{BAD_TOKEN}` frames |

Red → green → typecheck → commit.

---

### Task 16: Docs and done

**Files:**
- Modify: `AGENTS.md`

Update the stale "designed but not yet implemented" overview: the engine and transport exist; `src/server/` layout; the two-runner testing instructions (`bun run test`, and why server tests are `bun test`); `bun run serve`. Keep it terse — AGENTS.md points at code, it doesn't duplicate design docs.

**Definition of done**

- [ ] `bun run test` — engine (Vitest) and server (`bun test`) both green
- [ ] `bunx tsc --noEmit` — clean
- [ ] `bun run build` — the client bundle still builds
- [ ] Every *Design §13* row maps to a named passing test; every *Design §5* transition is exercised
- [ ] No raw token, seed, `actionLog`, or `MatchState` in any server→client frame (Task 13 asserts mechanically)
- [ ] All work committed on `server/transport`; pushed; PR opened via `but pr new`

**Out of scope:** the Phaser client for this protocol, host transfer, spectators, flexible retention (*Design §14* open questions), and any scaling past one process (*Design §15*).
