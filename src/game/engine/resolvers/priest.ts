import type { ResolveContext } from '../types';
import { heldCard, logFizzle, recordPeek } from './shared';

/**
 * Han Pritcher and Bail Channis (PRIEST): look at a target's hand.
 *
 * The card is revealed to the actor alone. Nothing enters the public log beyond
 * the fact that the Priest was played, which the shared discard step already
 * recorded.
 */
export function resolvePriest(context: ResolveContext): void {
    const { round, actorId, targetId, playedCardId } = context;

    if (targetId === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const seen = heldCard(round, targetId);
    if (seen === undefined) return;

    recordPeek(round, 'priest', actorId, targetId, seen);
}
