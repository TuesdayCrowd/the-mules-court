import type { CardInstanceId, EffectDef, PlayerId, RoundState } from './types';
import { CARD_CATALOG, cardTypeOf } from './cardCatalog';
import { EFFECT_DEFS } from './effectRegistry';

/**
 * The single implementation of what a player may play and whom they may target.
 *
 * Both validateAction (server authority) and view() (the client's hint) import
 * these, so the legality a client displays and the legality the server enforces
 * cannot drift apart.
 */

const effectOf = (instanceId: CardInstanceId): EffectDef =>
    EFFECT_DEFS[CARD_CATALOG[cardTypeOf(instanceId)].effectType];

/**
 * The cards a player may legally play this turn.
 *
 * Ordinarily that is the whole hand. The exception is the First Speaker: holding
 * it alongside a card whose effect appears in COUNTESS.forcedPlayTriggers — that
 * is, a KING or a PRINCE — forces the First Speaker and nothing else.
 *
 * Expressing the trigger over effect CATEGORIES rather than card names keeps the
 * rule correct for both Darells and for any card added later.
 */
export function computeLegalPlays(round: RoundState, playerId: PlayerId): CardInstanceId[] {
    const hand = round.players[playerId]?.hand ?? [];

    const forcing = hand.find(instanceId => {
        const def = effectOf(instanceId);
        if (def.forcedPlayTriggers.length === 0) return false;
        return hand.some(
            other => other !== instanceId && def.forcedPlayTriggers.includes(effectOf(other).effectType)
        );
    });

    return forcing ? [forcing] : [...hand];
}

/**
 * The players a card may legally target, in seat order.
 *
 * The actor and the opponents are checked SEPARATELY and deliberately so.
 * Collapsing them into one predicate such as
 *
 *     canTargetSelf || (alive && !protected)
 *
 * reads well and is wrong: the self-exemption then applies to every candidate,
 * letting a Prince target a protected opponent. The self-exemption belongs to the
 * actor alone; an opponent must always be alive and unprotected.
 */
export function computeLegalTargets(
    round: RoundState,
    actorId: PlayerId,
    effectDef: EffectDef
): PlayerId[] {
    if (!effectDef.requiresTarget) return [];

    return round.seatOrder.filter(candidateId => {
        const candidate = round.players[candidateId];
        if (!candidate || !candidate.alive) return false;

        return candidateId === actorId
            ? effectDef.canTargetSelf
            : !candidate.protected;
    });
}
