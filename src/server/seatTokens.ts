/**
 * Seat tokens, match ids, and RNG seeds (Design §4, §9, §13). All three are
 * 128-bit CSPRNG values of the same shape; they get separate exports because
 * their sensitivity differs — a seatToken is handed to exactly one socket, a
 * matchId is handed to every client, and a seed must never leave the server
 * (it is as sensitive as the actionLog: together they reconstruct every
 * hidden hand in the match).
 *
 * Tokens are never stored raw — only their SHA-256 hash — so a leaked
 * database hands out nothing (Design §4).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 128 bits of randomness as 32 lowercase hex chars. */
function mintHex128(): string {
    return randomBytes(16).toString('hex');
}

/** Server-allocated seat token, delivered to one socket via SEAT_CLAIMED. */
export function mintToken(): string {
    return mintHex128();
}

/** Room/match id (Design §13). Non-sequential — always sent to clients, never a secret. */
export function mintMatchId(): string {
    return mintHex128();
}

/** Match RNG seed (Design §9). As sensitive as the actionLog — must never reach a client. */
export function mintSeed(): string {
    return mintHex128();
}

/** SHA-256 of a token, hex-encoded. This, not the token, is what the database stores. */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * True when `presented` hashes to `storedHash`. Hashes `presented` first and
 * never parses it as hex — the comparison always runs on two fixed-length
 * sha256 digests, so a malformed or odd-length presented value never throws
 * and never leaks a length signal. `timingSafeEqual` requires equal-length
 * buffers, so a malformed `storedHash` is rejected by length before that call
 * rather than throwing.
 */
export function tokenMatches(presented: string, storedHash: string): boolean {
    const presentedHash = Buffer.from(hashToken(presented), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    if (presentedHash.length !== stored.length) return false;
    return timingSafeEqual(presentedHash, stored);
}
