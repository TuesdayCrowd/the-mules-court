import type { ResolveContext } from '../types';
import { CARD_CATALOG, cardTypeOf } from '../cardCatalog';
import { eliminate } from '../discard';
import { heldCard, logFizzle } from './shared';

/**
 * Informant (GUARD): name a card. A targeted opponent holding it is eliminated.
 *
 * The guess names a VALUE, not a character. Four values are shared by two
 * characters each, so guessing 5 catches either Darell. The Informant may never
 * guess its own value; validateAction enforces that before this runs.
 */
export function resolveGuard(context: ResolveContext): void {
    const { round, actorId, targetId, guess, playedCardId } = context;

    if (targetId === undefined || guess === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const target = heldCard(round, targetId);
    // Compared by VALUE: a guess of 5 catches either Darell, a guess of 2 either Priest.
    const hit = target !== undefined && CARD_CATALOG[cardTypeOf(target)].value === guess;

    round.publicLog.push({
        kind: 'GUESS',
        turn: round.turnNumber,
        actorId,
        targetId,
        guessedValue: guess,
        hit
    });

    if (hit) {
        eliminate(round, targetId, 'guard');
    }
}
