import { describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import type { TransportConfig } from '../config';
import { MatchStore } from '../persistence';
import type { ChatEntry, ServerMessage } from '../protocol';
import { Room } from '../room';
import type { RoomDeps, SeatConnection } from '../room';

class RecordingConn implements SeatConnection {
    sent: ServerMessage[] = [];
    closed = false;
    send(json: string): void {
        this.sent.push(JSON.parse(json));
    }
    close(): void {
        this.closed = true;
    }
}

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
    room.resumeSeat(hostConn, hostSeatToken, 'Host');
    conns.push(hostConn);

    for (let i = 1; i < seatCount; i++) {
        const conn = new RecordingConn();
        room.claimSeat(conn, `Player${i}`);
        const claimed = conn.sent.find(m => m.type === 'SEAT_CLAIMED') as Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
        tokens.push(claimed.seatToken);
        conns.push(conn);
    }

    return { room, store, config, conns, tokens };
}

function saidTo(conn: RecordingConn): Extract<ServerMessage, { type: 'CHAT_SAID' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'CHAT_SAID' }> => m.type === 'CHAT_SAID');
}

function historyTo(conn: RecordingConn): Extract<ServerMessage, { type: 'CHAT_HISTORY' }>[] {
    return conn.sent.filter((m): m is Extract<ServerMessage, { type: 'CHAT_HISTORY' }> => m.type === 'CHAT_HISTORY');
}

describe('Room.sendChat', () => {
    it('broadcasts to every connected seat, the speaker included', () => {
        const { room, conns } = makeConnectedLobby(3);
        room.sendChat(conns[1], 'hello');

        for (const conn of conns) {
            const said = saidTo(conn);
            expect(said).toHaveLength(1);
            expect(said[0].entry).toMatchObject({ kind: 'said', from: 'p2', nickname: 'Player1', text: 'hello' });
        }
    });

    it('numbers entries from 1, monotonically', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'one');
        room.sendChat(conns[1], 'two');

        const seqs = saidTo(conns[0]).map(m => m.entry.seq);
        expect(seqs).toEqual([1, 2]);
    });

    it('refuses once the match has ended, and says why', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.endMatch(conns[0]);
        conns[0].sent = [];

        room.sendChat(conns[0], 'gg');

        expect(saidTo(conns[0])).toHaveLength(0);
        expect(conns[0].sent).toContainEqual({ type: 'ERROR', code: 'MATCH_OVER' });
    });

    it('refuses a connection holding no seat', () => {
        const { room } = makeConnectedLobby(2);
        const stranger = new RecordingConn();

        room.sendChat(stranger, 'let me in');

        expect(saidTo(stranger)).toHaveLength(0);
        expect(stranger.sent).toContainEqual({ type: 'ERROR', code: 'NOT_YOUR_SEAT' });
    });

    it('carries the speaker name as it was, after the seat is handed to someone else', () => {
        // The failure this exists to prevent: a reopened seat relabelling the
        // words of whoever held it before.
        let now = 1_000_000;
        const { room, conns, config } = makeConnectedLobby(2, { now: () => now });
        room.sendChat(conns[1], 'brb');

        // Player1 drops, and the lobby reaper reopens the seat past its grace.
        room.handleClose(conns[1]);
        now += config.lobbyDisconnectGraceMs + 1;
        room.sweep();

        const replacement = new RecordingConn();
        room.claimSeat(replacement, 'Somebody Else');

        const history = historyTo(replacement);
        expect(history).toHaveLength(1);
        expect(history[0].entries).toEqual([
            expect.objectContaining({ kind: 'said', from: 'p2', nickname: 'Player1', text: 'brb' })
        ]);
    });
});

describe('the byte cap', () => {
    /** Small enough that a handful of ordinary messages overruns it. */
    const TINY = 400;

    it('evicts the oldest entries and leads the log with one TRIMMED note', () => {
        const { room, conns } = makeConnectedLobby(2, {}, { chatLogMaxBytes: TINY });
        for (let i = 0; i < 12; i++) room.sendChat(conns[0], `message number ${i}`);

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Late');
        const entries = historyTo(joiner)[0].entries;

        expect(entries[0]).toMatchObject({ kind: 'note', code: 'TRIMMED' });
        expect(entries.filter(e => e.kind === 'note')).toHaveLength(1);
        // The newest survived and the oldest did not.
        const texts = entries.filter((e): e is ChatEntry & { kind: 'said' } => e.kind === 'said').map(e => e.text);
        expect(texts).toContain('message number 11');
        expect(texts).not.toContain('message number 0');
    });

    it('keeps the serialized history inside the cap', () => {
        const { room, conns } = makeConnectedLobby(2, {}, { chatLogMaxBytes: TINY });
        for (let i = 0; i < 40; i++) room.sendChat(conns[0], 'x'.repeat(60));

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Late');
        const entries = historyTo(joiner)[0].entries;

        const bytes = entries.reduce((total, entry) => total + JSON.stringify(entry).length, 0);
        expect(bytes).toBeLessThanOrEqual(TINY);
    });
});

describe('history delivery', () => {
    it('reaches a seat on its SECOND reconnect, not only its first', () => {
        // Both seats already hold nicknames before this test body runs, so a
        // history send copying `resumeSeat`'s one-time-only nickname guard
        // would already fail on the FIRST iteration — that case proves
        // nothing about it. What the second iteration actually guards is a
        // different bug shape: a one-shot delivery flag, or any state that
        // makes history arrive once per seat rather than once per resume.
        const { room, conns, tokens } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'said once');

        for (const attempt of [1, 2]) {
            room.handleClose(conns[1]);
            const returning = new RecordingConn();
            room.resumeSeat(returning, tokens[1]);

            expect(historyTo(returning), `resume ${attempt}`).toHaveLength(1);
            expect(historyTo(returning)[0].entries).toHaveLength(1);
            conns[1] = returning;
        }
    });

    it('reaches a seat claimed after the conversation started', () => {
        const { room, conns } = makeConnectedLobby(2);
        room.sendChat(conns[0], 'before you arrived');

        const joiner = new RecordingConn();
        room.claimSeat(joiner, 'Third');

        expect(historyTo(joiner)[0].entries).toEqual([
            expect.objectContaining({ text: 'before you arrived' })
        ]);
    });
});

describe('a rebuilt room', () => {
    it('opens with a RESTARTED note, because the transcript did not survive', () => {
        const { room, store, config, tokens } = makeConnectedLobby(2);
        room.sendChat(new RecordingConn(), 'never mind');

        const record = store.load(room.matchId);
        if (record === null) throw new Error('the room was not persisted');
        const rebuilt = Room.rebuild(config, store, record, {});
        if (rebuilt === null) throw new Error('the room failed to rebuild');

        const conn = new RecordingConn();
        rebuilt.resumeSeat(conn, tokens[0]);

        expect(historyTo(conn)[0].entries).toEqual([
            expect.objectContaining({ kind: 'note', code: 'RESTARTED' })
        ]);
    });
});
