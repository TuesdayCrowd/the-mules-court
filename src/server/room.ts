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
 * without leaving a dangling timer behind. Task 10 completes the lifecycle:
 * `Room.rebuild` (lazy crash recovery, Design §7, §9) and the active-phase
 * sweep branch (Design §5 row 13 — row 12 already lives in `endMatch` above).
 */

import {
    CARD_CATALOG,
    cardTypeOf,
    createMatch as engineCreateMatch,
    INFORMANT_VALUE,
    isMatchOver as engineIsMatchOver,
    reduce as engineReduce,
    startNextRound as engineStartNextRound,
    view as engineView
} from '../game/engine';
import type {
    CardInstanceId,
    GuessValue,
    MatchState,
    PlayCardAction,
    PlayerId,
    ReduceResult,
    RedactedView
} from '../game/engine';
import type { TransportConfig } from './config';
import type { EndReason, MatchPhase, MatchRecord, StoredSeat } from './persistence';
import { MatchStore, replayMatch } from './persistence';
import type { ClientMessage, ErrorCode, ServerMessage, SeatStatus } from './protocol';
import { hashToken, mintMatchId, mintSeed, mintToken, tokenMatches } from './seatTokens';
import { createOpponent } from '../game/ai/difficulty';
import { makeRng } from '../game/ai/rng';

/** The fixed seat pool: index 0 is always the host, minted before any join (Design §2, §13). */
const HOST_SEAT_INDEX = 0;
const HOST_PLAYER_ID: PlayerId = 'p1';

/**
 * Display names for computer opponents, indexed by seat.
 *
 * Minted here because `nickname` is a `StoredSeat` field and a bot has no
 * client to supply one — the same reason the host seat's nickname is adopted
 * over the wire rather than invented. Every name is a Foundation character who
 * is NOT a card, so a seat label can never be mistaken for a revealed hand.
 */
const BOT_NICKNAMES: readonly string[] = ['Preem Palver', 'Arkady Darell', 'Lathan Devers', 'Ducem Barr'];

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
    /**
     * A computer opponent the host seated (Computer Opponent Design §8).
     *
     * A bot seat holds a token and never holds a socket, which is precisely
     * the shape `missingSeats` was written to detect — so every derivation
     * built on "claimed but not connected" has to exclude it explicitly.
     * There are four: `missingSeats`, `canStart`, the lobby reaper's seat
     * reopening, and `sweepActive`'s zero-connection check.
     */
    bot: boolean;
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
    /**
     * What a computer opponent plays, given only its own redacted view.
     *
     * Injected for the same reason every other engine call here is: a test can
     * force a specific line of play. The signature is the real defence, though
     * — it takes a `RedactedView`, so a bot cannot be handed the deck even by
     * a caller trying to.
     */
    chooseBotPlay?: (view: RedactedView) => BotPlay | null;
}

/** A bot's move, shaped like `PLAY_CARD`'s payload minus the routing. */
export interface BotPlay {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

/**
 * The default policy: the strongest tier from `src/game/ai/`.
 *
 * One generator per room, seeded from the match id so a room's bots replay
 * identically. It cannot affect the deal — the engine's own RNG is a separate
 * stream — so this only ever decides how a tie between equally-scored moves
 * falls.
 */
function defaultBotPlay(matchId: string): (view: RedactedView) => BotPlay | null {
    const rng = makeRng(`bots:${matchId}`);
    // The strongest tier. Its budget is 50ms of wall clock, which is a twenty-
    // fourth of the 1200ms pacing a player already waits — but it is synchronous
    // inside this process, so it is 50ms no other room's socket is served in.
    // That is affordable at this scale and is the first thing to revisit if one
    // process ever holds many simultaneous solo matches.
    const policy = createOpponent('master');
    return view => policy.decide(view, rng);
}

/**
 * The engine's own first offer — a stall-breaker, not a policy.
 *
 * Reached only when a policy proposes something `reduce` refuses, which means
 * the policy restated a rule. A dull legal move beats a table that stops.
 */
function firstLegalPlay(view: RedactedView): BotPlay | null {
    const cardInstanceId = view.own.legalPlays[0];
    if (cardInstanceId === undefined) return null;

    const target = (view.own.legalTargets[cardInstanceId] ?? [])[0];
    if (target === undefined) return { cardInstanceId };

    const isInformant = CARD_CATALOG[cardTypeOf(cardInstanceId)].value === INFORMANT_VALUE;
    return { cardInstanceId, target, ...(isInformant ? { guess: 2 as GuessValue } : {}) };
}

function makeEmptySeats(): Seat[] {
    return [0, 1, 2, 3].map(index => ({
        index,
        playerId: `p${index + 1}`,
        nickname: null,
        tokenHash: null,
        conn: null,
        disconnectedAt: null,
        bot: false
    }));
}

/**
 * Rebuilds the seat table from a persisted record (Design §7, §9; Task 10).
 * Every claimed seat comes back disconnected with `disconnectedAt` stamped
 * at REBUILD time, never at whatever it was before the crash: a rebuilt room
 * is indistinguishable from a mass disconnect, and every grace window
 * (lobby reopening, `activeGraceMs`, `zeroConnTtlMs`) must measure from this
 * instant, never a lost past the process has no record of.
 */
function restoreSeats(stored: readonly StoredSeat[], rebuiltAt: number): Seat[] {
    const seats = makeEmptySeats();
    for (const s of stored) {
        const seat = seats[s.index];
        seat.tokenHash = s.tokenHash;
        // '' unambiguously means "no nickname set" — the mirror of toStoredSeats below.
        seat.nickname = s.nickname === '' ? null : s.nickname;
        seat.conn = null;
        seat.bot = s.bot === true;
        // A rebuilt bot is not "disconnected" — it never had a socket to lose,
        // and stamping this would make it look missing to every grace window.
        seat.disconnectedAt = seat.bot ? null : rebuiltAt;
    }
    return seats;
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

    /** The pending computer move, if the seat holding the turn is a bot. */
    private botTimer: ReturnType<typeof setTimeout> | null;

    private queue: Promise<void> = Promise.resolve();

    private constructor(
        matchId: string,
        seats: Seat[],
        phase: MatchPhase,
        createdAt: number,
        config: TransportConfig,
        store: MatchStore,
        deps: Required<RoomDeps>,
        // Rebuild-only initial state (Task 10): `create()` never passes this,
        // so every field defaults exactly as before. `rebuild()` is the one
        // other caller, and supplies whichever of these its phase needs.
        initial: { match?: MatchState | null; endReason?: EndReason | null; winnerSeat?: PlayerId | null; endedAt?: number | null } = {}
    ) {
        this.matchId = matchId;
        this.seats = seats;
        this.phase = phase;
        this.endReason = initial.endReason ?? null;
        this.winnerSeat = initial.winnerSeat ?? null;
        this.endedAt = initial.endedAt ?? null;
        this.match = initial.match ?? null;
        this.revealDeadline = null;
        this.revealTimer = null;
        this.advancing = false;
        this.botTimer = null;
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
        // Minted before the deps rather than at construction, because the
        // default bot policy seeds its generator from it.
        const matchId = mintMatchId();
        const resolvedDeps: Required<RoomDeps> = {
            now: deps.now ?? Date.now,
            createMatch: deps.createMatch ?? engineCreateMatch,
            reduce: deps.reduce ?? engineReduce,
            startNextRound: deps.startNextRound ?? engineStartNextRound,
            view: deps.view ?? engineView,
            isMatchOver: deps.isMatchOver ?? engineIsMatchOver,
            chooseBotPlay: deps.chooseBotPlay ?? defaultBotPlay(matchId)
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

        const room = new Room(matchId, seats, 'lobby', createdAt, config, store, resolvedDeps);
        room.persist();

        return { room, hostSeatToken };
    }

    /**
     * Lazy crash recovery (Design §7, §9; plan Task 10). Called by the
     * registry on a cold `get()` — never eagerly for every stored row, so a
     * restart with many rooms doesn't stall before it can accept
     * connections. Every phase restores the seat table the same way
     * (`restoreSeats`): a rebuilt room is indistinguishable from everybody
     * having disconnected at once, and `disconnectedAt` is stamped at THIS
     * instant so every grace window measures from the rebuild, never a lost
     * past.
     *
     *  - `'lobby'`: no match; otherwise a plain lobby room.
     *  - `'active'`: replays `{seed, actionLog}` through the real engine
     *    (`replayMatch`). A null seed or a replay that fails validation both
     *    mean a corrupt log — the row is quarantined and `null` returned so
     *    the caller treats this id as gone rather than trusting a state
     *    nobody can reconstruct. No timer is armed here even if the
     *    replayed match sits at round-over: the room comes back fully
     *    paused (every seat missing), and the ordinary resume flow (Design
     *    §7) re-arms it the moment someone actually reconnects — arming a
     *    timer with nobody here to see it would just burn a countdown into
     *    silence.
     *  - `'ended'`: a corpse awaiting retention deletion. No replay needed —
     *    nobody will ever play this match again — so `match` stays `null`;
     *    `resync`/dispatch's gates answer `MATCH_OVER` without one (Task 11).
     *    `endedAt` is not itself a persisted column, but `updatedAt`
     *    coincides with the ended-transition's own `persist()` call
     *    (`transitionToEnded` is always immediately followed by `persist()`
     *    everywhere above), so `record.updatedAt` is exactly the value
     *    `endedAt` held right before the crash. Skipping this would leave
     *    `sweep`'s retention check with no deadline to compare against, and
     *    a rebuilt ended room would never get deleted.
     */
    static rebuild(config: TransportConfig, store: MatchStore, record: MatchRecord, deps: RoomDeps = {}): Room | null {
        const resolvedDeps: Required<RoomDeps> = {
            now: deps.now ?? Date.now,
            createMatch: deps.createMatch ?? engineCreateMatch,
            reduce: deps.reduce ?? engineReduce,
            startNextRound: deps.startNextRound ?? engineStartNextRound,
            view: deps.view ?? engineView,
            isMatchOver: deps.isMatchOver ?? engineIsMatchOver,
            chooseBotPlay: deps.chooseBotPlay ?? defaultBotPlay(record.matchId)
        };

        const seats = restoreSeats(record.seats, resolvedDeps.now());

        if (record.phase === 'lobby') {
            return new Room(record.matchId, seats, 'lobby', record.createdAt, config, store, resolvedDeps);
        }

        if (record.phase === 'active') {
            if (record.seed === null) {
                store.quarantine(record.matchId);
                return null;
            }
            // Seat order is already index order from toStoredSeats(), but a
            // fixed sort documents that guarantee rather than leaning on it.
            const playerIds = [...record.seats].sort((a, b) => a.index - b.index).map(s => s.playerId);
            const matchState = replayMatch(playerIds, record.seed, record.matchId, record.actionLog);
            if (matchState === null) {
                store.quarantine(record.matchId);
                return null;
            }
            return new Room(record.matchId, seats, 'active', record.createdAt, config, store, resolvedDeps, {
                match: matchState
            });
        }

        // 'ended'
        return new Room(record.matchId, seats, 'ended', record.createdAt, config, store, resolvedDeps, {
            endReason: record.endReason,
            winnerSeat: record.winnerSeat,
            endedAt: record.updatedAt
        });
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
    resumeSeat(conn: SeatConnection, token: string, nickname?: string): { seat: number; playerId: PlayerId } | null {
        const seat = this.seats.find(s => s.tokenHash !== null && tokenMatches(token, s.tokenHash));
        if (!seat) {
            this.sendFatal(conn, 'BAD_TOKEN');
            return null;
        }

        // UIX §13.1: the host seat is minted over HTTP with no nickname, and
        // `claimSeat` — the only other writer — never runs for it. Adopt one
        // exactly once, in lobby only. Both guards matter: the seat token is
        // this system's only credential, so allowing a rename on top of it
        // would make it an impersonation primitive, and nicknames resolve the
        // public log, so a mid-match rename would retroactively change who the
        // narration says played what. Persisted before any send (Design §9),
        // because `nickname` is a `StoredSeat` field and a rebuilt room must
        // not resurrect a blank host.
        if (nickname !== undefined && seat.nickname === null && this.phase === 'lobby') {
            seat.nickname = nickname;
            this.persist();
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
            // The bots stopped when the table paused; a resume is what restarts
            // them, and only after the state push so the reconnecting player
            // sees the position before it moves.
            this.scheduleBotTurn();
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
            // Re-evaluated rather than merely cleared: this returns early while
            // the table is paused, which is exactly the behaviour wanted, and
            // stays correct if the departing seat was not the one to move.
            this.scheduleBotTurn();
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
        this.scheduleBotTurn();
    }

    /**
     * Seats a computer opponent (Computer Opponent Design §8).
     *
     * Host only, lobby only, and only into a seat nobody holds — the host's own
     * seat needs no special case, because it is claimed from the moment the room
     * is minted and so fails the same check as any occupied seat.
     *
     * A bot seat mints a token like any other and simply never hands it out.
     * That keeps one answer to "is this seat taken" across `claimSeat`,
     * `resumeSeat`, `canStart` and the reaper, rather than adding a second kind
     * of occupancy every one of them would have to learn about.
     */
    addBot(conn: SeatConnection, seatIndex: number): void {
        if (this.phase !== 'lobby') {
            this.sendError(conn, 'CANNOT_START');
            return;
        }

        if (this.seats[HOST_SEAT_INDEX].conn !== conn) {
            this.sendError(conn, 'NOT_HOST');
            return;
        }

        const seat = this.seats[seatIndex];
        if (seat === undefined || seat.tokenHash !== null) {
            this.sendError(conn, 'SEAT_TAKEN');
            return;
        }

        seat.tokenHash = hashToken(mintToken());
        seat.nickname = BOT_NICKNAMES[seat.index] ?? `Computer ${seat.index + 1}`;
        seat.bot = true;
        seat.conn = null;
        seat.disconnectedAt = null;

        this.persist();
        this.broadcastLobbyUpdate();
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
                    !s.bot &&
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
        this.clearBotTimer();
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
        return this.seats
            .filter(s => s.tokenHash !== null && !s.bot && s.conn === null)
            .map(s => s.playerId);
    }

    /** Never a settable flag — always recomputed (Design §5). Not yet surfaced to clients in lobby phase. */
    get paused(): boolean {
        return this.missingSeats().length > 0;
    }

    /**
     * Every phase's reaper-driven transition (Design §5 rows 3, 6, 13, 14):
     * a disconnected lobby seat past grace reopens; a lobby past its TTL
     * ends; an active match with zero connections past `zeroConnTtlMs`
     * ends abandoned (row 13 — row 12, the grace-based `END_MATCH` a
     * connected player can call themselves, already lives in `endMatch`
     * above); an ended room past `retentionMs` is reported for deletion.
     * `'delete'` itself is only ever returned from the `ended` branch — the
     * registry (Task 10) still owns dropping the room from its map and the
     * store once told to.
     */
    sweep(): 'keep' | 'delete' {
        const now = this.deps.now();

        if (this.phase === 'ended') {
            if (this.endedAt !== null && now - this.endedAt > this.config.retentionMs) {
                return 'delete';
            }
            return 'keep';
        }

        if (this.phase === 'active') {
            this.sweepActive(now);
            return 'keep'; // active rooms are only ever removed via the 'ended' branch, on a LATER sweep
        }

        // phase === 'lobby' — the only case left.
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
                // A bot has no socket to have lost, so it never ages out.
                !seat.bot &&
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
        if (seat.bot) return 'computer';
        return seat.conn !== null ? 'occupied' : 'disconnected';
    }

    /**
     * `>=2 AND <=4` claimed seats, all connected — the only condition, in
     * either direction. A bot seat counts as claimed and is never waited on,
     * which is what lets one host start a table alone.
     */
    private canStart(): boolean {
        const claimed = this.seats.filter(s => s.tokenHash !== null);
        return (
            claimed.length >= 2 &&
            claimed.length <= 4 &&
            claimed.every(s => s.conn !== null || s.bot)
        );
    }

    /**
     * Design §5 transition 13 — the reaper's own backstop for an active
     * match nobody is left to end. Transition 12 (grace-based `END_MATCH` by
     * ANY connected seat once someone else has been missing past
     * `activeGraceMs`) already lives in `endMatch` above, but that requires
     * somebody connected to call it. When every claimed seat is missing,
     * there is nobody left to — so once the longest absence clears
     * `zeroConnTtlMs`, the room ends itself the same way `endMatch` would.
     *
     * `disconnectedAt` is non-null for every claimed seat counted here by
     * construction: a claimed seat only ever has `conn === null` after
     * `handleClose` or a rebuild, and both stamp `disconnectedAt` in the same
     * step that clears `conn` — so the `as number` below is provably safe,
     * not merely assumed. `broadcastMatchEnded` is a no-op with zero
     * connected seats; it still runs so this transition commits through the
     * exact same end-of-match code path as every other one, not a bespoke
     * copy of it.
     */
    private sweepActive(now: number): void {
        // Human seats only. A table of three bots plus one departed human has
        // nobody left watching it, which is exactly the case this ends; counting
        // the bots as present would keep it alive forever.
        const claimed = this.seats.filter(s => s.tokenHash !== null && !s.bot);
        const zeroConnected = claimed.length > 0 && claimed.every(s => s.conn === null);
        if (!zeroConnected) return;

        const longestMissingMs = Math.max(...claimed.map(s => now - (s.disconnectedAt as number)));
        if (longestMissingMs <= this.config.zeroConnTtlMs) return;

        this.transitionToEnded('abandoned', null);
        this.persist();
        this.broadcastMatchEnded('abandoned');
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

    /**
     * Schedules the seat holding the turn to move, when that seat is a bot.
     *
     * Idempotent by construction: it clears any pending move first, so every
     * call site can simply re-evaluate rather than reason about whether a timer
     * is already armed. A round-over deliberately schedules nothing — the
     * reveal timer owns that window, and `advanceRound` calls back here once
     * the next round is dealt.
     *
     * The delay is pacing (`botThinkMs`), not compute. Deciding takes well
     * under a millisecond, and the work happens inside the timer rather than
     * before it so one process serving many rooms is never blocked by a bot
     * thinking.
     */
    private scheduleBotTurn(): void {
        this.clearBotTimer();

        const match = this.match;
        if (this.phase !== 'active' || match === null || this.paused) return;
        if (match.round.phase !== 'awaiting-play') return;
        if (this.deps.isMatchOver(match)) return;

        const currentId = match.round.seatOrder[match.round.currentPlayerIndex];
        const seat = this.seats.find(s => s.playerId === currentId);
        if (seat === undefined || !seat.bot) return;

        this.botTimer = setTimeout(() => {
            // Through `enqueue`, exactly like a client message (Design §10), so
            // a computer move has no unserialized path of its own.
            void this.enqueue(() => this.playBotTurn(seat)).catch(err => {
                console.error('bot turn failed', this.matchId, seat.playerId, err);
            });
        }, this.config.botThinkMs);
    }

    private clearBotTimer(): void {
        if (this.botTimer !== null) {
            clearTimeout(this.botTimer);
            this.botTimer = null;
        }
    }

    /**
     * Plays one computer move, through the same `reduce` + `commitMatchState`
     * path a human's `PLAY_CARD` takes — which is what puts it in `actionLog`
     * and makes a solo match replay and persist like any other.
     *
     * Every precondition is re-checked rather than trusted: this ran as a timer
     * callback and then waited in the room's queue, so the world may have moved
     * (a disconnect, an `END_MATCH`, a match decided some other way).
     */
    private playBotTurn(seat: Seat): void {
        const match = this.match;
        if (this.phase !== 'active' || match === null || this.paused) return;
        if (match.round.phase !== 'awaiting-play') return;
        if (!seat.bot || match.round.seatOrder[match.round.currentPlayerIndex] !== seat.playerId) {
            return;
        }

        const seatView = this.deps.view(match, seat.playerId);
        const play = (move: BotPlay) =>
            this.deps.reduce(match, { type: 'PLAY_CARD', playerId: seat.playerId, ...move });

        const chosen = this.deps.chooseBotPlay(seatView);
        const result = chosen === null ? null : play(chosen);

        if (result !== null && result.ok) {
            this.commitMatchState(result.state);
            return;
        }

        // A refused move means the policy restated a rule somewhere. That is a
        // bug worth shouting about, but not one worth freezing a table over.
        if (result !== null) {
            console.error('bot move refused', this.matchId, seat.playerId, result.error.code);
        }

        const fallback = firstLegalPlay(seatView);
        if (fallback === null) return;

        const retry = play(fallback);
        if (retry.ok) this.commitMatchState(retry.state);
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
            this.scheduleBotTurn();
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

        // Last, so a chain of consecutive computer turns is driven by the same
        // commit path a human's move takes rather than by a loop of its own.
        this.scheduleBotTurn();
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
                tokenHash: s.tokenHash,
                ...(s.bot ? { bot: true } : {})
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
