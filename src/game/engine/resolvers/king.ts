import type { ResolveContext } from '../types';
import { heldCard, logFizzle, recordPeek } from './shared';

/**
 * Mayor Indbur (KING): trade hands with a target.
 *
 * Both sides hold exactly one card by now, because the played King was already
 * discarded. The swap happens in one synchronous step, so no half-traded state is
 * ever observable.
 *
 * Each trader learns where the card THEY GAVE AWAY landed — never the card they
 * received, which is already sitting in their own hand and needs no record. A
 * player who hands over an Informant has no way to use it without knowing which
 * seat it ended up in, and before this, that knowledge did not exist anywhere for
 * either side of the trade. determinize.ts's `revealed`-only replay stays correct
 * unmodified: it carries no `kind` for the AI to key on, so a 'king' record reads
 * exactly as a 'priest' one already did there.
 *
 * The two cards are read before the swap, exactly as baron.ts reads both hands
 * before its own comparison — reading afterward would have each player "learn"
 * the card they already hold, which is both useless and easy to get backwards
 * without noticing.
 */
export function resolveKing(context: ResolveContext): void {
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

    const actorHand = round.players[actorId].hand;
    const targetHand = round.players[targetId].hand;
    round.players[actorId].hand = targetHand;
    round.players[targetId].hand = actorHand;

    recordPeek(round, 'king', actorId, targetId, actorCard);
    recordPeek(round, 'king', targetId, actorId, targetCard);

    round.publicLog.push({ kind: 'TRADED', turn: round.turnNumber, actorId, targetId });
}
