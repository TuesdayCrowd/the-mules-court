import type { ResolveContext } from '../types';
import { CARD_CATALOG, cardTypeOf } from '../cardCatalog';
import { eliminate } from '../discard';
import { heldCard, logFizzle, recordPeek } from './shared';

/**
 * Ebling Mis and Magnifico (BARON): compare hands; the lower value falls.
 *
 * Both players are down to a single card here, because the played Baron was
 * discarded before this ran.
 *
 * The mutual reveal is unconditional and happens BEFORE the tie check. "Nothing
 * happens on a tie" refers only to the absence of an elimination — the two
 * players always learn each other's card, because they physically compared them.
 */
export function resolveBaron(context: ResolveContext): void {
    const { round, actorId, targetId, playedCardId } = context;

    if (targetId === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const actorCard = heldCard(round, actorId);
    const targetCard = heldCard(round, targetId);
    if (actorCard === undefined || targetCard === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    recordPeek(round, 'baron', actorId, targetId, targetCard);
    recordPeek(round, 'baron', targetId, actorId, actorCard);

    const actorValue = CARD_CATALOG[cardTypeOf(actorCard)].value;
    const targetValue = CARD_CATALOG[cardTypeOf(targetCard)].value;

    if (actorValue === targetValue) {
        round.publicLog.push({
            kind: 'COMPARE',
            turn: round.turnNumber,
            actorId,
            targetId,
            result: 'tie'
        });
        return;
    }

    const loserId = actorValue < targetValue ? actorId : targetId;
    round.publicLog.push({
        kind: 'COMPARE',
        turn: round.turnNumber,
        actorId,
        targetId,
        result: loserId === actorId ? 'actor-eliminated' : 'target-eliminated'
    });
    eliminate(round, loserId, 'baron');
}
