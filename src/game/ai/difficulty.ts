/**
 * The three opponents a player can choose between (Design §7).
 *
 * Every tier runs the SAME scorer on the SAME trained weights. What changes is
 * how much of the table the seat is allowed to remember, and whether it gets to
 * sample the futures its uncertainty allows.
 *
 * That is the whole design rule, and it is the easiest thing to get backwards:
 *
 *     An easy bot should reason well about less.
 *     It should not reason badly about everything.
 *
 * A bot that throws away a winning line reads as broken and teaches a new
 * player nothing. A bot that forgets a discard from four turns ago, misses that
 * a compare was a tie, and therefore guesses wrong reads as a person — and its
 * mistakes are legible, which is what makes beating the next tier up feel
 * earned rather than granted.
 *
 * Player-facing names for these belong in `src/client/content/`, with every
 * other string a player reads.
 */

import { PERFECT_RECALL, type Recall } from './census';
import { createHeuristicPolicy } from './heuristic';
import type { Policy } from './policy';
import { createSearchPolicy, type SearchBudget } from './search';
import { TRAINED_WEIGHTS } from './weights.generated';

export type Difficulty = 'novice' | 'adept' | 'master';

export const DIFFICULTIES: readonly Difficulty[] = ['novice', 'adept', 'master'];

/**
 * A seat that remembers only what was played most recently, and never retains
 * a peek past the turn it happened on.
 *
 * Deliberately forgetful rather than noisy: dropping the early round is how a
 * person loses track, so the errors it produces are the ones a player recognises
 * — a guess at a value that was discarded four turns ago.
 */
const NOVICE_RECALL: Recall = { discardDepth: 1, peeks: false };

/**
 * The strongest tier's thinking budget.
 *
 * Wall clock, so the tier behaves the same on a phone and a workstation, and
 * generous enough to matter without pushing past the pacing the table already
 * imposes — `botThinkMs` is 1200ms, so 50ms of search is invisible inside it.
 */
export const MASTER_BUDGET: SearchBudget = { maxIterations: 400, maxMs: 50 };

export function createOpponent(difficulty: Difficulty, budget: SearchBudget = MASTER_BUDGET): Policy {
    switch (difficulty) {
        case 'novice':
            return createHeuristicPolicy(TRAINED_WEIGHTS, 'novice', NOVICE_RECALL);
        case 'adept':
            return createHeuristicPolicy(TRAINED_WEIGHTS, 'adept', PERFECT_RECALL);
        case 'master':
            return createSearchPolicy({ budget }, 'master');
    }
}
