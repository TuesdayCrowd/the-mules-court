import type { PlayerId } from '../../game/engine';

/**
 * The seat this browser holds for one match.
 *
 * `seatToken` is the only credential in the system and, for a host, the only
 * copy that ever exists — it arrives in the `POST /api/rooms` response and never
 * over the socket. Losing it loses the seat permanently, which is why the menu
 * persists it before it navigates anywhere (UIX §3).
 */
export interface StoredSeat {
    readonly seat: number;
    readonly playerId: PlayerId;
    readonly seatToken: string;
}

/**
 * The slice of web storage this module uses, injected rather than reached for.
 *
 * Keeps the module pure enough to test under plain Node, and makes the Safari
 * private-mode failure mode a case a test can construct instead of a surprise
 * in production.
 */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface SeatTokenStore {
    load(matchId: string): StoredSeat | null;
    save(matchId: string, seat: StoredSeat): void;
    clear(matchId: string): void;
}

/** Namespaced per match, exactly as UIX §3 fixes it. */
export function seatStorageKey(matchId: string): string {
    return `mules-court:${matchId}`;
}

function parseStoredSeat(raw: string): StoredSeat | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.seat !== 'number') return null;
    if (typeof candidate.playerId !== 'string') return null;
    if (typeof candidate.seatToken !== 'string') return null;

    return { seat: candidate.seat, playerId: candidate.playerId, seatToken: candidate.seatToken };
}

/**
 * Reads and writes the stored seat, treating every storage failure as
 * "no stored seat".
 *
 * That degradation is deliberate at all three call sites. Storage can throw on
 * write (Safari private mode), on read, and on delete (a tightened
 * cross-site-storage policy). None of those are worth an exception during boot:
 * losing the token costs one rejoin, while an uncaught throw costs the app.
 */
export function createSeatTokenStore(storage: KeyValueStore): SeatTokenStore {
    return {
        load(matchId) {
            let raw: string | null;
            try {
                raw = storage.getItem(seatStorageKey(matchId));
            } catch {
                return null;
            }
            return raw === null ? null : parseStoredSeat(raw);
        },

        save(matchId, seat) {
            try {
                storage.setItem(seatStorageKey(matchId), JSON.stringify(seat));
            } catch {
                // Nothing to recover: the seat simply will not survive a reload.
            }
        },

        clear(matchId) {
            try {
                storage.removeItem(seatStorageKey(matchId));
            } catch {
                // Already unreachable by any later load(), which is what clear() means.
            }
        }
    };
}
