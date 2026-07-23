/**
 * One test per step of the validation pipeline (plan Task 11; Design §8),
 * each proving rejection AND that no game state changed. Drives the real
 * `dispatchMessage` against a real `RoomRegistry` + `MatchStore(':memory:')`
 * + `RecordingConn`, reusing the idioms established by room.test.ts and
 * roomRegistry.test.ts rather than mocking the thing under test.
 */
import { describe, expect, it } from 'bun:test';
import {
    CARD_CATALOG,
    EFFECT_DEFS,
    cardTypeOf,
    computeLegalPlays,
    computeLegalTargets,
    reduce as engineReduce
} from '../../game/engine';
import type { MatchState, PlayCardAction } from '../../game/engine';
import { makeConfig } from '../config';
import type { ConnectionState } from '../dispatch';
import { dispatchMessage } from '../dispatch';
import type { MatchRecord } from '../persistence';
import { MatchStore } from '../persistence';
import { TokenBucket } from '../rateLimiter';
import type { ServerMessage } from '../protocol';
import type { RoomDeps, SeatConnection } from '../room';
import { RoomRegistry } from '../roomRegistry';
import { hashToken, mintSeed, mintToken } from '../seatTokens';

/** A real object, not a mock of the thing under test (Design §12, room.test.ts's established pattern). */
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

/** ConnectionState with a generous token bucket, unless a test overrides it to target rate limiting. */
function makeState(overrides: Partial<ConnectionState> = {}): ConnectionState {
    return {
        ip: '127.0.0.1',
        bucket: new TokenBucket(1000, 1000),
        seat: null,
        matchId: null,
        conn: new RecordingConn(),
        ...overrides
    };
}

/** White-box access to Room's private `match` field — room.test.ts's established pattern. */
function liveMatch(room: ReturnType<RoomRegistry['get']>): MatchState {
    const match = (room as unknown as { match: MatchState | null }).match;
    if (match === null) throw new Error('liveMatch called before startMatch');
    return match;
}

function freshRegistry(deps: RoomDeps = {}): { registry: RoomRegistry; store: MatchStore; config: ReturnType<typeof makeConfig> } {
    const config = makeConfig({ dbPath: ':memory:' });
    const store = new MatchStore(':memory:');
    const registry = new RoomRegistry(config, store, deps);
    return { registry, store, config };
}

describe('dispatchMessage — step 2/3: parse + shape', () => {
    it('malformed JSON -> ERROR{MALFORMED}, socket stays open, no binding', async () => {
        const { registry, config } = freshRegistry();
        const state = makeState();

        await dispatchMessage(registry, config, state, '{not json');

        const conn = state.conn as RecordingConn;
        expect(conn.sent).toEqual([{ type: 'ERROR', code: 'MALFORMED' }]);
        expect(conn.closed).toBe(false);
        expect(state.seat).toBeNull();
        expect(state.matchId).toBeNull();
    });

    it('a shape failure (CLAIM_SEAT with an extra "seat" field) -> ERROR{MALFORMED}', async () => {
        const { registry, config } = freshRegistry();
        const state = makeState();

        await dispatchMessage(
            registry,
            config,
            state,
            JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'whatever', nickname: 'Alice', seat: 1 })
        );

        expect((state.conn as RecordingConn).sent).toEqual([{ type: 'ERROR', code: 'MALFORMED' }]);
        expect(state.seat).toBeNull();
    });
});

describe('dispatchMessage — step 4: rate limit', () => {
    it('a bucket with capacity 1 lets the first message through and RATE_LIMITEDs the second, for a type as innocuous as PING', async () => {
        const { registry, config } = freshRegistry();
        // A fixed clock (rateLimiter.test.ts's own idiom), not real Date.now():
        // a real clock risks the bucket refilling between the two awaited
        // calls below, since capacity 1 / refillPerSec 1000 would fully
        // refill from a single millisecond of ordinary test/event-loop
        // overhead, making the second call flakily succeed instead of
        // deterministically hitting RATE_LIMITED.
        const state = makeState({ bucket: new TokenBucket(1, 1000, () => 1_000_000) });

        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'PING' }));
        expect(last((state.conn as RecordingConn).sent)).toEqual({ type: 'PONG' });

        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'PING' }));
        expect(last((state.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'RATE_LIMITED' });
    });
});

describe('dispatchMessage — step 5: identity', () => {
    it('an unbound connection sending PLAY_CARD -> ERROR{NOT_YOUR_SEAT}; the room\'s actionLog is untouched', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();
        const room = registry.get(created.matchId)!;

        const hostConn = new RecordingConn();
        room.resumeSeat(hostConn, created.hostSeatToken);
        const guestConn = new RecordingConn();
        room.claimSeat(guestConn, 'Guest');
        room.startMatch(hostConn); // create+start a real match directly through Room, not dispatch

        const before = (store.load(created.matchId) as MatchRecord).actionLog;

        const stranger = makeState(); // seat: null
        await dispatchMessage(
            registry,
            config,
            stranger,
            JSON.stringify({ type: 'PLAY_CARD', matchId: created.matchId, cardInstanceId: 'informant#1' })
        );

        expect((stranger.conn as RecordingConn).sent).toEqual([{ type: 'ERROR', code: 'NOT_YOUR_SEAT' }]);
        expect((store.load(created.matchId) as MatchRecord).actionLog).toEqual(before);
    });

    it('a matchId that disagrees with the bound seat\'s matchId (END_MATCH) -> ERROR{NOT_YOUR_SEAT}, room untouched', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();

        const hostState = makeState();
        await dispatchMessage(
            registry,
            config,
            hostState,
            JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken })
        );
        expect(hostState.seat).toBe('p1');

        await dispatchMessage(registry, config, hostState, JSON.stringify({ type: 'END_MATCH', matchId: 'some-other-match-id' }));

        expect(last((hostState.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
        expect((store.load(created.matchId) as MatchRecord).phase).toBe('lobby');
    });
});

describe('dispatchMessage — the evicted-socket race (Room\'s canonical-pointer check, division of enforcement)', () => {
    it('claim on conn A, resume the same token on conn B (evicting A), then A\'s PLAY_CARD is refused and the log is unchanged', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();

        const stateA = makeState();
        await dispatchMessage(registry, config, stateA, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Alice' }));
        expect(stateA.seat).toBe('p2');
        const seatClaimed = (stateA.conn as RecordingConn).sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<
            ServerMessage,
            { type: 'SEAT_CLAIMED' }
        >;

        const stateB = makeState();
        await dispatchMessage(
            registry,
            config,
            stateB,
            JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: seatClaimed.seatToken })
        );
        expect(stateB.seat).toBe('p2');
        expect(last((stateA.conn as RecordingConn).sent)).toEqual({ type: 'FATAL', code: 'SEAT_TAKEN' });
        expect((stateA.conn as RecordingConn).closed).toBe(true);

        const before = (store.load(created.matchId) as MatchRecord).actionLog;

        // stateA still thinks it owns p2 — dispatch's own identity gate (step 5)
        // passes (seat bound, matchId matches); Room's own conn lookup is what
        // refuses it (step 6, deliberately not duplicated in dispatch).
        await dispatchMessage(
            registry,
            config,
            stateA,
            JSON.stringify({ type: 'PLAY_CARD', matchId: created.matchId, cardInstanceId: 'informant#1' })
        );

        expect(last((stateA.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
        expect((store.load(created.matchId) as MatchRecord).actionLog).toEqual(before);
    });
});

describe('dispatchMessage — step 7: one seat per connection', () => {
    it('a second CLAIM_SEAT on an already-bound connection -> ERROR{ALREADY_SEATED}, seat table unchanged', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();

        const state = makeState();
        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Alice' }));
        expect(state.seat).toBe('p2');

        const before = store.load(created.matchId) as MatchRecord;

        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Bob' }));

        expect(last((state.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'ALREADY_SEATED' });
        expect(state.seat).toBe('p2'); // unchanged — dispatch never rebinds
        expect(store.load(created.matchId) as MatchRecord).toEqual(before);
    });
});

describe('dispatchMessage — step 8: room lookup', () => {
    it('an unknown matchId -> ERROR{ROOM_NOT_FOUND}, no binding', async () => {
        const { registry, config } = freshRegistry();

        const state = makeState();
        await dispatchMessage(registry, config, state, JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'never-existed', nickname: 'A' }));

        expect(last((state.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'ROOM_NOT_FOUND' });
        expect(state.seat).toBeNull();
    });

    it('a quarantined matchId -> ERROR{ROOM_NOT_FOUND}, uniform with never-existed (Design §4)', async () => {
        const { registry, config, store } = freshRegistry();

        // A record this registry has never touched, whose actionLog fails
        // replay (p2 cannot go first — createMatch always starts playerIds[0]
        // = 'p1'): registry.get's lazy rebuild will quarantine it on first ask.
        const badLog: readonly PlayCardAction[] = [{ type: 'PLAY_CARD', playerId: 'p2', cardInstanceId: 'informant#1' }];
        store.save({
            matchId: 'quarantine-target',
            seed: mintSeed(),
            hostSeat: 'p1',
            phase: 'active',
            endReason: null,
            winnerSeat: null,
            seats: [
                { index: 0, playerId: 'p1', nickname: 'Host', tokenHash: hashToken(mintToken()) },
                { index: 1, playerId: 'p2', nickname: 'Guest', tokenHash: hashToken(mintToken()) }
            ],
            actionLog: badLog,
            quarantined: false,
            createdAt: 0,
            updatedAt: 0
        });

        const state = makeState();
        await dispatchMessage(
            registry,
            config,
            state,
            JSON.stringify({ type: 'CLAIM_SEAT', matchId: 'quarantine-target', nickname: 'A' })
        );

        expect(last((state.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'ROOM_NOT_FOUND' });
        expect(state.seat).toBeNull();
        expect(store.load('quarantine-target')).toBeNull(); // now quarantined
    });
});

describe('dispatchMessage — step 9: host gate', () => {
    it('a non-host START_MATCH -> ERROR{NOT_HOST}, room stays in lobby', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();

        const hostState = makeState();
        await dispatchMessage(
            registry,
            config,
            hostState,
            JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken })
        );

        const guestState = makeState();
        await dispatchMessage(registry, config, guestState, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Guest' }));
        expect(guestState.seat).toBe('p2');

        await dispatchMessage(registry, config, guestState, JSON.stringify({ type: 'START_MATCH', matchId: created.matchId }));

        expect(last((guestState.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'NOT_HOST' });
        expect((store.load(created.matchId) as MatchRecord).phase).toBe('lobby');
    });
});

describe('dispatchMessage — steps 10-11: the room command, never an uncaught rejection', () => {
    it('an engine throw -> ERROR{INTERNAL}, logged; the pipeline stays alive for the next message', async () => {
        let reduceCalls = 0;
        const deps: RoomDeps = {
            reduce: (match, action) => {
                reduceCalls += 1;
                if (reduceCalls === 1) throw new Error('boom: forced reduce failure');
                return engineReduce(match, action);
            }
        };
        const { registry, config } = freshRegistry(deps);
        const created = registry.createRoom();

        const hostState = makeState();
        await dispatchMessage(
            registry,
            config,
            hostState,
            JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken })
        );
        const guestState = makeState();
        await dispatchMessage(registry, config, guestState, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Guest' }));
        await dispatchMessage(registry, config, hostState, JSON.stringify({ type: 'START_MATCH', matchId: created.matchId }));

        const room = registry.get(created.matchId);
        const match = liveMatch(room);
        const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
        const actingState = currentPlayerId === 'p1' ? hostState : guestState;

        const cardInstanceId = computeLegalPlays(match.round, currentPlayerId)[0];
        const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
        const targets = computeLegalTargets(match.round, currentPlayerId, effectDef);

        const loggedErrors: unknown[][] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => {
            loggedErrors.push(args);
        };

        try {
            await dispatchMessage(
                registry,
                config,
                actingState,
                JSON.stringify({
                    type: 'PLAY_CARD',
                    matchId: created.matchId,
                    cardInstanceId,
                    ...(targets.length > 0 ? { target: targets[0] } : {}),
                    ...(effectDef.requiresGuess && targets.length > 0 ? { guess: 2 } : {})
                })
            );

            expect(last((actingState.conn as RecordingConn).sent)).toEqual({ type: 'ERROR', code: 'INTERNAL' });
            expect(loggedErrors.length).toBeGreaterThanOrEqual(1);

            // The queue is not wedged and the room is not corrupted: the very
            // next message still gets answered.
            await dispatchMessage(registry, config, actingState, JSON.stringify({ type: 'REQUEST_RESYNC', matchId: created.matchId }));
            expect(last((actingState.conn as RecordingConn).sent).type).toBe('STATE_UPDATE');
        } finally {
            console.error = originalConsoleError;
        }
    });
});

describe('dispatchMessage — happy path sanity', () => {
    it('CLAIM_SEAT and RESUME_SEAT bind state and yield the right frames; a legal PLAY_CARD advances the log by 1', async () => {
        const { registry, config, store } = freshRegistry();
        const created = registry.createRoom();

        const hostState = makeState();
        await dispatchMessage(
            registry,
            config,
            hostState,
            JSON.stringify({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken })
        );
        expect(hostState.seat).toBe('p1');
        expect(hostState.matchId).toBe(created.matchId);

        const guestState = makeState();
        await dispatchMessage(registry, config, guestState, JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Guest' }));
        expect(guestState.seat).toBe('p2');
        expect(guestState.matchId).toBe(created.matchId);

        const guestConn = guestState.conn as RecordingConn;
        expect(guestConn.sent.some(m => m.type === 'SEAT_CLAIMED')).toBe(true);
        expect(guestConn.sent.some(m => m.type === 'LOBBY_UPDATE')).toBe(true);

        await dispatchMessage(registry, config, hostState, JSON.stringify({ type: 'START_MATCH', matchId: created.matchId }));
        expect((store.load(created.matchId) as MatchRecord).phase).toBe('active');

        const room = registry.get(created.matchId);
        const match = liveMatch(room);
        const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
        const actingState = currentPlayerId === 'p1' ? hostState : guestState;

        const cardInstanceId = computeLegalPlays(match.round, currentPlayerId)[0];
        const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
        const targets = computeLegalTargets(match.round, currentPlayerId, effectDef);

        const before = (store.load(created.matchId) as MatchRecord).actionLog.length;

        await dispatchMessage(
            registry,
            config,
            actingState,
            JSON.stringify({
                type: 'PLAY_CARD',
                matchId: created.matchId,
                cardInstanceId,
                ...(targets.length > 0 ? { target: targets[0] } : {}),
                ...(effectDef.requiresGuess && targets.length > 0 ? { guess: 2 } : {})
            })
        );

        expect((store.load(created.matchId) as MatchRecord).actionLog.length).toBe(before + 1);
    });
});
