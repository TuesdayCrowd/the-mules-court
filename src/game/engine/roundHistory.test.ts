/**
 * Rounds the match has already finished.
 *
 * `dealRound` starts every round with `publicLog: []`, so until now the only
 * log any client could ever see was the one in progress — the moment a new
 * round was dealt, the previous round's narration ceased to exist anywhere in
 * the system. A player who looked away during a showdown had no way back to it.
 *
 * The alternative was for the client to snapshot `publicLog` before it noticed
 * the array get shorter. Which round a devotion token was won in is a fact
 * about the match, and a client inferring it from a length change is the drift
 * `store/targets.ts` exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { createMatch, reduce, startNextRound, view } from './index';
import type { MatchState, PlayerId } from './index';

/** Plays legal cards until the round ends, so a real log accumulates. */
function playOutRound(start: MatchState): MatchState {
    let state = start;

    for (let guard = 0; guard < 200; guard++) {
        if (state.round.phase === 'round-over') return state;

        const actor = state.round.seatOrder[state.round.currentPlayerIndex];
        const self = view(state, actor);
        const card = self.own.legalPlays[0];
        if (card === undefined) throw new Error('a player on turn had no legal play');

        const targets = self.own.legalTargets[card] ?? [];
        const result = reduce(state, {
            type: 'PLAY_CARD',
            playerId: actor,
            cardInstanceId: card,
            ...(targets.length > 0 ? { target: targets[0] } : {}),
            // 2 is always guessable and being wrong is fine — this only needs
            // the round to progress.
            ...(self.own.hand.includes(card) && card.startsWith('informant') ? { guess: 2 as const } : {})
        });

        if (!result.ok) throw new Error(`the engine refused a play it offered: ${result.error}`);
        state = result.state;
    }

    throw new Error('the round never ended');
}

const SEATS: PlayerId[] = ['p1', 'p2', 'p3'];

describe('a match that has finished a round', () => {
    it('starts with no history at all', () => {
        const match = createMatch(SEATS, 'history-seed');
        expect(match.roundHistory).toEqual([]);
        expect(view(match, 'p1').roundHistory).toEqual([]);
    });

    it('still shows the finished round as the current one before the next is dealt', () => {
        // Archiving at conclusion would list the round twice: once as history and
        // once as the round still on screen. It is archived when it is replaced.
        const finished = playOutRound(createMatch(SEATS, 'history-seed'));

        expect(finished.round.phase).toBe('round-over');
        expect(finished.roundHistory).toEqual([]);
        expect(view(finished, 'p1').publicLog.length).toBeGreaterThan(0);
    });

    it('keeps the finished round once the next one is dealt', () => {
        const finished = playOutRound(createMatch(SEATS, 'history-seed'));
        const before = finished.round.publicLog;
        const next = startNextRound(finished);

        expect(next.round.publicLog).toEqual([]);
        expect(next.roundHistory).toHaveLength(1);
        expect(next.roundHistory[0].publicLog).toEqual(before);
    });

    it('records which round it was and who took it', () => {
        const finished = playOutRound(createMatch(SEATS, 'history-seed'));
        const next = startNextRound(finished);
        const archived = next.roundHistory[0];

        expect(archived.roundNumber).toBe(1);
        expect(archived.winnerIds).toEqual(finished.round.roundResult!.winnerIds);
        expect(archived.reason).toBe(finished.round.roundResult!.reason);
    });

    it('accumulates in the order the rounds were played', () => {
        let state = startNextRound(playOutRound(createMatch(SEATS, 'history-seed')));
        state = startNextRound(playOutRound(state));

        expect(state.roundHistory.map(entry => entry.roundNumber)).toEqual([1, 2]);
        expect(state.round.roundNumber).toBe(3);
    });

    it('ends each archived log with that round’s result', () => {
        const state = startNextRound(playOutRound(createMatch(SEATS, 'history-seed')));
        const log = state.roundHistory[0].publicLog;

        expect(log[log.length - 1].kind).toBe('ROUND_END');
    });
});

describe('what the history discloses', () => {
    it('reaches every seat identically, because a public log is public', () => {
        const state = startNextRound(playOutRound(createMatch(SEATS, 'history-seed')));

        const seen = SEATS.map(id => JSON.stringify(view(state, id).roundHistory));
        expect(new Set(seen).size, 'one seat saw a different history').toBe(1);
    });

    it('carries nothing the live log would not have carried', () => {
        // `publicLog` is safe by construction — the engine keeps peeks out of it
        // entirely and surfaces them only through the per-viewer `revealed`. So
        // archiving it verbatim discloses exactly what was already disclosed.
        const finished = playOutRound(createMatch(SEATS, 'history-seed'));
        const live = JSON.stringify(finished.round.publicLog);
        const archived = JSON.stringify(startNextRound(finished).roundHistory[0].publicLog);

        expect(archived).toBe(live);
    });

    it('never names a card a living player still holds', () => {
        const state = startNextRound(playOutRound(createMatch(SEATS, 'history-seed')));
        const held = new Set(
            Object.values(state.round.players).flatMap(player => (player.alive ? player.hand : []))
        );

        const raw = JSON.stringify(state.roundHistory);
        for (const instanceId of held) {
            expect(raw.includes(instanceId), `history named a held card: ${instanceId}`).toBe(false);
        }
    });
});

describe('replay', () => {
    it('rebuilds the same history from the same actions', () => {
        // Persistence stores {seed, actionLog} and replays through reduce, so
        // history has to be a consequence of the actions rather than a snapshot.
        function run(): MatchState {
            let state = startNextRound(playOutRound(createMatch(SEATS, 'history-seed')));
            state = startNextRound(playOutRound(state));
            return state;
        }

        expect(JSON.stringify(run().roundHistory)).toBe(JSON.stringify(run().roundHistory));
    });
});
