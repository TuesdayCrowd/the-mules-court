/**
 * Uniform choice among the moves the engine offered.
 *
 * Its job is not to play well. It is the arena's zero mark — the score any
 * candidate policy must clear by a margin outside its confidence interval
 * before "it beats random" means anything — and it is the fixture every other
 * module in this directory is tested against, because it terminates a match
 * from any position without needing an opinion about the game.
 *
 * It reads `legalPlays` and `legalTargets` and nothing else. Even here that is
 * load-bearing: those are the engine's answers, already accounting for the
 * First Speaker's forcing rule and for protection, and `engine/view.ts` records
 * what happened the one time a client restated targeting itself — a Darell
 * could never be aimed at its own player.
 */

import type { GuessValue, RedactedView } from '../engine';
import { CARD_CATALOG, cardTypeOf, INFORMANT_VALUE } from '../engine';
import type { Policy, PolicyDecision } from './policy';
import { pick, type Rng } from './rng';

/**
 * Every value an Informant may name, derived from the catalog rather than
 * written out, so a card added at a new value is guessable without an edit here.
 */
const GUESSABLE_VALUES: readonly GuessValue[] = [
    ...new Set(Object.values(CARD_CATALOG).map(card => card.value))
]
    .filter((value): value is GuessValue => value !== INFORMANT_VALUE)
    .sort((a, b) => a - b);

export const randomPolicy: Policy = {
    id: 'random',

    decide(view: RedactedView, rng: Rng): PolicyDecision | null {
        const cardInstanceId = pick(view.own.legalPlays, rng);
        if (cardInstanceId === undefined) return null;

        const target = pick(view.own.legalTargets[cardInstanceId] ?? [], rng);
        if (target === undefined) return { cardInstanceId };

        if (CARD_CATALOG[cardTypeOf(cardInstanceId)].value !== INFORMANT_VALUE) {
            return { cardInstanceId, target };
        }

        return { cardInstanceId, target, guess: pick(GUESSABLE_VALUES, rng)! };
    }
};
