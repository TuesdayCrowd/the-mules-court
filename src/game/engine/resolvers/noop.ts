/**
 * The shared do-nothing resolver.
 *
 * Used by COUNTESS (The First Speaker) and PRINCESS (The Mule), whose entire game
 * function lives in metadata rather than in code:
 *
 *  - The First Speaker's forced-play rule is enforced by computeLegalPlays, via
 *    EFFECT_DEFS.COUNTESS.forcedPlayTriggers.
 *  - The Mule's elimination is enforced by the shared discard step, via
 *    EFFECT_DEFS.PRINCESS.eliminatesOnDiscard.
 *
 * Neither belongs here, so this stays empty on purpose.
 */
export function noopResolve(): void {
    // Intentionally empty. See the module comment.
}
