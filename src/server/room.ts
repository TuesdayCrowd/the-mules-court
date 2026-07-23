/**
 * The Room class (Design §2, §4, §5, §10): one Room owns a fixed 4-slot seat
 * table, a serialization queue, and every send for its match. Room performs
 * ALL sends itself — unicast via `seat.conn.send`, "broadcast" as the same
 * bytes looped over connected seats (this project's deliberate deviation from
 * `ws.publish()`, see the implementation plan's Stage conventions) — so Room
 * is directly testable with a plain recording connection and no running
 * server.
 *
 * Seat status is derived, never stored: `open` (no tokenHash), `occupied`
 * (conn bound), `disconnected` (tokenHash, no conn). `paused` is likewise
 * derived as `missingSeats().length > 0` and is never a settable flag
 * (Design §5) — it is not yet surfaced to clients in the lobby phase, but is
 * already correct so Task 8 needs no rework.
 *
 * This file implements only the lobby-phase surface (Design §5 transitions
 * 1, 2, 3, 6): `create`, `claimSeat`, `resumeSeat`, `handleClose`, `enqueue`,
 * and lobby `sweep`. `startMatch`, `playCard`, `endMatch`, `resync`, and
 * active/ended-phase `sweep` transitions arrive in Tasks 8-10.
 */

import type { PlayerId } from '../game/engine';
import type { TransportConfig } from './config';
import type { EndReason, MatchPhase, MatchRecord, StoredSeat } from './persistence';
import { MatchStore } from './persistence';
import type { ErrorCode, ServerMessage, SeatStatus } from './protocol';
import { hashToken, mintMatchId, mintToken, tokenMatches } from './seatTokens';

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

/** Engine fn overrides arrive in Tasks 8-9; this task only needs the clock. */
export interface RoomDeps {
    now?: () => number;
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
        const resolvedDeps: Required<RoomDeps> = { now: deps.now ?? Date.now };
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

        seat.conn = conn;
        seat.disconnectedAt = null;

        if (this.phase === 'lobby') {
            this.broadcastLobbyUpdate();
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
            this.phase = 'ended';
            this.endReason = 'abandoned';
            this.endedAt = now;
            this.persist();
            this.broadcast({ type: 'MATCH_ENDED', matchId: this.matchId, reason: 'abandoned' });
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

    private sendError(conn: SeatConnection, code: ErrorCode): void {
        this.send(conn, { type: 'ERROR', code });
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

    /** seed: null and actionLog: [] for every lobby record (controller decision 3) — Task 8 adds the engine. */
    private persist(): void {
        const record: MatchRecord = {
            matchId: this.matchId,
            seed: null,
            hostSeat: HOST_PLAYER_ID,
            phase: this.phase,
            endReason: this.endReason,
            winnerSeat: this.winnerSeat,
            seats: this.toStoredSeats(),
            actionLog: [],
            quarantined: false,
            createdAt: this.createdAt,
            updatedAt: this.deps.now()
        };
        this.store.save(record);
    }
}
