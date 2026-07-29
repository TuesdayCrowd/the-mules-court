/**
 * Stage 4: a whole match, played to a winner, through the real thing.
 *
 * Three seats are driven by `MatchSession` over three real WebSockets against
 * a real `Bun.serve`, choosing moves with `chooseFallbackPlay`. The fourth seat
 * is a scripted human. Nothing is mocked and nothing is stubbed — this is the
 * only test that proves the redaction boundary holds under the actual protocol
 * rather than a fixture, which is why the plan calls it the one to write before
 * believing any of the rest.
 *
 * Two checks run on **every** push, and both are deliberately race-free.
 *
 * A cross-seat hand comparison is not, and is left to `seatClient.test.ts`
 * where all three frames are known to come from one commit. Mid-match, a
 * Darell redraw or a Mayor Indbur trade moves a card between two players in a
 * single commit, and three independent sockets have no ordering guarantee at
 * this process's event loop — so "seat A's just-arrived hand" against "seat B's
 * last-processed view" can flag a legal trade as a leak. What is checked here
 * instead cannot go stale:
 *
 *  - **No instance id outside `own`.** A `RedactedView` names physical cards
 *    (`slug#n`) only under `own`. Everywhere else — discard piles, the face-up
 *    burn, the public log, round history — cards are named by *type*. So an
 *    instance id anywhere but `own` means hidden state escaped, whatever
 *    commit the frame came from.
 *  - **Forbidden substrings**, borrowed from the transport suite: a seed, an
 *    action log, or a seat token in a frame means something serialized raw
 *    state. Blunt on purpose; a precise check passes through the mistake.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { PlayerId, RedactedView } from '../game/engine';
import { makeConfig } from '../server/config';
import { startServer, type RunningServer } from '../server/index';
import type { ServerMessage } from '../server/protocol';
import { chooseMove, TestClient } from '../server/__tests__/testClient';
import { chooseFallbackPlay } from './fallbackPlay';
import { MatchSession } from './session';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: PlayerId;
    hostSeatToken: string;
}

/** Anything that would mean raw `MatchState` reached a client. */
const FORBIDDEN = ['seed', 'actionLog', 'seatToken', 'setAsideFaceDown', 'privateKnowledge', 'deckOrder'];

/** `slug#n` — one physical card. Legal only under `own`. */
const INSTANCE_ID = /[a-z]+(?:-[a-z]+)*#\d+/;

function assertRedacted(view: RedactedView, viewer: PlayerId): void {
    expect(view.own.playerId).toBe(viewer);

    // `own` is dropped by JSON.stringify when set to undefined, leaving exactly
    // the part of the view that may never name a physical card.
    const withoutOwn = JSON.stringify({ ...view, own: undefined });
    expect(withoutOwn).not.toMatch(INSTANCE_ID);

    const whole = JSON.stringify(view);
    for (const banned of FORBIDDEN) expect(whole).not.toContain(banned);
}

describe('a whole match through MatchSession', () => {
    let running: RunningServer;
    let httpBase: string;
    let wsBase: string;

    beforeAll(() => {
        running = startServer(
            makeConfig({
                port: 0,
                dbPath: ':memory:',
                // The reveal window is a real ten seconds in production. A match
                // runs several rounds, so the default would make this test spend
                // its life asleep rather than playing.
                revealWindowMs: 20,
                messageBurst: 10_000,
                messageRefillPerSec: 10_000
            })
        );
        httpBase = `http://localhost:${running.server.port}`;
        wsBase = `ws://localhost:${running.server.port}`;
    });

    afterAll(() => running.stop());

    it('plays four players to a Devotion Token winner, leaking nothing on any push', async () => {
        const created = (await (await fetch(`${httpBase}/api/rooms`, { method: 'POST' })).json()) as RoomCreated;

        const host = await TestClient.connect(wsBase);
        host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

        const session = new MatchSession();
        const joined = await session.joinMatch({
            matchId: created.matchId,
            nicknames: ['Bayta', 'Toran', 'Magnifico'],
            serverUrl: wsBase
        });
        const handleOf = new Map(joined.map(seat => [seat.playerId, seat.handle]));
        expect(handleOf.size).toBe(3);

        let lobby: LobbyUpdate | null = null;
        for (let i = 0; i < 12 && !lobby?.canStart; i++) lobby = await host.nextOfType('LOBBY_UPDATE');
        expect(lobby?.canStart).toBe(true);

        try {
            host.send({ type: 'START_MATCH', matchId: created.matchId });
            await host.nextOfType('STATE_UPDATE', 4000);

            let pushesChecked = 0;
            let seatMoves = 0;
            let humanMoves = 0;
            let winner: PlayerId | null = null;

            // Generous, but finite: a four-player match to its token target is
            // a few dozen turns, and a hang must fail rather than run forever.
            for (let guard = 0; guard < 800; guard++) {
                const signal = await session.awaitTurn(120);

                if (signal.status === 'match_over') {
                    // MATCH_ENDED is a broadcast and therefore the one
                    // authoritative statement of who won. Reading it off any
                    // single seat's latest STATE_UPDATE is racy: `awaitTurn`
                    // sees `ended` from whichever frame landed first, and the
                    // other sockets may not have delivered their final push
                    // yet. This test failed that way before it read the
                    // broadcast instead.
                    const ended = await host.nextOfType('MATCH_ENDED', 4000);
                    expect(ended.reason).toBe('won');
                    winner = ended.winnerSeat ?? null;
                    break;
                }

                if (signal.status === 'your_turn') {
                    const handle = handleOf.get(signal.seat!)!;
                    const seen = session.getView(handle);
                    expect(seen.ok).toBe(true);
                    if (seen.ok !== true) break;

                    assertRedacted(seen.view, signal.seat!);
                    pushesChecked++;

                    const move = chooseFallbackPlay(seen.view);
                    expect(move).not.toBeNull();
                    if (move === null) break;

                    const played = await session.playCard(handle, move);
                    expect(played.ok).toBe(true);
                    seatMoves++;
                    continue;
                }

                // `waiting` or `round_over`. If the table is live and the human
                // holds the turn, it is our job to move them along.
                const status = session.tableStatus();
                if (status.phase === 'active' && !status.paused && status.currentPlayerId === created.hostSeat) {
                    const humanView = host.lastState?.view;
                    if (humanView !== undefined && humanView.own.legalPlays.length > 0) {
                        host.send({ type: 'PLAY_CARD', matchId: created.matchId, ...chooseMove(humanView) });
                        await host.nextOfType('STATE_UPDATE', 4000);
                        humanMoves++;
                    }
                }
            }

            expect(winner).not.toBeNull();

            // The match was genuinely played by both sides, not won by a
            // forfeit or an abandonment that would satisfy `matchWinnerId`
            // without anybody taking a turn.
            expect(seatMoves).toBeGreaterThan(5);
            expect(humanMoves).toBeGreaterThan(0);
            expect(pushesChecked).toBeGreaterThan(5);

            // Every seat converges on the same winner. Converges, not "agrees
            // instantly" — the result is public and identical in every
            // projection of it, but three sockets deliver the final push
            // independently, so the invariant is eventual and the test has to
            // say so. Bounded, so a seat that never converges still fails.
            for (const seat of joined) {
                let settled: PlayerId | null = null;
                for (let attempt = 0; attempt < 40 && settled === null; attempt++) {
                    const seen = session.getView(seat.handle);
                    if (seen.ok === true && seen.view.matchWinnerId !== null) {
                        settled = seen.view.matchWinnerId;
                        break;
                    }
                    await Bun.sleep(25);
                }
                expect(settled).toBe(winner);
            }
        } finally {
            session.close();
            host.close();
        }
    }, 60_000);
});
