/**
 * Creating a room over HTTP (UIX §3, §5).
 *
 * The one request the client makes outside the socket, and the one that matters
 * most: `hostSeatToken` arrives in this response and nowhere else. It is never
 * re-sent, so a response this module accepts loosely is a seat lost on the first
 * reconnect — hence the shape guard, and hence a typed failure rather than a
 * thrown string the caller might not catch.
 */

import type { PlayerId } from '../../game/engine';
import type { Timers } from './socket';

export interface RoomInfo {
    readonly matchId: string;
    readonly joinUrl: string;
    readonly hostSeat: PlayerId;
    readonly hostSeatToken: string;
}

export type CreateRoomFailure = 'rate-limited' | 'server-error' | 'unreachable' | 'malformed';

export type CreateRoomResult = { readonly ok: true; readonly room: RoomInfo } | { readonly ok: false; readonly reason: CreateRoomFailure };

/** The slice of `fetch` this module uses, injected so tests need no network. */
export interface HttpResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface RoomApiDeps {
    readonly fetch: (url: string, init?: { method: string }) => Promise<HttpResponse>;
    readonly timers: Timers;
    readonly random: () => number;
    readonly maxAttempts?: number;
}

export interface RoomApi {
    createRoom(): Promise<CreateRoomResult>;
}

/** Relative, so the dev client (through the Vite proxy) and production share one path. */
const ROOMS_PATH = '/api/rooms';

const TOO_MANY_REQUESTS = 429;
/** One initial attempt plus two retries. Past that the player is better served by being told. */
const MAX_ATTEMPTS = 3;
const BASE_RETRY_MS = 400;
/** ±25%, so a crowd rate-limited together does not return in lockstep. */
const JITTER_SPREAD = 0.5;

function isRoomInfo(value: unknown): value is RoomInfo {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.matchId === 'string' &&
        typeof candidate.joinUrl === 'string' &&
        typeof candidate.hostSeat === 'string' &&
        typeof candidate.hostSeatToken === 'string'
    );
}

export function createRoomApi(deps: RoomApiDeps): RoomApi {
    const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;

    function wait(attempt: number): Promise<void> {
        const base = BASE_RETRY_MS * 2 ** attempt;
        const ms = Math.round(base * (1 - JITTER_SPREAD / 2 + deps.random() * JITTER_SPREAD));
        return new Promise(resolve => deps.timers.setTimeout(resolve, ms));
    }

    async function attempt(): Promise<CreateRoomResult | 'retry'> {
        let response: HttpResponse;
        try {
            response = await deps.fetch(ROOMS_PATH, { method: 'POST' });
        } catch {
            return { ok: false, reason: 'unreachable' };
        }

        if (response.status === TOO_MANY_REQUESTS) return 'retry';

        // Every other non-success fails now. UIX §5 names 429 alone as the
        // retryable case, and hammering a broken server is how it stays broken.
        if (!response.ok) return { ok: false, reason: 'server-error' };

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return { ok: false, reason: 'malformed' };
        }

        if (!isRoomInfo(body)) return { ok: false, reason: 'malformed' };

        // Copied field by field rather than passed through, so a later server
        // version's extra keys never reach storage or the wire.
        return {
            ok: true,
            room: {
                matchId: body.matchId,
                joinUrl: body.joinUrl,
                hostSeat: body.hostSeat,
                hostSeatToken: body.hostSeatToken
            }
        };
    }

    return {
        async createRoom() {
            for (let tries = 0; tries < maxAttempts; tries++) {
                const result = await attempt();
                if (result !== 'retry') return result;
                if (tries < maxAttempts - 1) await wait(tries);
            }
            return { ok: false, reason: 'rate-limited' };
        }
    };
}
