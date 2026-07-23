import type { CardTypeId, PlayerId, RoundDraft, RoundResult } from './types';
import { CARD_CATALOG, cardTypeOf } from './cardCatalog';

/** An empty hand ranks below every real card at the showdown. */
const EMPTY_HAND_RANK = -1;

/**
 * Passes the turn to the next living player.
 *
 * Clearing that player's protection is the FIRST thing that happens, before they
 * draw. Shielded Mind lasts "until your next turn", which is a positional rule;
 * expressing it positionally means eliminations that shrink the rotation
 * mid-window cannot desynchronise it from a stored expiry number.
 */
export function advanceTurn(round: RoundDraft): void {
    const seats = round.seatOrder;
    let index = round.currentPlayerIndex;

    for (let step = 0; step < seats.length; step++) {
        index = (index + 1) % seats.length;
        if (round.players[seats[index]].alive) break;
    }

    round.currentPlayerIndex = index;
    round.turnNumber += 1;

    const incoming = round.players[seats[index]];
    incoming.protected = false;

    const drawn = round.deckOrder.pop();
    if (drawn !== undefined) incoming.hand.push(drawn);
}

/** The rank used to compare survivors at a deck-out showdown. */
function handRank(round: RoundDraft, playerId: PlayerId): number {
    const held = round.players[playerId].hand[0];
    return held === undefined ? EMPTY_HAND_RANK : CARD_CATALOG[cardTypeOf(held)].value;
}

/**
 * Decides whether the round is over, and who won.
 *
 * Called after a play resolves and before the next player draws. That placement
 * is what implements "a round ends when a player cannot draw": if the deck is
 * empty once a turn completes, the next player could not draw, so the round ends
 * here.
 *
 * Returns null while the round continues.
 */
export function checkRoundEnd(round: RoundDraft): RoundResult | null {
    const survivors = round.seatOrder.filter(id => round.players[id].alive);

    if (survivors.length <= 1) {
        return { reason: 'last-survivor', winnerIds: survivors };
    }

    if (round.deckOrder.length > 0) return null;

    const revealedHands: Record<PlayerId, CardTypeId | null> = {};
    for (const id of survivors) {
        const held = round.players[id].hand[0];
        revealedHands[id] = held === undefined ? null : cardTypeOf(held);
    }

    // Highest card, then the larger discard total. Players tied on both share the
    // round and each earn a token.
    const bestRank = Math.max(...survivors.map(id => handRank(round, id)));
    const byRank = survivors.filter(id => handRank(round, id) === bestRank);

    const bestDiscard = Math.max(...byRank.map(id => round.players[id].discardValueTotal));
    const winnerIds = byRank.filter(id => round.players[id].discardValueTotal === bestDiscard);

    return { reason: 'deck-out', winnerIds, revealedHands };
}
