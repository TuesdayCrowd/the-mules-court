/**
 * Real round-advancement scheduling (plan Task 9; Design §6, §12.4, §13 row 10).
 *
 * Unlike room.test.ts, these tests run against REAL wall-clock time: `deps.now`
 * is left at its default (real `Date.now`) so the deadline math done by
 * `armRevealTimer` and the real `setTimeout` it schedules agree, and
 * `config.revealWindowMs` is shrunk to 20ms so the suite stays fast. Every
 * test disposes its room in a `finally` so no dangling `setTimeout` keeps
 * `bun test` from exiting cleanly.
 */
import { describe, expect, it } from 'bun:test';
import {
    CARD_CATALOG,
    EFFECT_DEFS,
    cardTypeOf,
    computeLegalPlays,
    computeLegalTargets,
    createMatch,
    isMatchOver,
    reduce as realEngineReduce,
    startNextRound as realEngineStartNextRound
} from '../../game/engine';
import type { GuessValue, MatchState, PlayCardAction, ReduceResult } from '../../game/engine';
import type { TransportConfig } from '../config';
import { makeConfig } from '../config';
import { MatchStore } from '../persistence';
import type { ServerMessage } from '../protocol';
import { Room } from '../room';
import type { RoomDeps, SeatConnection } from '../room';

/** Same fixed seed room.test.ts proves reaches a non-winning round-over with 2 claimed seats. */
const SEED = 'room-gameplay-fixed-seed';

/** A real object, not a mock of the thing under test (Design §12). */
class RecordingConn implements SeatConnection {
    sent: ServerMessage[] = [];
    raw: string[] = [];
    closed = false;

    send(json: string): void {
        this.raw.push(json);
        this.sent.push(JSON.parse(json));
    }

    close(): void {
        this.closed = true;
    }
}

function last<T>(arr: readonly T[]): T {
    return arr[arr.length - 1];
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls `fn` every `intervalMs` until it returns true or `timeoutMs` elapses,
 * returning the elapsed wall-clock time when it first became true. Used
 * instead of a single fixed wait so timing assertions measure the real
 * elapsed time from a reference point (e.g. a reconnect) to an observed push,
 * rather than assuming a specific real-timer schedule.
 */
async function waitForElapsed(fn: () => boolean, timeoutMs: number, intervalMs = 2): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fn()) return Date.now() - start;
        await sleep(intervalMs);
    }
    throw new Error('condition not met within timeout');
}

/** RoomDeps whose createMatch ignores Room's own mintSeed() and always deals from `seed` (Design §9 guidance). */
function fixedSeedDeps(seed: string): RoomDeps {
    return {
        createMatch: (playerIds, _seed, matchId) => createMatch(playerIds, seed, matchId)
    };
}

/** Seats a room with 2 claimed AND connected seats — host first, then one invitee. */
function makeConnectedLobby(
    deps: RoomDeps = {},
    configOverrides: Partial<TransportConfig> = {}
): { room: Room; store: MatchStore; config: TransportConfig; conns: RecordingConn[]; tokens: string[] } {
    const config = makeConfig({ dbPath: ':memory:', revealWindowMs: 20, ...configOverrides });
    const store = new MatchStore(':memory:');
    const { room, hostSeatToken } = Room.create(config, store, deps);

    const hostConn = new RecordingConn();
    room.resumeSeat(hostConn, hostSeatToken);

    const conn1 = new RecordingConn();
    room.claimSeat(conn1, 'Player1');
    const claimedMsg = conn1.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;

    return { room, store, config, conns: [hostConn, conn1], tokens: [hostSeatToken, claimedMsg.seatToken] };
}

function stateUpdates(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'STATE_UPDATE' }> => m.type === 'STATE_UPDATE');
}

function latestStateUpdate(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }> {
    return last(stateUpdates(conn));
}

/** White-box access to Room's private fields — this file follows room.test.ts's established pattern. */
function liveMatch(room: Room): MatchState {
    const match = (room as unknown as { match: MatchState | null }).match;
    if (match === null) throw new Error('liveMatch called before startMatch');
    return match;
}

function isAdvancing(room: Room): boolean {
    return (room as unknown as { advancing: boolean }).advancing;
}

/** One legal move for whoever currently holds the turn, driven through room.playCard (Design §12). */
function playOneLegalMove(room: Room, conns: readonly RecordingConn[]): void {
    const match = liveMatch(room);
    const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
    const cardInstanceId = computeLegalPlays(match.round, currentPlayerId)[0];
    const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
    const targets = computeLegalTargets(match.round, currentPlayerId, effectDef);

    const actingConn = conns[Number(currentPlayerId.slice(1)) - 1];
    room.playCard(actingConn, {
        type: 'PLAY_CARD',
        matchId: room.matchId,
        cardInstanceId,
        ...(targets.length > 0 ? { target: targets[0] } : {}),
        ...(effectDef.requiresGuess && targets.length > 0 ? { guess: 2 as GuessValue } : {})
    });
}

/** Drives real legal plays through `room.playCard` until the round ends or the match is decided. */
function driveUntilRoundOver(room: Room, conns: readonly RecordingConn[]): void {
    for (let i = 0; i < 200; i++) {
        const match = liveMatch(room);
        if (match.round.phase === 'round-over' || isMatchOver(match)) return;
        playOneLegalMove(room, conns);
    }
    throw new Error('drive did not reach round-over within the iteration cap');
}

describe('Room — round advancement (Design §6, §12.4)', () => {
    it('arms the timer on a non-winning round-over, and ~40ms later every seat sees the next round dealt', async () => {
        const { room, conns, config } = makeConnectedLobby(fixedSeedDeps(SEED));
        try {
            room.startMatch(conns[0]);
            driveUntilRoundOver(room, conns);

            // The interim round_over push carries a deadline ~serverTime + revealWindowMs.
            // `revealDeadline` and `serverTime` come from two separate real
            // `Date.now()` calls a couple of synchronous steps apart (arm, then
            // persist, then build each seat's push), so allow a few ms of real
            // clock drift between them rather than asserting exact equality.
            for (const conn of conns) {
                const roundOverUpdate = latestStateUpdate(conn);
                expect(roundOverUpdate.phase).toBe('round_over');
                const delta = (roundOverUpdate.revealDeadline as number) - roundOverUpdate.serverTime;
                expect(delta).toBeLessThanOrEqual(config.revealWindowMs);
                expect(delta).toBeGreaterThanOrEqual(config.revealWindowMs - 5);
            }
            const countsBefore = conns.map(c => stateUpdates(c).length);

            await sleep(40);

            conns.forEach((conn, i) => {
                expect(stateUpdates(conn).length).toBeGreaterThan(countsBefore[i]);

                const update = latestStateUpdate(conn);
                expect(update.phase).toBe('active');
                // RedactedView has no round counter of its own — a restarted
                // turnNumber IS the wire-visible "a new round was dealt" signal.
                expect(update.view.turnNumber).toBe(1);
                expect(update.view.roundResult).toBeNull();
                // Freshly dealt: 1 card each, except the round's starter, who has
                // also taken the opening draw dealRound() gives them (setup.ts) —
                // so their hand is 2, not 1.
                const isStarter = update.view.own.playerId === update.view.currentPlayerId;
                expect(update.view.own.hand).toHaveLength(isStarter ? 2 : 1);
                expect(update.revealDeadline).toBeUndefined();
            });
        } finally {
            room.dispose();
        }
    });

    it('a match-winning round never arms the timer: no further push, and no throw, across the window', async () => {
        // The Task 8 idiom, made the true precedence stress test: only force
        // matchWinnerId when the underlying reduce() ALSO ended the round, so
        // isMatchOver and round-over are true at once (Design §13 row 1).
        const forcedReduce = (match: MatchState, action: PlayCardAction): ReduceResult => {
            const result = realEngineReduce(match, action);
            if (!result.ok) return result;
            if (result.state.round.phase === 'round-over') {
                return { ok: true, state: { ...result.state, matchWinnerId: action.playerId } };
            }
            return result;
        };

        const { room, conns } = makeConnectedLobby({
            ...fixedSeedDeps(SEED),
            reduce: forcedReduce
        });
        try {
            room.startMatch(conns[0]);
            driveUntilRoundOver(room, conns); // stops as soon as round-over AND isMatchOver are both true

            expect(liveMatch(room).matchWinnerId).not.toBeNull();
            expect(liveMatch(room).round.phase).toBe('round-over');

            for (const conn of conns) {
                const update = latestStateUpdate(conn);
                expect(update.phase).toBe('ended');
                expect(update.endReason).toBe('won');
                expect(update.revealDeadline).toBeUndefined(); // never armed
            }
            const countsBefore = conns.map(c => stateUpdates(c).length);

            await sleep(60); // 3x revealWindowMs — plenty of time for a wrongly-armed timer to fire

            conns.forEach((conn, i) => {
                expect(stateUpdates(conn).length).toBe(countsBefore[i]); // no further push
            });
            expect(room.sweep()).toBe('keep'); // ended, but nowhere near retentionMs yet
        } finally {
            room.dispose();
        }
    });

    it('a disconnect cancels the armed timer; reconnect re-arms at the FULL window, not the remainder', async () => {
        const { room, conns, tokens, config } = makeConnectedLobby(fixedSeedDeps(SEED));
        try {
            room.startMatch(conns[0]);
            driveUntilRoundOver(room, conns);

            const originalDeadline = latestStateUpdate(conns[0]).revealDeadline;
            expect(originalDeadline).toBeDefined();

            await sleep(10); // ~half the window has elapsed
            room.handleClose(conns[1]); // disconnect — cancels, does not merely reduce, the timer

            // Wait past where the ORIGINAL timer would have fired (had it survived)
            // to prove it was truly cancelled, not left running underneath.
            await sleep(15); // total ~25ms since round-over > the 20ms window
            expect(liveMatch(room).round.phase).toBe('round-over'); // still — no advance happened
            expect(latestStateUpdate(conns[0]).paused).toBe(true);

            const reconnectConn = new RecordingConn();
            room.resumeSeat(reconnectConn, tokens[1]);

            // The reconnect repaint (still round_over) carries a FRESH deadline,
            // strictly later than the one armed at the original round end.
            const reconnectRepaint = last(reconnectConn.sent) as Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
            expect(reconnectRepaint.phase).toBe('round_over');
            expect(reconnectRepaint.revealDeadline).toBeDefined();
            expect(reconnectRepaint.revealDeadline as number).toBeGreaterThan(originalDeadline as number);

            // Measured from the reconnect (not from the original round end): if
            // the timer had resumed with only the leftover time (~10ms) rather
            // than the full window, 'active' would appear far sooner than 20ms.
            const elapsedSinceReconnect = await waitForElapsed(
                () => latestStateUpdate(conns[0]).phase === 'active',
                80
            );
            expect(elapsedSinceReconnect).toBeGreaterThanOrEqual(config.revealWindowMs - 4); // small real-timer tolerance
        } finally {
            room.dispose();
        }
    });

    it('a throw from startNextRound is logged, not crashed: the room keeps serving and releases its advance lock', async () => {
        let calls = 0;
        const throwOnceThenDelegate: RoomDeps['startNextRound'] = match => {
            calls += 1;
            if (calls === 1) throw new Error('boom: forced startNextRound failure');
            return realEngineStartNextRound(match);
        };

        const { room, conns } = makeConnectedLobby({ ...fixedSeedDeps(SEED), startNextRound: throwOnceThenDelegate });

        const loggedErrors: unknown[][] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
            loggedErrors.push(args);
        };

        try {
            room.startMatch(conns[0]);
            driveUntilRoundOver(room, conns);
            expect(latestStateUpdate(conns[0]).phase).toBe('round_over');

            await sleep(40); // past the 20ms window — the timer fires and startNextRound throws

            expect(loggedErrors.length).toBeGreaterThanOrEqual(1);
            expect(loggedErrors[0][0]).toBe('advanceRound failed');
            expect(loggedErrors[0][1]).toBe(room.matchId);
            expect(loggedErrors[0][2]).toBeInstanceOf(Error);

            // The lock is released, not left held (Design §13 row 10).
            expect(isAdvancing(room)).toBe(false);

            // Match state was not corrupted: still round-over, not silently advanced or half-mutated.
            expect(liveMatch(room).round.phase).toBe('round-over');

            // The room keeps serving: a resync still returns a valid, consistent STATE_UPDATE.
            const resyncConn = conns[0];
            const beforeResync = stateUpdates(resyncConn).length;
            room.resync(resyncConn);
            expect(stateUpdates(resyncConn).length).toBe(beforeResync + 1);
            expect(latestStateUpdate(resyncConn).phase).toBe('round_over');
        } finally {
            console.error = originalConsoleError;
            room.dispose();
        }
    });

    it('endMatch during an armed reveal window clears revealDeadline from the final push and truly cancels the timer', async () => {
        const { room, conns, config } = makeConnectedLobby(fixedSeedDeps(SEED));
        try {
            room.startMatch(conns[0]);
            driveUntilRoundOver(room, conns);
            expect(latestStateUpdate(conns[0]).revealDeadline).toBeDefined();

            room.endMatch(conns[0]); // host ends the match before the timer fires

            for (const conn of conns) {
                const update = latestStateUpdate(conn);
                expect(update.phase).toBe('ended');
                expect(update.endReason).toBe('abandoned');
                expect(update.revealDeadline).toBeUndefined();
            }
            const countsBefore = conns.map(c => stateUpdates(c).length);

            // Past the ORIGINAL window: if the timer were merely nulled rather
            // than truly cancelled, it would still fire here.
            await sleep(config.revealWindowMs + 15);

            conns.forEach((conn, i) => {
                expect(stateUpdates(conn).length).toBe(countsBefore[i]); // no 'active' push arrived
            });
            expect(liveMatch(room).round.phase).toBe('round-over'); // engine state frozen, never advanced
        } finally {
            room.dispose();
        }
    });
});
