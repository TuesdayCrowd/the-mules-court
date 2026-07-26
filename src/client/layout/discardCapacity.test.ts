/**
 * How many cards one seat can actually discard in a round.
 *
 * UIX §6.2 says "a two-player round can reach 7 discards on one seat — verified
 * against the engine by simulation", and the layout reserves room on that
 * number. This is that simulation: the figure is measured here rather than
 * trusted, because the pip block is sized from it and interface rule 7 makes a
 * truncated pile a design failure rather than a graceful degradation.
 */

import { describe, expect, it } from 'vitest';
import * as engine from '../../game/engine';
import { computeLegalPlays, createMatch, reduce, startNextRound } from '../../game/engine';
import type { MatchState, PlayCardAction, PlayerId } from '../../game/engine';
import { MAX_DISCARDS } from './tableLayout';

/**
 * Plays one card, choosing among the legal options by an index the caller
 * varies. The engine's own integration driver always takes the first legal
 * play; sweeping the choice explores far more of the branch space, which is
 * what a worst-case search needs.
 *
 * `computeLegalPlays` rather than `view(...).own.legalPlays`: this sweep runs
 * thousands of matches, and building a whole redacted projection per action to
 * read one field off it is what made an earlier version time out.
 */
function autoAction(match: MatchState, choice: number): PlayCardAction | null {
    const round = match.round;
    if (round.phase !== 'awaiting-play') return null;

    const playerId = round.seatOrder[round.currentPlayerIndex];
    const legal = computeLegalPlays(round, playerId);
    if (legal.length === 0) return null;

    const cardInstanceId = legal[choice % legal.length];
    const cardId = engine.cardTypeOf(cardInstanceId);
    const effect = engine.EFFECT_DEFS[engine.CARD_CATALOG[cardId].effectType];
    const targets = engine.computeLegalTargets(round, playerId, effect);

    const action: PlayCardAction = { type: 'PLAY_CARD', playerId, cardInstanceId };
    if (!effect.requiresTarget || targets.length === 0) return action;

    const target = targets[choice % targets.length];
    if (!effect.requiresGuess) return { ...action, target };

    // Guesses run 2..8; INFORMANT_VALUE is never a legal guess.
    const guess = (engine.MIN_CARD_VALUE + 1 + (choice % 7)) as 2 | 3 | 4 | 5 | 6 | 7 | 8;
    return { ...action, target, guess };
}

/** The largest single-seat discard pile seen anywhere in one match. */
function worstPileInMatch(players: PlayerId[], seed: string, variation: number, maxSteps = 4000): number {
    let match = createMatch(players, seed, 'capacity');
    let worst = 0;
    let step = 0;

    const record = (state: MatchState): void => {
        for (const player of Object.values(state.round.players)) {
            worst = Math.max(worst, player.discardPile.length);
        }
    };

    record(match);

    while (step < maxSteps && match.matchWinnerId === null) {
        if (match.round.phase === 'round-over') {
            match = startNextRound(match);
            record(match);
            step++;
            continue;
        }

        const action = autoAction(match, variation + step);
        if (action === null) break;

        const result = reduce(match, action);
        if (!result.ok) throw new Error(`illegal action: ${result.error.code}`);
        match = result.state;
        record(match);
        step++;
    }

    return worst;
}

const SEAT_COUNTS: ReadonlyArray<readonly PlayerId[]> = [
    ['p0', 'p1'],
    ['p0', 'p1', 'p2'],
    ['p0', 'p1', 'p2', 'p3']
];

/** Sweeps seeds and choice variations, returning the worst pile over all of them. */
function measureWorstPile(players: readonly PlayerId[], seeds: number): number {
    let worst = 0;
    for (let seed = 0; seed < seeds; seed++) {
        for (let variation = 0; variation < 3; variation++) {
            worst = Math.max(worst, worstPileInMatch([...players], `capacity-${seed}`, variation));
        }
    }
    return worst;
}

describe('discard capacity, measured against the engine', () => {
    it.each(SEAT_COUNTS.map(players => [players.length, players] as const))(
        'never exceeds the reserved capacity at %i players',
        (_count, players) => {
            expect(measureWorstPile(players, 60)).toBeLessThanOrEqual(MAX_DISCARDS);
        }
    );

    it('actually reaches a deep pile somewhere, so the bound is not vacuous', () => {
        // A capacity test that never approaches its own limit proves nothing
        // about the limit. Two players run the longest rounds.
        expect(measureWorstPile(['p0', 'p1'], 60)).toBeGreaterThanOrEqual(5);
    });
});
