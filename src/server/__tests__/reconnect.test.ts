/**
 * Reconnection and crash recovery over real sockets (plan Task 14; Design
 * §7). No mocking of the transport, same as `integration.test.ts`: a real
 * `Bun.serve` instance, real `WebSocket` clients, and — for the server-
 * restart case — a real file-backed `bun:sqlite` database that outlives the
 * process that wrote to it.
 *
 * Design §7's punchline is that a mid-match drop and a full server crash are
 * the SAME code path: both leave a room with every affected seat missing and
 * `paused` true, and the ordinary `RESUME_SEAT` flow is what clears it
 * either way. This file's four cases are, in order: an ordinary drop, a drop
 * during the round-over reveal window (the timer must cancel and later
 * re-arm at the FULL window on reconnect, never the leftover), a whole-
 * process restart, and `REQUEST_RESYNC`'s no-op idempotence.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerId } from '../../game/engine';
import { makeConfig } from '../config';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import type { ServerMessage } from '../protocol';
import { chooseMove, TestClient } from './testClient';

type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
type SeatClaimed = Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: string;
    hostSeatToken: string;
}

/** One seated client: enough identity to reconnect it later with its own stored token. */
interface Seated {
    readonly client: TestClient;
    readonly playerId: PlayerId;
    readonly seatToken: string;
}

/**
 * The per-connection/per-IP token buckets are a real control this suite
 * isn't testing (that's Task 15's abuse suite) — a driver loop playing many
 * cards back-to-back over real, near-zero-latency localhost sockets would
 * otherwise trip `RATE_LIMITED` well before a match can finish, exactly as
 * `integration.test.ts` notes at its own `beforeAll`.
 */
const GENEROUS_RATE_LIMITS = { messageBurst: 1000, messageRefillPerSec: 1000 };

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function createRoom(httpBase: string): Promise<RoomCreated> {
    const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomCreated;
}

/**
 * Seats a host (via RESUME_SEAT with the HTTP-minted token) and one CLAIM_SEAT
 * client per entry in `nicknames`, waiting for the lobby to report `canStart`.
 * A generalized, N-player version of `integration.test.ts`'s `seatFourClients`.
 */
async function seatClients(wsBase: string, created: RoomCreated, nicknames: readonly string[]): Promise<Seated[]> {
    const host = await TestClient.connect(wsBase);
    const others = await Promise.all(nicknames.map(() => TestClient.connect(wsBase)));

    host.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });

    const claims: SeatClaimed[] = [];
    for (const [i, client] of others.entries()) {
        client.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: nicknames[i] });
        claims.push(await client.nextOfType('SEAT_CLAIMED'));
    }

    let lobby: LobbyUpdate | null = null;
    for (let i = 0; i < 10 && !(lobby && lobby.canStart); i++) {
        lobby = await host.nextOfType('LOBBY_UPDATE');
    }
    expect(lobby?.canStart).toBe(true);

    return [
        { client: host, playerId: 'p1' as PlayerId, seatToken: created.hostSeatToken },
        ...others.map((client, i) => ({ client, playerId: claims[i].playerId, seatToken: claims[i].seatToken }))
    ];
}

/** Collects one STATE_UPDATE from every listed client, keyed by playerId. */
async function nextBatch(seated: readonly { client: TestClient; playerId: PlayerId }[]): Promise<Map<PlayerId, StateUpdate>> {
    const msgs = await Promise.all(seated.map(s => s.client.nextOfType<'STATE_UPDATE'>('STATE_UPDATE', 5000)));
    const batch = new Map<PlayerId, StateUpdate>();
    seated.forEach((s, i) => batch.set(s.playerId, msgs[i]));
    return batch;
}

/** Whoever currently holds the turn, connected and unpaused — or undefined during a round-over lull. */
function findActor(
    seated: readonly { client: TestClient; playerId: PlayerId }[],
    batch: ReadonlyMap<PlayerId, StateUpdate>
): { client: TestClient; playerId: PlayerId } | undefined {
    return seated.find(s => {
        const m = batch.get(s.playerId)!;
        return m.phase === 'active' && !m.paused && m.view.currentPlayerId === s.playerId;
    });
}

describe('reconnect: dropped seats and crash recovery over real sockets (Design §7)', () => {
    it('pauses the room on a hard drop, refuses PLAY_CARD, and repaints identically on reconnect', async () => {
        const running = startServer(makeConfig({ port: 0, dbPath: ':memory:', revealWindowMs: 5000, ...GENEROUS_RATE_LIMITS }));
        const httpBase = `http://localhost:${running.server.port}`;
        const wsBase = `ws://localhost:${running.server.port}`;

        try {
            const created = await createRoom(httpBase);
            const matchId = created.matchId;
            const seated = await seatClients(wsBase, created, ['Bayta', 'Toran']); // 3 clients, per the plan

            seated[0].client.send({ type: 'START_MATCH', matchId });
            await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));

            let batch = await nextBatch(seated);
            const dropped = seated[1];
            const remaining = seated.filter(s => s !== dropped);
            const remainingHasLiveHand = (b: Map<PlayerId, StateUpdate>): boolean =>
                remaining.some(s => b.get(s.playerId)!.view.own.hand.length > 0);

            // Play 1-2 moves so the drop happens genuinely mid-match.
            for (let i = 0; i < 2; i++) {
                const actor = findActor(seated, batch);
                if (actor === undefined) break;
                const move = chooseMove(batch.get(actor.playerId)!.view);
                actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                batch = await nextBatch(seated);
            }

            // Root-caused (2026-07-23 flake audit): a rare opening shuffle can
            // have those 1-2 moves eliminate BOTH remaining seats outright
            // (e.g. two correct Informant guesses back to back) — round-over,
            // not a bug, but it leaves neither remaining seat holding a card
            // to attempt a well-formed PLAY_CARD with below. When that
            // happens, ride out the round_over lull — the server's own timer
            // redeals — until a remaining seat is holding a card again,
            // rather than asserting on a state this scenario cannot produce.
            let wipeoutRecoveryIterations = 0;
            while (!remainingHasLiveHand(batch)) {
                if (++wipeoutRecoveryIterations > 40) {
                    throw new Error('both remaining seats stayed handless well past the opening moves');
                }
                const actor = findActor(seated, batch);
                if (actor === undefined) {
                    batch = await nextBatch(seated); // a round_over lull — let the server's own timer redeal
                    continue;
                }
                const move = chooseMove(batch.get(actor.playerId)!.view);
                actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                batch = await nextBatch(seated);
            }

            const preDropState = batch.get(dropped.playerId)!;
            const preDropHand = preDropState.view.own.hand;
            const preDropPublicLog = preDropState.view.publicLog;

            // Hard-close from the client side — a real socket drop, not a
            // graceful sign-off the server could tell apart from a crash.
            dropped.client.close();

            // Design §5/§7: every remaining seat's very next push is paused,
            // naming the dropped seat.
            const pausedPushes = await Promise.all(remaining.map(s => s.client.nextOfType('STATE_UPDATE')));
            remaining.forEach((_s, i) => {
                expect(pausedPushes[i].paused).toBe(true);
                expect(pausedPushes[i].missingSeats).toContain(dropped.playerId);
            });

            // A connected client's PLAY_CARD is refused PAUSED regardless of
            // whose turn it is — Design §8's pause gate runs before the engine,
            // so it beats NOT_YOUR_TURN outright even for an off-turn seat.
            // Picked by non-empty hand rather than hardcoded to remaining[0]:
            // one of the 1-2 opening moves can, rarely, eliminate a player
            // outright (a correct Informant guess), and an eliminated seat's
            // hand is empty — a cardInstanceId of `undefined` would draw
            // MALFORMED instead of the PAUSED this step means to exercise.
            // The wipeout-recovery loop above guarantees at least one of
            // `remaining` has a card by this point, so this is never -1.
            const attemptedIdx = pausedPushes.findIndex(m => m.view.own.hand.length > 0);
            expect(attemptedIdx).toBeGreaterThanOrEqual(0);
            const attempted = remaining[attemptedIdx];
            const attemptedHand = pausedPushes[attemptedIdx].view.own.hand;
            attempted.client.send({ type: 'PLAY_CARD', matchId, cardInstanceId: attemptedHand[0] });
            const err = await attempted.client.nextOfType('ERROR');
            expect(err.code).toBe('PAUSED');

            // Reconnect on a brand-new socket with the stored token.
            const resumed = await TestClient.connect(wsBase);
            resumed.send({ type: 'RESUME_SEAT', matchId, seatToken: dropped.seatToken });

            // Design §7 step 5: the FIRST push this new socket ever sees is a
            // complete repaint built fresh from live state, never a cache —
            // and since nothing touched match state while it was gone, it
            // matches the pre-drop view exactly.
            const repaint = await resumed.nextOfType('STATE_UPDATE');
            expect(repaint.view.own.hand).toEqual(preDropHand);
            expect(repaint.view.publicLog).toEqual(preDropPublicLog);
            expect(repaint.paused).toBe(false);
            expect(repaint.missingSeats).toEqual([]);

            // Design §7 step 6: once the last missing seat clears, every OTHER
            // connected seat gets its own fresh push too, so the "waiting for…"
            // banners clear together everywhere, not just for the resumer.
            const clearedPushes = await Promise.all(remaining.map(s => s.client.nextOfType('STATE_UPDATE')));
            for (const msg of clearedPushes) {
                expect(msg.paused).toBe(false);
                expect(msg.missingSeats).toEqual([]);
            }

            resumed.close();
            for (const s of remaining) s.client.close();
        } finally {
            running.stop();
        }
    }, 8000);

    it('cancels the reveal countdown on a drop during round_over and re-arms a FULL window on reconnect', async () => {
        const revealWindowMs = 300; // generous enough to act inside, per the plan
        const running = startServer(makeConfig({ port: 0, dbPath: ':memory:', revealWindowMs, ...GENEROUS_RATE_LIMITS }));
        const httpBase = `http://localhost:${running.server.port}`;
        const wsBase = `ws://localhost:${running.server.port}`;

        try {
            const created = await createRoom(httpBase);
            const matchId = created.matchId;
            const seated = await seatClients(wsBase, created, ['Bayta']); // 2-player match, per the plan

            seated[0].client.send({ type: 'START_MATCH', matchId });
            await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));

            let batch = await nextBatch(seated);
            let iterations = 0;
            while (![...batch.values()].some(m => m.phase === 'round_over')) {
                if (++iterations > 200) throw new Error('did not reach round_over within 200 batches');
                const actor = findActor(seated, batch);
                if (actor === undefined) throw new Error('no actor while driving to round_over (unexpected mid-active lull)');
                const move = chooseMove(batch.get(actor.playerId)!.view);
                actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                batch = await nextBatch(seated);
            }

            const roundOverPush = batch.get(seated[0].playerId)!;
            expect(roundOverPush.revealDeadline).toBeDefined();
            const originalDeadline = roundOverPush.revealDeadline as number;

            const dropped = seated[1];
            const remaining = seated[0];

            // A real gap before dropping: everything up to here runs
            // synchronously back-to-back, and `Date.now()` only has 1ms
            // resolution, so without this the reconnect's re-arm could land
            // in the exact same tick as the original arm and produce a
            // numerically equal (not merely no-later) deadline despite being
            // logically later. Still tiny next to the 300ms window, so the
            // original timer has not fired by the time we drop.
            await sleep(20);

            dropped.client.close();

            const pausedPush = await remaining.client.nextOfType('STATE_UPDATE');
            expect(pausedPush.paused).toBe(true);
            expect(pausedPush.missingSeats).toContain(dropped.playerId);
            // The room cancels the timer outright on disconnect (Design §5 row
            // 7/§6) — it does not merely leave a stale deadline on the wire.
            expect(pausedPush.revealDeadline).toBeUndefined();

            const resumed = await TestClient.connect(wsBase);
            const reconnectStart = Date.now();
            resumed.send({ type: 'RESUME_SEAT', matchId, seatToken: dropped.seatToken });

            const repaint = await resumed.nextOfType('STATE_UPDATE');
            expect(repaint.paused).toBe(false);
            expect(repaint.revealDeadline).toBeDefined();
            const freshDeadline = repaint.revealDeadline as number;
            expect(freshDeadline).toBeGreaterThan(originalDeadline);

            // Drain the other seat's own "banners clear together" push before
            // waiting for the next round, so its STATE_UPDATE queue realigns
            // to one message per commit.
            const clearedPush = await remaining.client.nextOfType('STATE_UPDATE');
            expect(clearedPush.paused).toBe(false);
            expect(clearedPush.revealDeadline).toBe(freshDeadline);

            // The full window runs again measured from THIS reconnect, not a
            // resumed leftover of the original countdown.
            const nextRoundPush = await resumed.nextOfType('STATE_UPDATE', revealWindowMs + 2000);
            const elapsedSinceReconnect = Date.now() - reconnectStart;
            expect(nextRoundPush.phase === 'active' || nextRoundPush.phase === 'round_over').toBe(true);
            expect(elapsedSinceReconnect).toBeGreaterThanOrEqual(revealWindowMs * 0.6);

            resumed.close();
            remaining.client.close();
        } finally {
            running.stop();
        }
    }, 8000);

    it('a full server restart replays to a fully live state and the match plays on to MATCH_ENDED', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mules-'));
        const dbPath = join(dir, 'reconnect-restart.sqlite');

        let running1: RunningServer | null = null;
        let running2: RunningServer | null = null;
        const allClients: TestClient[] = [];

        try {
            running1 = startServer(makeConfig({ port: 0, dbPath, revealWindowMs: 40, ...GENEROUS_RATE_LIMITS }));
            const httpBase1 = `http://localhost:${running1.server.port}`;
            const wsBase1 = `ws://localhost:${running1.server.port}`;

            const created = await createRoom(httpBase1);
            const matchId = created.matchId;
            const seated = await seatClients(wsBase1, created, ['Bayta', 'Toran']); // 3 clients, per the plan
            allClients.push(...seated.map(s => s.client));

            seated[0].client.send({ type: 'START_MATCH', matchId });
            await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));

            const TARGET_PLAYS = 4; // "several turns"
            let plays = 0;
            let iterations = 0;
            let batch = await nextBatch(seated);
            let preRestartBatch: Map<PlayerId, StateUpdate> | null = null;
            // Root-caused (2026-07-23 flake audit): `startNextRound` is never
            // appended to `actionLog` (persistence.ts's `replayMatch` — it is
            // re-derived from state alone on replay), so the FIRST active
            // batch after a round_over lull reflects a redeal nothing in the
            // log records yet. Capturing THAT batch as `preRestartBatch` and
            // comparing it to a post-crash replay is comparing a live,
            // post-redeal hand to a replay that (correctly, per Design §7)
            // rebuilds only as far as the previous round's logged round-over
            // — a mismatch in the test's own capture point, not a recovery
            // bug. `justRedealt` forces at least one PLAY_CARD to actually
            // land in the new round — and so be captured in `actionLog` —
            // before this loop is willing to treat a batch as "pre".
            let justRedealt = false;

            while (preRestartBatch === null) {
                if (++iterations > 300) throw new Error('did not reach the target play count before restart');
                const actor = findActor(seated, batch);
                if (actor === undefined) {
                    batch = await nextBatch(seated); // a round_over lull — let the server's own timer advance it
                    justRedealt = true;
                    continue;
                }
                if (plays >= TARGET_PLAYS && !justRedealt) {
                    preRestartBatch = batch; // stop with a live, actionLog-backed actor — don't consume this turn
                    break;
                }
                const move = chooseMove(batch.get(actor.playerId)!.view);
                actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                plays++;
                justRedealt = false;
                batch = await nextBatch(seated);
            }

            // The crash: the whole process goes down with live sockets still
            // attached. index.ts's `stopped` flag makes this safe (its own
            // close handler no-ops once the flag is set, before the registry
            // or the store are torn down).
            running1.stop();
            running1 = null;

            running2 = startServer(makeConfig({ port: 0, dbPath, revealWindowMs: 40, ...GENEROUS_RATE_LIMITS }));
            const wsBase2 = `ws://localhost:${running2.server.port}`;

            // Reconnect one at a time: only the LAST RESUME_SEAT flips the room
            // from paused, so this is the only way to cleanly tell each seat's
            // own repaint apart from the "banners clear together" broadcast
            // that follows it (Design §7 steps 5-6).
            const resumedClients: TestClient[] = [];
            const repaints = new Map<PlayerId, StateUpdate>();
            for (const s of seated) {
                const client = await TestClient.connect(wsBase2);
                allClients.push(client);
                resumedClients.push(client);
                client.send({ type: 'RESUME_SEAT', matchId, seatToken: s.seatToken });
                repaints.set(s.playerId, await client.nextOfType('STATE_UPDATE'));
            }

            for (const s of seated) {
                const pre = preRestartBatch.get(s.playerId)!;
                const rebuilt = repaints.get(s.playerId)!;

                expect(rebuilt.view.own.hand).toEqual(pre.view.own.hand);
                expect(rebuilt.view.currentPlayerId).toBe(pre.view.currentPlayerId);
                expect(rebuilt.view.turnNumber).toBe(pre.view.turnNumber);
                for (const prePlayer of pre.view.players) {
                    const rebuiltPlayer = rebuilt.view.players.find(p => p.id === prePlayer.id);
                    expect(rebuiltPlayer).toBeDefined();
                    expect(rebuiltPlayer?.tokens).toBe(prePlayer.tokens);
                    expect(rebuiltPlayer?.discardPile.length).toBe(prePlayer.discardPile.length);
                }
            }

            // The last reconnect above also flipped every EARLIER seat from
            // paused to unpaused — drain those pushes now so the STATE_UPDATE
            // queues realign to one message per commit before playing on.
            const newSeated = seated.map((s, i) => ({ client: resumedClients[i], playerId: s.playerId }));
            const liveStartBatch = new Map<PlayerId, StateUpdate>();
            for (let i = 0; i < newSeated.length - 1; i++) {
                const drained = await newSeated[i].client.nextOfType<'STATE_UPDATE'>('STATE_UPDATE');
                expect(drained.paused).toBe(false);
                liveStartBatch.set(newSeated[i].playerId, drained);
            }
            const lastPlayerId = newSeated[newSeated.length - 1].playerId;
            liveStartBatch.set(lastPlayerId, repaints.get(lastPlayerId)!);

            // Play on to MATCH_ENDED — proving the rebuilt state is fully
            // live, not merely readable (Design §7's "no special case").
            const PLAY_CAP = 500;
            const ITERATION_CAP = PLAY_CAP * 3;
            let livePlays = 0;
            let liveIterations = 0;
            let liveBatch = liveStartBatch;
            let ended = false;

            while (!ended && livePlays < PLAY_CAP) {
                if (++liveIterations > ITERATION_CAP) {
                    throw new Error(`exceeded ${ITERATION_CAP} batches without reaching MATCH_ENDED (${livePlays} plays so far)`);
                }
                if ([...liveBatch.values()].every(m => m.phase === 'ended')) {
                    ended = true;
                    break;
                }
                const actor = findActor(newSeated, liveBatch);
                if (actor !== undefined) {
                    const move = chooseMove(liveBatch.get(actor.playerId)!.view);
                    actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
                    livePlays++;
                }
                liveBatch = await nextBatch(newSeated);
            }

            if (!ended) throw new Error(`match did not reach MATCH_ENDED within ${PLAY_CAP} plays after restart`);

            await Promise.all(newSeated.map(s => s.client.nextOfType('MATCH_ENDED')));
        } finally {
            for (const client of allClients) client.close();
            running1?.stop();
            running2?.stop();
            rmSync(dir, { recursive: true, force: true });
        }
    }, 20000);

    it('REQUEST_RESYNC repeats the last STATE_UPDATE and changes nothing else', async () => {
        const running = startServer(makeConfig({ port: 0, dbPath: ':memory:', revealWindowMs: 5000, ...GENEROUS_RATE_LIMITS }));
        const httpBase = `http://localhost:${running.server.port}`;
        const wsBase = `ws://localhost:${running.server.port}`;

        try {
            const created = await createRoom(httpBase);
            const matchId = created.matchId;
            const seated = await seatClients(wsBase, created, ['Bayta', 'Toran']);

            seated[0].client.send({ type: 'START_MATCH', matchId });
            await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));

            let batch = await nextBatch(seated);

            // One real move first, so this is genuinely mid-match rather than
            // the opening deal.
            const firstActor = findActor(seated, batch);
            if (firstActor === undefined) throw new Error('no actor on the opening turn');
            const firstMove = chooseMove(batch.get(firstActor.playerId)!.view);
            firstActor.client.send({ type: 'PLAY_CARD', matchId, ...firstMove });
            batch = await nextBatch(seated);

            const resyncer = findActor(seated, batch);
            if (resyncer === undefined) throw new Error('no current actor to resync as');
            const others = seated.filter(s => s !== resyncer);
            const beforeLens = others.map(o => o.client.inbox.length);

            resyncer.client.send({ type: 'REQUEST_RESYNC', matchId });
            const resyncPush = await resyncer.client.nextOfType('STATE_UPDATE');

            // Deep-equal on everything but the two fields that are allowed —
            // expected, even — to move: serverTime is a fresh Date.now() every
            // build, and revealDeadline would differ if a round-over countdown
            // were live (it isn't here, but stripping it is the general rule).
            const before = batch.get(resyncer.playerId)!;
            const { serverTime: _beforeTime, revealDeadline: _beforeDeadline, ...beforeRest } = before;
            const { serverTime: _afterTime, revealDeadline: _afterDeadline, ...afterRest } = resyncPush;
            expect(afterRest).toEqual(beforeRest);

            // A settle window: nobody ELSE hears anything from a resync — it
            // is a private resend, never a broadcast.
            await sleep(150);
            others.forEach((o, i) => expect(o.client.inbox.length).toBe(beforeLens[i]));

            // And the resyncing client can still play normally afterward — the
            // clearest proof a resync left the room's own state, including its
            // actionLog, untouched rather than corrupting or re-appending it.
            const move = chooseMove(resyncPush.view);
            resyncer.client.send({ type: 'PLAY_CARD', matchId, ...move });
            const afterPlayBatch = await nextBatch(seated);
            for (const msg of afterPlayBatch.values()) {
                expect(['active', 'round_over', 'ended']).toContain(msg.phase);
            }

            for (const s of seated) s.client.close();
        } finally {
            running.stop();
        }
    }, 8000);
});
