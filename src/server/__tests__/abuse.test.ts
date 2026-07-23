/**
 * The abuse suite (plan Task 15; Design §13 — "Exploits closed"). Every row
 * of §13 not already pinned by an earlier test file, driven as a real attack
 * over real sockets (or real HTTP) against a real `Bun.serve` instance — no
 * mocks, matching every other file under `__tests__/`. Each `it` block names
 * the row it covers and asserts both refusal AND that state did not move.
 *
 * Two attacks (flood, room brute force) need their OWN dedicated server with
 * tight `TransportConfig` overrides to be fast and deterministic; every other
 * attack shares one generously-limited server so the many rooms/sockets this
 * file creates never trip a limit some OTHER test is specifically targeting.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { makeConfig } from '../config';
import { startServer } from '../index';
import type { RunningServer } from '../index';
import type { ServerMessage } from '../protocol';
import { chooseMove, TestClient } from './testClient';

type LobbyUpdate = Extract<ServerMessage, { type: 'LOBBY_UPDATE' }>;
type SeatClaimed = Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;
type ErrorMsg = Extract<ServerMessage, { type: 'ERROR' }>;
type FatalMsg = Extract<ServerMessage, { type: 'FATAL' }>;

interface RoomCreated {
    matchId: string;
    joinUrl: string;
    hostSeat: string;
    hostSeatToken: string;
}

/** One seated client — same shape integration.test.ts/reconnect.test.ts already established. */
interface Seated {
    readonly client: TestClient;
    readonly playerId: string;
    readonly seatToken: string;
}

/** A placeholder `cardInstanceId`, shape-valid but never asserted to be genuinely in anyone's hand.
 * Every test that uses it only needs to clear the PROTOCOL's shape guard (`CARD_INSTANCE_ID_RE`) —
 * the engine rejection each such test is actually probing (`NOT_YOUR_TURN`) fires from
 * `validateAction` BEFORE the hand-membership check, so the literal value here never matters. */
const PLACEHOLDER_CARD_ID = 'informant#1';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomHex128(): string {
    return randomBytes(16).toString('hex');
}

async function createRoom(httpBase: string): Promise<RoomCreated> {
    const res = await fetch(`${httpBase}/api/rooms`, { method: 'POST' });
    expect(res.status).toBe(201);
    return (await res.json()) as RoomCreated;
}

/** Resumes the HTTP-minted host and CLAIM_SEATs one client per nickname, waiting for `canStart`. */
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
        { client: host, playerId: created.hostSeat, seatToken: created.hostSeatToken },
        ...others.map((client, i) => ({ client, playerId: claims[i].playerId, seatToken: claims[i].seatToken }))
    ];
}

/** Finds the raw frame that produced `msg` (mirrors integration.test.ts's `rawFor`). */
function rawFor(client: TestClient, msg: ServerMessage): string {
    const idx = client.inbox.indexOf(msg);
    if (idx === -1) throw new Error("rawFor: message not found in this client's inbox");
    return client.rawFrames[idx];
}

describe('abuse suite: exploits closed (Design §13; plan Task 15)', () => {
    let running: RunningServer;
    let httpBase: string;
    let wsBase: string;

    beforeAll(() => {
        running = startServer(
            makeConfig({
                port: 0,
                dbPath: ':memory:',
                // Generous on every limit this file isn't specifically
                // targeting: this suite creates many rooms and sockets
                // across its own `it` blocks, and must never trip a limit
                // that flood/brute-force below deliberately tighten in
                // their OWN dedicated servers.
                messageBurst: 1000,
                messageRefillPerSec: 1000,
                ipConnectionsPerMinute: 1000
            })
        );
        httpBase = `http://localhost:${running.server.port}`;
        wsBase = `ws://localhost:${running.server.port}`;
    });

    afterAll(() => {
        running.stop();
    });

    // -----------------------------------------------------------------
    // Invitee races for host
    // -----------------------------------------------------------------
    it('an invitee racing to CLAIM_SEAT can never land on the host seat, and only the HTTP creator can START_MATCH', async () => {
        const created = await createRoom(httpBase);

        // Two invitees, connected and claiming as fast as possible — "instantly
        // after room creation" — before the real host has even connected.
        const invitee1 = await TestClient.connect(wsBase);
        const invitee2 = await TestClient.connect(wsBase);
        invitee1.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Racer1' });
        invitee2.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Racer2' });

        const [claim1, claim2] = await Promise.all([invitee1.nextOfType('SEAT_CLAIMED'), invitee2.nextOfType('SEAT_CLAIMED')]);

        // Design §2: seat 0 / 'p1' is minted over HTTP before the join link
        // exists, so CLAIM_SEAT's "lowest open seat" can never select it.
        for (const claim of [claim1, claim2]) {
            expect(claim.seat).toBeGreaterThanOrEqual(1);
            expect(claim.playerId).not.toBe('p1');
        }

        invitee1.send({ type: 'START_MATCH', matchId: created.matchId });
        invitee2.send({ type: 'START_MATCH', matchId: created.matchId });
        const [err1, err2] = await Promise.all([invitee1.nextOfType('ERROR'), invitee2.nextOfType('ERROR')]);
        expect(err1.code).toBe('NOT_HOST');
        expect(err2.code).toBe('NOT_HOST');

        // The real creator, on a brand-new socket, resumes the seat the HTTP
        // response actually minted, and its START_MATCH succeeds normally
        // (2 invitees + host = 3 seats, within the 2-4 range).
        const creator = await TestClient.connect(wsBase);
        creator.send({ type: 'RESUME_SEAT', matchId: created.matchId, seatToken: created.hostSeatToken });
        await creator.nextOfType('LOBBY_UPDATE');

        creator.send({ type: 'START_MATCH', matchId: created.matchId });
        const started = await Promise.all([
            creator.nextOfType('MATCH_STARTED'),
            invitee1.nextOfType('MATCH_STARTED'),
            invitee2.nextOfType('MATCH_STARTED')
        ]);
        expect(started.every(m => m.matchId === created.matchId)).toBe(true);

        creator.close();
        invitee1.close();
        invitee2.close();
    });

    // -----------------------------------------------------------------
    // Parallel claim race
    // -----------------------------------------------------------------
    it('two sockets CLAIM_SEAT with both sends fired before either is awaited -> distinct seats, no duplicate playerId', async () => {
        const created = await createRoom(httpBase);

        const clientA = await TestClient.connect(wsBase);
        const clientB = await TestClient.connect(wsBase);

        // Both fired before awaiting anything — the literal race the plan
        // asks for. Room.enqueue's promise-chain queue (Design §10) is what
        // makes the outcome deterministic regardless of arrival order.
        clientA.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'A' });
        clientB.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'B' });

        const [claimA, claimB] = await Promise.all([clientA.nextOfType('SEAT_CLAIMED'), clientB.nextOfType('SEAT_CLAIMED')]);

        expect(claimA.seat).not.toBe(claimB.seat);
        expect(claimA.playerId).not.toBe(claimB.playerId);
        expect(new Set([claimA.playerId, claimB.playerId]).size).toBe(2);

        clientA.close();
        clientB.close();
    });

    // -----------------------------------------------------------------
    // One socket, whole table
    // -----------------------------------------------------------------
    it('a second CLAIM_SEAT on an already-bound socket -> ALREADY_SEATED, seat count unchanged per LOBBY_UPDATE', async () => {
        const created = await createRoom(httpBase);

        const client = await TestClient.connect(wsBase);
        client.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Solo' });
        const firstClaim = await client.nextOfType('SEAT_CLAIMED');
        await client.nextOfType('LOBBY_UPDATE'); // the broadcast claimSeat triggers for itself

        client.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'SecondTry' });
        const err = await client.nextOfType('ERROR');
        expect(err.code).toBe('ALREADY_SEATED');

        // Verify via a LOBBY_UPDATE snapshot (REQUEST_RESYNC in the lobby
        // just resends it, Room.resync's lobby branch): exactly one seat is
        // occupied, and it is still the FIRST claim's seat, never a second one.
        client.send({ type: 'REQUEST_RESYNC', matchId: created.matchId });
        const lobby = await client.nextOfType('LOBBY_UPDATE');
        const occupied = lobby.seats.filter(s => s.status === 'occupied');
        expect(occupied.length).toBe(1);
        expect(occupied[0].playerId).toBe(firstClaim.playerId);

        client.close();
    });

    // -----------------------------------------------------------------
    // Seat-index probe
    // -----------------------------------------------------------------
    it('CLAIM_SEAT with an extra "seat" field -> MALFORMED (the field the design deleted rather than validated)', async () => {
        const created = await createRoom(httpBase);
        const prober = await TestClient.connect(wsBase);

        prober.sendRaw(JSON.stringify({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Prober', seat: 1 }));

        const err = await prober.nextOfType('ERROR');
        expect(err.code).toBe('MALFORMED');

        // No seat was bound by the malformed attempt: a legitimate CLAIM_SEAT
        // on the SAME socket right after still works normally.
        prober.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'ProberRetry' });
        const claimed = await prober.nextOfType('SEAT_CLAIMED');
        expect(claimed.seat).toBeGreaterThanOrEqual(1);

        prober.close();
    });

    // -----------------------------------------------------------------
    // playerId spoof
    // -----------------------------------------------------------------
    it('PLAY_CARD with a spoofed playerId -> MALFORMED; a correctly-shaped play for another seat\'s turn -> NOT_YOUR_TURN', async () => {
        const created = await createRoom(httpBase);
        const seated = await seatClients(wsBase, created, ['Bayta', 'Toran']);

        seated[0].client.send({ type: 'START_MATCH', matchId: created.matchId });
        await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));
        const openingBatch = await Promise.all(seated.map(s => s.client.nextOfType('STATE_UPDATE')));
        const currentPlayerId = openingBatch[0].view.currentPlayerId;
        const actor = seated.find(s => s.playerId === currentPlayerId)!;
        const bystander = seated.find(s => s.playerId !== currentPlayerId)!;

        // `PLAY_CARD` has no `playerId` field in the protocol at all — an
        // extra one is a shape violation, caught before identity or the
        // engine ever run (Design §3, §8 step 3).
        actor.client.sendRaw(
            JSON.stringify({
                type: 'PLAY_CARD',
                matchId: created.matchId,
                cardInstanceId: PLACEHOLDER_CARD_ID,
                playerId: bystander.playerId
            })
        );
        const malformed = await actor.client.nextOfType('ERROR');
        expect(malformed.code).toBe('MALFORMED');

        // A correctly-shaped play from whoever does NOT hold the turn is
        // still refused — this time by the engine, because the acting
        // identity is `Room.playCard`'s own connection lookup, never a
        // payload field. Forwarded verbatim (Design §3).
        bystander.client.send({ type: 'PLAY_CARD', matchId: created.matchId, cardInstanceId: PLACEHOLDER_CARD_ID });
        const notYourTurn = await bystander.client.nextOfType('ERROR');
        expect(notYourTurn.code).toBe('NOT_YOUR_TURN');

        // Neither attempt moved the turn: the ACTUAL current player can
        // still act normally afterward.
        const move = chooseMove(openingBatch.find(m => m.view.currentPlayerId === currentPlayerId)!.view);
        actor.client.send({ type: 'PLAY_CARD', matchId: created.matchId, ...move });
        const afterPlay = await actor.client.nextOfType('STATE_UPDATE');
        expect(['active', 'round_over', 'ended']).toContain(afterPlay.phase);

        for (const s of seated) s.client.close();
    });

    // -----------------------------------------------------------------
    // Evicted socket plays on
    // -----------------------------------------------------------------
    it('a stale PLAY_CARD from a just-evicted socket has no effect on match state', async () => {
        const created = await createRoom(httpBase);
        const seated = await seatClients(wsBase, created, ['Bayta', 'Toran']);
        const matchId = created.matchId;

        seated[0].client.send({ type: 'START_MATCH', matchId });
        await Promise.all(seated.map(s => s.client.nextOfType('MATCH_STARTED')));
        const openingBatch = await Promise.all(seated.map(s => s.client.nextOfType('STATE_UPDATE')));
        const currentPlayerId = openingBatch[0].view.currentPlayerId;

        // Pick the victim to be someone who does NOT currently hold the
        // turn, so this test isolates the eviction check alone — a play
        // from the actual current player would separately be refused (or
        // succeed) for reasons that have nothing to do with eviction.
        const victim = seated.find(s => s.playerId !== currentPlayerId)!;

        const intruder = await TestClient.connect(wsBase);

        // Fire the eviction trigger and the victim's stale play back to back,
        // with no await between them — the genuine race Design §4 closes.
        // Empirically (spiked separately against this exact runtime): once
        // the eviction message is sent first, the server always processes it
        // first and the victim's already-in-flight frame is discarded by the
        // transport before it ever reaches `dispatchMessage` — a STRICTER
        // refusal than an application-level error, since the frame never
        // reaches game logic at all. Either outcome (silently dropped, or
        // delivered and refused) is safe; this test asserts the OBSERVABLE
        // state guarantee that holds either way, rather than pinning the
        // specific wire-level mechanics.
        intruder.send({ type: 'RESUME_SEAT', matchId, seatToken: victim.seatToken });
        victim.client.send({ type: 'PLAY_CARD', matchId, cardInstanceId: PLACEHOLDER_CARD_ID });

        const fatal = await victim.client.nextOfType('FATAL');
        expect(fatal.code).toBe('SEAT_TAKEN');

        // The intruder is now the seat's canonical connection and gets a
        // fresh repaint (Design §4, §7): the current player is EXACTLY who
        // it was before the victim's stale attempt — proof the attempt had
        // no effect, whether it was dropped in flight or reached Room and
        // was refused by the canonical-pointer check.
        const intruderRepaint = await intruder.nextOfType('STATE_UPDATE');
        expect(intruderRepaint.view.own.playerId).toBe(victim.playerId);
        expect(intruderRepaint.view.currentPlayerId).toBe(currentPlayerId);

        // And the game is still fully live: the REAL current player's next
        // legitimate move still succeeds normally.
        const actor = seated.find(s => s.playerId === currentPlayerId)!;
        const move = chooseMove(openingBatch.find(m => m.view.currentPlayerId === currentPlayerId)!.view);
        actor.client.send({ type: 'PLAY_CARD', matchId, ...move });
        const afterPlay = await actor.client.nextOfType('STATE_UPDATE');
        expect(['active', 'round_over', 'ended']).toContain(afterPlay.phase);

        intruder.close();
        for (const s of seated) if (s !== victim) s.client.close();
    });

    // -----------------------------------------------------------------
    // Oversized frame
    // -----------------------------------------------------------------
    it('an over-limit frame gets the socket closed by Bun\'s maxPayloadLength; other clients are unaffected', async () => {
        const attacker = new WebSocket(wsBase);
        await new Promise<void>((resolve, reject) => {
            attacker.onopen = () => resolve();
            attacker.onerror = () => reject(new Error('attacker socket failed to open'));
        });

        const closed = new Promise<void>(resolve => {
            attacker.onclose = () => resolve();
        });

        // Config default maxPayloadLength is 4096; this frame is well over 8KB.
        const oversized = JSON.stringify({ type: 'PING', pad: 'x'.repeat(9000) });
        expect(oversized.length).toBeGreaterThan(8192);
        attacker.send(oversized);

        await closed;
        expect(attacker.readyState).toBe(WebSocket.CLOSED);

        // The server itself is unharmed: a fresh client completes an
        // ordinary action (claim a seat) right after.
        const created = await createRoom(httpBase);
        const survivor = await TestClient.connect(wsBase);
        survivor.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Survivor' });
        const claimed = await survivor.nextOfType('SEAT_CLAIMED');
        expect(claimed.seat).toBeGreaterThanOrEqual(1);

        survivor.close();
    });

    // -----------------------------------------------------------------
    // Compression bomb
    // -----------------------------------------------------------------
    it('the WS upgrade response never offers permessage-deflate, even when the client requests it', async () => {
        const key = Buffer.from(randomBytes(16)).toString('base64');

        const res = await fetch(`${httpBase}/`, {
            headers: {
                Upgrade: 'websocket',
                Connection: 'Upgrade',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
            }
        });

        // The handshake itself succeeds (101) — it is the EXTENSION
        // negotiation that is refused outright (Design §8 step 1: disabled
        // entirely, not merely capped), so a compression bomb has no
        // decompression path to abuse in the first place.
        expect(res.status).toBe(101);
        expect(res.headers.get('sec-websocket-extensions')).toBeNull();
    });

    // -----------------------------------------------------------------
    // Prototype pollution
    // -----------------------------------------------------------------
    it('target: "__proto__" -> MALFORMED; nickname: "__proto__" is accepted as ordinary text with no pollution', async () => {
        const created = await createRoom(httpBase);

        // target is validated against the closed p1..p4 enum (Design §13's
        // "playerId always server-allocated from a fixed pool") — a
        // dictionary-attack key like "__proto__" is simply not in it.
        const prober = await TestClient.connect(wsBase);
        prober.sendRaw(
            JSON.stringify({
                type: 'PLAY_CARD',
                matchId: created.matchId,
                cardInstanceId: PLACEHOLDER_CARD_ID,
                target: '__proto__'
            })
        );
        const err = await prober.nextOfType('ERROR');
        expect(err.code).toBe('MALFORMED');
        prober.close();

        // nickname is free text (Design §8 step 3) — "__proto__" as a VALUE
        // is harmless (it is never used as an object key) and must round-trip
        // exactly, proving the server neither special-cases nor mangles it.
        const claimant = await TestClient.connect(wsBase);
        claimant.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: '__proto__' });
        const claimed = await claimant.nextOfType('SEAT_CLAIMED');
        const lobby = await claimant.nextOfType('LOBBY_UPDATE');

        const ownSeat = lobby.seats.find(s => s.playerId === claimed.playerId);
        expect(ownSeat?.nickname).toBe('__proto__');
        // No linter is configured in this project (AGENTS.md) — a bare `any`
        // here is deliberate: this line exists solely to prove the empty
        // object literal was never mutated, not to model a real type.
        expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined();

        claimant.close();
    });

    // -----------------------------------------------------------------
    // Room brute force
    // -----------------------------------------------------------------
    it('sequential fake matchId lookups get uniform ROOM_NOT_FOUND, then the IP limiter refuses further connections', async () => {
        const IP_LIMIT = 3;
        const dedicated = startServer(makeConfig({ port: 0, dbPath: ':memory:', ipConnectionsPerMinute: IP_LIMIT }));
        // Explicit IPv4 loopback, not 'localhost': the IP limiter keys on
        // `server.requestIP(req).address`, and 'localhost' can resolve to
        // ::1 or 127.0.0.1 depending on the host's resolver — a mismatch
        // here would silently split this test's connections across two
        // "different" IPs and defeat the whole point of a per-IP budget.
        const dedicatedWsBase = `ws://127.0.0.1:${dedicated.server.port}`;

        try {
            const clients: TestClient[] = [];
            for (let i = 0; i < IP_LIMIT; i++) {
                const client = await TestClient.connect(dedicatedWsBase);
                clients.push(client);

                const fakeMatchId = randomHex128();
                client.send({ type: 'CLAIM_SEAT', matchId: fakeMatchId, nickname: 'Brute' });
                const err = await client.nextOfType('ERROR');
                // Uniform with a never-existed room: no way to tell "wrong
                // id" apart from "right shape, wrong id" from this response.
                expect(err.code).toBe('ROOM_NOT_FOUND');
            }

            // The budget is now exhausted: the very next NEW connection
            // attempt gets refused at the HTTP-upgrade layer (429, never a
            // 101), so the WebSocket handshake itself fails.
            await expect(TestClient.connect(dedicatedWsBase)).rejects.toThrow();

            for (const client of clients) client.close();
        } finally {
            dedicated.stop();
        }
    });

    // -----------------------------------------------------------------
    // Non-gameplay flood
    // -----------------------------------------------------------------
    it('~50 rapid REQUEST_RESYNCs draw RATE_LIMITED, and the room still answers the next in-budget message after refill', async () => {
        const dedicated = startServer(
            makeConfig({
                port: 0,
                dbPath: ':memory:',
                messageBurst: 3,
                messageRefillPerSec: 5,
                ipConnectionsPerMinute: 1000 // not what this test targets
            })
        );
        const dedicatedHttpBase = `http://localhost:${dedicated.server.port}`;
        const dedicatedWsBase = `ws://localhost:${dedicated.server.port}`;

        try {
            const created = await createRoom(dedicatedHttpBase);
            const client = await TestClient.connect(dedicatedWsBase);

            // Bind a seat first — spends one token (2 of 3 left) — so the
            // in-budget replies below are genuine LOBBY_UPDATEs, not
            // NOT_YOUR_SEAT, proving a SEATED connection's flood is what
            // gets rate-limited and later served again.
            client.send({ type: 'CLAIM_SEAT', matchId: created.matchId, nickname: 'Flooder' });
            await client.nextOfType('SEAT_CLAIMED');
            await client.nextOfType('LOBBY_UPDATE');

            const beforeFlood = client.inbox.length;
            for (let i = 0; i < 50; i++) {
                client.send({ type: 'REQUEST_RESYNC', matchId: created.matchId });
            }
            await sleep(300); // let every round trip on this near-instant loopback settle

            const floodResponses = client.inbox.slice(beforeFlood);
            expect(floodResponses.length).toBe(50);
            const rateLimited = floodResponses.filter((m): m is ErrorMsg => m.type === 'ERROR' && m.code === 'RATE_LIMITED');
            const succeeded = floodResponses.filter(m => m.type === 'LOBBY_UPDATE');
            expect(rateLimited.length).toBeGreaterThan(0);
            expect(succeeded.length).toBeGreaterThan(0);
            expect(succeeded.length).toBeLessThan(50);

            // Refill (5/sec — well over 300ms's worth) and confirm the room
            // still answers this seat's next in-budget message normally.
            await sleep(300);
            client.send({ type: 'REQUEST_RESYNC', matchId: created.matchId });
            const afterRefill = await client.nextOfType('LOBBY_UPDATE');
            expect(afterRefill.matchId).toBe(created.matchId);

            client.close();
        } finally {
            dedicated.stop();
        }
    });

    // -----------------------------------------------------------------
    // Token oracle
    // -----------------------------------------------------------------
    it('RESUME_SEAT with a random/foreign/expired token all draw the byte-identical FATAL{BAD_TOKEN}', async () => {
        const targetRoom = await createRoom(httpBase); // the room every attempt below targets
        const otherRoom = await createRoom(httpBase); // (b) source of a token from a DIFFERENT, still-live room

        // (c) source of a token from a room that has since expired/ended.
        const expiredRoom = await createRoom(httpBase);
        const expiredHost = await TestClient.connect(wsBase);
        expiredHost.send({ type: 'RESUME_SEAT', matchId: expiredRoom.matchId, seatToken: expiredRoom.hostSeatToken });
        await expiredHost.nextOfType('LOBBY_UPDATE');
        expiredHost.send({ type: 'END_MATCH', matchId: expiredRoom.matchId });
        await expiredHost.nextOfType('MATCH_ENDED');

        const attempts: { label: string; token: string }[] = [
            { label: 'random hex', token: randomHex128() },
            { label: 'token from a different room', token: otherRoom.hostSeatToken },
            { label: 'token from an expired room', token: expiredRoom.hostSeatToken }
        ];

        const rawFatals: string[] = [];
        for (const attempt of attempts) {
            const client = await TestClient.connect(wsBase);
            client.send({ type: 'RESUME_SEAT', matchId: targetRoom.matchId, seatToken: attempt.token });
            const fatal = await client.nextOfType<'FATAL'>('FATAL');
            expect(fatal.code).toBe('BAD_TOKEN');
            rawFatals.push(rawFor(client, fatal));
            client.close();
        }

        expect(new Set(rawFatals).size).toBe(1);
        expect(rawFatals[0]).toBe(JSON.stringify({ type: 'FATAL', code: 'BAD_TOKEN' } satisfies FatalMsg));
    });
});
