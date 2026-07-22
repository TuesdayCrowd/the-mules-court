import type { ResolveContext } from '../types';
import { cardTypeOf } from '../cardCatalog';
import { eliminate } from '../discard';
import { heldCard, logFizzle } from './shared';

/**
 * Informant (GUARD): name a card. A targeted opponent holding it is eliminated.
 *
 * The Informant may never name itself; validateAction enforces that by identity
 * before this ever runs.
 */
export function resolveGuard(context: ResolveContext): void {
    const { round, actorId, targetId, guess, playedCardId } = context;

    if (targetId === undefined || guess === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const target = heldCard(round, targetId);
    const hit = target !== undefined && cardTypeOf(target) === guess;

    round.publicLog.push({
        kind: 'GUESS',
        turn: round.turnNumber,
        actorId,
        targetId,
        guessedCardId: guess,
        hit
    });

    if (hit) {
        eliminate(round, targetId, 'guard');
    }
}
