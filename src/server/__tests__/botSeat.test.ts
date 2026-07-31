/**
 * Computer opponents claimed from the lobby (Computer Opponent Design §8).
 *
 * Driven end to end over real sockets against a real `Bun.serve`, matching
 * every other file here. The point of testing it at this level rather than on
 * `Room` directly is that a bot seat's whole risk is how it interacts with
 * machinery built for humans — pause derivation, the start gate, the reaper,
 * and the reveal timer. A unit test of `addBot` would prove none of that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import type { BotDifficulty, ServerMessage } from '../protocol';
import { chooseMove, TestClient } from './testClient';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;

interface RoomCreated {
    matchId: string;
    hostSeatToken: string;
}

let server: RunningServer;
let httpBase: string;
let wsBase: string;

beforeAll(() => {
    server = startServer(
        makeConfig({
            port: 0,
            dbPath: ':memory:',
            // Small enough that a whole match runs inside a test, large enough
            // that the ordering under test is still the real ordering.
            botThinkMs: 2,
            revealWindowMs: 20,
            // Necessary here, and the reason is worth stating: compressing the
            // pacing to 2ms lets this one human client act faster than any
            // human could, and the default bucket (burst 10, refill 5/sec)
            // correctly throttles it. At the shipped `botThinkMs` a player
            // cannot approach that rate, so this is a fixture concession to the
            // fast clock, not a limit the feature needs raised.
            messageBurst: 1000,
            messageRefillPerSec: 1000
        })
    );
    httpBase = `http://localhost:${server.server.port}`;
    wsBase = `ws://localhost:${server.server.port}`;
});

afterAll(() => server.stop());

async function createRoom(): Promise<RoomCreated> {
    const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomCreated;
}

/** A connected host sitting in a fresh lobby, having adopted a nickname. */
async function hostALobby(): Promise<{ room: RoomCreated; host: TestClient }> {
    const room = await createRoom();
    const host = await TestClient.connect(`${wsBase}/ws`);
    host.send({
        type: 'RESUME_SEAT',
        matchId: room.matchId,
        seatToken: room.hostSeatToken,
        nickname: 'Bayta'
    });
    await host.nextOfType('LOBBY_UPDATE');
    return { room, host };
}

const lastLobby = (client: TestClient): LobbyUpdate =>
    [...client.inbox].reverse().find(m => m.type === 'LOBBY_UPDATE') as LobbyUpdate;

async function fillWithBots(
    host: TestClient,
    matchId: string,
    seats: number[],
    difficulty: BotDifficulty = 'adept'
): Promise<void> {
    for (const seat of seats) {
        host.send({ type: 'ADD_BOT', matchId, seat, difficulty });
        await host.nextOfType('LOBBY_UPDATE');
    }
}

describe('a host filling seats with computer opponents', () => {
    it('marks the seat as a computer and names it', async () => {
        const { room, host } = await hostALobby();

        await fillWithBots(host, room.matchId, [1]);

        const seat = lastLobby(host).seats[1];
        expect(seat.status).toBe('computer');
        expect(seat.playerId).toBe('p2');
        expect(seat.nickname).toBeTruthy();

        host.close();
    });

    it('seats the tier the host chose, and reports it back', async () => {
        const { room, host } = await hostALobby();

        await fillWithBots(host, room.matchId, [1], 'novice');
        await fillWithBots(host, room.matchId, [2], 'master');

        const seats = lastLobby(host).seats;
        expect(seats[1].difficulty).toBe('novice');
        expect(seats[2].difficulty).toBe('master');
        // A human seat must never carry one — the lobby renders a tier name
        // from it, and a name beside a person would be a lie.
        expect(seats[0].difficulty).toBeNull();

        host.close();
    });

    it('refuses a difficulty the protocol does not know', async () => {
        const { room, host } = await hostALobby();

        host.sendRaw(
            JSON.stringify({ type: 'ADD_BOT', matchId: room.matchId, seat: 1, difficulty: 'unbeatable' })
        );
        const error = await host.nextOfType('ERROR');

        expect(error.code).toBe('MALFORMED');
        expect(lastLobby(host).seats[1].status).toBe('open');

        host.close();
    });

    it('lets the host start alone once bots fill the table', async () => {
        const { room, host } = await hostALobby();
        expect(lastLobby(host).canStart).toBe(false);

        await fillWithBots(host, room.matchId, [1, 2, 3]);

        expect(lastLobby(host).canStart).toBe(true);
        host.close();
    });

    it('never counts a computer seat as missing', async () => {
        const { room, host } = await hostALobby();
        await fillWithBots(host, room.matchId, [1, 2, 3]);

        host.send({ type: 'START_MATCH', matchId: room.matchId });
        const started = await host.nextOfType('STATE_UPDATE');

        // The whole hazard: a bot seat holds a token and no socket, which is
        // exactly the shape `missingSeats` was written to detect. If bots are
        // not excluded, a solo match is born paused and can never be played.
        expect(started.paused).toBe(false);
        expect(started.missingSeats).toEqual([]);

        host.close();
    });

    it(
        'plays a whole match against three computer opponents',
        async () => {
            const { room, host } = await hostALobby();
            await fillWithBots(host, room.matchId, [1, 2, 3]);

            host.onFrame = msg => {
                if (msg.type !== 'STATE_UPDATE') return;
                if (msg.phase !== 'active' || msg.paused) return;
                if (msg.view.currentPlayerId !== 'p1') return;
                if (msg.view.own.legalPlays.length === 0) return;
                host.send({ type: 'PLAY_CARD', matchId: room.matchId, ...chooseMove(msg.view) });
            };

            host.send({ type: 'START_MATCH', matchId: room.matchId });
            const ended = await host.nextOfType('MATCH_ENDED', 30_000);

            expect(ended.reason).toBe('won');
            host.onFrame = null;
            host.close();
        },
        40_000
    );

    it('refuses a seat somebody is already sitting in', async () => {
        const { room, host } = await hostALobby();

        const guest = await TestClient.connect(`${wsBase}/ws`);
        guest.send({ type: 'CLAIM_SEAT', matchId: room.matchId, nickname: 'Toran' });
        await guest.nextOfType('SEAT_CLAIMED');
        await host.nextOfType('LOBBY_UPDATE');

        host.send({ type: 'ADD_BOT', matchId: room.matchId, seat: 1, difficulty: 'adept' });
        const error = await host.nextOfType('ERROR');

        expect(error.code).toBe('SEAT_TAKEN');

        host.close();
        guest.close();
    });

    it('refuses anyone but the host', async () => {
        const { room, host } = await hostALobby();

        const guest = await TestClient.connect(`${wsBase}/ws`);
        guest.send({ type: 'CLAIM_SEAT', matchId: room.matchId, nickname: 'Toran' });
        await guest.nextOfType('SEAT_CLAIMED');

        guest.send({ type: 'ADD_BOT', matchId: room.matchId, seat: 2, difficulty: 'adept' });
        const error = await guest.nextOfType('ERROR');

        expect(error.code).toBe('NOT_HOST');

        host.close();
        guest.close();
    });

    it('refuses once the match is under way', async () => {
        const { room, host } = await hostALobby();
        await fillWithBots(host, room.matchId, [1, 2]);

        host.send({ type: 'START_MATCH', matchId: room.matchId });
        await host.nextOfType('MATCH_STARTED');

        host.send({ type: 'ADD_BOT', matchId: room.matchId, seat: 3, difficulty: 'adept' });
        const error = await host.nextOfType('ERROR');

        expect(error.code).toBe('CANNOT_START');

        host.close();
    });
});
