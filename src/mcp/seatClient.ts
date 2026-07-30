/**
 * One seat, one socket (Design §3, §6).
 *
 * The MCP process holds three of these for the life of a match. Each owns a
 * real WebSocket and receives its own unicast `STATE_UPDATE`, so redaction is
 * the server's existing work rather than anything this layer performs — which
 * is exactly why it is trustworthy. `view(match, viewerId)` is the only
 * function whose output reaches a client, and this module never sees another
 * seat's output to leak in the first place.
 *
 * It speaks `ClientMessage` and `ServerMessage` from `../server/protocol`
 * rather than restating the wire, so a protocol change is a compile error here
 * instead of a version skew discovered mid-match. AGENTS.md records what that
 * skew costs: one added field presented first as "cards stopped being
 * clickable" and then as a rule being misreported.
 *
 * **Sockets stay open for the life of the match.** A reconnect during a
 * round-over re-arms the reveal deadline for every player at the table
 * (`room.ts` `armRevealTimer`, re-entered on resume), so a seat that
 * reconnected per turn would quietly stretch the reveal window for the human.
 * `reconnect()` exists for a dropped socket, not as a request pattern.
 */

import type { CardInstanceId, GuessValue, PlayerId } from '../game/engine';
import type { ClientMessage, ServerMessage } from '../server/protocol';

export type StateUpdate = Extract<ServerMessage, { type: 'STATE_UPDATE' }>;
type SeatClaimed = Extract<ServerMessage, { type: 'SEAT_CLAIMED' }>;

/** Who this socket speaks for. `seatToken` never leaves the process. */
export interface SeatIdentity {
    readonly seat: number;
    readonly playerId: PlayerId;
    readonly seatToken: string;
    readonly nickname: string;
}

/** A move, shaped like `PLAY_CARD` minus the routing the transport supplies. */
export interface SeatPlay {
    readonly cardInstanceId: CardInstanceId;
    readonly target?: PlayerId;
    readonly guess?: GuessValue;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            ws.close();
            reject(new Error(`SeatClient: connecting to ${url} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        ws.onopen = () => {
            clearTimeout(timer);
            resolve(ws);
        };
        ws.onerror = () => {
            clearTimeout(timer);
            reject(new Error(`SeatClient: connection to ${url} failed`));
        };
    });
}

export class SeatClient {
    private ws: WebSocket;
    private seatIdentity: SeatIdentity;

    /**
     * Pushes that arrived with nobody waiting, and callers waiting with nothing
     * to hand them. One queue and one waiter list, because a seat only ever
     * cares about `STATE_UPDATE` — every other frame is either handled inline
     * (`SEAT_CLAIMED`) or is the referee's business, not a seat's.
     */
    private readonly pending: StateUpdate[] = [];
    private readonly waiters: { resolve: (s: StateUpdate) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

    /** The last error frame the server sent, so a rejected play can be read back. */
    lastError: Extract<ServerMessage, { type: 'ERROR' }> | null = null;
    /** Latest push, or null before the match starts. */
    lastState: StateUpdate | null = null;

    private constructor(
        ws: WebSocket,
        identity: SeatIdentity,
        private readonly url: string,
        private readonly matchId: string
    ) {
        this.ws = ws;
        this.seatIdentity = identity;
        this.attach(ws);
    }

    get identity(): SeatIdentity {
        return this.seatIdentity;
    }

    /**
     * Opens a socket, claims the lowest open seat, and resolves once the server
     * has answered with the seat's identity.
     *
     * `CLAIM_SEAT` carries no seat index — the server assigns one — so which
     * seat this becomes is not something the caller may choose, and the
     * returned identity is the only place it is discoverable.
     */
    static async claim(url: string, matchId: string, nickname: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SeatClient> {
        const ws = await openSocket(url, timeoutMs);

        const claimed = await new Promise<SeatClaimed>((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error(`SeatClient: CLAIM_SEAT went unanswered for ${timeoutMs}ms`));
            }, timeoutMs);

            ws.onmessage = event => {
                const msg = JSON.parse(String(event.data)) as ServerMessage;
                // LOBBY_UPDATE broadcasts arrive before and after the claim;
                // only SEAT_CLAIMED is this socket's own answer.
                if (msg.type === 'SEAT_CLAIMED') {
                    clearTimeout(timer);
                    resolve(msg);
                } else if (msg.type === 'FATAL') {
                    clearTimeout(timer);
                    reject(new Error(`SeatClient: server refused the claim with ${msg.code}`));
                }
            };

            ws.send(JSON.stringify({ type: 'CLAIM_SEAT', matchId, nickname } satisfies ClientMessage));
        });

        return new SeatClient(
            ws,
            { seat: claimed.seat, playerId: claimed.playerId, seatToken: claimed.seatToken, nickname },
            url,
            matchId
        );
    }

    /**
     * Re-opens the socket and resumes this seat.
     *
     * `RESUME_SEAT` has no per-connection acknowledgement — the seat learns it
     * worked from the repaint that follows — so this resolves once the frame is
     * sent, and the caller awaits `nextState()` for the repaint.
     */
    async reconnect(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
        this.ws.close();
        this.ws = await openSocket(this.url, timeoutMs);
        this.attach(this.ws);
        this.send({
            type: 'RESUME_SEAT',
            matchId: this.matchId,
            seatToken: this.seatIdentity.seatToken,
            nickname: this.seatIdentity.nickname
        });
    }

    /** The next push, or one already queued. Rejects rather than hanging. */
    nextState(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<StateUpdate> {
        const queued = this.pending.shift();
        if (queued !== undefined) return Promise.resolve(queued);

        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    const idx = this.waiters.indexOf(entry);
                    if (idx !== -1) this.waiters.splice(idx, 1);
                    reject(new Error(`SeatClient(${this.seatIdentity.playerId}): no STATE_UPDATE within ${timeoutMs}ms`));
                }, timeoutMs)
            };
            this.waiters.push(entry);
        });
    }

    /** Sends a move. The engine decides legality; a refusal comes back as ERROR. */
    play(move: SeatPlay, clientMsgId?: string): void {
        this.send({
            type: 'PLAY_CARD',
            matchId: this.matchId,
            cardInstanceId: move.cardInstanceId,
            ...(move.target !== undefined ? { target: move.target } : {}),
            ...(move.guess !== undefined ? { guess: move.guess } : {}),
            ...(clientMsgId !== undefined ? { clientMsgId } : {})
        });
    }

    /** Closes the socket for good. */
    close(): void {
        for (const waiter of this.waiters.splice(0)) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(`SeatClient(${this.seatIdentity.playerId}): closed while waiting`));
        }
        this.ws.close();
    }

    /**
     * Drops the socket without clearing waiters, so a test can exercise the
     * reconnect path. Named for what it is rather than dressed up as a
     * failure injector — the production path never calls it.
     */
    dropSocket(): void {
        this.ws.close();
    }

    private send(msg: ClientMessage): void {
        this.ws.send(JSON.stringify(msg));
    }

    private attach(ws: WebSocket): void {
        ws.onmessage = event => this.handleFrame(String(event.data));
    }

    private handleFrame(raw: string): void {
        const msg = JSON.parse(raw) as ServerMessage;

        if (msg.type === 'ERROR') {
            this.lastError = msg;
            return;
        }
        if (msg.type !== 'STATE_UPDATE') return;

        this.lastState = msg;

        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
            return;
        }
        this.pending.push(msg);
    }
}
