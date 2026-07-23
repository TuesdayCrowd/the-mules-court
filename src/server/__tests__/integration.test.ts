/**
 * Real sockets, a real server, a full match (plan Task 13; Design §12 suite
 * 6 — "the one that matters most"). No mocks: `startServer` boots an actual
 * `Bun.serve` on an ephemeral port, and every `TestClient` is a genuine
 * `WebSocket`.
 *
 * The first test below is the minimal version this file first landed as —
 * create a room over HTTP, seat four clients, start the match — written and
 * run BEFORE `src/server/index.ts` existed, to prove it failed for the right
 * reason (`Cannot find module '../index'`). Task 12 made it pass, and only
 * then did this file grow the full play-to-completion leak-fuzzer below.
 *
 * Two different check styles are used deliberately, split by whether the
 * thing being checked can go stale mid-flight:
 *
 *  - Per-frame, via `TestClient.onFrame`, the instant any frame arrives at
 *    any client: forbidden substrings, and another seat's TOKEN. Both are
 *    static for the life of the match (a token never rotates), so there is
 *    no wrong moment to check them.
 *  - Per fully-synchronized commit "batch" — one STATE_UPDATE collected from
 *    EVERY seated client for the SAME commit, via `nextBatch` — for
 *    everything else: presence, and another seat's current HAND. A hand is
 *    NOT static (KING trades it between two players in one commit), and
 *    `Room.pushStateToConnectedSeats` sends all four pushes over four
 *    independent sockets with no ordering guarantee between them at the test
 *    process's event loop. Comparing "clientA's just-arrived frame" against
 *    "clientB's most-recently-PROCESSED frame" — the natural per-frame
 *    check — is provably racy the instant a KING trade lands: B's own
 *    repaint of the SAME commit may simply not have been dispatched yet,
 *    making its hand look one commit stale relative to A's, and flagging a
 *    trade as a leak. Comparing within one synchronized batch instead
 *    guarantees both sides are drawn from the identical commit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cardTypeOf } from '../../game/engine';
import type { PlayerId } from '../../game/engine';
import { makeConfig } from '../config';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import type { ServerMessage } from '../protocol';
import { chooseMove, TestClient } from './testClient';

type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
type MatchEnded = Extract<ServerMessage, { type: 'MATCH_ENDED' }>;
type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
type SeatClaimed = Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: string;
    hostSeatToken: string;
}

/** One seated client, with everything the leak-fuzzer needs to know about it. */
interface Seated {
    readonly client: TestClient;
    readonly playerId: PlayerId;
    readonly seatToken: string;
    readonly nickname: string;
}

/**
 * Substrings that must never appear in ANY wire frame (Design §12 suite 6,
 * §13's exploit table). None of these are ever legitimately present in a
 * `RedactedView` — `types.ts` makes that a compile-time property of the type
 * itself — so finding one here means something server-side reached past
 * `view()`/`buildStateUpdate` and serialized raw `MatchState` or a stored
 * token hash directly.
 */
const FORBIDDEN_SUBSTRINGS = [
    'deckOrder',
    'setAsideFaceDown',
    '"rng"',
    '"seed"',
    'actionLog',
    'privateKnowledge',
    'tokenHash'
];

const PRIEST_CARD_TYPES = new Set(['han-pritcher', 'bail-channis']);

async function createRoom(httpBase: string): Promise<RoomCreated> {
    const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomCreated;
}

/**
 * Seats a host (via RESUME_SEAT with the HTTP-minted token) and three
 * CLAIM_SEAT clients into a freshly created room, and waits for the lobby to
 * report `canStart`. Returns every client tagged with the identity info the
 * leak-fuzzer needs (Design §12 suite 6's presence/absence checks).
 */
async function seatFourClients(wsBase: string, created: RoomCreated): Promise<Seated[]> {
    const host = await TestClient.connect(wsBase);
    const others = await Promise.all([TestClient.connect(wsBase), TestClient.connect(wsBase), TestClient.connect(wsBase)]);

    // RESUME_SEAT has no direct per-connection ack (unlike CLAIM_SEAT's
    // SEAT_CLAIMED) — the host learns it succeeded only via the broadcast
    // LOBBY_UPDATE that resumeSeat triggers (Design §5 transition 2/7).
    host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

    const nicknames = ['Bayta', 'Toran', 'Ebling'];
    const claims: SeatClaimed[] = [];
    for (const [i, client] of others.entries()) {
        client.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: nicknames[i] });
        claims.push(await client.nextOfType('SEAT_CLAIMED'));
    }

    // Every claim (and the host's own resume) broadcasts a fresh
    // LOBBY_UPDATE; canStart flips true once 2-4 seats are claimed and
    // connected, so it may already be true before the last claim lands.
    // Drain the host's queue until it reports true rather than assuming any
    // particular frame is the one that does.
    let lobby: LobbyUpdate | null = null;
    for (let i = 0; i < 10 && !(lobby && lobby.canStart); i++) {
        lobby = await host.nextOfType('LOBBY_UPDATE');
    }
    expect(lobby?.canStart).toBe(true);

    return [
        { client: host, playerId: 'p1', seatToken: created.hostSeatToken, nickname: '' },
        ...others.map((client, i) => ({
            client,
            playerId: claims[i].playerId,
            seatToken: claims[i].seatToken,
            nickname: nicknames[i]
        }))
    ];
}

/** Finds the raw frame that produced `msg` (same reference `handleFrame` pushed to both `inbox` and `rawFrames`). */
function rawFor(client: TestClient, msg: ServerMessage): string {
    const idx = client.inbox.indexOf(msg);
    if (idx === -1) throw new Error("rawFor: message not found in this client's inbox");
    return client.rawFrames[idx];
}

interface FrameSink {
    matchStarted: string[];
    matchEnded: string[];
    /** Every ERROR any client received. `chooseMove` only ever offers legal moves, so a well-behaved happy-path match should draw none. */
    errors: Extract<ServerMessage, { type: 'ERROR' }>[];
}

/** Installs the ALWAYS-safe per-frame checks (Design §12 suite 6's absence half, minus the hand check — see file header). */
function installFrameChecks(seated: readonly Seated[], sink: FrameSink): void {
    for (const owner of seated) {
        owner.client.onFrame = (msg, raw) => {
            for (const needle of FORBIDDEN_SUBSTRINGS) {
                expect(raw.includes(needle)).toBe(false);
            }
            for (const other of seated) {
                if (other.client === owner.client) continue;
                expect(raw.includes(other.seatToken)).toBe(false);
            }
            if (msg.type === 'MATCH_STARTED') sink.matchStarted.push(raw);
            if (msg.type === 'MATCH_ENDED') sink.matchEnded.push(raw);
            if (msg.type === 'ERROR') sink.errors.push(msg);
        };
    }
}

/** Collects one STATE_UPDATE from every seated client, all belonging to the SAME server-side commit (see file header). */
async function nextBatch(seated: readonly Seated[]): Promise<Map<PlayerId, StateUpdate>> {
    const msgs = await Promise.all(seated.map(s => s.client.nextOfType<'STATE_UPDATE'>('STATE_UPDATE', 5000)));
    const batch = new Map<PlayerId, StateUpdate>();
    seated.forEach((s, i) => batch.set(s.playerId, msgs[i]));
    return batch;
}

/**
 * The cross-client half of Design §12 suite 6's leak-fuzzer, run once per
 * synchronized batch: presence invariants for every viewer, and absence of
 * every OTHER seat's hand — both safe here because every entry in `batch`
 * reflects the identical commit (see file header for why that matters).
 */
function assertBatchSafe(seated: readonly Seated[], batch: ReadonlyMap<PlayerId, StateUpdate>): void {
    for (const owner of seated) {
        const msg = batch.get(owner.playerId)!;
        const raw = rawFor(owner.client, msg);

        expect(msg.view.own.playerId).toBe(owner.playerId);
        for (const seated2 of seated) {
            expect(Object.prototype.hasOwnProperty.call(msg.nicknames, seated2.playerId)).toBe(true);
        }

        if (msg.phase === 'active') {
            const ownPlayer = msg.view.players.find(p => p.id === owner.playerId);
            if (!msg.paused && ownPlayer?.alive) {
                expect(msg.view.own.hand.length).toBeGreaterThan(0);
                if (msg.view.currentPlayerId === owner.playerId) {
                    expect(msg.view.own.legalPlays.length).toBeGreaterThan(0);
                }
            }
        }

        for (const other of seated) {
            if (other.playerId === owner.playerId) continue;
            const otherHand = batch.get(other.playerId)!.view.own.hand;
            for (const cardInstanceId of otherHand) {
                expect(raw.includes(cardInstanceId)).toBe(false);
            }
        }
    }
}

describe('integration: a full match over real sockets', () => {
    let running: RunningServer;
    let httpBase: string;
    let wsBase: string;

    beforeAll(() => {
        running = startServer(
            makeConfig({
                port: 0,
                dbPath: ':memory:',
                revealWindowMs: 25,
                // The per-connection token bucket (Design §8 step 4) is a real
                // control this suite isn't testing — that's Task 15's abuse
                // suite. A driver playing hundreds of cards back-to-back over
                // real, near-zero-latency localhost sockets would otherwise
                // legitimately trip RATE_LIMITED against the production
                // default (10 burst, 5/sec refill) well before a 4-player
                // match can finish.
                messageBurst: 1000,
                messageRefillPerSec: 1000
            })
        );
        httpBase = `http://localhost:${running.server.port}`;
        wsBase = `ws://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
    });

    it('creates a room over HTTP and seats four clients into a started match', async () => {
        const created = await createRoom(httpBase);
        expect(created.hostSeat).toBe('p1');
        expect(typeof created.matchId).toBe('string');
        expect(typeof created.hostSeatToken).toBe('string');

        const seated = await seatFourClients(wsBase, created);

        seated[0].client.send({ type: 'START_MATCH', matchId: created.matchId });
        await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));
        await Promise.all(seated.map(s => s.client.nextOfType('STATE_UPDATE')));

        for (const s of seated) s.client.close();
    });

    it(
        'plays a full 4-player match to completion with no leaked hidden state',
        async () => {
            const created = await createRoom(httpBase);
            const seated = await seatFourClients(wsBase, created);
            const matchId = created.matchId;

            const sink: FrameSink = { matchStarted: [], matchEnded: [], errors: [] };
            installFrameChecks(seated, sink);

            seated[0].client.send({ type: 'START_MATCH', matchId });
            await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));

            const PLAY_CAP = 500;
            const ITERATION_CAP = PLAY_CAP * 3; // generous headroom for round_over/advance batches that play nothing
            let plays = 0;
            let iterations = 0;
            let revealDeadlineSeen = false;
            let ended = false;
            // Peek presence over the wire (Design §12 suite 6): once a
            // client plays a PRIEST-effect card with a target, its OWN next
            // batch entry — guaranteed to be the push from that exact play,
            // since Room fully serializes one command at a time — must
            // carry a `revealed` entry for that target.
            const pendingPeekTarget = new Map<PlayerId, PlayerId>();

            let batch = await nextBatch(seated);

            while (!ended && plays < PLAY_CAP) {
                if (++iterations > ITERATION_CAP) {
                    throw new Error(`exceeded ${ITERATION_CAP} batches without reaching MATCH_ENDED (${plays} plays so far)`);
                }

                assertBatchSafe(seated, batch);

                for (const [actorId, targetId] of pendingPeekTarget) {
                    const actorMsg = batch.get(actorId)!;
                    expect(actorMsg.view.revealed.some(r => r.subjectId === targetId)).toBe(true);
                }
                pendingPeekTarget.clear();

                if ([...batch.values()].some(m => m.revealDeadline !== undefined)) revealDeadlineSeen = true;

                if ([...batch.values()].every(m => m.phase === 'ended')) {
                    ended = true;
                    break;
                }

                const actor = seated.find(s => {
                    const m = batch.get(s.playerId)!;
                    return m.phase === 'active' && !m.paused && m.view.currentPlayerId === s.playerId;
                });

                if (actor !== undefined) {
                    const view = batch.get(actor.playerId)!.view;
                    const move = chooseMove(view);
                    if (move.target !== undefined && PRIEST_CARD_TYPES.has(cardTypeOf(move.cardInstanceId))) {
                        pendingPeekTarget.set(actor.playerId, move.target);
                    }
                    actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                    plays++;
                }
                // else: nobody's turn this batch (a round_over reveal window)
                // — nothing to send; the server's own reveal timer advances
                // it, and the next batch reflects that automatically.

                batch = await nextBatch(seated);
            }

            if (!ended) {
                throw new Error(`match did not reach MATCH_ENDED within ${PLAY_CAP} plays`);
            }

            expect(plays).toBeGreaterThan(0);
            expect(plays).toBeLessThan(PLAY_CAP);
            expect(revealDeadlineSeen).toBe(true);

            const finalMatchWinnerIds = new Set([...batch.values()].map(m => m.view.matchWinnerId));
            expect(finalMatchWinnerIds.size).toBe(1);
            const matchWinnerId = [...finalMatchWinnerIds][0];
            expect(typeof matchWinnerId).toBe('string');
            if (typeof matchWinnerId !== 'string') {
                throw new Error('unreachable: matchWinnerId must be a string once every view reports the match won');
            }

            const matchEndedMsgs: MatchEnded[] = await Promise.all(seated.map(s => s.client.nextOfType<'MATCH_ENDED'>('MATCH_ENDED')));
            for (const msg of matchEndedMsgs) {
                expect(msg.reason).toBe('won');
                expect(msg.winnerSeat).toBe(matchWinnerId);
            }

            expect(sink.matchStarted.length).toBe(4);
            expect(new Set(sink.matchStarted).size).toBe(1);
            expect(sink.matchEnded.length).toBe(4);
            expect(new Set(sink.matchEnded).size).toBe(1);

            // chooseMove only ever offers a legal move, so a well-behaved
            // happy-path match should never draw a server-side ERROR.
            expect(sink.errors).toEqual([]);

            // The server survives the win: a PING still gets a PONG.
            seated[0].client.send({ type: 'PING' });
            await seated[0].client.nextOfType('PONG');

            for (const s of seated) s.client.close();
        },
        15000
    );
});
