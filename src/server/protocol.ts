/**
 * WebSocket message protocol (Design §3) and the parse boundary (Design §8 step 3).
 *
 * Every inbound frame passes through parseClientMessage before anything else
 * touches it. A hand-written switch, not a schema library — the union is seven
 * variants wide, well short of the fifteen-or-twenty where a schema library
 * would earn its dependency.
 */

import type { CardInstanceId, GuessValue, PlayerId, RedactedView, ValidationError } from '../game/engine';

/** Server-allocated, >=128-bit random, opaque to the client. */
export type SeatToken = string;

/** Server-allocated, >=128-bit random, non-sequential. */
export type MatchId = string;

export type ErrorCode =
    | 'MALFORMED'
    | 'ROOM_NOT_FOUND'
    | 'SEAT_TAKEN'
    | 'ROOM_FULL'
    | 'ALREADY_SEATED'
    | 'BAD_TOKEN'
    | 'NOT_YOUR_SEAT'
    | 'NOT_HOST'
    | 'CANNOT_START'
    | 'PAUSED'
    | 'MATCH_OVER'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | ValidationError['code']; // engine codes forwarded verbatim — they name rules, never cards

export type SeatStatus = 'open' | 'occupied' | 'disconnected';

export type ClientMessage =
    | { type: 'CLAIM_SEAT'; matchId: MatchId; nickname: string } // no seat index — server assigns
    | { type: 'RESUME_SEAT'; matchId: MatchId; seatToken: SeatToken }
    | { type: 'START_MATCH'; matchId: MatchId } // host only; 2-4 seats claimed
    | {
          type: 'PLAY_CARD';
          matchId: MatchId;
          cardInstanceId: CardInstanceId;
          target?: PlayerId;
          guess?: GuessValue; // a card value 2-8, never a character name
          clientMsgId?: string; // echo only; never authorises or orders
      }
    | { type: 'END_MATCH'; matchId: MatchId } // host, or any seat after the grace period
    | { type: 'REQUEST_RESYNC'; matchId: MatchId }
    | { type: 'PING' };

export type ServerMessage =
    | {
          type: 'LOBBY_UPDATE'; // broadcast
          matchId: MatchId;
          hostSeat: PlayerId;
          canStart: boolean;
          seats: { seat: number; playerId: PlayerId | null; nickname: string | null; status: SeatStatus }[];
      }
    | { type: 'SEAT_CLAIMED'; matchId: MatchId; seat: number; playerId: PlayerId; seatToken: SeatToken } // once, this socket only
    | { type: 'MATCH_STARTED'; matchId: MatchId } // broadcast
    | {
          type: 'STATE_UPDATE'; // UNICAST
          view: RedactedView; // view(match, ws.data.seat)
          nicknames: Record<PlayerId, string>; // transport-owned, NEVER inside view
          phase: 'active' | 'round_over' | 'ended';
          endReason?: 'won' | 'abandoned';
          winnerSeat?: PlayerId;
          paused: boolean;
          missingSeats: PlayerId[];
          revealDeadline?: number; // epoch ms, present only while round_over
          serverTime: number;
      }
    | { type: 'MATCH_ENDED'; matchId: MatchId; reason: 'won' | 'abandoned'; winnerSeat?: PlayerId } // broadcast
    | { type: 'ERROR'; code: ErrorCode; refId?: string }
    | { type: 'FATAL'; code: ErrorCode } // sent, then socket closed
    | { type: 'PONG' };

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false };

// ---------------------------------------------------------------- shape guards

/** True when every required key is present and no key falls outside required+optional. */
function hasExactKeys(obj: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    // hasOwnProperty, not `in` — a required key must be the object's own, never inherited
    // from the prototype chain (e.g. 'toString'), which `in` would happily accept.
    return (
        required.every(key => Object.prototype.hasOwnProperty.call(obj, key)) &&
        Object.keys(obj).every(key => allowed.has(key))
    );
}

/** True for any C0 control character (U+0000-U+001F) or DEL (U+007F). */
function hasControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

/** Trims, then rejects empty, oversized, or control-bearing nicknames. The only free text in the protocol. */
function parseNickname(value: unknown, maxNickname: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxNickname) return undefined;
    if (hasControlChar(trimmed)) return undefined;
    return trimmed;
}

/** The server-allocated seat pool. Closes the prototype-pollution row of Design §13. */
const TARGET_RE = /^p[1-4]$/;
function isTarget(value: unknown): value is PlayerId {
    return typeof value === 'string' && TARGET_RE.test(value);
}

function isGuessValue(value: unknown): value is GuessValue {
    return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 8;
}

/** Shape only — "slug#n". Whether the slug names a real card is the engine's concern. */
const CARD_INSTANCE_ID_RE = /^[a-z]+(-[a-z]+)*#\d+$/;
function isCardInstanceId(value: unknown): value is CardInstanceId {
    return typeof value === 'string' && CARD_INSTANCE_ID_RE.test(value);
}

function isClientMsgId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64;
}

/** Shared parse for the three variants that carry nothing but `{ type, matchId }`. */
function parseMatchIdOnly<T extends 'START_MATCH' | 'END_MATCH' | 'REQUEST_RESYNC'>(
    obj: Record<string, unknown>,
    type: T
): { type: T; matchId: string } | undefined {
    if (!hasExactKeys(obj, ['type', 'matchId'])) return undefined;
    if (typeof obj.matchId !== 'string') return undefined;
    return { type, matchId: obj.matchId };
}

// -------------------------------------------------------------------- parse

/**
 * The parse boundary (Design §8 steps 2-3). Never throws: a malformed payload
 * is expected traffic, not an exceptional condition.
 */
export function parseClientMessage(raw: string, maxNickname: number): ParseResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false };
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') {
        return { ok: false };
    }

    switch (obj.type) {
        case 'CLAIM_SEAT': {
            if (!hasExactKeys(obj, ['type', 'matchId', 'nickname'])) return { ok: false };
            if (typeof obj.matchId !== 'string') return { ok: false };
            const nickname = parseNickname(obj.nickname, maxNickname);
            if (nickname === undefined) return { ok: false };
            return { ok: true, msg: { type: 'CLAIM_SEAT', matchId: obj.matchId, nickname } };
        }

        case 'RESUME_SEAT': {
            if (!hasExactKeys(obj, ['type', 'matchId', 'seatToken'])) return { ok: false };
            if (typeof obj.matchId !== 'string' || typeof obj.seatToken !== 'string') return { ok: false };
            return { ok: true, msg: { type: 'RESUME_SEAT', matchId: obj.matchId, seatToken: obj.seatToken } };
        }

        case 'START_MATCH': {
            const msg = parseMatchIdOnly(obj, 'START_MATCH');
            return msg === undefined ? { ok: false } : { ok: true, msg };
        }

        case 'PLAY_CARD': {
            if (!hasExactKeys(obj, ['type', 'matchId', 'cardInstanceId'], ['target', 'guess', 'clientMsgId'])) {
                return { ok: false };
            }
            if (typeof obj.matchId !== 'string') return { ok: false };
            if (!isCardInstanceId(obj.cardInstanceId)) return { ok: false };
            if (obj.target !== undefined && !isTarget(obj.target)) return { ok: false };
            if (obj.guess !== undefined && !isGuessValue(obj.guess)) return { ok: false };
            if (obj.clientMsgId !== undefined && !isClientMsgId(obj.clientMsgId)) return { ok: false };

            const msg: ClientMessage = {
                type: 'PLAY_CARD',
                matchId: obj.matchId,
                cardInstanceId: obj.cardInstanceId,
                ...(obj.target !== undefined ? { target: obj.target } : {}),
                ...(obj.guess !== undefined ? { guess: obj.guess } : {}),
                ...(obj.clientMsgId !== undefined ? { clientMsgId: obj.clientMsgId } : {})
            };
            return { ok: true, msg };
        }

        case 'END_MATCH': {
            const msg = parseMatchIdOnly(obj, 'END_MATCH');
            return msg === undefined ? { ok: false } : { ok: true, msg };
        }

        case 'REQUEST_RESYNC': {
            const msg = parseMatchIdOnly(obj, 'REQUEST_RESYNC');
            return msg === undefined ? { ok: false } : { ok: true, msg };
        }

        case 'PING': {
            if (!hasExactKeys(obj, ['type'])) return { ok: false };
            return { ok: true, msg: { type: 'PING' } };
        }

        default:
            return { ok: false };
    }
}
