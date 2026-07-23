import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CARD_CATALOG,
    EFFECT_DEFS,
    cardTypeOf,
    computeLegalPlays,
    computeLegalTargets,
    createMatch,
    isMatchOver,
    reduce,
    startNextRound
} from '../../game/engine';
import type { GuessValue, MatchState, PlayCardAction, PlayerId } from '../../game/engine';
import { MatchStore, replayMatch } from '../persistence';
import type { MatchRecord, StoredSeat } from '../persistence';
import { hashToken, mintToken } from '../seatTokens';

/** Fixed so a failure reproduces (Design §9 guidance). */
const SEED = 'mules-court-persistence-fixed-seed';

/**
 * Drives a real match forward with legal moves picked straight off the
 * engine's own legality helpers (Design §9 test 2 guidance), calling
 * `startNextRound` at every round boundary exactly as `replayMatch` does.
 * Stops once `actionLog` holds ~15 entries AND at least one round boundary
 * has been crossed, so the replay test exercises both PLAY_CARD folding and
 * the round-boundary re-derivation in the same drive.
 */
function driveMatch(playerIds: readonly PlayerId[], seed: string, matchId: string): MatchState {
    let state = createMatch(playerIds, seed, matchId);

    for (let i = 0; i < 500; i++) {
        if (state.actionLog.length >= 15 && state.round.roundNumber >= 2) return state;

        if (state.round.phase === 'round-over') {
            if (isMatchOver(state)) {
                throw new Error(`match decided after only ${state.actionLog.length} actions; pick a different seed`);
            }
            state = startNextRound(state);
            continue;
        }

        const currentPlayerId = state.round.seatOrder[state.round.currentPlayerIndex];
        const cardInstanceId = computeLegalPlays(state.round, currentPlayerId)[0];
        const effectDef = EFFECT_DEFS[CARD_CATALOG[cardTypeOf(cardInstanceId)].effectType];
        const targets = computeLegalTargets(state.round, currentPlayerId, effectDef);

        const action: PlayCardAction = {
            type: 'PLAY_CARD',
            playerId: currentPlayerId,
            cardInstanceId,
            ...(targets.length > 0 ? { target: targets[0] } : {}),
            ...(effectDef.requiresGuess && targets.length > 0 ? { guess: 2 as GuessValue } : {})
        };

        const result = reduce(state, action);
        if (!result.ok) throw new Error(`drive produced an illegal action: ${JSON.stringify(result.error)}`);
        state = result.state;
    }

    throw new Error(`drive did not reach the target action count within the iteration cap`);
}

function makeSeats(playerIds: readonly PlayerId[]): StoredSeat[] {
    return playerIds.map((playerId, index) => ({
        index,
        playerId,
        nickname: `Nick-${index}`,
        tokenHash: hashToken(mintToken())
    }));
}

describe('MatchStore', () => {
    it('round-trips a lobby record: save then load deep-equals it', () => {
        const store = new MatchStore(':memory:');
        const record: MatchRecord = {
            matchId: 'lobby-match',
            seed: null, // Design §9: NULL until START_MATCH
            hostSeat: 'p1',
            phase: 'lobby',
            endReason: null,
            winnerSeat: null,
            seats: makeSeats(['p1']),
            actionLog: [],
            quarantined: false,
            createdAt: 1_000,
            updatedAt: 1_000
        };

        store.save(record);

        expect(store.load('lobby-match')).toEqual(record);
        store.close();
    });

    it('returns null when loading an id that was never saved', () => {
        const store = new MatchStore(':memory:');
        expect(store.load('never-saved')).toBeNull();
        store.close();
    });

    it('replays a driven match deterministically from {seed, actionLog}', () => {
        const playerIds: PlayerId[] = ['p1', 'p2', 'p3'];
        const matchId = 'replay-match';
        const live = driveMatch(playerIds, SEED, matchId);

        // Sanity on the drive itself before trusting the replay assertion.
        expect(live.actionLog.length).toBeGreaterThanOrEqual(15);
        expect(live.round.roundNumber).toBeGreaterThanOrEqual(2);

        const replayed = replayMatch(playerIds, SEED, matchId, live.actionLog);

        expect(replayed).not.toBeNull();
        expect(replayed).toEqual(live);
        // Called out explicitly per Design §9 test guidance, even though the
        // toEqual above already covers them structurally.
        expect(replayed!.rng).toEqual(live.rng);
        expect(replayed!.players.map(p => p.tokens)).toEqual(live.players.map(p => p.tokens));
        expect(replayed!.players.map(p => p.lastStartedRound)).toEqual(live.players.map(p => p.lastStartedRound));
    });

    it('returns null for a corrupt log, and quarantine() then hides the row from load() while listIds() keeps it', () => {
        const playerIds: PlayerId[] = ['p1', 'p2', 'p3'];
        const matchId = 'corrupt-match';
        const live = driveMatch(playerIds, SEED, matchId);

        const corruptLog = [...live.actionLog, live.actionLog[live.actionLog.length - 1]];
        expect(replayMatch(playerIds, SEED, matchId, corruptLog)).toBeNull();

        const store = new MatchStore(':memory:');
        const record: MatchRecord = {
            matchId,
            seed: SEED,
            hostSeat: 'p1',
            phase: 'active',
            endReason: null,
            winnerSeat: null,
            seats: makeSeats(playerIds),
            actionLog: corruptLog,
            quarantined: false,
            createdAt: 1_000,
            updatedAt: 1_000
        };
        store.save(record);
        expect(store.load(matchId)).not.toBeNull();

        store.quarantine(matchId);

        expect(store.load(matchId)).toBeNull();
        expect(store.listIds()).toContain(matchId); // the reaper must still be able to find it
        store.close();
    });

    it('lists ids not yet quarantined too, and delete() removes a row from listIds() entirely', () => {
        const store = new MatchStore(':memory:');
        const record: MatchRecord = {
            matchId: 'to-delete',
            seed: null,
            hostSeat: 'p1',
            phase: 'lobby',
            endReason: null,
            winnerSeat: null,
            seats: makeSeats(['p1']),
            actionLog: [],
            quarantined: false,
            createdAt: 1_000,
            updatedAt: 1_000
        };
        store.save(record);
        expect(store.listIds()).toContain('to-delete');

        store.delete('to-delete');

        expect(store.listIds()).not.toContain('to-delete');
        expect(store.load('to-delete')).toBeNull();
        store.close();
    });

    it('never serializes a raw seat token — only its hash — in any saved row', () => {
        const playerIds: PlayerId[] = ['p1', 'p2', 'p3'];
        const rawTokens = playerIds.map(() => mintToken());
        const seats: StoredSeat[] = playerIds.map((playerId, index) => ({
            index,
            playerId,
            nickname: `Nick-${index}`,
            tokenHash: hashToken(rawTokens[index])
        }));

        const store = new MatchStore(':memory:');
        const record: MatchRecord = {
            matchId: 'secrets-match',
            seed: SEED,
            hostSeat: 'p1',
            phase: 'active',
            endReason: null,
            winnerSeat: null,
            seats,
            actionLog: [],
            quarantined: false,
            createdAt: 1_000,
            updatedAt: 1_000
        };
        store.save(record);

        const serializedRow = JSON.stringify(store.load('secrets-match'));

        for (let i = 0; i < rawTokens.length; i++) {
            expect(serializedRow).not.toContain(rawTokens[i]);
            expect(serializedRow).toContain(seats[i].tokenHash);
        }
        store.close();
    });

    it('self-quarantines a row whose JSON column got hand-corrupted, instead of throwing', () => {
        // ':memory:' handles do not share a database, so this one test uses a
        // real temp file: MatchStore opens it, and a second raw Database
        // handle corrupts a column underneath it with plain SQL.
        const dir = mkdtempSync(join(tmpdir(), 'mules-court-persistence-'));
        const dbPath = join(dir, 'corrupt.sqlite');

        try {
            const store = new MatchStore(dbPath);
            const record: MatchRecord = {
                matchId: 'hand-corrupted',
                seed: SEED,
                hostSeat: 'p1',
                phase: 'active',
                endReason: null,
                winnerSeat: null,
                seats: makeSeats(['p1']),
                actionLog: [],
                quarantined: false,
                createdAt: 1_000,
                updatedAt: 1_000
            };
            store.save(record);

            const rawDb = new Database(dbPath);
            rawDb
                .query('UPDATE matches SET actionLog = ? WHERE matchId = ?')
                .run('{not valid json', 'hand-corrupted');
            rawDb.close();

            let loaded: MatchRecord | null = null;
            expect(() => {
                loaded = store.load('hand-corrupted'); // must not let the SyntaxError escape
            }).not.toThrow();
            expect(loaded).toBeNull();

            expect(store.listIds()).toContain('hand-corrupted'); // the reaper must still find it

            const rawDbAfter = new Database(dbPath);
            const row = rawDbAfter
                .query('SELECT quarantined FROM matches WHERE matchId = ?')
                .get('hand-corrupted') as { quarantined: number };
            expect(row.quarantined).toBe(1);
            rawDbAfter.close();

            store.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
