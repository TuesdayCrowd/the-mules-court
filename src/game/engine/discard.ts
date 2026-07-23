import type { CardInstanceId, PlayerId, RoundDraft } from './types';
import { CARD_CATALOG, cardTypeOf } from './cardCatalog';
import { EFFECT_DEFS } from './effectRegistry';

export type EliminationCause = 'guard' | 'baron' | 'mule-voluntary' | 'mule-forced';

/** Moves one card into a player's public discard pile and keeps the running total. */
function pushToDiscard(round: RoundDraft, playerId: PlayerId, instanceId: CardInstanceId): void {
    const card = CARD_CATALOG[cardTypeOf(instanceId)];
    const player = round.players[playerId];
    player.discardPile.push({ instanceId, cardId: card.id, value: card.value });
    player.discardValueTotal += card.value;
}

/**
 * Removes a player from the round.
 *
 * This is the ONLY code path that eliminates anyone. Every elimination — a
 * correct Informant guess, a lost Baron comparison, a voluntary Mule play, a
 * Prince-forced Mule discard — routes through here, so "an eliminated player's
 * card becomes public" holds by construction rather than by remembering the rule
 * at four separate call sites.
 */
export function eliminate(round: RoundDraft, playerId: PlayerId, cause: EliminationCause): void {
    const player = round.players[playerId];

    // Reveal whatever they still hold. Usually one card; none after the
    // four-player empty-deck Prince fallback.
    for (const instanceId of [...player.hand]) {
        pushToDiscard(round, playerId, instanceId);
    }
    player.hand.length = 0;
    player.alive = false;

    round.publicLog.push({ kind: 'ELIMINATED', turn: round.turnNumber, playerId, cause });
}

/**
 * Discards the card a player has just played, before its effect resolves.
 *
 * Running this first is what makes the resolvers unambiguous: once the played
 * instance is gone, "the actor's remaining card" is a hand of at most one, so
 * Baron's comparison, King's swap, and a self-targeted Prince's discard need no
 * index arithmetic and cannot pick up the card being played.
 *
 * The Mule's elimination is handled here too, generically, through the
 * eliminatesOnDiscard flag rather than inside a resolver.
 */
export function discardPlayedCard(
    round: RoundDraft,
    playerId: PlayerId,
    instanceId: CardInstanceId
): void {
    const player = round.players[playerId];
    const cardId = cardTypeOf(instanceId);

    player.hand.splice(player.hand.indexOf(instanceId), 1);
    pushToDiscard(round, playerId, instanceId);
    round.publicLog.push({ kind: 'PLAY', turn: round.turnNumber, actorId: playerId, cardId });

    if (EFFECT_DEFS[CARD_CATALOG[cardId].effectType].eliminatesOnDiscard) {
        eliminate(round, playerId, 'mule-voluntary');
    }
}
