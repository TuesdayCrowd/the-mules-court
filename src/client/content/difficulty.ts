/**
 * What a player reads when choosing a computer opponent (UIX §4).
 *
 * Names are in-world; the descriptions are not. A player picking a difficulty
 * needs to know what actually changes, and "Officer" tells them nothing — so
 * each tier says plainly what its opponent can and cannot do. The names carry
 * the setting; the sentences carry the choice.
 *
 * None of the three reuses a card name. "Speaker" was the obvious pick for the
 * strongest tier and is rejected for exactly that reason: The First Speaker is
 * a card, and a seat label that reads as a revealed hand is a cruelty in a
 * deduction game.
 *
 * The engineering names (`novice`/`adept`/`master`) stay in
 * `src/game/ai/difficulty.ts`. This file is the only place either wording lives,
 * so renaming an opponent never means touching the AI.
 */

import type { BotDifficulty } from '../../server/protocol';

export interface DifficultyCopy {
    readonly id: BotDifficulty;
    readonly name: string;
    /** One sentence, in terms of what the opponent knows. */
    readonly description: string;
}

/** Presented in this order — weakest first, the way a difficulty list reads. */
export const DIFFICULTY_COPY: readonly DifficultyCopy[] = [
    {
        id: 'novice',
        name: 'Converted',
        description: 'Forgets the cards played earlier in the round.'
    },
    {
        id: 'adept',
        name: 'Officer',
        description: 'Remembers every card played, and what it has seen.'
    },
    {
        id: 'master',
        name: 'Mentalic',
        description: 'Remembers everything, and plays the odds forward.'
    }
];

/** The tier a host gets without choosing. The middle one, never the hardest. */
export const DEFAULT_DIFFICULTY: BotDifficulty = 'adept';

export function difficultyCopy(id: BotDifficulty): DifficultyCopy {
    const found = DIFFICULTY_COPY.find(entry => entry.id === id);
    if (found === undefined) throw new Error(`No copy for difficulty '${id}'`);
    return found;
}
