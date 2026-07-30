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
import type { ErrorCode } from '../server/protocol';
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
    /** The most recent ERROR frame, so a refused play can name its reason. */
    readonly lastError: { readonly code: ErrorCode } | null;
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

/**
 * Why a tool refused. The first three are this layer's own; the rest are the
 * engine's, forwarded verbatim, because a seat told `NOT_YOUR_SEAT` can act on
 * that and a seat told `NO_RESPONSE` cannot.
 */
export type ToolError = 'UNKNOWN_HANDLE' | 'NOT_STARTED' | 'NO_RESPONSE' | ErrorCode;

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
 * `awaitTurn`'s default, and the one number Design §7 sets.
 *
 * §7 chose the continuous loop: the referee stays running for a whole match, so
 * this call blocks on a human's think time and wants to be as long as the
 * harness will tolerate.
 *
 * Ninety seconds — and the binding constraint is not the one it looks like.
 * Claude Code's per-call wall-clock limit (`MCP_TOOL_TIMEOUT`) defaults to
 * roughly 28 hours, and the idle timeout for a stdio server to 30 minutes;
 * neither is anywhere near the horizon here. What bites first is **automatic
 * backgrounding**: a main-conversation tool call that runs past two minutes is
 * moved to a background task. Right for a long build, wrong for a turn-based
 * game, where it would tear the referee out of its own loop mid-match.
 *
 * So the target is "comfortably under two minutes", not "as long as possible".
 * A human who thinks for more than ninety seconds costs one extra re-entry,
 * which is the cheap failure; a backgrounded referee costs the loop.
 */
const DEFAULT_AWAIT_MS = 90_000;

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
     * Sends a move and waits until the table has actually moved on.
     *
     * Confirmation is a **condition**, not an event, and that distinction was a
     * real bug. Waiting for "a push arrived" is satisfied by any push —
     * including one already sitting in the socket's queue from before the move
     * was sent. `playCard` then returned while the seat's view still showed its
     * own turn, the referee looped, `await_turn` handed the same seat the same
     * turn a second time, and `get_view` — by then holding the post-play frame
     * — reported no legal plays. That is precisely how the stdio suite failed.
     *
     * Waiting for the view to *advance* cannot be fooled that way: a stale
     * queued frame simply fails the check and the loop waits again. It also
     * makes overlapping with `awaitTurn` harmless, since both now re-read
     * `lastState` rather than depending on which waiter a push woke.
     */
    async playCard(handle: string, move: SeatPlay, timeoutMs = PLAY_CONFIRM_MS): Promise<AckResult> {
        const seat = this.seats.get(handle);
        if (seat === undefined) return { ok: false, error: 'UNKNOWN_HANDLE' };

        const startedAt = seat.lastState?.view.turnNumber ?? -1;
        const moved = (state: StateUpdate | null): boolean =>
            state !== null &&
            (state.view.turnNumber !== startedAt ||
                state.phase !== 'active' ||
                state.view.currentPlayerId !== seat.identity.playerId);

        // Held by reference: a refusal is a NEW frame, and the seat may already
        // be carrying an older one from a previous turn.
        const errorBefore = seat.lastError;
        seat.play(move);

        const deadline = this.now() + timeoutMs;
        for (;;) {
            if (moved(seat.lastState)) return { ok: true };

            // A rejected play produces an ERROR and no push, so waiting for the
            // view to advance would time out and report NO_RESPONSE — which
            // names the symptom and hides the cause. Design §6 promises the
            // engine's own code reaches the seat; this is where that happens.
            // Found by a 40-match soak: two matches died as NO_RESPONSE when
            // the round had advanced underneath a play that was already chosen.
            const refusal = seat.lastError;
            if (refusal !== null && refusal !== errorBefore) return { ok: false, error: refusal.code };

            const remaining = deadline - this.now();
            if (remaining <= 0) return { ok: false, error: 'NO_RESPONSE' };

            // A rejection here is only "nothing arrived in time"; the condition
            // above is the authority, so it is swallowed and re-checked.
            await seat.nextState(remaining).then(
                () => undefined,
                () => undefined
            );
        }
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

    /**
     * Whose turn it is, and whether we may act on it.
     *
     * **A seat's own frame is the only authority on that seat's turn**, and
     * that is not a nicety — it is the fix for a race this got wrong first
     * time. Three sockets have no ordering guarantee at this process's event
     * loop, so seat p2's fresh frame can announce that p3 is up before p3's
     * own frame has arrived. Routing from whichever frame landed first then
     * says `your_turn` for p3 while `getView(h3)` still returns p3's previous
     * frame — and `own.legalPlays` is populated only in the frame where its
     * viewer holds the turn, so the seat is handed a turn with no legal move
     * in sight. Stage 4 caught exactly that, as a null from
     * `chooseFallbackPlay` on a seat's own turn.
     *
     * Checking each seat against its own frame makes the signal and the view
     * the same commit by construction, so there is no window to lose.
     */
    private signal(): TurnSignal {
        const table = this.anyState();
        // Before the first push there is no phase to report. `waiting` is the
        // honest answer: no seat we hold has the turn, because no turn exists.
        if (table === null) return { status: 'waiting', turnNumber: 0, phase: 'active' };

        for (const seat of this.seats.values()) {
            const state = seat.lastState;
            if (state === null) continue;

            const routed = routeTurn({
                // This seat alone: the question is whether *its* frame says it
                // may act, not whether some frame says someone might.
                heldPlayerIds: [seat.identity.playerId],
                currentPlayerId: state.view.currentPlayerId,
                turnNumber: state.view.turnNumber,
                phase: state.phase,
                paused: state.paused
            });
            if (routed.status === 'your_turn') return routed;
        }

        // No held seat can act. Report the table's own state — and pass an
        // empty held set deliberately, so this call cannot resurrect a
        // `your_turn` from the stale frame the loop above just rejected.
        return routeTurn({
            heldPlayerIds: [],
            currentPlayerId: table.view.currentPlayerId,
            turnNumber: table.view.turnNumber,
            phase: table.phase,
            paused: table.paused
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
