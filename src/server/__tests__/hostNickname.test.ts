/**
 * The host seat's nickname (UIX §13.1).
 *
 * `createRoom` mints the host seat over HTTP, where no nickname exists to
 * supply, and `claimSeat` — the only writer of `seat.nickname` — never runs for
 * that seat, because the host arrives holding a token and sends `RESUME_SEAT`.
 * Seat 1's nickname therefore stays `null` forever, and the lobby shows a blank
 * host row.
 *
 * The fix is an optional `nickname` on `RESUME_SEAT`, adopted under two guards
 * that this file exists to pin down:
 *
 *  - Adopt ONCE, never rename. The seat token is the only credential in the
 *    system; a rename built on top of a credential is an impersonation
 *    primitive, and in a deduction game reconnecting under someone else's name
 *    attacks the core mechanic rather than merely annoying people.
 *  - LOBBY only. Nicknames resolve the public log, so a mid-match rename would
 *    retroactively change who the narration says played what.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../config';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import type { ServerMessage } from '../protocol';
import { TestClient } from './testClient';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: string;
    hostSeatToken: string;
}

/**
 * Seat indices are 0-based on the wire (`room.ts:83` builds seats 0-3 with
 * playerIds p1-p4), while UIX §4's lobby mockup numbers them from 1 for the
 * player. These name the wire values so the two never get confused here.
 */
const HOST_SEAT = 0;
const SECOND_SEAT = 1;

async function createRoom(httpBase: string): Promise<RoomCreated> {
    const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomCreated;
}

/** Reads lobby updates until the seat rows satisfy `until`, or gives up. */
async function lobbyWhere(client: TestClient, until: (l: LobbyUpdate) => boolean): Promise<LobbyUpdate> {
    let lobby: LobbyUpdate | null = null;
    for (let i = 0; i < 10; i++) {
        lobby = await client.nextOfType('LOBBY_UPDATE');
        if (until(lobby)) return lobby;
    }
    throw new Error(`lobby never satisfied the predicate; last was ${JSON.stringify(lobby)}`);
}

function nicknameOfSeat(lobby: LobbyUpdate, seat: number): string | null {
    return lobby.seats.find(s => s.seat === seat)?.nickname ?? null;
}

/** Fresh server per test: rooms are process-local, so isolation has to be too. */
function start(overrides: Parameters<typeof makeConfig>[0] = {}): {
    running: RunningServer;
    httpBase: string;
    wsBase: string;
} {
    const running = startServer(makeConfig({ port: 0, dbPath: ':memory:', ...overrides }));
    return {
        running,
        httpBase: `http://localhost:${running.server.port}`,
        wsBase: `ws://localhost:${running.server.port}`
    };
}

describe('host nickname over RESUME_SEAT (UIX §13.1)', () => {
    it('adopts the nickname a host presents on RESUME_SEAT', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const host = await TestClient.connect(wsBase);

            host.send({
                type: 'RESUME_SEAT',
                matchId: created.matchId,
                seatToken: created.hostSeatToken,
                nickname: 'Cornelius'
            });

            const lobby = await host.nextOfType('LOBBY_UPDATE');
            expect(nicknameOfSeat(lobby, HOST_SEAT)).toBe('Cornelius');

            host.close();
        } finally {
            running.stop();
        }
    });

    it('leaves the host blank when no nickname is presented', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const host = await TestClient.connect(wsBase);

            host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

            const lobby = await host.nextOfType('LOBBY_UPDATE');
            expect(nicknameOfSeat(lobby, HOST_SEAT)).toBeNull();

            host.close();
        } finally {
            running.stop();
        }
    });

    it('ignores a nickname on a seat that already has one', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const host = await TestClient.connect(wsBase);
            host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });
            await host.nextOfType('LOBBY_UPDATE');

            const ana = await TestClient.connect(wsBase);
            ana.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Ana' });
            const claimed = await ana.nextOfType('SEAT_CLAIMED');
            expect(claimed.seat).toBe(SECOND_SEAT);

            ana.close();
            await lobbyWhere(host, l => nicknameOfSeat(l, SECOND_SEAT) === 'Ana');

            // A second client presents Ana's token under a different name. The
            // seat is already named, so the rename must be refused silently.
            const mallory = await TestClient.connect(wsBase);
            mallory.send({
                type: 'RESUME_SEAT',
                matchId: created.matchId,
                seatToken: claimed.seatToken,
                nickname: 'Mallory'
            });

            const lobby = await mallory.nextOfType('LOBBY_UPDATE');
            expect(nicknameOfSeat(lobby, SECOND_SEAT)).toBe('Ana');

            mallory.close();
            host.close();
        } finally {
            running.stop();
        }
    });

    it('ignores a nickname once the match is active', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const matchId = created.matchId;

            const host = await TestClient.connect(wsBase);
            host.send({ type: 'RESUME_SEAT', matchId, seatToken: created.hostSeatToken });
            await host.nextOfType('LOBBY_UPDATE');

            const ana = await TestClient.connect(wsBase);
            ana.send({ type: 'CLAIM_SEAT', matchId, nickname: 'Ana' });
            await ana.nextOfType('SEAT_CLAIMED');
            await lobbyWhere(host, l => l.canStart);

            host.send({ type: 'START_MATCH', matchId });
            await host.nextOfType('MATCH_STARTED');
            await host.nextOfType('STATE_UPDATE');

            // Host drops mid-match and comes back claiming a name. The phase is
            // no longer lobby, so the seat must stay as it was.
            host.close();
            const returning = await TestClient.connect(wsBase);
            returning.send({ type: 'RESUME_SEAT', matchId, seatToken: created.hostSeatToken, nickname: 'Cornelius' });

            const state: StateUpdate = await returning.nextOfType('STATE_UPDATE');
            expect(state.nicknames.p1).toBe('');

            returning.close();
            ana.close();
        } finally {
            running.stop();
        }
    });

    it('rejects a control-character nickname on RESUME_SEAT as MALFORMED', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const host = await TestClient.connect(wsBase);

            host.send({
                type: 'RESUME_SEAT',
                matchId: created.matchId,
                seatToken: created.hostSeatToken,
                nickname: 'Corn' + String.fromCharCode(1) + 'elius'
            });

            const err = await host.nextOfType('ERROR');
            expect(err.code).toBe('MALFORMED');

            host.close();
        } finally {
            running.stop();
        }
    });

    it('rejects an oversized nickname on RESUME_SEAT rather than truncating it', async () => {
        const { running, httpBase, wsBase } = start();
        try {
            const created = await createRoom(httpBase);
            const host = await TestClient.connect(wsBase);

            host.send({
                type: 'RESUME_SEAT',
                matchId: created.matchId,
                seatToken: created.hostSeatToken,
                nickname: 'x'.repeat(25)
            });

            const err = await host.nextOfType('ERROR');
            expect(err.code).toBe('MALFORMED');

            host.close();
        } finally {
            running.stop();
        }
    });

    it('persists an adopted nickname across a server restart', async () => {
        // The adoption writes a StoredSeat field, so it has to reach sqlite
        // before any send — otherwise a rebuilt room resurrects a blank host.
        const dir = mkdtempSync(join(tmpdir(), 'mules-host-nickname-'));
        const dbPath = join(dir, 'match.sqlite');
        const first = start({ dbPath });
        let created: RoomCreated;

        try {
            created = await createRoom(first.httpBase);
            const host = await TestClient.connect(first.wsBase);
            host.send({
                type: 'RESUME_SEAT',
                matchId: created.matchId,
                seatToken: created.hostSeatToken,
                nickname: 'Cornelius'
            });
            const lobby = await host.nextOfType('LOBBY_UPDATE');
            expect(nicknameOfSeat(lobby, HOST_SEAT)).toBe('Cornelius');
            host.close();
        } finally {
            first.running.stop();
        }

        const second = start({ dbPath });
        try {
            const host = await TestClient.connect(second.wsBase);
            host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

            const lobby = await host.nextOfType('LOBBY_UPDATE');
            expect(nicknameOfSeat(lobby, HOST_SEAT)).toBe('Cornelius');

            host.close();
        } finally {
            second.running.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
