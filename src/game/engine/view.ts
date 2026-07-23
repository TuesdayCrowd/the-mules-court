import type { MatchState, PlayerId, RedactedView } from './types';
import { cardTypeOf } from './cardCatalog';
import { computeLegalPlays } from './legality';

/**
 * The only function whose output may ever reach a client.
 *
 * RedactedView is built field by field from scratch rather than by stripping keys
 * off MatchState. Because it is a structurally distinct type with no field
 * capable of holding a deck, a set-aside card, a seed, the RNG, or another
 * player's hand, forwarding hidden state is a compile error rather than a
 * filtering mistake a reviewer has to spot.
 */
export function view(match: MatchState, viewerId: PlayerId): RedactedView {
    const round = match.round;
    const viewer = round.players[viewerId];
    const isCurrentPlayer = round.seatOrder[round.currentPlayerIndex] === viewerId;

    return {
        matchId: match.matchId,
        playerCount: match.playerCount,
        tokensToWin: match.tokensToWin,
        mode: match.mode,

        players: match.players.map(player => {
            const inRound = round.players[player.id];
            return {
                id: player.id,
                seat: player.seat,
                tokens: player.tokens,
                alive: inRound?.alive ?? false,
                protected: inRound?.protected ?? false,
                discardPile: (inRound?.discardPile ?? []).map(entry => ({
                    cardId: entry.cardId,
                    value: entry.value
                })),
                discardValueTotal: inRound?.discardValueTotal ?? 0
            };
        }),

        // A bare integer. A padded array would leak deck positions.
        deckCount: round.deckOrder.length,

        // Only the two-player face-up burn is public, and only as a card type —
        // the instance id would distinguish otherwise identical copies.
        setAsideFaceUp: round.setAsideFaceUp === null ? null : cardTypeOf(round.setAsideFaceUp),

        currentPlayerId: round.seatOrder[round.currentPlayerIndex],
        turnNumber: round.turnNumber,
        publicLog: round.publicLog,

        own: {
            playerId: viewerId,
            hand: viewer?.hand ?? [],
            legalPlays: isCurrentPlayer ? computeLegalPlays(round, viewerId) : []
        },

        // Peeks are re-checked live, every call. A record survives only while the
        // subject still holds that exact instance, so a card that was played,
        // traded, or redrawn simply stops resolving. It is never reinterpreted as
        // knowledge about whatever replaced it.
        revealed: round.privateKnowledge
            .filter(
                record =>
                    record.viewerId === viewerId &&
                    record.roundNumber === round.roundNumber &&
                    (round.players[record.subjectId]?.hand ?? []).includes(record.cardInstanceId)
            )
            .map(record => ({ subjectId: record.subjectId, cardTypeId: record.cardTypeId })),

        roundResult: round.phase === 'round-over' ? round.roundResult : null,
        matchWinnerId: match.matchWinnerId
    };
}

/**
 * Projects one view per player.
 *
 * This is the sanctioned call site for a transport layer, so that nobody reaches
 * for the raw MatchState when serialising per client.
 */
export function broadcastViews(
    match: MatchState,
    playerIds: readonly PlayerId[]
): Record<PlayerId, RedactedView> {
    const views: Record<PlayerId, RedactedView> = {};
    for (const id of playerIds) {
        views[id] = view(match, id);
    }
    return views;
}
