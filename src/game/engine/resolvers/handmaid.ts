import type { ResolveContext } from '../types';

/**
 * Shielded Mind (HANDMAID): the actor cannot be targeted until their next turn.
 *
 * The flag is cleared positionally by advanceTurn, the moment this player becomes
 * the current player again — never by a stored expiry number, because the rule is
 * positional and eliminations reshape the rotation mid-window.
 */
export function resolveHandmaid(context: ResolveContext): void {
    const { round, actorId } = context;
    round.players[actorId].protected = true;
    round.publicLog.push({ kind: 'PROTECTED', turn: round.turnNumber, actorId });
}
