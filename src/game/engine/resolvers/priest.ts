import type { ResolveContext } from '../types';
import { heldCard, logFizzle, recordPeek } from './shared';

/**
 * Han Pritcher and Bail Channis (PRIEST): look at a target's hand.
 *
 * The card is revealed to the actor alone; the *targeting* is public, exactly as
 * it is at a physical table. `PEEKED` therefore carries both seats and no card,
 * which is what the other targeted resolvers already do.
 *
 * It is logged before the hand is read, and so is logged even when the target
 * holds nothing (the four-player empty-deck Prince case). Being pointed at is
 * the public event; whether there was a card behind it is already public from
 * the hand counts, and a reader who saw nothing still spent their turn looking.
 */
export function resolvePriest(context: ResolveContext): void {
    const { round, actorId, targetId, playedCardId } = context;

    if (targetId === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    round.publicLog.push({ kind: 'PEEKED', turn: round.turnNumber, actorId, targetId });

    const seen = heldCard(round, targetId);
    if (seen === undefined) return;

    recordPeek(round, 'priest', actorId, targetId, seen);
}
