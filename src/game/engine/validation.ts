import type { PlayCardAction, RoundState, ValidationResult } from './types';
import { CARD_CATALOG, INFORMANT_ID, cardTypeOf } from './cardCatalog';
import { EFFECT_DEFS } from './effectRegistry';
import { computeLegalPlays, computeLegalTargets } from './legality';

/**
 * The single legality gate.
 *
 * Every check re-derives its answer from true server state; nothing here trusts a
 * claim made by the caller. The function is pure, mutates nothing, and returns a
 * typed rejection rather than throwing, because illegal client input is expected
 * traffic rather than an exceptional condition.
 *
 * Check order matters: each step assumes the previous ones held.
 */
export function validateAction(round: RoundState, action: PlayCardAction): ValidationResult {
    // 1. The round must still accept plays.
    if (round.phase !== 'awaiting-play') {
        return { ok: false, error: { code: 'ROUND_NOT_IN_PROGRESS' } };
    }

    // 2. The claimed player must actually hold the turn.
    if (action.playerId !== round.seatOrder[round.currentPlayerIndex]) {
        return { ok: false, error: { code: 'NOT_YOUR_TURN' } };
    }

    // 3. The named instance must be in that player's hand.
    const player = round.players[action.playerId];
    if (!player || !player.hand.includes(action.cardInstanceId)) {
        return { ok: false, error: { code: 'CARD_NOT_IN_HAND' } };
    }

    // 4. The First Speaker constraint, enforced entirely through computeLegalPlays.
    const legalPlays = computeLegalPlays(round, action.playerId);
    if (!legalPlays.includes(action.cardInstanceId)) {
        return {
            ok: false,
            error: { code: 'FORCED_PLAY_VIOLATION', requiredCardId: cardTypeOf(legalPlays[0]) }
        };
    }

    const cardDef = CARD_CATALOG[cardTypeOf(action.cardInstanceId)];
    const effectDef = EFFECT_DEFS[cardDef.effectType];
    const legalTargets = computeLegalTargets(round, action.playerId, effectDef);

    // 5-6. Targeting, including the no-valid-target fizzle.
    if (effectDef.requiresTarget) {
        if (legalTargets.length === 0) {
            // The play still happens and still discards; the effect simply does
            // nothing. A target must therefore be genuinely absent, not null.
            if (action.target !== undefined) {
                return { ok: false, error: { code: 'TARGET_NOT_ALLOWED' } };
            }
        } else if (action.target === undefined) {
            return { ok: false, error: { code: 'TARGET_REQUIRED' } };
        } else if (!legalTargets.includes(action.target)) {
            return { ok: false, error: { code: 'TARGET_NOT_LEGAL', reason: reasonFor(round, action) } };
        }
    } else if (action.target !== undefined) {
        return { ok: false, error: { code: 'TARGET_NOT_ALLOWED' } };
    }

    // 7. The Informant's guess.
    const guessApplies = effectDef.requiresGuess && legalTargets.length > 0;
    if (guessApplies) {
        // A guess must name a real card. An unknown string could only ever miss,
        // so this buys no advantage — but the engine never accepts a shape it did
        // not define.
        if (action.guess === undefined || CARD_CATALOG[action.guess] === undefined) {
            return { ok: false, error: { code: 'GUESS_REQUIRED' } };
        }
        // Banned by identity, never by value, so the rule survives a future value-1 card.
        if (action.guess === INFORMANT_ID) {
            return { ok: false, error: { code: 'GUESS_CANNOT_BE_INFORMANT' } };
        }
    } else if (action.guess !== undefined) {
        return { ok: false, error: { code: 'GUESS_NOT_ALLOWED' } };
    }

    return { ok: true };
}

/** Explains why a named target was refused, for a clearer client error. */
function reasonFor(
    round: RoundState,
    action: PlayCardAction
): 'PROTECTED' | 'ELIMINATED' | 'SELF_NOT_ALLOWED' | 'UNKNOWN_PLAYER' {
    const target = action.target !== undefined ? round.players[action.target] : undefined;
    if (!target) return 'UNKNOWN_PLAYER';
    if (!target.alive) return 'ELIMINATED';
    if (action.target === action.playerId) return 'SELF_NOT_ALLOWED';
    return 'PROTECTED';
}
