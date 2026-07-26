/**
 * The client's WebSocket, with reconnection (UIX §5).
 *
 * Every ambient dependency is injected: the socket constructor, the timers, and
 * the jitter source. That is what lets the backoff schedule be asserted exactly
 * rather than waited on, and it is why this module still satisfies the pure-layer
 * guard in `src/client/__tests__/purity.test.ts` despite owning a live socket.
 *
 * The module knows nothing about game rules. It reconnects, it resumes a seat,
 * and it hands frames to a sink; every decision about what those frames mean
 * belongs to the store.
 */

import type { ClientMessage, ServerMessage } from '../../server/protocol';
import type { StoredSeat } from './seatTokenStore';
import type { ConnectionStatus } from './types';

/**
 * The slice of the browser `WebSocket` this module uses.
 *
 * Handler properties rather than `addEventListener`: one handler each is all the
 * client wants, and a property is trivially settable by a fake.
 */
export interface WebSocketLike {
    send(data: string): void;
    close(): void;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((e: { data: string }) => void) | null;
    onerror: (() => void) | null;
}

/** Opaque: a number in the browser, a `Timeout` object under Node. Never inspected. */
export type TimerHandle = unknown;

export interface Timers {
    setTimeout(fn: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
}

export interface SocketDeps {
    readonly url: string;
    readonly matchId: string;
    readonly open: (url: string) => WebSocketLike;
    /**
     * Read fresh on every open, never captured: the first connection has no
     * token, and the reconnect after `SEAT_CLAIMED` must resume the seat that
     * message just granted.
     */
    readonly storedSeat: () => StoredSeat | null;
    /** The nickname to offer a seat that has none (UIX §13.1). Read fresh, same reason. */
    readonly nickname: () => string | undefined;
    readonly onMessage: (msg: ServerMessage) => void;
    readonly onStatus: (status: ConnectionStatus) => void;
    readonly timers: Timers;
    /** Injected so jitter is deterministic under test. */
    readonly random: () => number;
}

export interface Socket {
    connect(): void;
    /** True when the frame went out. False while reconnecting — the caller decides what that means. */
    send(msg: ClientMessage): boolean;
    /** Deliberate teardown: cancels any pending retry and never reconnects. */
    close(): void;
}

/** `https://host/anything` → `wss://host/ws`. Same origin in dev (via the Vite proxy) and in production. */
export function socketUrl(origin: string): string {
    return origin.replace(/^http/, 'ws') + '/ws';
}

// --------------------------------------------------------------- inbound parse

/**
 * Every `ServerMessage.type`. Listed rather than derived, because the union is a
 * type and has no runtime form; the protocol test suite is what keeps the two
 * aligned on the server side, and a frame of an unlisted type is dropped here.
 */
const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
    'LOBBY_UPDATE',
    'SEAT_CLAIMED',
    'MATCH_STARTED',
    'STATE_UPDATE',
    'MATCH_ENDED',
    'ERROR',
    'FATAL',
    'PONG'
]);

/**
 * The inbound boundary, mirroring the server's own `parseClientMessage`: a
 * client trusts the server's shape no more than the server trusts the client's.
 *
 * The check stops at `type`, deliberately. Validating every field would be a
 * second copy of the protocol schema maintained on the far side of the wire; the
 * narrow guarantee this gives — that a `switch (msg.type)` in the store is safe
 * and total — is the one the store actually depends on.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.type !== 'string' || !SERVER_MESSAGE_TYPES.has(candidate.type)) return null;

    return candidate as unknown as ServerMessage;
}

// ------------------------------------------------------------------- backoff

/** First retry delay. Long enough to ride out a server restart, short enough to feel immediate. */
const BASE_DELAY_MS = 500;
/** Ceiling. Past this a player has noticed the amber dot and will refresh anyway. */
const MAX_DELAY_MS = 8000;
/** ±25% spread, so a room full of clients dropped by one server restart do not return in lockstep. */
const JITTER_SPREAD = 0.5;

function jittered(base: number, random: () => number): number {
    return Math.round(base * (1 - JITTER_SPREAD / 2 + random() * JITTER_SPREAD));
}

// -------------------------------------------------------------------- socket

export function createSocket(deps: SocketDeps): Socket {
    let socket: WebSocketLike | null = null;
    let status: ConnectionStatus = 'closed';
    let retryHandle: TimerHandle | null = null;
    let attempt = 0;
    /** Set once `close()` is called. Every later event becomes a no-op. */
    let shutDown = false;

    function setStatus(next: ConnectionStatus): void {
        status = next;
        deps.onStatus(next);
    }

    /**
     * The first frame of every open, or null when there is nothing to resume.
     *
     * A blank nickname is dropped rather than sent: `parseNickname` rejects it
     * and the server fails the *whole* frame as MALFORMED, so an empty name
     * would cost the seat and not merely the name.
     */
    function handshake(): ClientMessage | null {
        const seat = deps.storedSeat();
        if (seat === null) return null;

        const nickname = deps.nickname()?.trim();
        return {
            type: 'RESUME_SEAT',
            matchId: deps.matchId,
            seatToken: seat.seatToken,
            ...(nickname !== undefined && nickname.length > 0 ? { nickname } : {})
        };
    }

    function scheduleRetry(): void {
        const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
        attempt++;
        retryHandle = deps.timers.setTimeout(() => {
            retryHandle = null;
            openSocket();
        }, jittered(base, deps.random));
    }

    function openSocket(): void {
        const live = deps.open(deps.url);
        socket = live;

        live.onopen = () => {
            if (shutDown || socket !== live) return;
            attempt = 0; // a landed connection earns a fresh schedule
            setStatus('open');
            const first = handshake();
            if (first !== null) live.send(JSON.stringify(first));
        };

        live.onmessage = event => {
            if (shutDown || socket !== live) return;
            const msg = parseServerMessage(event.data);
            if (msg !== null) deps.onMessage(msg);
        };

        // Browsers fire `error` and then `close`. Reconnecting from both would
        // schedule two retries for one drop, so `close` alone owns the retry.
        live.onerror = () => {};

        live.onclose = () => {
            if (shutDown || socket !== live) return;
            socket = null;
            setStatus('reconnecting');
            scheduleRetry();
        };
    }

    return {
        connect(): void {
            if (shutDown || socket !== null || retryHandle !== null) return;
            setStatus('connecting');
            openSocket();
        },

        send(msg: ClientMessage): boolean {
            if (socket === null || status !== 'open') return false;
            socket.send(JSON.stringify(msg));
            return true;
        },

        close(): void {
            if (shutDown) return;
            shutDown = true;
            if (retryHandle !== null) {
                deps.timers.clearTimeout(retryHandle);
                retryHandle = null;
            }
            socket?.close();
            socket = null;
            setStatus('closed');
        }
    };
}
