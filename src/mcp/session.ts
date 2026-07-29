/**
 * The seven tools, as a session object with no MCP in it (Design §4).
 *
 * Everything the tool surface decides lives here; the MCP layer above is meant
 * to be glue thin enough to review by reading — the same split `Court` keeps
 * with `buildRenderPlan` and `computeLayout`, and for the same reason. It also
 * means the whole tool surface is testable against a fake seat, with no stdio
 * transport and no dependency this repo has not yet taken.
 *
 * Three of the seven are public and safe for the referee: `joinMatch`,
 * `awaitTurn`, `tableStatus`. Four require a handle and serve exactly one seat:
 * `getView`, `playCard`, `readNotebook`, `writeNotebook`. `joinMatch` is the
 * only place a handle is ever returned, which is what makes that split
 * enforceable rather than aspirational.
 */

import type { PlayerId, RedactedView } from '../game/engine';
import { SeatClient, type SeatIdentity, type SeatPlay, type StateUpdate } from './seatClient';
import { SeatRegistry, type PublicSeat } from './seatRegistry';
import { routeTurn, type TurnSignal, type WirePhase } from './turnRouter';

/**
 * What the session needs from a seat. `SeatClient` satisfies it structurally,
 * so the session never imports the socket — and a fake seat needs no network.
 */
export interface Seat {
    readonly identity: SeatIdentity;
    readonly lastState: StateUpdate | null;
    nextState(timeoutMs?: number): Promise<StateUpdate>;
    play(move: SeatPlay, clientMsgId?: string): void;
    close(): void;
}

export type SeatConnector = (url: string, matchId: string, nickname: string) => Promise<Seat>;

export interface MatchSessionDeps {
    readonly connect?: SeatConnector;
    readonly now?: () => number;
}

/** The one payload that carries a handle. Returned once, from `joinMatch`. */
export interface JoinedSeat {
    readonly seat: number;
    readonly handle: string;
    readonly nickname: string;
    /**
     * Included deliberately, though Design §4's table abbreviates it away: the
     * referee is handed a `PlayerId` by `awaitTurn` and needs the mapping back
     * to a handle in order to dispatch. Without it the routing signal is
     * unusable.
     */
    readonly playerId: PlayerId;
}

export type ToolError = 'UNKNOWN_HANDLE' | 'NOT_STARTED' | 'NO_RESPONSE';

export interface Refusal {
    readonly ok: false;
    readonly error: ToolError;
}

export type ViewResult = { readonly ok: true; readonly view: RedactedView; readonly nicknames: Record<PlayerId, string> } | Refusal;
export type NotebookResult = { readonly ok: true; readonly text: string } | Refusal;
export type AckResult = { readonly ok: true } | Refusal;

export interface TableStatus {
    readonly matchId: string;
    readonly seats: readonly PublicSeat[];
    readonly nicknames: Record<PlayerId, string>;
    readonly phase: WirePhase | 'not_started';
    readonly paused: boolean;
    readonly turnNumber: number;
    readonly currentPlayerId: PlayerId | null;
    readonly recentLog: RedactedView['publicLog'];
}

/**
 * How much of the public log `tableStatus` returns.
 *
 * A tail rather than the whole thing: the log is public, so length is not a
 * disclosure question, but a referee narrating a match wants what just
 * happened and the full history is `roundHistory`'s job.
 */
const LOG_TAIL = 12;

/**
 * `awaitTurn`'s default. **This is the one number Design §7 sets.** A
 * continuous referee loop wants it just under the harness's tool-call ceiling,
 * so a human's think time resolves inside a single blocked call instead of
 * churning through re-entries; a nudge-driven referee barely touches it,
 * because it only calls when a move is already pending. Sixty seconds is the
 * conservative middle until that question is answered.
 */
const DEFAULT_AWAIT_MS = 60_000;

const PLAY_CONFIRM_MS = 5_000;

export class MatchSession {
    private readonly registry = new SeatRegistry();
    /** handle → the socket it authorises. The other half of the capability table. */
    private readonly seats = new Map<string, Seat>();
    /**
     * One outstanding `nextState` per seat, reused across overlapping waits.
     *
     * Not an optimisation — a correctness fix. `SeatClient` hands each push to
     * one waiter, so registering a fresh waiter per `awaitTurn` call would
     * leave the previous ones queued to swallow the next pushes, and a later
     * call would block behind pushes that had already arrived.
     */
    private readonly waiting = new Map<Seat, Promise<void>>();

    private readonly connect: SeatConnector;
    private readonly now: () => number;
    private matchId = '';

    constructor(deps: MatchSessionDeps = {}) {
        this.connect = deps.connect ?? ((url, matchId, nickname) => SeatClient.claim(url, matchId, nickname));
        this.now = deps.now ?? Date.now;
    }

    // ------------------------------------------------------------ public tools

    /**
     * Claims one seat per nickname and returns their handles — once.
     *
     * Sequential rather than parallel, because the server assigns the lowest
     * open seat and three simultaneous claims would make which nickname landed
     * in which seat a race.
     */
    async joinMatch(input: { matchId: string; nicknames: readonly string[]; serverUrl: string }): Promise<JoinedSeat[]> {
        this.matchId = input.matchId;
        const joined: JoinedSeat[] = [];

        for (const nickname of input.nicknames) {
            const seat = await this.connect(input.serverUrl, input.matchId, nickname);
            const handle = this.registry.claim({
                playerId: seat.identity.playerId,
                seat: seat.identity.seat,
                nickname: seat.identity.nickname,
                seatToken: seat.identity.seatToken
            });
            this.seats.set(handle, seat);
            joined.push({ seat: seat.identity.seat, handle, nickname: seat.identity.nickname, playerId: seat.identity.playerId });
        }

        return joined;
    }

    /**
     * Blocks until one of the held seats holds the turn.
     *
     * Returns at once for `your_turn` and `match_over` — one is the thing being
     * waited for and the other means there is nothing left to wait for. It
     * blocks *through* `round_over` rather than returning it, because the
     * reveal window is a ten-second server timer and a referee that returned
     * immediately would spin on it; the status still surfaces on timeout, so a
     * caller learns why it waited.
     *
     * Carries no hand. `routeTurn` decides from `currentPlayerId`, which every
     * player at the table already sees.
     */
    async awaitTurn(timeoutMs = DEFAULT_AWAIT_MS): Promise<TurnSignal> {
        const deadline = this.now() + timeoutMs;

        for (;;) {
            const signal = this.signal();
            if (signal.status === 'your_turn' || signal.status === 'match_over') return signal;

            const remaining = deadline - this.now();
            if (remaining <= 0) return signal;

            await this.raceNextPush(remaining);
        }
    }

    /** Public state only: the roster, the phase, and the tail of the public log. */
    tableStatus(): TableStatus {
        const state = this.anyState();
        return {
            matchId: this.matchId,
            seats: this.registry.roster(),
            nicknames: state?.nicknames ?? {},
            phase: state?.phase ?? 'not_started',
            paused: state?.paused ?? false,
            turnNumber: state?.view.turnNumber ?? 0,
            currentPlayerId: state?.view.currentPlayerId ?? null,
            recentLog: state === null ? [] : state.view.publicLog.slice(-LOG_TAIL)
        };
    }

    // -------------------------------------------------------- seat-scoped tools

    getView(handle: string): ViewResult {
        const seat = this.seats.get(handle);
        if (seat === undefined) return { ok: false, error: 'UNKNOWN_HANDLE' };
        if (seat.lastState === null) return { ok: false, error: 'NOT_STARTED' };
        return { ok: true, view: seat.lastState.view, nicknames: seat.lastState.nicknames };
    }

    /**
     * Sends a move and waits for the push that confirms it.
     *
     * The waiter is registered *before* the frame goes out, so a fast server
     * cannot answer into a gap. One constraint the referee loop already
     * respects: this must not overlap with `awaitTurn` on the same seat, since
     * a single push resolves a single waiter — play, then await.
     */
    async playCard(handle: string, move: SeatPlay, timeoutMs = PLAY_CONFIRM_MS): Promise<AckResult> {
        const seat = this.seats.get(handle);
        if (seat === undefined) return { ok: false, error: 'UNKNOWN_HANDLE' };

        const confirmed = seat.nextState(timeoutMs).then(
            () => true,
            () => false
        );
        seat.play(move);

        return (await confirmed) ? { ok: true } : { ok: false, error: 'NO_RESPONSE' };
    }

    readNotebook(handle: string): NotebookResult {
        const text = this.registry.readNotebook(handle);
        if (text === undefined) return { ok: false, error: 'UNKNOWN_HANDLE' };
        return { ok: true, text };
    }

    writeNotebook(handle: string, text: string): AckResult {
        return this.registry.writeNotebook(handle, text) ? { ok: true } : { ok: false, error: 'UNKNOWN_HANDLE' };
    }

    /** Closes every socket. The match is ephemeral; nothing is persisted. */
    close(): void {
        for (const seat of this.seats.values()) seat.close();
        this.seats.clear();
        this.waiting.clear();
    }

    // ------------------------------------------------------------------ internals

    /**
     * Any seat's latest push, for the fields every push shares.
     *
     * `currentPlayerId`, `turnNumber`, `phase` and `paused` are identical
     * across the three, so reading one seat's frame for them discloses
     * nothing — and `own` is never touched here.
     */
    private anyState(): StateUpdate | null {
        for (const seat of this.seats.values()) {
            if (seat.lastState !== null) return seat.lastState;
        }
        return null;
    }

    private signal(): TurnSignal {
        const state = this.anyState();
        // Before the first push there is no phase to report. `waiting` is the
        // honest answer: no seat we hold has the turn, because no turn exists.
        if (state === null) return { status: 'waiting', turnNumber: 0, phase: 'active' };

        return routeTurn({
            heldPlayerIds: this.registry.heldPlayerIds(),
            currentPlayerId: state.view.currentPlayerId,
            turnNumber: state.view.turnNumber,
            phase: state.phase,
            paused: state.paused
        });
    }

    /** Resolves as soon as any held seat sees a push, or when `timeoutMs` elapses. */
    private raceNextPush(timeoutMs: number): Promise<void> {
        const seats = [...this.seats.values()];
        if (seats.length === 0) return Promise.resolve();

        return new Promise(resolve => {
            const timer = setTimeout(resolve, timeoutMs);
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            for (const seat of seats) void this.waitFor(seat, timeoutMs).then(done);
        });
    }

    private waitFor(seat: Seat, timeoutMs: number): Promise<void> {
        const outstanding = this.waiting.get(seat);
        if (outstanding !== undefined) return outstanding;

        const wait = seat
            .nextState(timeoutMs)
            .then(
                () => undefined,
                () => undefined
            )
            .finally(() => this.waiting.delete(seat));

        this.waiting.set(seat, wait);
        return wait;
    }
}
