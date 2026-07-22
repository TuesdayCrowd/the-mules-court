import type { ResolveContext } from '../types';
import { CARD_CATALOG, cardTypeOf } from '../cardCatalog';
import { EFFECT_DEFS } from '../effectRegistry';
import { eliminate } from '../discard';
import { heldCard, logFizzle } from './shared';

/**
 * Bayta and Toran Darell (PRINCE): a chosen player discards and draws again.
 *
 * The actor is always a legal target, so this effect never fizzles in practice.
 * When the actor targets itself the card discarded is its remaining card — the
 * played Prince has already gone to the discard pile, so there is no ambiguity
 * about which card "the hand" means.
 */
export function resolvePrince(context: ResolveContext): void {
    const { round, actorId, targetId, playedCardId } = context;

    if (targetId === undefined) {
        logFizzle(round, actorId, playedCardId);
        return;
    }

    const target = round.players[targetId];
    const discarded = heldCard(round, targetId);

    if (discarded !== undefined) {
        const card = CARD_CATALOG[cardTypeOf(discarded)];
        target.hand.shift();
        target.discardPile.push({ instanceId: discarded, cardId: card.id, value: card.value });
        target.discardValueTotal += card.value;

        // Forced to discard The Mule: eliminated, and no replacement is drawn.
        // Drawing one would bury a card nobody ever sees and would shift the turn
        // on which the deck runs out.
        if (EFFECT_DEFS[card.effectType].eliminatesOnDiscard) {
            eliminate(round, targetId, 'mule-forced');
            return;
        }
    }

    const drewFrom = drawReplacement(context, targetId);
    round.publicLog.push({
        kind: 'REDREW',
        turn: round.turnNumber,
        actorId,
        targetId,
        drewFrom
    });
}

/**
 * Deck first, then the face-down set-aside card.
 *
 * Four-player games remove no cards during setup, so no set-aside exists. The
 * target then simply holds nothing — a valid empty hand, never a placeholder —
 * which ranks below every card value at the deck-out showdown.
 */
function drawReplacement(
    context: ResolveContext,
    targetId: string
): 'deck' | 'set-aside' | 'none' {
    const { round } = context;
    const hand = round.players[targetId].hand;

    const fromDeck = round.deckOrder.pop();
    if (fromDeck !== undefined) {
        hand.push(fromDeck);
        return 'deck';
    }

    const fromSetAside = round.setAsideFaceDown.pop();
    if (fromSetAside !== undefined) {
        hand.push(fromSetAside);
        return 'set-aside';
    }

    return 'none';
}
