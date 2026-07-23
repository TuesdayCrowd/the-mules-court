/**
 * The ordered validation pipeline between a raw socket frame and the Room
 * (Design §8; plan Task 11). `dispatchMessage` is the single function that
 * ever mutates `ConnectionState.seat` / `ConnectionState.matchId`, and it
 * does so exactly once, on a successful CLAIM_SEAT or RESUME_SEAT.
 *
 * Step numbers in the comments below match Design §8 exactly, so a reviewer
 * can check this file against the design section line by line:
 *
 *   1. Frame size — lives in `Bun.serve`'s `maxPayloadLength` (Task 12);
 *      this function is never even called for an oversized frame.
 *   2-3. Parse + shape — `parseClientMessage`.
 *   4. Rate limit — `state.bucket.take()`, before any switch on type.
 *      `PING` is answered with `PONG` right here: it needs no identity and
 *      no room.
 *   5. Identity — `PLAY_CARD` / `START_MATCH` / `END_MATCH` /
 *      `REQUEST_RESYNC` require a bound seat whose `matchId` agrees with
 *      the message.
 *   6. Canonical pointer — DELIBERATELY ABSENT here. Room's own conn-keyed
 *      seat lookup (`this.seats.find(s => s.conn === conn)` inside
 *      `playCard`/`endMatch`/`resync`) already answers `NOT_YOUR_SEAT` for
 *      an evicted or otherwise non-canonical connection. Re-checking the
 *      pointer here would duplicate enforcement Room already owns — see
 *      the plan's "Division of enforcement".
 *   7. One seat per connection — `CLAIM_SEAT` / `RESUME_SEAT` refuse a
 *      connection that already has a bound seat.
 *   8. Room lookup — a registry miss (never-existed, expired, or
 *      quarantined — all indistinguishable to the client) is uniformly
 *      `ROOM_NOT_FOUND`. Every OTHER phase gate (`ROOM_FULL`, `MATCH_OVER`,
 *      `ROUND_NOT_IN_PROGRESS`, `PAUSED`, `CANNOT_START`) is Room's job,
 *      not dispatch's.
 *   9. Host gate — only `START_MATCH`'s simple check lives here.
 *      `END_MATCH`'s richer host-or-grace-period rule lives entirely in
 *      `Room.endMatch`.
 *   10-11. The room command itself, serialized through `room.enqueue`,
 *      wrapped in `try/catch`: a throw is logged and answered
 *      `ERROR{INTERNAL}` rather than becoming an uncaught rejection.
 *
 * `dispatchMessage` never rejects: the only step capable of throwing (the
 * room command) is caught, so every call resolves.
 */

import type { PlayerId } from '../game/engine';
import type { TransportConfig } from './config';
import type { ClientMessage, ErrorCode, ServerMessage } from './protocol';
import { parseClientMessage } from './protocol';
import type { TokenBucket } from './rateLimiter';
import type { SeatConnection } from './room';
import type { RoomRegistry } from './roomRegistry';

/**
 * The fixed host seat's playerId (Design §2: seat index 0 is always the
 * host, minted before any join). `room.ts` keeps its own copy of this as a
 * private constant (`HOST_PLAYER_ID`) — it is not exported, so dispatch's
 * step-9 host gate duplicates the literal here rather than reaching into
 * Room's internals.
 */
const HOST_PLAYER_ID: PlayerId = 'p1';

/** The four message types whose acting identity is the bound seat, never a payload field (Design §8 step 5). */
function requiresBoundSeat(type: ClientMessage['type']): boolean {
    return type === 'PLAY_CARD' || type === 'START_MATCH' || type === 'END_MATCH' || type === 'REQUEST_RESYNC';
}

/** Lives in `ws.data` (Task 12). One instance per socket; mutated only by `dispatchMessage`. */
export interface ConnectionState {
    readonly ip: string;
    readonly bucket: TokenBucket;
    /** Bound by a successful CLAIM_SEAT/RESUME_SEAT only; the only writer is `dispatchMessage`. */
    seat: PlayerId | null;
    matchId: string | null;
    /** Assigned in `websocket.open()`, which always precedes the first `message` (Task 12). */
    conn: SeatConnection;
}

function send(conn: SeatConnection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
}

function sendError(conn: SeatConnection, code: ErrorCode): void {
    send(conn, { type: 'ERROR', code });
}

export async function dispatchMessage(
    registry: RoomRegistry,
    config: TransportConfig,
    state: ConnectionState,
    raw: string
): Promise<void> {
    // Steps 2-3.
    const parsed = parseClientMessage(raw, config.maxNicknameLength);
    if (!parsed.ok) {
        sendError(state.conn, 'MALFORMED');
        return;
    }
    const msg = parsed.msg;

    // Step 4 — every message type spends a token, PING included.
    if (!state.bucket.take()) {
        sendError(state.conn, 'RATE_LIMITED');
        return;
    }

    // Still step 4: PING needs no identity and no room.
    if (msg.type === 'PING') {
        send(state.conn, { type: 'PONG' });
        return;
    }

    // Step 5. Reads state.seat and msg.matchId only — no other payload field
    // ever informs this decision.
    if (requiresBoundSeat(msg.type) && (state.seat === null || msg.matchId !== state.matchId)) {
        sendError(state.conn, 'NOT_YOUR_SEAT');
        return;
    }

    // Step 6 is Room's job — see the file header.

    // Step 7.
    if ((msg.type === 'CLAIM_SEAT' || msg.type === 'RESUME_SEAT') && state.seat !== null) {
        sendError(state.conn, 'ALREADY_SEATED');
        return;
    }

    // Step 8. `msg.matchId` is safe to read directly for every remaining
    // type: for the four identity-gated types (msg.type narrowed away from
    // 'PING' above) it was just proven equal to state.matchId; for
    // CLAIM_SEAT/RESUME_SEAT it is the only matchId dispatch has ever seen.
    // Reading it uniformly — rather than branching to state.matchId for one
    // group — needs no non-null assertion on a field TypeScript cannot
    // narrow across the two independent ConnectionState properties.
    const matchId = msg.matchId;
    const room = registry.get(matchId);
    if (room === null) {
        sendError(state.conn, 'ROOM_NOT_FOUND');
        return;
    }

    // Step 9. END_MATCH's richer host/grace rule lives in Room.endMatch.
    if (msg.type === 'START_MATCH' && state.seat !== HOST_PLAYER_ID) {
        sendError(state.conn, 'NOT_HOST');
        return;
    }

    // Steps 10-11.
    try {
        await room.enqueue(() => {
            switch (msg.type) {
                case 'CLAIM_SEAT': {
                    const result = room.claimSeat(state.conn, msg.nickname);
                    if (result !== null) {
                        state.seat = result.playerId;
                        state.matchId = matchId;
                    }
                    break;
                }
                case 'RESUME_SEAT': {
                    const result = room.resumeSeat(state.conn, msg.seatToken);
                    if (result !== null) {
                        state.seat = result.playerId;
                        state.matchId = matchId;
                    }
                    break;
                }
                case 'START_MATCH':
                    room.startMatch(state.conn);
                    break;
                case 'PLAY_CARD':
                    room.playCard(state.conn, msg);
                    break;
                case 'END_MATCH':
                    room.endMatch(state.conn);
                    break;
                case 'REQUEST_RESYNC':
                    room.resync(state.conn);
                    break;
            }
        });
    } catch (err) {
        console.error('dispatch: room command threw', matchId, msg.type, err);
        sendError(state.conn, 'INTERNAL');
    }
}
