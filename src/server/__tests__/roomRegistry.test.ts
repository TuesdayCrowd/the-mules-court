import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARD_CATALOG, EFFECT_DEFS, cardTypeOf, computeLegalPlays, computeLegalTargets } from '../../game/engine';
import type { GuessValue, MatchState } from '../../game/engine';
import { makeConfig } from '../config';
import type { MatchRecord } from '../persistence';
import { MatchStore } from '../persistence';
import type { ServerMessage } from '../protocol';
import { Room } from '../room';
import type { SeatConnection } from '../room';
import { RoomRegistry } from '../roomRegistry';
import { hashToken, mintToken } from '../seatTokens';

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

function stateUpdates(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'STATE_UPDATE' }> => m.type === 'STATE_UPDATE');
}

function latestStateUpdate(conn: RecordingConn): Extract<ServerMessage, { type: 'STATE_UPDATE' }> {
    return last(stateUpdates(conn));
}

/** White-box access to Room's private `match` field — room.test.ts's established pattern. */
function liveMatch(room: Room): MatchState {
    const match = (room as unknown as { match: MatchState | null }).match;
    if (match === null) throw new Error('liveMatch called before startMatch');
    return match;
}

/** One legal move for whoever currently holds the turn, driven through room.playCard (room.test.ts's helper). */
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

/** Claims and connects `seatCount` seats total (host + invitees) on `room`, returning conns and raw tokens. */
function seatRoom(room: Room, hostSeatToken: string, seatCount: 2 | 3 | 4): { conns: RecordingConn[]; tokens: string[] } {
    const hostConn = new RecordingConn();
    room.resumeSeat(hostConn, hostSeatToken);

    const conns = [hostConn];
    const tokens = [hostSeatToken];

    for (let i = 1; i < seatCount; i++) {
        const conn = new RecordingConn();
        room.claimSeat(conn, `Player${i}`);
        const claimedMsg = conn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        tokens.push(claimedMsg.seatToken);
        conns.push(conn);
    }

    return { conns, tokens };
}

function makeSyntheticRecord(overrides: Partial<MatchRecord> & { matchId: string }): MatchRecord {
    return {
        seed: null,
        hostSeat: 'p1',
        phase: 'lobby',
        endReason: null,
        winnerSeat: null,
        seats: [{ index: 0, playerId: 'p1', nickname: 'Host', tokenHash: hashToken(mintToken()) }],
        actionLog: [],
        quarantined: false,
        createdAt: 0,
        updatedAt: 0,
        ...overrides
    };
}

describe('RoomRegistry.createRoom / get — in-memory', () => {
    it('get returns the exact instance createRoom mapped, with the configured joinUrl shape and size 1', () => {
        const config = makeConfig({ dbPath: ':memory:', publicBaseUrl: 'https://mules.example' });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store);

        const created = registry.createRoom();

        expect(created.hostSeat).toBe('p1');
        expect(created.joinUrl).toBe(`https://mules.example/join/${created.matchId}`);
        expect(created.hostSeatToken).toHaveLength(32);
        expect(registry.size).toBe(1);

        const room = registry.get(created.matchId);
        expect(room).not.toBeNull();
        expect(room!.matchId).toBe(created.matchId);

        // Same object identity, not merely an equivalent rebuild.
        expect(registry.get(created.matchId)).toBe(room);
    });

    it('returns null for an id that was never created', () => {
        const config = makeConfig({ dbPath: ':memory:' });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store);

        expect(registry.get('never-created')).toBeNull();
        expect(registry.size).toBe(0);
    });
});

describe('RoomRegistry.get — lazy crash recovery', () => {
    it('cold-rebuilds a lobby room from a store shared with a previous registry instance, every claimed seat disconnected', () => {
        const config = makeConfig({ dbPath: ':memory:' });
        const store = new MatchStore(':memory:'); // ':memory:' handles differ per Database — share the OBJECT
        const registryA = new RoomRegistry(config, store);

        const { matchId, hostSeatToken } = registryA.createRoom();
        const roomA = registryA.get(matchId)!;

        const inviteeConn = new RecordingConn();
        roomA.claimSeat(inviteeConn, 'Bayta');
        const claimedMsg = inviteeConn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        const inviteeToken = claimedMsg.seatToken;

        // "Crash": registryA/roomA are simply abandoned — no explicit teardown,
        // matching a real process death. A fresh registry on the SAME store
        // stands in for the restarted process.
        const registryB = new RoomRegistry(config, store);
        const roomB = registryB.get(matchId);

        expect(roomB).not.toBeNull();
        expect(roomB).not.toBe(roomA);

        const hostConn = new RecordingConn();
        const hostResult = roomB!.resumeSeat(hostConn, hostSeatToken);
        expect(hostResult).toEqual({ seat: 0, playerId: 'p1' });

        const lobbyUpdate = last(hostConn.sent) as Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
        expect(lobbyUpdate.seats.find(s => s.seat === 1)).toEqual({
            seat: 1,
            playerId: 'p2',
            nickname: 'Bayta',
            status: 'disconnected'
        });

        // The original invitee token still resumes onto its seat.
        const inviteeConnAfter = new RecordingConn();
        expect(roomB!.resumeSeat(inviteeConnAfter, inviteeToken)).toEqual({ seat: 1, playerId: 'p2' });
    });

    it('cold-rebuilds an ACTIVE room via replay; a resumed seat repaints with its pre-crash view', () => {
        const config = makeConfig({ dbPath: ':memory:' });
        const store = new MatchStore(':memory:');
        const registryA = new RoomRegistry(config, store);

        const { matchId, hostSeatToken } = registryA.createRoom();
        const roomA = registryA.get(matchId)!;
        const { conns } = seatRoom(roomA, hostSeatToken, 2);

        roomA.startMatch(conns[0]);
        playOneLegalMove(roomA, conns);

        const preCrashView = latestStateUpdate(conns[0]).view;

        const registryB = new RoomRegistry(config, store);
        const roomB = registryB.get(matchId);
        expect(roomB).not.toBeNull();
        expect(roomB).not.toBe(roomA);

        const resumedHostConn = new RecordingConn();
        const result = roomB!.resumeSeat(resumedHostConn, hostSeatToken);
        expect(result).toEqual({ seat: 0, playerId: 'p1' });

        const postResumeUpdate = last(resumedHostConn.sent) as Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
        expect(postResumeUpdate.view.own.hand).toEqual(preCrashView.own.hand);
        expect(postResumeUpdate.view.publicLog).toEqual(preCrashView.publicLog);
        expect(postResumeUpdate.view.currentPlayerId).toEqual(preCrashView.currentPlayerId);
        expect(postResumeUpdate.view.turnNumber).toEqual(preCrashView.turnNumber);

        // The OTHER seat (p2) is still disconnected: this resume alone cannot unpause the room.
        expect(postResumeUpdate.paused).toBe(true);
        expect(postResumeUpdate.missingSeats).toEqual(['p2']);
    });

    it('a semantically corrupt actionLog fails replay on cold get: the row is quarantined, and a second get returns null without re-attempting replay', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mules-court-roomRegistry-'));
        const dbPath = join(dir, 'rooms.sqlite');

        try {
            const config = makeConfig({ dbPath });
            const storeA = new MatchStore(dbPath);
            const registryA = new RoomRegistry(config, storeA);

            const { matchId, hostSeatToken } = registryA.createRoom();
            const roomA = registryA.get(matchId)!;
            const { conns } = seatRoom(roomA, hostSeatToken, 2);
            roomA.startMatch(conns[0]);
            playOneLegalMove(roomA, conns);
            storeA.close();

            // Hand-corrupt the actionLog underneath the store with a second raw
            // connection (temp-dir idiom from persistence.test.ts): duplicate the
            // last logged action, which is syntactically valid JSON but illegal
            // to replay a second time (persistence.test.ts's own "corrupt log"
            // recipe) — this exercises Room.rebuild's OWN quarantine call, not
            // MatchStore.load()'s separate JSON-parse guard.
            const rawDb = new Database(dbPath);
            const row = rawDb.query('SELECT actionLog FROM matches WHERE matchId = ?').get(matchId) as { actionLog: string };
            const log = JSON.parse(row.actionLog) as unknown[];
            const corruptLog = [...log, log[log.length - 1]];
            rawDb.query('UPDATE matches SET actionLog = ? WHERE matchId = ?').run(JSON.stringify(corruptLog), matchId);
            rawDb.close();

            const storeB = new MatchStore(dbPath);
            const registryB = new RoomRegistry(config, storeB);

            expect(registryB.get(matchId)).toBeNull();
            expect(storeB.load(matchId)).toBeNull(); // Room.rebuild's own store.quarantine() took effect
            expect(storeB.listIds()).toContain(matchId); // still present for the reaper

            // Second attempt: MatchStore.load() now filters the row out on its
            // own (quarantined = 0), so Room.rebuild/replayMatch never runs again.
            expect(registryB.get(matchId)).toBeNull();
            expect(registryB.size).toBe(0);

            storeB.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('RoomRegistry.sweep — mapped rooms', () => {
    it('sweeps a mapped stale lobby to ended (transition 6)', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 100, retentionMs: 10_000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => t });

        const { matchId } = registry.createRoom();

        t = 200; // past lobbyTtlMs
        registry.sweep();

        const record = store.load(matchId) as MatchRecord;
        expect(record.phase).toBe('ended');
        expect(record.endReason).toBe('abandoned');
        expect(registry.size).toBe(1); // kept: nowhere near retentionMs yet
    });

    it('sweeps a mapped active room with zero connections past zeroConnTtlMs to ended("abandoned") (transition 13)', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', zeroConnTtlMs: 100, retentionMs: 10_000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => t });

        const { matchId, hostSeatToken } = registry.createRoom();
        const room = registry.get(matchId)!;
        const { conns } = seatRoom(room, hostSeatToken, 2);
        room.startMatch(conns[0]);

        room.handleClose(conns[0]);
        room.handleClose(conns[1]); // zero connections, both missing from t=0

        t = 200; // past zeroConnTtlMs
        registry.sweep();

        const record = store.load(matchId) as MatchRecord;
        expect(record.phase).toBe('ended');
        expect(record.endReason).toBe('abandoned');
        expect(registry.size).toBe(1); // an 'ended' room is only removed on a LATER sweep, past retentionMs
    });

    it('does not abandon a mapped active room while at least one seat is still connected', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', zeroConnTtlMs: 100, retentionMs: 10_000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => t });

        const { matchId, hostSeatToken } = registry.createRoom();
        const room = registry.get(matchId)!;
        const { conns } = seatRoom(room, hostSeatToken, 2);
        room.startMatch(conns[0]);

        room.handleClose(conns[1]); // only ONE seat missing; the other stays connected

        t = 1000; // far past zeroConnTtlMs
        registry.sweep();

        const record = store.load(matchId) as MatchRecord;
        expect(record.phase).toBe('active');
    });

    it('deletes a mapped ended room past retentionMs from both the map and the store (transition 14)', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 100, retentionMs: 200 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => t });

        const { matchId } = registry.createRoom();

        t = 150;
        registry.sweep(); // past lobbyTtlMs -> ended
        expect(registry.size).toBe(1);

        t = 150 + 200 + 1;
        registry.sweep(); // past retentionMs -> deleted

        expect(registry.size).toBe(0);
        expect(store.load(matchId)).toBeNull();
        expect(store.listIds()).not.toContain(matchId);
    });
});

describe('RoomRegistry.sweep — cold rows (never rebuilt since this process started)', () => {
    it('deletes a cold quarantined row once past retentionMs, requiring a full retention window from first observation', () => {
        let t = 0;
        const config = makeConfig({ dbPath: ':memory:', retentionMs: 100 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => t });

        store.save(makeSyntheticRecord({ matchId: 'quarantined-cold', phase: 'active', seed: 'seed' }));
        store.quarantine('quarantined-cold');

        registry.sweep(); // first sighting at t=0: starts the cold-quarantine clock, does not delete
        expect(store.listIds()).toContain('quarantined-cold');

        t = 100 + 1;
        registry.sweep(); // a full retentionMs has now passed since first observed cold
        expect(store.listIds()).not.toContain('quarantined-cold');
    });

    it('deletes a cold ended row past retentionMs, deciding from the record alone', () => {
        const config = makeConfig({ dbPath: ':memory:', retentionMs: 100 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => 1_000 });

        store.save(
            makeSyntheticRecord({ matchId: 'cold-ended-stale', phase: 'ended', endReason: 'abandoned', updatedAt: 0 })
        );

        registry.sweep();

        expect(store.load('cold-ended-stale')).toBeNull();
        expect(store.listIds()).not.toContain('cold-ended-stale');
    });

    it('keeps a cold ended row not yet past retentionMs', () => {
        const config = makeConfig({ dbPath: ':memory:', retentionMs: 1000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => 500 });

        store.save(
            makeSyntheticRecord({ matchId: 'cold-ended-fresh', phase: 'ended', endReason: 'abandoned', updatedAt: 0 })
        );

        registry.sweep();

        expect(store.listIds()).toContain('cold-ended-fresh');
    });

    it('deletes a cold lobby row past lobbyTtlMs+retentionMs, never rebuilding it to check', () => {
        const config = makeConfig({ dbPath: ':memory:', lobbyTtlMs: 50, retentionMs: 50 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => 1000 });

        store.save(makeSyntheticRecord({ matchId: 'cold-lobby-stale', phase: 'lobby', updatedAt: 0 }));

        registry.sweep();

        expect(store.load('cold-lobby-stale')).toBeNull();
        expect(store.listIds()).not.toContain('cold-lobby-stale');
        expect(registry.size).toBe(0); // never entered the map — decided cold, per the plan's lazy-rebuild rule
    });

    it('deletes a cold ACTIVE row past zeroConnTtlMs+retentionMs, even with an actionLog that would fail replay', () => {
        const config = makeConfig({ dbPath: ':memory:', zeroConnTtlMs: 50, retentionMs: 50 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => 1000 });

        store.save(
            makeSyntheticRecord({
                matchId: 'cold-active-stale',
                phase: 'active',
                seed: 'seed',
                updatedAt: 0,
                // A log nobody should ever be able to replay — proves this row
                // is deleted by age alone, never rebuilt to find out (the plan's
                // "sweep must not stall a big restart" rule): if a mutation
                // routed this through Room.rebuild instead, the illegal action
                // would only quarantine the row, and it would still be present
                // in listIds() afterward rather than gone entirely.
                actionLog: [{ type: 'PLAY_CARD', playerId: 'p9', cardInstanceId: 'informant#1' }]
            })
        );

        registry.sweep();

        expect(store.load('cold-active-stale')).toBeNull();
        expect(store.listIds()).not.toContain('cold-active-stale'); // truly deleted, not merely quarantined
    });

    it('keeps a cold active row not yet past zeroConnTtlMs+retentionMs', () => {
        const config = makeConfig({ dbPath: ':memory:', zeroConnTtlMs: 1000, retentionMs: 1000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store, { now: () => 500 });

        store.save(makeSyntheticRecord({ matchId: 'cold-active-fresh', phase: 'active', seed: 'seed', updatedAt: 0 }));

        registry.sweep();

        expect(store.listIds()).toContain('cold-active-fresh');
        expect(registry.size).toBe(0); // still never rebuilt — kept cold, not promoted into the map
    });
});

describe('RoomRegistry.startSweeping / stop', () => {
    it('schedules and clears without throwing; sweep still works after stop', () => {
        const config = makeConfig({ dbPath: ':memory:', sweepIntervalMs: 10_000 });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store);

        registry.createRoom();

        expect(() => registry.startSweeping()).not.toThrow();
        expect(() => registry.stop()).not.toThrow();

        // stop() disposed the mapped room; a manual sweep() afterward must
        // still run cleanly against the now-empty live map.
        expect(() => registry.sweep()).not.toThrow();
        expect(registry.size).toBe(0);
    });

    it('calling stop() twice does not throw', () => {
        const config = makeConfig({ dbPath: ':memory:' });
        const store = new MatchStore(':memory:');
        const registry = new RoomRegistry(config, store);

        registry.startSweeping();
        registry.stop();

        expect(() => registry.stop()).not.toThrow();
    });
});
