import { describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import type { MatchRecord } from '../persistence';
import { MatchStore } from '../persistence';
import type { ServerMessage } from '../protocol';
import { Room } from '../room';
import type { SeatConnection } from '../room';
import { hashToken } from '../seatTokens';

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
});
