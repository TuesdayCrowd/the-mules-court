import { describe, expect, it } from 'bun:test';
import {
    CARD_CATALOG,
    EFFECT_DEFS,
    cardTypeOf,
    computeLegalPlays,
    computeLegalTargets,
    createMatch,
    isMatchOver,
    reduce as engineReduce,
    view as engineView
} from '../../game/engine';
import type { GuessValue, MatchState, PlayCardAction, PlayerId, ReduceResult } from '../../game/engine';
import type { TransportConfig } from '../config';
import { makeConfig } from '../config';
import type { MatchRecord } from '../persistence';
import { MatchStore } from '../persistence';
import type { ServerMessage } from '../protocol';
import { Room } from '../room';
import type { RoomDeps, SeatConnection } from '../room';
import { hashToken } from '../seatTokens';

/** Fixed so a round-over/match-win drive reproduces (Design §9 guidance). */
const SEED = 'room-gameplay-fixed-seed';

/** A real object, not a mock of the thing under test (Design §12, plan Task 7 test guidance). */
class RecordingConn implements SeatConnection {
    sent: ServerMessage[] = [];
    raw: string[] = [];
    closed = false;

    /** Optional shared log so a test can interleave sends with store calls to prove ordering. */
    constructor(private readonly order?: string[]) {}

    send(json: string): void {
        this.raw.push(json);
        this.sent.push(JSON.parse(json));
        this.order?.push('send');
    }

    close(): void {
        this.closed = true;
    }
}

function last<T>(arr: readonly T[]): T {
    return arr[arr.length - 1];
}

/** RoomDeps whose createMatch ignores Room's own mintSeed() and always deals from `seed` (Design §9 guidance). */
function fixedSeedDeps(seed: string): RoomDeps {
    return {
        createMatch: (playerIds, _seed, matchId) => createMatch(playerIds, seed, matchId)
    };
}

/**
 * Seats a room with `seatCount` claimed AND connected seats (host first,
 * then invitees in claim order — so `conns[i]` is always seat `i` / `p${i+1}`).
 */
function makeConnectedLobby(
    seatCount: 2 | 3 | 4,
    deps: RoomDeps = {},
    configOverrides: Partial<TransportConfig> = {}
): { room: Room; store: MatchStore; config: TransportConfig; conns: RecordingConn[]; tokens: string[] } {
    const config = makeConfig({ dbPath: ':memory:', ...configOverrides });
    const store = new MatchStore(':memory:');
    const { room, hostSeatToken } = Room.create(config, store, deps);

    const conns: RecordingConn[] = [];
    const tokens: string[] = [hostSeatToken];

    const hostConn = new RecordingConn();
    room.resumeSeat(hostConn, hostSeatToken);
    conns.push(hostConn);

    for (let i = 1; i < seatCount; i++) {
        const conn = new RecordingConn();
        room.claimSeat(conn, `Player${i}`);
        const claimedMsg = conn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        tokens.push(claimedMsg.seatToken);
        conns.push(conn);
    }

    return { room, store, config, conns, tokens };
}

/** Every seat's own conn, indexed by seat: `conns[i]` is always `p${i+1}` (Design §2's fixed seat pool). */
function connFor(conns: readonly RecordingConn[], playerId: PlayerId): RecordingConn {
    return conns[Number(playerId.slice(1)) - 1];
}

function stateUpdates(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'STATE_UPDATE' }> => m.type === 'STATE_UPDATE');
}

function latestStateUpdate(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }> {
    return last(stateUpdates(conn));
}

/** White-box access to Room's private `match` field — this file's established pattern for setup/assertion. */
function liveMatch(room: Room): MatchState {
    const match = (room as unknown as { match: MatchState | null }).match;
    if (match === null) throw new Error('liveMatch called before startMatch');
    return match;
}

/**
 * One legal move for whoever currently holds the turn, computed exactly like
 * persistence.test.ts's `driveMatch` helper — straight off the engine's own
 * legality functions — but driven THROUGH `room.playCard`, exercising the
 * real commit sequence rather than calling `reduce` directly.
 */
function playOneLegalMove(room: Room, conns: readonly RecordingConn[], clientMsgId?: string): void {
    const match = liveMatch(room);
    const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
    const cardInstanceId = computeLegalPlays(match.round, currentPlayerId)[0];
    const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
    const targets = computeLegalTargets(match.round, currentPlayerId, effectDef);

    const actingConn = connFor(conns, currentPlayerId);
    room.playCard(actingConn, {
        type: 'PLAY_CARD',
        matchId: room.matchId,
        cardInstanceId,
        ...(targets.length > 0 ? { target: targets[0] } : {}),
        ...(effectDef.requiresGuess && targets.length > 0 ? { guess: 2 as GuessValue } : {}),
        ...(clientMsgId !== undefined ? { clientMsgId } : {})
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

describe('Room.create', () => {
    it('mints the host at seat 0 before any join, and persists a lobby record whose seat 0 hash matches the returned token', () => {
        const store = new MatchStore(':memory:');
        const { room, hostSeatToken } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const record = store.load(room.matchId) as MatchRecord;
        expect(record).not.toBeNull();
        expect(record.phase).toBe('lobby');
        expect(record.hostSeat).toBe('p1');
        expect(record.seed).toBeNull();
        expect(record.actionLog).toEqual([]);
        expect(record.seats).toEqual([{ index: 0, playerId: 'p1', nickname: '', tokenHash: hashToken(hostSeatToken) }]);
    });

    it('resumes the host token from create() onto seat 0', () => {
        const store = new MatchStore(':memory:');
        const { room, hostSeatToken } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const conn = new RecordingConn();
        const result = room.resumeSeat(conn, hostSeatToken);

        expect(result).toEqual({ seat: 0, playerId: 'p1' });
    });
});

describe('Room.claimSeat', () => {
    it('lands two successive claims on seats 1 and 2, in order', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const conn1 = new RecordingConn();
        const conn2 = new RecordingConn();

        expect(room.claimSeat(conn1, 'Bayta')).toEqual({ seat: 1, playerId: 'p2' });
        expect(room.claimSeat(conn2, 'Toran')).toEqual({ seat: 2, playerId: 'p3' });
    });

    it('sends SEAT_CLAIMED once, to the claiming socket only, with a token whose hash matches the persisted record', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const conn = new RecordingConn();
        const result = room.claimSeat(conn, 'Bayta')!;

        const claimedMsgs = conn.sent.filter(m => m.type === 'SEAT_CLAIMED');
        expect(claimedMsgs).toHaveLength(1);
        const claimed = claimedMsgs[0] as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        expect(claimed.matchId).toBe(room.matchId);
        expect(claimed.seat).toBe(result.seat);
        expect(claimed.playerId).toBe(result.playerId);

        const record = store.load(room.matchId) as MatchRecord;
        const storedSeat = record.seats.find(s => s.index === result.seat)!;
        expect(storedSeat.tokenHash).toBe(hashToken(claimed.seatToken));
        expect(storedSeat.nickname).toBe('Bayta');
    });

    it('refuses a claim into a full room with ERROR{ROOM_FULL}, sent to the requesting conn only', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        // Seat 0 is the host (already claimed by create()); fill seats 1-3.
        room.claimSeat(new RecordingConn(), 'A');
        room.claimSeat(new RecordingConn(), 'B');
        room.claimSeat(new RecordingConn(), 'C');

        const overflowConn = new RecordingConn();
        const result = room.claimSeat(overflowConn, 'D');

        expect(result).toBeNull();
        expect(overflowConn.sent).toEqual([{ type: 'ERROR', code: 'ROOM_FULL' }]);
    });

    it('broadcasts LOBBY_UPDATE with correct statuses, and canStart only once >=2 claimed seats are all connected', () => {
        const store = new MatchStore(':memory:');
        const { room, hostSeatToken } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const hostConn = new RecordingConn();
        room.resumeSeat(hostConn, hostSeatToken); // host connects; still only 1 claimed seat

        const afterHostResume = last(hostConn.sent) as Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
        expect(afterHostResume.type).toBe('LOBBY_UPDATE');
        expect(afterHostResume.canStart).toBe(false); // only 1 claimed

        const conn1 = new RecordingConn();
        room.claimSeat(conn1, 'Bayta'); // now 2 claimed, both connected

        const afterClaim = last(hostConn.sent) as Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
        expect(afterClaim.hostSeat).toBe('p1');
        expect(afterClaim.canStart).toBe(true);
        expect(afterClaim.seats).toEqual([
            { seat: 0, playerId: 'p1', nickname: null, status: 'occupied' },
            { seat: 1, playerId: 'p2', nickname: 'Bayta', status: 'occupied' },
            { seat: 2, playerId: null, nickname: null, status: 'open' },
            { seat: 3, playerId: null, nickname: null, status: 'open' }
        ]);

        // conn1 (the claimer) saw the same broadcast bytes.
        expect(last(conn1.raw)).toBe(JSON.stringify(afterClaim));
    });

    it('refuses a claim once the room has ended, with ERROR{MATCH_OVER}', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 100 });
        const store = new MatchStore(':memory:');
        const { room } = Room.create(config, store, { now: () => t });

        t = 200;
        room.sweep(); // past lobbyTtlMs -> phase 'ended'

        const conn = new RecordingConn();
        const result = room.claimSeat(conn, 'Late');

        expect(result).toBeNull();
        expect(conn.sent).toEqual([{ type: 'ERROR', code: 'MATCH_OVER' }]);
    });
});

describe('Room.resumeSeat', () => {
    it('produces a byte-identical FATAL{BAD_TOKEN}, and closes the socket, for a wrong token, an empty token, and another room\'s token', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const otherStore = new MatchStore(':memory:');
        const { hostSeatToken: otherRoomToken } = Room.create(makeConfig({ dbPath: ':memory:' }), otherStore);

        const wrongConn = new RecordingConn();
        const emptyConn = new RecordingConn();
        const otherRoomConn = new RecordingConn();

        expect(room.resumeSeat(wrongConn, '0'.repeat(32))).toBeNull();
        expect(room.resumeSeat(emptyConn, '')).toBeNull();
        expect(room.resumeSeat(otherRoomConn, otherRoomToken)).toBeNull();

        const expectedRaw = JSON.stringify({ type: 'FATAL', code: 'BAD_TOKEN' });
        expect(wrongConn.raw).toEqual([expectedRaw]);
        expect(emptyConn.raw).toEqual([expectedRaw]);
        expect(otherRoomConn.raw).toEqual([expectedRaw]);

        expect(wrongConn.closed).toBe(true);
        expect(emptyConn.closed).toBe(true);
        expect(otherRoomConn.closed).toBe(true);
    });

    it('evicts a live old connection: it gets FATAL{SEAT_TAKEN} and is closed, and the new conn owns the seat', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const oldConn = new RecordingConn();
        const claimed = room.claimSeat(oldConn, 'Bayta')!;
        const seatClaimedMsg = oldConn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<
            ServerMessage,
            { type: 'SEAT_CLAIMED' }
        >;

        const newConn = new RecordingConn();
        const result = room.resumeSeat(newConn, seatClaimedMsg.seatToken);

        expect(result).toEqual({ seat: claimed.seat, playerId: claimed.playerId });
        expect(oldConn.closed).toBe(true);
        expect(last(oldConn.sent)).toEqual({ type: 'FATAL', code: 'SEAT_TAKEN' });

        // White-box check per the plan's test guidance: seats[i].conn === newConn.
        const seats = (room as unknown as { seats: { conn: SeatConnection | null }[] }).seats;
        expect(seats[claimed.seat].conn).toBe(newConn);
    });
});

describe('Room.handleClose', () => {
    it('only acts when the conn is the seat\'s canonical pointer — an evicted conn\'s own close is ignored', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const oldConn = new RecordingConn();
        room.claimSeat(oldConn, 'Bayta');
        const seatClaimedMsg = oldConn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<
            ServerMessage,
            { type: 'SEAT_CLAIMED' }
        >;

        const newConn = new RecordingConn();
        room.resumeSeat(newConn, seatClaimedMsg.seatToken); // evicts oldConn

        const messagesBefore = newConn.sent.length;
        room.handleClose(oldConn); // oldConn is no longer canonical for its seat

        expect(newConn.sent.length).toBe(messagesBefore); // no spurious broadcast

        const seats = (room as unknown as { seats: { conn: SeatConnection | null }[] }).seats;
        expect(seats[1].conn).toBe(newConn); // still bound to the new conn, untouched
    });

    it('broadcasts LOBBY_UPDATE showing the seat disconnected, in lobby phase', () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const conn1 = new RecordingConn();
        room.claimSeat(conn1, 'Bayta');
        const conn2 = new RecordingConn();
        room.claimSeat(conn2, 'Toran');

        room.handleClose(conn1);

        const update = last(conn2.sent) as Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
        expect(update.seats.find(s => s.seat === 1)).toEqual({ seat: 1, playerId: 'p2', nickname: 'Bayta', status: 'disconnected' });
    });
});

describe('Room.sweep — lobby phase', () => {
    it('reopens a disconnected seat past lobbyDisconnectGraceMs, and the stale token now resumes to BAD_TOKEN', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyDisconnectGraceMs: 1000, lobbyTtlMs: 10_000_000 });
        const store = new MatchStore(':memory:');
        const { room } = Room.create(config, store, { now: () => t });

        const conn1 = new RecordingConn();
        room.claimSeat(conn1, 'Bayta');
        const seatClaimedMsg = conn1.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<
            ServerMessage,
            { type: 'SEAT_CLAIMED' }
        >;
        const staleToken = seatClaimedMsg.seatToken;

        room.handleClose(conn1); // seat 1 disconnected at t=0

        t = 500; // before grace: sweep must not yet reopen the seat
        expect(room.sweep()).toBe('keep');
        const tooEarly = new RecordingConn();
        expect(room.resumeSeat(tooEarly, staleToken)).toEqual({ seat: 1, playerId: 'p2' }); // still resumable
        room.handleClose(tooEarly); // back to disconnected, still at t=500

        t = 2000; // 1500ms past the t=500 disconnect — past the 1000ms grace
        expect(room.sweep()).toBe('keep');

        const conn2 = new RecordingConn();
        expect(room.resumeSeat(conn2, staleToken)).toBeNull();
        expect(conn2.sent).toEqual([{ type: 'FATAL', code: 'BAD_TOKEN' }]);

        // The seat reopened: a fresh claim lands right back on index 1.
        const conn3 = new RecordingConn();
        expect(room.claimSeat(conn3, 'NewPlayer')).toEqual({ seat: 1, playerId: 'p2' });
    });

    it('never reopens the host seat by grace — whoever claimed a reopened seat 0 would become p1, the host', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyDisconnectGraceMs: 1000, lobbyTtlMs: 10_000_000 });
        const store = new MatchStore(':memory:');
        // The host never connects at all — disconnectedAt is seeded at creation,
        // so grace has unambiguously elapsed by t=5000; the seat must still hold.
        const { room, hostSeatToken } = Room.create(config, store, { now: () => t });

        const conn1 = new RecordingConn();
        room.claimSeat(conn1, 'Bayta'); // a connected invitee keeps the room live

        t = 5000; // far past the 1000ms grace
        expect(room.sweep()).toBe('keep');

        // Seat 0 did not reopen: a fresh claim lands on seat 2, not seat 0...
        const wouldBeUsurper = new RecordingConn();
        expect(room.claimSeat(wouldBeUsurper, 'Usurper')).toEqual({ seat: 2, playerId: 'p3' });

        // ...and the host token still resumes onto seat 0.
        const hostConn = new RecordingConn();
        expect(room.resumeSeat(hostConn, hostSeatToken)).toEqual({ seat: 0, playerId: 'p1' });
    });

    it('ends the room once past lobbyTtlMs: persists phase "ended" and broadcasts MATCH_ENDED', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 1000, retentionMs: 5000 });
        const store = new MatchStore(':memory:');
        const { room, hostSeatToken } = Room.create(config, store, { now: () => t });

        const hostConn = new RecordingConn();
        room.resumeSeat(hostConn, hostSeatToken);

        t = 1500;
        expect(room.sweep()).toBe('keep'); // ended, but not yet past retention

        expect(last(hostConn.sent)).toEqual({ type: 'MATCH_ENDED', matchId: room.matchId, reason: 'abandoned' });

        const record = store.load(room.matchId) as MatchRecord;
        expect(record.phase).toBe('ended');
        expect(record.endReason).toBe('abandoned');
    });

    it('returns "delete" once an ended room is past retentionMs', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 1000, retentionMs: 2000 });
        const store = new MatchStore(':memory:');
        const { room } = Room.create(config, store, { now: () => t });

        t = 1500;
        expect(room.sweep()).toBe('keep'); // just ended

        t = 1500 + 2000 + 1;
        expect(room.sweep()).toBe('delete');
    });
});

describe('Room.enqueue', () => {
    it('serializes calls — two enqueued fns never interleave, even when the first awaits a timer', async () => {
        const store = new MatchStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const events: string[] = [];

        const first = room.enqueue(async () => {
            events.push('first-enter');
            await new Promise<void>(resolve => setTimeout(resolve, 20));
            events.push('first-exit');
        });
        const second = room.enqueue(() => {
            events.push('second-enter');
            events.push('second-exit');
        });

        await Promise.all([first, second]);

        expect(events).toEqual(['first-enter', 'first-exit', 'second-enter', 'second-exit']);
    });
});

describe('persist-before-send ordering', () => {
    it('persists before any conn.send on a state-changing operation (Design §9)', () => {
        const order: string[] = [];

        class OrderTrackingStore extends MatchStore {
            save(record: MatchRecord): void {
                order.push('save');
                super.save(record);
            }
        }

        const store = new OrderTrackingStore(':memory:');
        const { room } = Room.create(makeConfig({ dbPath: ':memory:' }), store); // create()'s own save is not under test
        order.length = 0;

        const conn = new RecordingConn(order);
        room.claimSeat(conn, 'Bayta');

        expect(order[0]).toBe('save');
        expect(order.slice(1)).toEqual(order.slice(1).map(() => 'send'));
        expect(order.length).toBeGreaterThan(1);
    });

    it('persists before any conn.send on a legal PLAY_CARD commit too (Design §9)', () => {
        const order: string[] = [];

        class OrderTrackingStore extends MatchStore {
            save(record: MatchRecord): void {
                order.push('save');
                super.save(record);
            }
        }

        const store = new OrderTrackingStore(':memory:');
        const { room, hostSeatToken } = Room.create(makeConfig({ dbPath: ':memory:' }), store);

        const hostConn = new RecordingConn(order);
        room.resumeSeat(hostConn, hostSeatToken);
        const conn1 = new RecordingConn(order);
        room.claimSeat(conn1, 'Bayta');

        room.startMatch(hostConn);
        order.length = 0;

        playOneLegalMove(room, [hostConn, conn1]);

        expect(order[0]).toBe('save');
        expect(order.slice(1)).toEqual(order.slice(1).map(() => 'send'));
        expect(order.length).toBeGreaterThan(1);
    });
});

describe('Room.startMatch', () => {
    it('deals seats in index order, and MATCH_STARTED precedes every seat\'s first STATE_UPDATE', () => {
        const { room, conns } = makeConnectedLobby(3);

        room.startMatch(conns[0]);

        const expectedPlayerIds: PlayerId[] = ['p1', 'p2', 'p3'];
        conns.forEach((conn, i) => {
            const startedIdx = conn.sent.findIndex(m => m.type === 'MATCH_STARTED');
            const stateIdx = conn.sent.findIndex(m => m.type === 'STATE_UPDATE');
            expect(startedIdx).toBeGreaterThanOrEqual(0);
            expect(stateIdx).toBeGreaterThan(startedIdx);

            const update = latestStateUpdate(conn);
            expect(update.view.own.playerId).toBe(expectedPlayerIds[i]);
        });
    });

    it('refuses a start with only 1 claimed seat: ERROR{CANNOT_START}', () => {
        const store = new MatchStore(':memory:');
        const { room, hostSeatToken } = Room.create(makeConfig({ dbPath: ':memory:' }), store);
        const hostConn = new RecordingConn();
        room.resumeSeat(hostConn, hostSeatToken);

        room.startMatch(hostConn);

        expect(last(hostConn.sent)).toEqual({ type: 'ERROR', code: 'CANNOT_START' });
    });

    it('refuses a start when a claimed seat is disconnected: ERROR{CANNOT_START}', () => {
        const { room, conns } = makeConnectedLobby(3);
        room.handleClose(conns[1]); // seat p2 stays claimed but disconnects

        room.startMatch(conns[0]);

        expect(last(conns[0].sent)).toEqual({ type: 'ERROR', code: 'CANNOT_START' });
    });

    it('refuses a non-host start: ERROR{NOT_HOST}', () => {
        const { room, conns } = makeConnectedLobby(3);

        room.startMatch(conns[1]);

        expect(last(conns[1].sent)).toEqual({ type: 'ERROR', code: 'NOT_HOST' });
    });
});

describe('Room.playCard', () => {
    it('a legal play advances the turn and pushes every seat a distinct, correctly-labeled view', () => {
        const { room, conns } = makeConnectedLobby(3);
        room.startMatch(conns[0]);

        const beforeIndex = liveMatch(room).round.currentPlayerIndex;
        playOneLegalMove(room, conns);

        const afterViews = conns.map(c => latestStateUpdate(c).view);
        conns.forEach((_, i) => {
            expect(afterViews[i].own.playerId).toBe(`p${i + 1}`);
        });
        expect(liveMatch(room).round.currentPlayerIndex).not.toBe(beforeIndex);

        const hands = afterViews.map(v => JSON.stringify(v.own.hand));
        expect(new Set(hands).size).toBe(hands.length); // every seat's own.hand is distinct
    });

    it('an illegal play returns the engine code verbatim with refId echoed, and touches no state', () => {
        const { room, conns, store } = makeConnectedLobby(3);
        room.startMatch(conns[0]);

        const match = liveMatch(room);
        const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
        const nonCurrentSeatIndex = conns.findIndex((_, i) => `p${i + 1}` !== currentPlayerId);
        const nonCurrentConn = conns[nonCurrentSeatIndex];
        const nonCurrentPlayerId: PlayerId = `p${nonCurrentSeatIndex + 1}`;
        const cardInstanceId = match.round.players[nonCurrentPlayerId].hand[0];

        const before = store.load(room.matchId) as MatchRecord;

        room.playCard(nonCurrentConn, {
            type: 'PLAY_CARD',
            matchId: room.matchId,
            cardInstanceId,
            clientMsgId: 'abc-123'
        });

        expect(last(nonCurrentConn.sent)).toEqual({ type: 'ERROR', code: 'NOT_YOUR_TURN', refId: 'abc-123' });

        const after = store.load(room.matchId) as MatchRecord;
        expect(after.actionLog).toEqual(before.actionLog);
    });

    it('refuses PLAY_CARD while paused with ERROR{PAUSED}, before the engine runs and before actionLog changes', () => {
        const { room, conns, store } = makeConnectedLobby(3);
        room.startMatch(conns[0]);

        room.handleClose(conns[1]); // p2 disconnects — not the current player (p1 always starts)

        const match = liveMatch(room);
        const currentPlayerId = match.round.seatOrder[match.round.currentPlayerIndex];
        const actingConn = connFor(conns, currentPlayerId);
        const cardInstanceId = match.round.players[currentPlayerId].hand[0];

        const before = store.load(room.matchId) as MatchRecord;

        room.playCard(actingConn, { type: 'PLAY_CARD', matchId: room.matchId, cardInstanceId });

        expect(last(actingConn.sent)).toEqual({ type: 'ERROR', code: 'PAUSED' });
        expect((store.load(room.matchId) as MatchRecord).actionLog).toEqual(before.actionLog);
    });

    it('refuses PLAY_CARD from an unseated connection: ERROR{NOT_YOUR_SEAT}', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.startMatch(conns[0]);

        const stranger = new RecordingConn();
        room.playCard(stranger, { type: 'PLAY_CARD', matchId: room.matchId, cardInstanceId: 'informant#1' });

        expect(last(stranger.sent)).toEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
    });
});

describe('Room — active-phase handleClose', () => {
    it('a mid-round disconnect pauses the match: remaining seats see paused:true and the missing seat in missingSeats', () => {
        const { room, conns } = makeConnectedLobby(3);
        room.startMatch(conns[0]);

        room.handleClose(conns[2]); // p3 disconnects

        const update0 = latestStateUpdate(conns[0]);
        const update1 = latestStateUpdate(conns[1]);
        expect(update0.paused).toBe(true);
        expect(update0.missingSeats).toEqual(['p3']);
        expect(update1.paused).toBe(true);
        expect(update1.missingSeats).toEqual(['p3']);
    });
});

describe('Room.resumeSeat — active phase', () => {
    it('repaints the reconnected seat with a fresh view() and pushes paused:false to every other seat', () => {
        const { room, conns, tokens } = makeConnectedLobby(3);
        room.startMatch(conns[0]);

        room.handleClose(conns[2]); // p3 disconnects
        expect(latestStateUpdate(conns[0]).paused).toBe(true);

        const newConn = new RecordingConn();
        room.resumeSeat(newConn, tokens[2]);

        const matchNow = liveMatch(room);
        const expectedView = engineView(matchNow, 'p3');

        const reconnectUpdate = last(newConn.sent) as Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
        expect(reconnectUpdate.view).toEqual(expectedView);
        expect(reconnectUpdate.paused).toBe(false);

        expect(latestStateUpdate(conns[0]).paused).toBe(false);
        expect(latestStateUpdate(conns[1]).paused).toBe(false);
    });
});

describe('Room — round-over commit (Design §6)', () => {
    it('arms the reveal timer before persisting, so the round_over push carries revealDeadline = serverTime + revealWindowMs', () => {
        const t = 1_700_000_000_000;
        const deps: RoomDeps = { ...fixedSeedDeps(SEED), now: () => t };
        const { room, conns, config } = makeConnectedLobby(2, deps);

        room.startMatch(conns[0]);
        driveUntilRoundOver(room, conns);

        for (const conn of conns) {
            const update = latestStateUpdate(conn);
            expect(update.phase).toBe('round_over');
            expect(update.revealDeadline).toBe(update.serverTime + config.revealWindowMs);
        }
    });

    it('a disconnect during round-over clears the armed deadline from the next push', () => {
        const t = 1_700_000_000_000;
        const deps: RoomDeps = { ...fixedSeedDeps(SEED), now: () => t };
        const { room, conns } = makeConnectedLobby(2, deps);

        room.startMatch(conns[0]);
        driveUntilRoundOver(room, conns);
        expect(latestStateUpdate(conns[0]).revealDeadline).toBeDefined();

        room.handleClose(conns[1]);

        const afterDisconnect = latestStateUpdate(conns[0]);
        expect(afterDisconnect.paused).toBe(true);
        expect(afterDisconnect.revealDeadline).toBeUndefined();
    });
});

describe('Room — match-win commit (Design §6, §13 row 1)', () => {
    it('ends the match with reason "won", sets endedAt, clears the reveal timer, and broadcasts MATCH_ENDED last', () => {
        let t = 1_800_000_000_000;
        const forcedReduce = (match: MatchState, action: PlayCardAction): ReduceResult => {
            const result = engineReduce(match, action);
            if (!result.ok) return result;
            return { ok: true, state: { ...result.state, matchWinnerId: action.playerId } };
        };

        const { room, conns, config } = makeConnectedLobby(2, { now: () => t, reduce: forcedReduce });
        room.startMatch(conns[0]);

        const winnerId = liveMatch(room).round.seatOrder[liveMatch(room).round.currentPlayerIndex];
        playOneLegalMove(room, conns);

        for (const conn of conns) {
            const update = latestStateUpdate(conn);
            expect(update.phase).toBe('ended');
            expect(update.endReason).toBe('won');
            expect(update.winnerSeat).toBe(winnerId);
            expect(update.revealDeadline).toBeUndefined();
        }

        for (const conn of conns) {
            const types = conn.sent.map(m => m.type);
            expect(types.lastIndexOf('MATCH_ENDED')).toBeGreaterThan(types.lastIndexOf('STATE_UPDATE'));
        }

        // Advancing the clock past retentionMs and sweeping proves endedAt was
        // actually set on the match-win transition, not left null.
        t += config.retentionMs + 1;
        expect(room.sweep()).toBe('delete');
    });
});

describe('Room.endMatch', () => {
    it('a connected non-host is refused before another seat\'s activeGraceMs elapses, and succeeds as abandoned after', () => {
        let t = 0;
        const { room, conns } = makeConnectedLobby(3, { now: () => t }, { activeGraceMs: 1000 });
        room.startMatch(conns[0]);

        room.handleClose(conns[2]); // p3 missing, starting at t=0

        t = 500;
        room.endMatch(conns[1]); // p2, connected, non-host, before grace
        expect(last(conns[1].sent)).toEqual({ type: 'ERROR', code: 'NOT_HOST' });

        t = 1500; // past the 1000ms activeGraceMs
        room.endMatch(conns[1]);

        const finalUpdate = latestStateUpdate(conns[1]);
        expect(finalUpdate.phase).toBe('ended');
        expect(finalUpdate.endReason).toBe('abandoned');

        const endedMsgs = conns[1].sent.filter(m => m.type === 'MATCH_ENDED');
        expect(endedMsgs).toHaveLength(1);
        expect(endedMsgs[0]).toEqual({ type: 'MATCH_ENDED', matchId: room.matchId, reason: 'abandoned' });
    });

    it('the host may end an active match immediately, with no grace required', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.startMatch(conns[0]);

        room.endMatch(conns[0]);

        expect(last(conns[0].sent)).toEqual({ type: 'MATCH_ENDED', matchId: room.matchId, reason: 'abandoned' });
    });

    it('in a lobby whose never-connected host has been missing past lobbyDisconnectGraceMs, any connected invitee may end the room', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyDisconnectGraceMs: 1000 });
        const store = new MatchStore(':memory:');
        const { room } = Room.create(config, store, { now: () => t }); // host never connects

        const invitee = new RecordingConn();
        room.claimSeat(invitee, 'Invitee');

        t = 500;
        room.endMatch(invitee);
        expect(last(invitee.sent)).toEqual({ type: 'ERROR', code: 'NOT_HOST' });

        t = 1500; // past the 1000ms lobbyDisconnectGraceMs
        room.endMatch(invitee);

        const record = store.load(room.matchId) as MatchRecord;
        expect(record.phase).toBe('ended');
        expect(record.endReason).toBe('abandoned');
        expect(last(invitee.sent)).toEqual({ type: 'MATCH_ENDED', matchId: room.matchId, reason: 'abandoned' });
    });

    it('refuses to end an already-ended match: ERROR{MATCH_OVER}', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.startMatch(conns[0]);
        room.endMatch(conns[0]);

        room.endMatch(conns[0]);

        expect(last(conns[0].sent)).toEqual({ type: 'ERROR', code: 'MATCH_OVER' });
    });
});

describe('Room.resync', () => {
    it('resends the current LOBBY_UPDATE in the lobby, and changes nothing', () => {
        const { room, conns, store } = makeConnectedLobby(2);
        const before = store.load(room.matchId) as MatchRecord;

        room.resync(conns[0]);

        expect(last(conns[0].sent)).toMatchObject({ type: 'LOBBY_UPDATE' });
        expect(store.load(room.matchId) as MatchRecord).toEqual(before);
    });

    it('resends the current STATE_UPDATE once active, and changes nothing', () => {
        const { room, conns, store } = makeConnectedLobby(2);
        room.startMatch(conns[0]);
        const before = store.load(room.matchId) as MatchRecord;

        room.resync(conns[0]);

        expect(last(conns[0].sent)).toMatchObject({ type: 'STATE_UPDATE' });
        expect(store.load(room.matchId) as MatchRecord).toEqual(before);
    });

    it('refuses a resync from an unseated connection: ERROR{NOT_YOUR_SEAT}', () => {
        const { room } = makeConnectedLobby(2);
        const stranger = new RecordingConn();

        room.resync(stranger);

        expect(last(stranger.sent)).toEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
    });
});
