/**
 * bun:sqlite store and the replay rebuild (Design §9).
 *
 * Storing `{seed, actionLog}` rather than a serialized MatchState keeps the
 * storage schema independent of the engine's internal shape: a future field
 * on MatchState needs no migration, only `reduce()` behaving as its own test
 * suite already pins down. The action log is as sensitive as the seed —
 * together they reconstruct every hidden hand in the match — so only seat
 * token HASHES are ever stored, never a raw token.
 *
 * `save()` is synchronous and sits in the commit path by design: Room calls
 * it in the same queued step that ran the engine call, before the broadcast,
 * so a crash between acceptance and notification can only lose a broadcast,
 * never create a divergence between the log and what players saw.
 *
 * Timestamps are supplied by the caller inside MatchRecord. This module never
 * reads the clock — Room owns time, which keeps the store deterministic and
 * trivially testable.
 */

import { Database } from 'bun:sqlite';
import { createMatch, isMatchOver, reduce, startNextRound } from '../game/engine';
import type { MatchState, PlayCardAction, PlayerId } from '../game/engine';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
    matchId     TEXT PRIMARY KEY,
    seed        TEXT,
    hostSeat    TEXT NOT NULL,
    phase       TEXT NOT NULL,
    endReason   TEXT,
    winnerSeat  TEXT,
    seats       TEXT NOT NULL,
    actionLog   TEXT NOT NULL,
    quarantined INTEGER NOT NULL DEFAULT 0,
    createdAt   INTEGER NOT NULL,
    updatedAt   INTEGER NOT NULL
)`;

export type MatchPhase = 'lobby' | 'active' | 'ended';

/** Design §3's `MATCH_ENDED.reason` domain. Null while the match has not ended. */
export type EndReason = 'won' | 'abandoned';

/** One occupied or reserved seat. `tokenHash`, never the raw token (Design §4, §9). */
export interface StoredSeat {
    readonly index: number;
    readonly playerId: PlayerId;
    readonly nickname: string;
    readonly tokenHash: string;
}

export interface MatchRecord {
    readonly matchId: string;
    /** NULL until START_MATCH — the lobby has no engine state yet. */
    readonly seed: string | null;
    readonly hostSeat: PlayerId;
    readonly phase: MatchPhase;
    readonly endReason: EndReason | null;
    readonly winnerSeat: PlayerId | null;
    readonly seats: readonly StoredSeat[];
    /** Canonical replay source alongside `seed`; PLAY_CARD entries only (see replayMatch). */
    readonly actionLog: readonly PlayCardAction[];
    readonly quarantined: boolean;
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** The raw shape a `SELECT *` returns: JSON columns are strings, booleans are 0/1. */
interface MatchRow {
    matchId: string;
    seed: string | null;
    hostSeat: string;
    phase: string;
    endReason: string | null;
    winnerSeat: string | null;
    seats: string;
    actionLog: string;
    quarantined: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Trusts the store's own writes: beyond the JSON.parse calls below, there is
 * no field-level runtime validation, and no re-checking that `phase` or
 * `endReason` actually hold one of their narrow TS values. A row this
 * function cannot make sense of is expected to throw (caught by `load()`,
 * which quarantines it), not to be silently coerced into something valid.
 */
function rowToRecord(row: MatchRow): MatchRecord {
    return {
        matchId: row.matchId,
        seed: row.seed,
        hostSeat: row.hostSeat,
        phase: row.phase as MatchPhase,
        endReason: row.endReason as EndReason | null,
        winnerSeat: row.winnerSeat,
        seats: JSON.parse(row.seats) as StoredSeat[],
        actionLog: JSON.parse(row.actionLog) as PlayCardAction[],
        quarantined: row.quarantined !== 0,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

/**
 * The one `matches` table (Design §9). Every method is synchronous, matching
 * `bun:sqlite`, so callers may sit it directly in a per-room commit step
 * without awaiting anything.
 */
export class MatchStore {
    private readonly db: Database;
    private readonly upsertStmt: ReturnType<Database['query']>;
    private readonly loadStmt: ReturnType<Database['query']>;
    private readonly quarantineStmt: ReturnType<Database['query']>;
    private readonly deleteStmt: ReturnType<Database['query']>;
    private readonly listIdsStmt: ReturnType<Database['query']>;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.run(SCHEMA);

        this.upsertStmt = this.db.query(`
            INSERT INTO matches
                (matchId, seed, hostSeat, phase, endReason, winnerSeat, seats, actionLog, quarantined, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(matchId) DO UPDATE SET
                seed        = excluded.seed,
                hostSeat    = excluded.hostSeat,
                phase       = excluded.phase,
                endReason   = excluded.endReason,
                winnerSeat  = excluded.winnerSeat,
                seats       = excluded.seats,
                actionLog   = excluded.actionLog,
                quarantined = excluded.quarantined,
                createdAt   = excluded.createdAt,
                updatedAt   = excluded.updatedAt
        `);
        // quarantined rows are invisible to load() — the reaper still needs listIds() to find them.
        this.loadStmt = this.db.query('SELECT * FROM matches WHERE matchId = ? AND quarantined = 0');
        this.quarantineStmt = this.db.query('UPDATE matches SET quarantined = 1 WHERE matchId = ?');
        this.deleteStmt = this.db.query('DELETE FROM matches WHERE matchId = ?');
        this.listIdsStmt = this.db.query('SELECT matchId FROM matches');
    }

    save(record: MatchRecord): void {
        this.upsertStmt.run(
            record.matchId,
            record.seed,
            record.hostSeat,
            record.phase,
            record.endReason,
            record.winnerSeat,
            JSON.stringify(record.seats),
            JSON.stringify(record.actionLog),
            record.quarantined ? 1 : 0,
            record.createdAt,
            record.updatedAt
        );
    }

    /**
     * Null for an unknown id, for an already-quarantined one, and — self-
     * quarantining as it goes — for a row whose `seats`/`actionLog` JSON
     * columns fail to parse. A bare JSON.parse SyntaxError escaping here
     * would bypass the quarantine path this module exists to provide, so
     * the parse runs inside a try/catch: on failure the row is quarantined
     * on the spot and null is returned, mirroring the design's "quarantined
     * for inspection rather than crashing the boot" (Design §9).
     */
    load(matchId: string): MatchRecord | null {
        const row = this.loadStmt.get(matchId) as MatchRow | null;
        if (!row) return null;
        try {
            return rowToRecord(row);
        } catch {
            this.quarantine(matchId);
            return null;
        }
    }

    quarantine(matchId: string): void {
        this.quarantineStmt.run(matchId);
    }

    delete(matchId: string): void {
        this.deleteStmt.run(matchId);
    }

    /** ALL ids, quarantined or not — the reaper is the one caller allowed to see quarantined rows exist. */
    listIds(): string[] {
        return (this.listIdsStmt.all() as { matchId: string }[]).map(row => row.matchId);
    }

    close(): void {
        this.db.close();
    }
}

/**
 * Rebuilds a MatchState by folding `actionLog` through the real engine,
 * starting from `createMatch(playerIds, seed, matchId)`.
 *
 * The subtlety: MatchState.actionLog records PLAY_CARD actions only. Round
 * boundaries are never logged, because `startNextRound` is deterministic
 * from the state alone — so the fold re-derives them here exactly as Room
 * does live, calling `startNextRound` whenever the round has ended before
 * applying the next logged action. A log that ends at round-over is left
 * there on purpose: the rebuilt room re-arms the reveal timer through the
 * ordinary resume flow (Design §7), and since `startNextRound` is
 * deterministic, the next deal is identical whether it happens before or
 * after a crash.
 *
 * Returns null on any divergence — an action past a decided match, or one
 * `reduce` rejects — so the caller can quarantine the row instead of trusting
 * a corrupt log.
 */
export function replayMatch(
    playerIds: readonly PlayerId[],
    seed: string,
    matchId: string,
    actionLog: readonly PlayCardAction[]
): MatchState | null {
    let state = createMatch(playerIds, seed, matchId);

    for (const action of actionLog) {
        if (state.round.phase === 'round-over') {
            if (isMatchOver(state)) return null; // actions logged after a decided match: corrupt
            state = startNextRound(state);
        }
        const result = reduce(state, action);
        if (!result.ok) return null; // corrupt log — caller quarantines
        state = result.state;
    }

    return state;
}
