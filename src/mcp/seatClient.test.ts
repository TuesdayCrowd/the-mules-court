/**
 * Stage 2's criterion, against a real server: three seats claimed over three
 * real WebSockets, each receiving its own `RedactedView`.
 *
 * The host is a `TestClient` borrowed from the transport suite rather than a
 * second `SeatClient`. That is deliberate — the human hosts (Design §1), so
 * `SeatClient` has no business knowing how to mint a room or send
 * `START_MATCH`, and reusing the transport's own harness for the player this
 * package will never be is cheaper than widening the API for a test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { makeConfig } from '../server/config';
import { startServer, type RunningServer } from '../server/index';
import type { ServerMessage } from '../server/protocol';
import { TestClient } from '../server/__tests__/testClient';
import { SeatClient } from './seatClient';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: string;
    hostSeatToken: string;
}

const NICKNAMES = ['Bayta', 'Toran', 'Magnifico'] as const;

describe('SeatClient against a real server', () => {
    let running: RunningServer;
    let httpBase: string;
    let wsBase: string;

    beforeAll(() => {
        running = startServer(
            makeConfig({
                port: 0,
                dbPath: ':memory:',
                // The token bucket is a real control, tested in the transport's
                // own abuse suite. Raising it here keeps that from being what
                // this file measures.
                messageBurst: 1000,
                messageRefillPerSec: 1000
            })
        );
        httpBase = `http://localhost:${running.server.port}`;
        wsBase = `ws://localhost:${running.server.port}`;
    });

    afterAll(() => running.stop());

    async function createRoom(): Promise<RoomCreated> {
        const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
        expect(res.status).toBe(201);
        return (await res.json()) as RoomCreated;
    }

    /** A room with the host resumed and `count` MCP seats claimed, not yet started. */
    async function seatRoom(count: number) {
        const created = await createRoom();
        const host = await TestClient.connect(wsBase);
        host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

        const seats: SeatClient[] = [];
        for (let i = 0; i < count; i++) {
            seats.push(await SeatClient.claim(wsBase, created.matchId, NICKNAMES[i]!));
        }

        // canStart may flip before the final claim lands, so drain rather than
        // assume any one frame is the one that reports it.
        let lobby: LobbyUpdate | null = null;
        for (let i = 0; i < 12 && !lobby?.canStart; i++) {
            lobby = await host.nextOfType('LOBBY_UPDATE');
        }
        expect(lobby?.canStart).toBe(true);

        return { created, host, seats };
    }

    function shutDown(host: TestClient, seats: readonly SeatClient[]): void {
        host.close();
        for (const seat of seats) seat.close();
    }

    it('claims a seat and learns who it is', async () => {
        const { created, host, seats } = await seatRoom(1);
        try {
            const [seat] = seats;
            expect(seat!.identity.playerId).toMatch(/^p[1-4]$/);
            expect(seat!.identity.playerId).not.toBe(created.hostSeat);
            expect(seat!.identity.nickname).toBe('Bayta');
            expect(seat!.identity.seatToken).toMatch(/^[0-9a-f]{32}$/);
        } finally {
            shutDown(host, seats);
        }
    });

    it('gives each of three seats its own view', async () => {
        const { created, host, seats } = await seatRoom(3);
        try {
            host.send({ type: 'START_MATCH', matchId: created.matchId });
            const states = await Promise.all(seats.map(seat => seat.nextState()));

            const viewers = states.map(state => state.view.own.playerId);
            expect(new Set(viewers).size).toBe(3);
            // Each view is that seat's own, not a shared broadcast.
            expect(viewers).toEqual(seats.map(seat => seat.identity.playerId));
            for (const state of states) {
                expect(state.view.own.hand.length).toBeGreaterThan(0);
                expect(state.view.playerCount).toBe(4);
            }
        } finally {
            shutDown(host, seats);
        }
    });

    it('never lets one seat see a card in another seat\'s hand', async () => {
        const { created, host, seats } = await seatRoom(3);
        try {
            host.send({ type: 'START_MATCH', matchId: created.matchId });
            const states = await Promise.all(seats.map(seat => seat.nextState()));

            // Instance ids are unique per physical card, so an id held by one
            // seat appearing anywhere in another's frame is a leak with no
            // innocent reading — a discard pile holds played cards, never held
            // ones, and `revealed` names types rather than instances.
            for (const [i, mine] of states.entries()) {
                for (const [j, theirs] of states.entries()) {
                    if (i === j) continue;
                    const otherFrame = JSON.stringify(theirs.view);
                    for (const card of mine.view.own.hand) {
                        expect(otherFrame).not.toContain(card);
                    }
                }
            }
        } finally {
            shutDown(host, seats);
        }
    });

    it('resumes the same seat after its socket drops', async () => {
        const { created, host, seats } = await seatRoom(3);
        try {
            host.send({ type: 'START_MATCH', matchId: created.matchId });
            await Promise.all(seats.map(seat => seat.nextState()));

            const seat = seats[0]!;
            const before = seat.identity.playerId;

            seat.dropSocket();
            await Bun.sleep(50); // let the server notice the close
            await seat.reconnect();

            const repaint = await seat.nextState();
            expect(repaint.view.own.playerId).toBe(before);
            expect(seat.identity.playerId).toBe(before);
        } finally {
            shutDown(host, seats);
        }
    });
});
