import type { ResolveContext } from '../types';
import { logFizzle } from './shared';

/**
 * Mayor Indbur (KING): trade hands with a target.
 *
 * Both sides hold exactly one card by now, because the played King was already
 * discarded. The swap happens in one synchronous step, so no half-traded state is
 * ever observable.
 *
 * No peek record is created. Each trader simply holds a new card and sees it as
 * ordinary self-knowledge. Any third party's earlier knowledge about either traded
 * card invalidates itself, because view() checks whether the subject still holds
 * that instance rather than trusting a stored fact.
 */
export function resolveKing(context: ResolveContext): void {
    const { round, actorId, targetId, playedCardId } = context;

    if (targetId === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const actorHand = round.players[actorId].hand;
    const targetHand = round.players[targetId].hand;
    round.players[actorId].hand = targetHand;
    round.players[targetId].hand = actorHand;

    round.publicLog.push({ kind: 'TRADED', turn: round.turnNumber, actorId, targetId });
}
