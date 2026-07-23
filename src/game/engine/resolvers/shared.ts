import type { CardInstanceId, PeekRecord, PlayerId, RoundDraft } from '../types';
import { cardTypeOf } from '../cardCatalog';
import type { CardTypeId } from '../types';

/** Records that a play had no legal target and therefore did nothing. */
export function logFizzle(round: RoundDraft, actorId: PlayerId, cardId: CardTypeId): void {
    round.publicLog.push({ kind: 'FIZZLE', turn: round.turnNumber, actorId, cardId });
}

/**
 * Grants one player knowledge of one card another player currently holds.
 *
 * The record is bound to the immutable (viewer, subject, instance) triple. It is
 * never rewritten or deleted: view() re-checks whether the subject still holds
 * that instance on every call, so a traded or discarded card simply stops
 * resolving instead of being misreported as knowledge about its replacement.
 *
 * The id is derived from the record's own coordinates so that replaying a match
 * reproduces it exactly.
 */
export function recordPeek(
    round: RoundDraft,
    kind: 'priest' | 'baron',
    viewerId: PlayerId,
    subjectId: PlayerId,
    cardInstanceId: CardInstanceId
): void {
    const record: PeekRecord = {
        id: `${kind}-r${round.roundNumber}-t${round.turnNumber}-${viewerId}-${subjectId}`,
        kind,
        viewerId,
        subjectId,
        cardInstanceId,
        cardTypeId: cardTypeOf(cardInstanceId),
        roundNumber: round.roundNumber,
        createdAtTurn: round.turnNumber
    };
    round.privateKnowledge.push(record);
}

/**
 * The single card a player still holds after the played card was discarded.
 *
 * Undefined only in the four-player empty-deck Prince case, where a player can
 * legitimately hold nothing.
 */
export function heldCard(round: RoundDraft, playerId: PlayerId): CardInstanceId | undefined {
    return round.players[playerId].hand[0];
}
