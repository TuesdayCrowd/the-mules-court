/**
 * `Map<matchId, Room>`, room creation, lazy crash recovery, and the reaper
 * sweep (Design §2, §9; plan Task 10).
 *
 * A restart holds nothing but an empty map: no row is rebuilt until
 * something actually asks for it (`get()`), so a server with many stored
 * rooms comes back up instantly rather than replaying every match before it
 * can accept a single connection (Design §9's "rooms rebuild lazily on
 * first touch"). The reaper (`sweep()`) honors that same rule for rows it
 * has never touched: it decides delete-vs-keep straight from the stored
 * record's own fields (phase, updatedAt) rather than calling `Room.rebuild`
 * just to look, which would defeat the entire point on a big restart.
 */

import type { TransportConfig } from './config';
import type { MatchRecord } from './persistence';
import { MatchStore } from './persistence';
import { Room } from './room';
import type { RoomDeps } from './room';

export class RoomRegistry {
    private readonly config: TransportConfig;
    private readonly store: MatchStore;
    private readonly deps: RoomDeps;
    private readonly now: () => number;

    private readonly rooms = new Map<string, Room>();

    /**
     * First-observed-cold timestamp for a matchId that appears in
     * `store.listIds()` but whose `store.load()` returns null — i.e. it is
     * quarantined (or, in a vanishingly rare race, was deleted by something
     * else between the two calls). `MatchStore.load()` deliberately hides a
     * quarantined row's columns (Design §9's "quarantined for inspection"),
     * so there is no `updatedAt` reachable through the store's public
     * surface for these rows — and `persistence.ts` is out of scope for this
     * task. Tracking "first seen cold by THIS registry" and requiring
     * `retentionMs` to pass from there is the conservative substitute: it
     * can only ever delete a quarantined row LATER than a hypothetical
     * updatedAt-based rule would (a fresh process needs one full
     * `retentionMs` after its own first sweep before deleting anything), matching
     * the plan's "deleting late is safe, deleting early destroys a live
     * game's log."
     */
    private readonly coldMissingFirstSeen = new Map<string, number>();

    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config: TransportConfig, store: MatchStore, deps: RoomDeps = {}) {
        this.config = config;
        this.store = store;
        this.deps = deps;
        this.now = deps.now ?? Date.now;
    }

    /** HTTP path (Design §2, §3): mints the host seat, maps the room, and returns the join response. */
    createRoom(): { matchId: string; joinUrl: string; hostSeat: 'p1'; hostSeatToken: string } {
        const { room, hostSeatToken } = Room.create(this.config, this.store, this.deps);
        this.rooms.set(room.matchId, room);

        return {
            matchId: room.matchId,
            joinUrl: `${this.config.publicBaseUrl}/join/${room.matchId}`,
            hostSeat: 'p1',
            hostSeatToken
        };
    }

    /**
     * An in-memory hit, or a lazy rebuild from the store (Design §9). Returns
     * `null` for an id that was never created, one whose row is quarantined,
     * or one whose replay just failed (`Room.rebuild` has already
     * quarantined it in that case, so a later `get()` on the same id takes
     * the "never created" path above — `MatchStore.load()` itself now
     * filters it out, so replay is never re-attempted).
     */
    get(matchId: string): Room | null {
        const cached = this.rooms.get(matchId);
        if (cached) return cached;

        const record = this.store.load(matchId);
        if (record === null) return null;

        const room = Room.rebuild(this.config, this.store, record, this.deps);
        if (room === null) return null; // record.phase 'active' with a corrupt replay: already quarantined

        this.rooms.set(matchId, room);
        this.coldMissingFirstSeen.delete(matchId); // no longer cold, if it was ever seen that way
        return room;
    }

    /**
     * One reaper tick (Design §5 rows 3, 6, 12-14). Every room already in
     * memory delegates to its own `Room.sweep()`; a `'delete'` result is
     * this registry's job alone to act on: dispose the timer, drop the map
     * entry, delete the row. Every OTHER id the store knows about — never
     * touched by this process since it started, so never lazily rebuilt —
     * is swept cold, straight off the record, per this file's header
     * comment.
     */
    sweep(): void {
        for (const [matchId, room] of this.rooms) {
            if (room.sweep() === 'delete') {
                room.dispose();
                this.rooms.delete(matchId);
                this.store.delete(matchId);
            }
        }

        const now = this.now();
        for (const matchId of this.store.listIds()) {
            if (this.rooms.has(matchId)) continue; // already handled live, above
            this.sweepCold(matchId, now);
        }
    }

    /** Schedules `sweep()` on `config.sweepIntervalMs`; the handle is kept so `stop()` can clear it. */
    startSweeping(): void {
        this.sweepTimer = setInterval(() => this.sweep(), this.config.sweepIntervalMs);
    }

    /** Clears the sweep interval and disposes every mapped room's timer. Leaves the store open — the caller owns it. */
    stop(): void {
        if (this.sweepTimer !== null) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        for (const room of this.rooms.values()) {
            room.dispose();
        }
        this.rooms.clear();
    }

    /** Mapped room count — test-only visibility into the registry's live set. */
    get size(): number {
        return this.rooms.size;
    }

    // ------------------------------------------------------------ internals

    /**
     * Decides delete-vs-keep for a row this process has never rebuilt,
     * using only the record's own fields — never `Room.rebuild` /
     * `replayMatch`, which would defeat lazy recovery on a big restart.
     * Every window below is the phase's own live-`Room.sweep()` TTL PLUS
     * `retentionMs`, so a cold row is only ever deleted once it is at least
     * as stale as a live room in the same phase would have had to be before
     * its own `sweep()` deleted it — conservative by construction, per the
     * plan's "deleting late is safe, deleting early destroys a live game's
     * log."
     */
    private sweepCold(matchId: string, now: number): void {
        const record = this.store.load(matchId);
        if (record === null) {
            this.sweepColdMissingOrQuarantined(matchId, now);
            return;
        }

        this.coldMissingFirstSeen.delete(matchId); // readable again: not (or no longer) missing/quarantined

        this.sweepColdRecord(matchId, record, now);
    }

    private sweepColdRecord(matchId: string, record: MatchRecord, now: number): void {
        const age = now - record.updatedAt;

        if (record.phase === 'ended') {
            if (age > this.config.retentionMs) this.store.delete(matchId);
            return;
        }

        if (record.phase === 'lobby') {
            if (age > this.config.lobbyTtlMs + this.config.retentionMs) this.store.delete(matchId);
            return;
        }

        // 'active': nobody has resumed it since this process started.
        if (age > this.config.zeroConnTtlMs + this.config.retentionMs) this.store.delete(matchId);
    }

    /** A row `store.load()` cannot return a record for: quarantined, or (rarely) deleted mid-sweep by something else. */
    private sweepColdMissingOrQuarantined(matchId: string, now: number): void {
        const firstSeen = this.coldMissingFirstSeen.get(matchId);
        if (firstSeen === undefined) {
            this.coldMissingFirstSeen.set(matchId, now);
            return;
        }
        if (now - firstSeen > this.config.retentionMs) {
            this.store.delete(matchId);
            this.coldMissingFirstSeen.delete(matchId);
        }
    }
}
