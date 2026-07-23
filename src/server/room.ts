/**
 * The Room class (Design §2, §4, §5, §6, §7, §10): one Room owns a fixed
 * 4-slot seat table, a serialization queue, an optional `MatchState`, and
 * every send for its match. Room performs ALL sends itself — unicast via
 * `seat.conn.send`, "broadcast" as the same bytes looped over connected seats
 * (this project's deliberate deviation from `ws.publish()`, see the
 * implementation plan's Stage conventions) — so Room is directly testable
 * with a plain recording connection and no running server.
 *
 * Seat status is derived, never stored: `open` (no tokenHash), `occupied`
 * (conn bound), `disconnected` (tokenHash, no conn). `paused` is likewise
 * derived as `missingSeats().length > 0` and is never a settable flag
 * (Design §5).
 *
 * This file implements the lobby-phase surface (Design §5 transitions 1, 2,
 * 3, 6: `create`, `claimSeat`, `resumeSeat`, `handleClose`, `enqueue`, lobby
 * `sweep`), the active/ended-phase gameplay surface added in Task 8:
 * `startMatch`, `playCard`, `endMatch`, `resync`, and the active/ended
 * branches of `handleClose`/`resumeSeat`, AND real round advancement (Task 9):
 * `armRevealTimer` schedules a genuine `setTimeout` into `advanceRound`,
 * routed through `enqueue` like every other room message (Design §6, §10).
 * `dispose()` is the shutdown seam a registry or test uses to drop a room
 * without leaving a dangling timer behind. Active-phase `sweep` (rows 12, 13)
 * still arrives in Task 10.
 */

import {
    createMatch as engineCreateMatch,
    isMatchOver as engineIsMatchOver,
    reduce as engineReduce,
    startNextRound as engineStartNextRound,
    view as engineView
} from '../game/engine';
import type { MatchState, PlayCardAction, PlayerId, ReduceResult, RedactedView } from '../game/engine';
import type { TransportConfig } from './config';
import type { EndReason, MatchPhase, MatchRecord, StoredSeat } from './persistence';
import { MatchStore } from './persistence';
import type { ClientMessage, ErrorCode, ServerMessage, SeatStatus } from './protocol';
import { hashToken, mintMatchId, mintSeed, mintToken, tokenMatches } from './seatTokens';

/** The fixed seat pool: index 0 is always the host, minted before any join (Design §2, §13). */
const HOST_SEAT_INDEX = 0;
const HOST_PLAYER_ID: PlayerId = 'p1';

/** index.ts adapts a `ServerWebSocket` to this; RecordingConn in tests implements it directly. */
export interface SeatConnection {
    send(json: string): void;
    close(): void;
}

/**
 * One seat slot. `index`/`playerId` are fixed for the room's lifetime — the
 * seat pool is never client-chosen (Design §13's prototype-pollution row).
 * `conn`/`disconnectedAt` are transport-only and are never persisted (see
 * `toStoredSeats` below); only `nickname`/`tokenHash` cross into `StoredSeat`.
 */
interface Seat {
    readonly index: number;
    readonly playerId: PlayerId;
    nickname: string | null;
    tokenHash: string | null; // null = open
    conn: SeatConnection | null;
    disconnectedAt: number | null;
}

/**
 * Explicit dependency injection (plan Task 8), not mocking: every default is
 * the real engine function or the real clock, and only a test that must
 * force an otherwise-unreachable state overrides a field. `startNextRound`
 * (Task 9) is what `advanceRound` calls once the reveal window elapses.
 */
export interface RoomDeps {
    now?: () => number;
    createMatch?: (playerIds: readonly PlayerId[], seed: string, matchId: string) => MatchState;
    reduce?: (match: MatchState, action: PlayCardAction) => ReduceResult;
    startNextRound?: (match: MatchState) => MatchState;
    view?: (match: MatchState, viewerId: PlayerId) => RedactedView;
    isMatchOver?: (match: MatchState) => boolean;
}

function makeEmptySeats(): Seat[] {
    return [0, 1, 2, 3].map(index => ({
        index,
        playerId: `p${index + 1}`,
        nickname: null,
        tokenHash: null,
        conn: null,
        disconnectedAt: null
    }));
}

export class Room {
    readonly matchId: string;

    private readonly config: TransportConfig;
    private readonly store: MatchStore;
    private readonly deps: Required<RoomDeps>;
    private readonly seats: Seat[];
    private readonly createdAt: number;

    private phase: MatchPhase;
    private endReason: EndReason | null;
    private winnerSeat: PlayerId | null;
    private endedAt: number | null;

    /** Null in the lobby; set once by `startMatch`, replaced on every subsequent commit. */
    private match: MatchState | null;
    /** Epoch ms, non-null only while a round-over reveal is armed (Design §6). */
    private revealDeadline: number | null;
    /** The live `setTimeout` backing `revealDeadline`; cleared on commit, reconnect, match end, and dispose. */
    private revealTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Advance-lock (Design §13 row 10: "advance lock leaks on an engine
     * throw"). Guards re-entrancy of `advanceRound` and survives a throw from
     * `startNextRound` via `try/finally` — it is never left `true`.
     */
    private advancing: boolean;

    private queue: Promise<void> = Promise.resolve();

    private constructor(
        matchId: string,
        seats: Seat[],
        phase: MatchPhase,
        createdAt: number,
        config: TransportConfig,
        store: MatchStore,
        deps: Required<RoomDeps>
    ) {
        this.matchId = matchId;
        this.seats = seats;
        this.phase = phase;
        this.endReason = null;
        this.winnerSeat = null;
        this.endedAt = null;
        this.match = null;
        this.revealDeadline = null;
        this.revealTimer = null;
        this.advancing = false;
        this.createdAt = createdAt;
        this.config = config;
        this.store = store;
        this.deps = deps;
    }

    /**
     * HTTP path (Design §2): mints the host's seat and token before any join
     * link exists, closing the host race of Design §13. Persists the initial
     * lobby record before returning.
     */
    static create(config: TransportConfig, store: MatchStore, deps: RoomDeps = {}): { room: Room; hostSeatToken: string } {
        const resolvedDeps: Required<RoomDeps> = {
            now: deps.now ?? Date.now,
            createMatch: deps.createMatch ?? engineCreateMatch,
            reduce: deps.reduce ?? engineReduce,
            startNextRound: deps.startNextRound ?? engineStartNextRound,
            view: deps.view ?? engineView,
            isMatchOver: deps.isMatchOver ?? engineIsMatchOver
        };
        const createdAt = resolvedDeps.now();

        const seats = makeEmptySeats();
        const hostSeatToken = mintToken();
        seats[HOST_SEAT_INDEX].tokenHash = hashToken(hostSeatToken);
        // The host is claimed-but-not-connected from the first instant, so
        // "missing since" must be seeded here: transition 4 (host absent in
        // lobby, Task 8's endMatch) gates on this even when the host never
        // connects at all. handleClose overwrites it on later disconnects.
        seats[HOST_SEAT_INDEX].disconnectedAt = createdAt;

        const room = new Room(mintMatchId(), seats, 'lobby', createdAt, config, store, resolvedDeps);
        room.persist();

        return { room, hostSeatToken };
    }

    /** The 15-line chain of Design §10, copied exactly: every room message routes through one queue. */
    enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
        const result = this.queue.then(fn);
        this.queue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    /**
     * Lowest open seat, or `null` (with the requesting conn sent an `ERROR`)
     * when refused: `ROOM_FULL` in `active` phase or when no seat is open,
     * `MATCH_OVER` once the room has ended (controller decision 1). Persists
     * before the `SEAT_CLAIMED` unicast and `LOBBY_UPDATE` broadcast (Design
     * §9 ordering discipline).
     */
    claimSeat(conn: SeatConnection, nickname: string): { seat: number; playerId: PlayerId } | null {
        if (this.phase === 'active') {
            this.sendError(conn, 'ROOM_FULL');
            return null;
        }
        if (this.phase === 'ended') {
            this.sendError(conn, 'MATCH_OVER');
            return null;
        }

        const seat = this.seats.find(s => s.tokenHash === null);
        if (!seat) {
            this.sendError(conn, 'ROOM_FULL');
            return null;
        }

        const rawToken = mintToken();
        seat.tokenHash = hashToken(rawToken);
        seat.nickname = nickname;
        seat.conn = conn;
        seat.disconnectedAt = null;

        this.persist();
        this.send(conn, {
            type: 'SEAT_CLAIMED',
            matchId: this.matchId,
            seat: seat.index,
            playerId: seat.playerId,
            seatToken: rawToken
        });
        this.broadcastLobbyUpdate();

        return { seat: seat.index, playerId: seat.playerId };
    }

    /**
     * Hash lookup across every seat. Every unresolvable token — wrong,
     * empty, or belonging to another room — gets the same `FATAL{BAD_TOKEN}`
     * (Design §4) and the presenting conn is closed, matching the protocol
     * invariant that a `FATAL` frame is always followed by a close.
     *
     * A live conn already bound to the seat is evicted: it receives
     * `FATAL{SEAT_TAKEN}` and is closed, then the new conn is bound in the
     * same synchronous call (controller decision 2) — no persist is needed
     * for the rebind itself, since `conn`/`disconnectedAt` are transport-only
     * and never appear in `StoredSeat`.
     */
    resumeSeat(conn: SeatConnection, token: string): { seat: number; playerId: PlayerId } | null {
        const seat = this.seats.find(s => s.tokenHash !== null && tokenMatches(token, s.tokenHash));
        if (!seat) {
            this.sendFatal(conn, 'BAD_TOKEN');
            return null;
        }

        const oldConn = seat.conn;
        if (oldConn !== null && oldConn !== conn) {
            this.sendFatal(oldConn, 'SEAT_TAKEN');
        }

        const wasPaused = this.paused;

        seat.conn = conn;
        seat.disconnectedAt = null;

        if (this.phase === 'lobby') {
            this.broadcastLobbyUpdate();
            return { seat: seat.index, playerId: seat.playerId };
        }

        // Design §7's reconnection order: bind above, then — only when THIS
        // resume is what cleared the last missing seat — re-arm BEFORE
        // building any push, so this seat's own repaint already carries the
        // fresh revealDeadline; then this seat's repaint; then everyone
        // else's, so the "waiting for…" banners clear together.
        const nowUnpaused = wasPaused && !this.paused;

        if (
            this.phase === 'active' &&
            nowUnpaused &&
            this.match !== null &&
            this.match.round.phase === 'round-over' &&
            !this.deps.isMatchOver(this.match)
        ) {
            this.armRevealTimer();
        }

        if (this.match !== null) {
            this.send(conn, this.buildStateUpdate(seat));
        }

        if (nowUnpaused) {
            this.pushStateToConnectedSeats(seat);
        }

        return { seat: seat.index, playerId: seat.playerId };
    }

    /**
     * Only acts when `conn` is the seat's canonical pointer (Design §4): an
     * evicted socket's own close event arrives after its seat already points
     * at the new conn, and is correctly ignored here. No persist is needed —
     * `disconnectedAt` is transport-only.
     */
    handleClose(conn: SeatConnection): void {
        const seat = this.seats.find(s => s.conn === conn);
        if (!seat) return;

        seat.conn = null;
        seat.disconnectedAt = this.deps.now();

        if (this.phase === 'lobby') {
            this.broadcastLobbyUpdate();
            return;
        }

        // Design §5 row 7 / §6: a disconnect always cancels any armed reveal
        // timer — the countdown restarts on reconnect, it never resumes.
        if (this.phase === 'active') {
            this.clearRevealTimer();
            this.pushStateToConnectedSeats();
        }
    }

    /**
     * Design §5 transition 5. `playerIds` is the claimed seats in index
     * order — already true of `this.seats`, whose order is fixed by
     * `makeEmptySeats()`. Host gating is dispatch's job (Task 11), but is
     * cheaply re-checked here too, matching this file's established
     * defense-in-depth pattern (`resumeSeat`'s eviction check, `sweep`'s
     * host-seat exemption).
     */
    startMatch(conn: SeatConnection): void {
        if (this.phase !== 'lobby') {
            this.sendError(conn, 'CANNOT_START');
            return;
        }

        const hostSeat = this.seats[HOST_SEAT_INDEX];
        if (hostSeat.conn !== conn) {
            this.sendError(conn, 'NOT_HOST');
            return;
        }

        if (!this.canStart()) {
            this.sendError(conn, 'CANNOT_START');
            return;
        }

        const playerIds = this.seats.filter(s => s.tokenHash !== null).map(s => s.playerId);
        const seed = mintSeed();
        this.match = this.deps.createMatch(playerIds, seed, this.matchId);
        this.phase = 'active';

        this.persist();

        this.broadcast({ type: 'MATCH_STARTED', matchId: this.matchId });
        this.pushStateToConnectedSeats();
    }

    /**
     * Design §5 row 9, §8 step 11. The acting identity comes from `conn`
     * alone (Design §3) — the action carries no `playerId` a client could
     * spoof.
     */
    playCard(conn: SeatConnection, msg: Extract<ClientMessage, { type: 'PLAY_CARD' }>): void {
        const seat = this.seats.find(s => s.conn === conn);
        if (!seat) {
            this.sendError(conn, 'NOT_YOUR_SEAT');
            return;
        }

        if (this.phase === 'lobby') {
            this.sendError(conn, 'ROUND_NOT_IN_PROGRESS');
            return;
        }
        if (this.phase === 'ended') {
            this.sendError(conn, 'MATCH_OVER');
            return;
        }
        // Checked BEFORE the engine runs and BEFORE actionLog is touched (Design §7).
        if (this.paused) {
            this.sendError(conn, 'PAUSED');
            return;
        }

        const match = this.match;
        if (match === null) {
            // Unreachable in practice: phase 'active' is only ever set alongside `match`.
            // Echoes clientMsgId like every other rejection below it.
            this.sendError(conn, 'ROUND_NOT_IN_PROGRESS', msg.clientMsgId);
            return;
        }

        const action: PlayCardAction = {
            type: 'PLAY_CARD',
            playerId: seat.playerId,
            cardInstanceId: msg.cardInstanceId,
            // Omitted entirely when absent, never a literal `undefined` value —
            // that would break structuredClone equality against a replay.
            ...(msg.target !== undefined ? { target: msg.target } : {}),
            ...(msg.guess !== undefined ? { guess: msg.guess } : {})
        };

        const result = this.deps.reduce(match, action);
        if (!result.ok) {
            this.sendError(conn, result.error.code, msg.clientMsgId);
            return;
        }

        this.commitMatchState(result.state);
    }

    /**
     * Design §5 rows 11/12. Allowed for the host at any time; for any
     * connected seat once the active match has had a seat missing past
     * `activeGraceMs` (row 12 — a non-host laptop dying is at least as
     * common as the host's); for any connected seat in a lobby whose host
     * has been missing past `lobbyDisconnectGraceMs` (row 4 — the host's
     * `disconnectedAt` is seeded at `create()`, so a host who never connects
     * at all still counts).
     */
    endMatch(conn: SeatConnection): void {
        const requester = this.seats.find(s => s.conn === conn);
        if (!requester) {
            this.sendError(conn, 'NOT_YOUR_SEAT');
            return;
        }

        if (this.phase === 'ended') {
            this.sendError(conn, 'MATCH_OVER');
            return;
        }

        const hostSeat = this.seats[HOST_SEAT_INDEX];
        const now = this.deps.now();

        const anySeatMissingPastActiveGrace =
            this.phase === 'active' &&
            this.seats.some(
                s =>
                    s.tokenHash !== null &&
                    s.conn === null &&
                    s.disconnectedAt !== null &&
                    now - s.disconnectedAt > this.config.activeGraceMs
            );

        const hostMissingPastLobbyGrace =
            this.phase === 'lobby' &&
            hostSeat.conn === null &&
            hostSeat.disconnectedAt !== null &&
            now - hostSeat.disconnectedAt > this.config.lobbyDisconnectGraceMs;

        if (requester !== hostSeat && !anySeatMissingPastActiveGrace && !hostMissingPastLobbyGrace) {
            this.sendError(conn, 'NOT_HOST');
            return;
        }

        this.transitionToEnded('abandoned', null);

        this.persist();

        if (this.match !== null) {
            this.pushStateToConnectedSeats();
        }

        this.broadcastMatchEnded('abandoned');
    }

    /**
     * Room shutdown seam: clears the reveal timer so a dropped room (test
     * teardown, or the registry retiring an entry) never leaves a dangling
     * `setTimeout` keeping the process alive. Nothing else is touched.
     */
    dispose(): void {
        this.clearRevealTimer();
    }

    /** Rebuilds and resends this seat's current snapshot; changes nothing (Design §7). */
    resync(conn: SeatConnection): void {
        const seat = this.seats.find(s => s.conn === conn);
        if (!seat) {
            this.sendError(conn, 'NOT_YOUR_SEAT');
            return;
        }

        if (this.phase === 'lobby') {
            this.send(conn, this.buildLobbyUpdate());
            return;
        }

        if (this.match !== null) {
            this.send(conn, this.buildStateUpdate(seat));
        }
    }

    /** Claimed seats with no live connection — the derivation `paused` is built from (Design §5). */
    missingSeats(): PlayerId[] {
        return this.seats.filter(s => s.tokenHash !== null && s.conn === null).map(s => s.playerId);
    }

    /** Never a settable flag — always recomputed (Design §5). Not yet surfaced to clients in lobby phase. */
    get paused(): boolean {
        return this.missingSeats().length > 0;
    }

    /**
     * Lobby-phase transitions only (Design §5 rows 3, 6): a disconnected
     * seat past grace reopens; a lobby past its TTL ends. `active`/`ended`
     * transitions (rows 7-14) arrive in Tasks 8-10. `'delete'` past
     * retention is included since it needs nothing this task doesn't
     * already track — the registry (Task 10) still owns dropping the room
     * from its map and the store.
     */
    sweep(): 'keep' | 'delete' {
        const now = this.deps.now();

        if (this.phase === 'ended') {
            if (this.endedAt !== null && now - this.endedAt > this.config.retentionMs) {
                return 'delete';
            }
            return 'keep';
        }

        if (this.phase !== 'lobby') {
            return 'keep'; // active-phase reaping (rows 12, 13) arrives in Task 10
        }

        let seatsReopened = false;
        for (const seat of this.seats) {
            if (
                // The host seat NEVER reopens: whoever claimed a reopened
                // seat 0 would become 'p1' and pass every host gate — the
                // §13 host race reintroduced through a side door. Host
                // absence is resolved by dissolution (transition 4) or the
                // lobby TTL below, only ever by this seat's own token.
                seat.index !== HOST_SEAT_INDEX &&
                seat.tokenHash !== null &&
                seat.conn === null &&
                seat.disconnectedAt !== null &&
                now - seat.disconnectedAt > this.config.lobbyDisconnectGraceMs
            ) {
                // tokenHash cleared, not merely the conn: the old token must die (Design §5 row 3).
                seat.tokenHash = null;
                seat.nickname = null;
                seat.disconnectedAt = null;
                seatsReopened = true;
            }
        }

        if (now - this.createdAt > this.config.lobbyTtlMs) {
            this.transitionToEnded('abandoned', null);
            this.persist();
            this.broadcastMatchEnded('abandoned');
            return 'keep';
        }

        if (seatsReopened) {
            this.persist();
            this.broadcastLobbyUpdate();
        }

        return 'keep';
    }

    // ------------------------------------------------------------ internals

    private seatStatus(seat: Seat): SeatStatus {
        if (seat.tokenHash === null) return 'open';
        return seat.conn !== null ? 'occupied' : 'disconnected';
    }

    /** `>=2 AND <=4` claimed seats, all connected — the only condition, in either direction. */
    private canStart(): boolean {
        const claimed = this.seats.filter(s => s.tokenHash !== null);
        return claimed.length >= 2 && claimed.length <= 4 && claimed.every(s => s.conn !== null);
    }

    /**
     * Arms the real reveal-window timer (Design §6). Preconditions are
     * established by every call site, not re-asserted here: `commitMatchState`
     * only calls this when `!isMatchOver(state) && round.phase === 'round-over'`,
     * and `resumeSeat` only when that resume is what cleared the last missing
     * seat during a round-over. Both sites are already inside `phase ===
     * 'active'` and neither is reachable while `paused` — this method assumes
     * that context rather than re-checking it.
     *
     * `advanceRound` is the timer's target, and it is re-entered through
     * `enqueue` exactly like any client message (Design §10) — so round
     * advancement has no unserialized path of its own. A throw out of
     * `advanceRound` (i.e. out of `deps.startNextRound`) would otherwise be an
     * unhandled rejection on the promise `enqueue` returns; it is caught here
     * and logged instead (Design §8 step 10's "log, never crash a socket
     * handler" philosophy, applied to a timer instead of a message).
     */
    private armRevealTimer(): void {
        this.clearRevealTimer();
        this.revealDeadline = this.deps.now() + this.config.revealWindowMs;
        this.revealTimer = setTimeout(() => {
            void this.enqueue(() => this.advanceRound()).catch(err => {
                console.error('advanceRound failed', this.matchId, err);
            });
        }, this.config.revealWindowMs);
    }

    /** Clears both the scheduled timeout and the deadline it backs — the only way either is unset. */
    private clearRevealTimer(): void {
        if (this.revealTimer !== null) {
            clearTimeout(this.revealTimer);
            this.revealTimer = null;
        }
        this.revealDeadline = null;
    }

    /**
     * `armRevealTimer`'s scheduled callback, routed through `enqueue`. Design
     * §6's sketch and §13 row 10 ("advance lock leaks on an engine throw"):
     * every precondition is re-checked rather than trusted, because the world
     * may have moved on while this callback sat in the room's queue (a
     * disconnect, a manual `endMatch`, a match decided some other way).
     * `advancing` is a re-entrancy guard set/cleared around the call to
     * `deps.startNextRound`, released in `finally` so a throw from the engine
     * still leaves the room able to advance again later.
     */
    private advanceRound(): void {
        if (this.advancing) return;
        this.advancing = true;
        try {
            const match = this.match;
            if (
                this.phase !== 'active' ||
                match === null ||
                match.round.phase !== 'round-over' ||
                this.deps.isMatchOver(match) ||
                this.paused
            ) {
                return;
            }

            this.match = this.deps.startNextRound(match);
            this.clearRevealTimer();
            this.persist();
            this.pushStateToConnectedSeats();
        } finally {
            this.advancing = false;
        }
    }

    /** Shared iteration for both a full broadcast-by-loop push and resumeSeat's "everyone but the resumer" push. */
    private pushStateToConnectedSeats(exclude?: Seat): void {
        for (const seat of this.seats) {
            if (seat.conn !== null && seat !== exclude) {
                this.send(seat.conn, this.buildStateUpdate(seat));
            }
        }
    }

    private broadcastMatchEnded(reason: EndReason): void {
        const msg: ServerMessage =
            this.winnerSeat !== null
                ? { type: 'MATCH_ENDED', matchId: this.matchId, reason, winnerSeat: this.winnerSeat }
                : { type: 'MATCH_ENDED', matchId: this.matchId, reason };
        this.broadcast(msg);
    }

    /**
     * The ended-transition field cluster, shared by `commitMatchState`
     * (won), `endMatch` (abandoned), and `sweep`'s lobby-TTL branch
     * (abandoned) — a code-review consolidation. Sets phase/endReason/
     * winnerSeat/endedAt and clears any armed reveal timer; persisting,
     * pushing, and broadcasting stay with each caller since those differ
     * legitimately (e.g. `commitMatchState` has already pushed the
     * STATE_UPDATE batch that `MATCH_ENDED` follows; `endMatch` only pushes
     * when a match exists at all).
     */
    private transitionToEnded(reason: EndReason, winnerSeat: PlayerId | null): void {
        this.phase = 'ended';
        this.endReason = reason;
        this.winnerSeat = winnerSeat;
        this.endedAt = this.deps.now();
        this.clearRevealTimer();
    }

    /**
     * The commit sequence for a successful PLAY_CARD — the plan's Task 8
     * pseudocode, followed exactly (Design §6, §8 step 11, §13 rows 1 & 11):
     * match-over precedence is checked FIRST, never as a sibling conditional
     * to round-over, so an ordinary match win can never arm a timer that
     * later fires into a decided match. Arming (or match-over) happens
     * BEFORE persist so the round_over push already carries `revealDeadline`;
     * persist happens BEFORE any send (Design §9); MATCH_ENDED broadcasts
     * last, after every seat's final STATE_UPDATE.
     */
    private commitMatchState(state: MatchState): void {
        this.match = state;

        if (this.deps.isMatchOver(state)) {
            this.transitionToEnded('won', state.matchWinnerId);
        } else if (state.round.phase === 'round-over') {
            this.armRevealTimer();
        }

        this.persist();
        this.pushStateToConnectedSeats();

        if (this.phase === 'ended') {
            this.broadcastMatchEnded('won');
        }
    }

    /**
     * The only source of game data (Design §3): `view` from the engine,
     * `nicknames` beside it — never inside it, since the engine has no
     * concept of a display name.
     */
    private buildStateUpdate(seat: Seat): ServerMessage {
        const match = this.match;
        if (match === null) {
            throw new Error('buildStateUpdate requires an active or ended match');
        }

        const nicknames: Record<PlayerId, string> = {};
        for (const s of this.seats) {
            if (s.tokenHash !== null) nicknames[s.playerId] = s.nickname ?? '';
        }

        const wirePhase: 'active' | 'round_over' | 'ended' =
            this.phase === 'ended' ? 'ended' : match.round.phase === 'round-over' ? 'round_over' : 'active';

        return {
            type: 'STATE_UPDATE',
            view: this.deps.view(match, seat.playerId),
            nicknames,
            phase: wirePhase,
            paused: this.paused,
            missingSeats: this.missingSeats(),
            serverTime: this.deps.now(),
            // Cast kept: `endReason` is typed `EndReason | null` because it starts
            // null, but `transitionToEnded` always sets it in the same assignment
            // as `phase = 'ended'` — an invariant true by construction that TS
            // cannot see across methods/fields, so the null case here is provably
            // unreachable rather than actually possible.
            ...(this.phase === 'ended' ? { endReason: this.endReason as EndReason } : {}),
            ...(this.phase === 'ended' && this.winnerSeat !== null ? { winnerSeat: this.winnerSeat } : {}),
            ...(this.revealDeadline !== null ? { revealDeadline: this.revealDeadline } : {})
        };
    }

    private buildLobbyUpdate(): ServerMessage {
        return {
            type: 'LOBBY_UPDATE',
            matchId: this.matchId,
            hostSeat: HOST_PLAYER_ID,
            canStart: this.canStart(),
            seats: this.seats.map(s => ({
                seat: s.index,
                playerId: s.tokenHash === null ? null : s.playerId, // null for OPEN seats only
                nickname: s.nickname,
                status: this.seatStatus(s)
            }))
        };
    }

    private send(conn: SeatConnection, msg: ServerMessage): void {
        conn.send(JSON.stringify(msg));
    }

    /** `refId` echoes `clientMsgId`, present only when the client sent one (Design §3). */
    private sendError(conn: SeatConnection, code: ErrorCode, refId?: string): void {
        this.send(conn, refId !== undefined ? { type: 'ERROR', code, refId } : { type: 'ERROR', code });
    }

    /** A FATAL frame is always followed by a close — encoded here so the invariant cannot be half-applied. */
    private sendFatal(conn: SeatConnection, code: ErrorCode): void {
        this.send(conn, { type: 'FATAL', code });
        conn.close();
    }

    private broadcast(msg: ServerMessage): void {
        const json = JSON.stringify(msg);
        for (const seat of this.seats) {
            if (seat.conn !== null) seat.conn.send(json);
        }
    }

    private broadcastLobbyUpdate(): void {
        this.broadcast(this.buildLobbyUpdate());
    }

    /**
     * Only claimed seats persist (`StoredSeat.tokenHash` is non-nullable);
     * an open seat needs no row since the seat pool is the fixed `p1..p4`
     * indices — its absence from `seats` already means "open" on rebuild.
     * `nickname` is stored as `''` for a claimed seat with none yet (the
     * host, minted with no nickname over HTTP) since `StoredSeat.nickname`
     * is non-nullable and `parseNickname` never accepts an empty string, so
     * `''` unambiguously means "no nickname set".
     */
    private toStoredSeats(): StoredSeat[] {
        return this.seats
            .filter((s): s is Seat & { tokenHash: string } => s.tokenHash !== null)
            .map(s => ({
                index: s.index,
                playerId: s.playerId,
                nickname: s.nickname ?? '',
                tokenHash: s.tokenHash
            }));
    }

    /** `seed`/`actionLog` come from `match` once one exists; both stay `null`/`[]` in the lobby. */
    private persist(): void {
        const record: MatchRecord = {
            matchId: this.matchId,
            seed: this.match?.seed ?? null,
            hostSeat: HOST_PLAYER_ID,
            phase: this.phase,
            endReason: this.endReason,
            winnerSeat: this.winnerSeat,
            seats: this.toStoredSeats(),
            actionLog: this.match?.actionLog ?? [],
            quarantined: false,
            createdAt: this.createdAt,
            updatedAt: this.deps.now()
        };
        this.store.save(record);
    }
}
