import type { EffectDef, EffectType } from './types';
import { noopResolve } from './resolvers/noop';
import { resolveGuard } from './resolvers/guard';
import { resolvePriest } from './resolvers/priest';
import { resolveBaron } from './resolvers/baron';
import { resolveHandmaid } from './resolvers/handmaid';
import { resolvePrince } from './resolvers/prince';
import { resolveKing } from './resolvers/king';

/**
 * Card behaviour, keyed by effect type.
 *
 * Eleven card identities collapse onto these eight behaviours. This table is
 * code, never state: a MatchState stores card identities, and behaviour is looked
 * up here, which is what keeps state plain JSON.
 *
 * Two flags carry rules that never reach a resolver:
 *  - forcedPlayTriggers drives the First Speaker constraint in computeLegalPlays.
 *  - eliminatesOnDiscard drives The Mule's elimination in the shared discard step.
 *
 * canTargetSelf exempts the ACTOR alone. It must never relax the alive-and-
 * unprotected requirement for an opponent; see computeLegalTargets.
 */
export const EFFECT_DEFS: Readonly<Record<EffectType, EffectDef>> = {
    GUARD: {
        effectType: 'GUARD',
        requiresTarget: true,
        canTargetSelf: false,
        requiresGuess: true,
        isPassive: false,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolveGuard
    },
    PRIEST: {
        effectType: 'PRIEST',
        requiresTarget: true,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: false,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolvePriest
    },
    BARON: {
        effectType: 'BARON',
        requiresTarget: true,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: false,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolveBaron
    },
    HANDMAID: {
        effectType: 'HANDMAID',
        requiresTarget: false,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: true,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolveHandmaid
    },
    PRINCE: {
        effectType: 'PRINCE',
        requiresTarget: true,
        canTargetSelf: true,
        requiresGuess: false,
        isPassive: false,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolvePrince
    },
    KING: {
        effectType: 'KING',
        requiresTarget: true,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: false,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: [],
        resolve: resolveKing
    },
    COUNTESS: {
        effectType: 'COUNTESS',
        requiresTarget: false,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: true,
        eliminatesOnDiscard: false,
        forcedPlayTriggers: ['KING', 'PRINCE'],
        resolve: noopResolve
    },
    PRINCESS: {
        effectType: 'PRINCESS',
        requiresTarget: false,
        canTargetSelf: false,
        requiresGuess: false,
        isPassive: true,
        eliminatesOnDiscard: true,
        forcedPlayTriggers: [],
        resolve: noopResolve
    }
};
