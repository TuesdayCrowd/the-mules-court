/**
 * The capability table (Design §3). Everything the MCP knows about a seat it
 * holds, reachable only by that seat's handle.
 *
 * This is the whole isolation mechanism. Three seats played by one model would
 * make every Informant guess a certainty and decide every comparison before it
 * was played, so a seat agent must be unable to read a sibling's hand. It is
 * unable because reading p3's view requires p3's handle and it holds only its
 * own — a missing capability, not a rule someone has to remember. The same
 * trade `protocol.ts` makes when it deletes `playerId` from PLAY_CARD instead
 * of validating it.
 *
 * Handles are minted like seat tokens — 128 bits of CSPRNG hex — because they
 * are the same kind of thing one layer out. `roster()` is the deliberate hole
 * in the wall: the referee needs seat numbers and nicknames to narrate a match
 * and route a turn, and gets them without ever touching a handle or a token.
 */

import { randomBytes } from 'node:crypto';
import type { PlayerId } from '../game/engine';

/** What a claimed seat is known by. `seatToken` never leaves this process. */
export interface SeatClaim {
    readonly playerId: PlayerId;
    readonly seat: number;
    readonly nickname: string;
    readonly seatToken: string;
}

export interface SeatRecord extends SeatClaim {
    readonly handle: string;
}

/** The referee-safe projection. Carries no capability — see `roster()`. */
export interface PublicSeat {
    readonly playerId: PlayerId;
    readonly seat: number;
    readonly nickname: string;
}

/** Mutable internals. `resolve` copies out of this, so a caller cannot write through it. */
interface HeldSeat {
    readonly handle: string;
    readonly playerId: PlayerId;
    readonly seat: number;
    readonly nickname: string;
    seatToken: string;
    notebook: string;
}

/** 128 bits as 32 lowercase hex chars, matching `seatTokens.mintToken`. */
function mintHandle(): string {
    return randomBytes(16).toString('hex');
}

export class SeatRegistry {
    /**
     * A Map rather than an object, so a handle spelled `__proto__` or
     * `constructor` is an ordinary miss instead of a prototype hit. The same
     * row of the transport's threat table, closed the same way.
     *
     * Insertion order is the claim order, which is the seat order, so `roster`
     * and `heldPlayerIds` need no sort of their own.
     */
    private readonly seats = new Map<string, HeldSeat>();

    /** `mint` is injectable so tests can name the handle they expect to be absent. */
    constructor(private readonly mint: () => string = mintHandle) {}

    /** Records a claimed seat and returns its handle. Returned once, never again. */
    claim(claim: SeatClaim): string {
        const handle = this.mint();
        this.seats.set(handle, {
            handle,
            playerId: claim.playerId,
            seat: claim.seat,
            nickname: claim.nickname,
            seatToken: claim.seatToken,
            notebook: ''
        });
        return handle;
    }

    /**
     * The seat this handle authorises, or undefined for a handle we never
     * minted. Undefined rather than a throw: an unknown handle is an expected
     * tool call from a confused caller, not an exceptional condition.
     */
    resolve(handle: string): SeatRecord | undefined {
        const held = this.seats.get(handle);
        if (held === undefined) return undefined;
        return {
            handle: held.handle,
            playerId: held.playerId,
            seat: held.seat,
            nickname: held.nickname,
            seatToken: held.seatToken
        };
    }

    /**
     * Every held seat, named but not authorised.
     *
     * Built field by field from scratch rather than by stripping keys off
     * `HeldSeat` — the engine's `view()` reasoning applied here. Because
     * `PublicSeat` has no field capable of holding a handle or a token,
     * leaking one is a compile error rather than a filtering mistake a
     * reviewer has to spot.
     */
    roster(): readonly PublicSeat[] {
        return [...this.seats.values()].map(held => ({
            playerId: held.playerId,
            seat: held.seat,
            nickname: held.nickname
        }));
    }

    /** The ids a turn may be routed to. Public information — `currentPlayerId` is in every view. */
    heldPlayerIds(): readonly PlayerId[] {
        return [...this.seats.values()].map(held => held.playerId);
    }

    /**
     * This seat's accumulated notes, or undefined for an unknown handle.
     *
     * An empty string and an unknown handle are different answers on purpose:
     * a seat that has written nothing yet must not be indistinguishable from a
     * capability the caller does not hold.
     */
    readNotebook(handle: string): string | undefined {
        return this.seats.get(handle)?.notebook;
    }

    /** Replaces this seat's notes. False for an unknown handle. */
    writeNotebook(handle: string, text: string): boolean {
        const held = this.seats.get(handle);
        if (held === undefined) return false;
        held.notebook = text;
        return true;
    }

    /**
     * Points a handle at a new seat token, keeping the notebook.
     *
     * A reconnect resumes with the token we already hold, so this is for the
     * case where a seat is claimed afresh — the agent's read of the table is
     * the expensive part and must outlive the credential.
     */
    refreshToken(handle: string, seatToken: string): boolean {
        const held = this.seats.get(handle);
        if (held === undefined) return false;
        held.seatToken = seatToken;
        return true;
    }
}
