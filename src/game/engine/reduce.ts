import type {
    MatchPlayer,
    MatchState,
    PlayCardAction,
    PlayerId,
    ReduceResult,
    RoundDraft,
    RoundResult,
    RoundState
} from './types';
import { CARD_CATALOG, cardTypeOf } from './cardCatalog';
import { EFFECT_DEFS } from './effectRegistry';
import { validateAction } from './validation';
import { discardPlayedCard } from './discard';
import { advanceTurn, checkRoundEnd } from './roundFlow';
import { dealRound } from './setup';

/**
 * The sole gameplay mutation entrypoint.
 *
 * Returns the full MatchState for SERVER-SIDE persistence only. No transport may
 * forward this to a client — every client-facing value comes from view().
 *
 * The pipeline order is fixed and load-bearing:
 *
 *   validate -> discard the played card -> resolve -> check round end -> advance
 *
 * Discarding before resolving is what makes "the actor's remaining card"
 * unambiguous for Baron, King, and a self-targeted Prince.
 *
 * A round that ends STOPS at phase 'round-over' carrying its result. It does not
 * roll straight into the next deal, because the deck-out showdown has to be
 * visible to clients before the table is swept. Call startNextRound to continue.
 */
export function reduce(match: MatchState, action: PlayCardAction): ReduceResult {
    if (match.matchWinnerId !== null) {
        return { ok: false, error: { code: 'ROUND_NOT_IN_PROGRESS' } };
    }

    const validation = validateAction(match.round, action);
    if (!validation.ok) return validation;

    const round = structuredClone(match.round) as RoundDraft;
    const cardId = cardTypeOf(action.cardInstanceId);
    const effectDef = EFFECT_DEFS[CARD_CATALOG[cardId].effectType];

    discardPlayedCard(round, action.playerId, action.cardInstanceId);

    // A player who played The Mule is already out; their effect never resolves.
    if (round.players[action.playerId].alive) {
        effectDef.resolve({
            round,
            actorId: action.playerId,
            targetId: action.target,
            guess: action.guess,
            playedCardId: cardId
        });
    }

    const actionLog = [...match.actionLog, action];
    const outcome = checkRoundEnd(round);

    if (outcome === null) {
        advanceTurn(round);
        return { ok: true, state: { ...match, round: round as RoundState, actionLog } };
    }

    return { ok: true, state: concludeRound({ ...match, actionLog }, round as RoundState, outcome) };
}

/**
 * Settles a finished round: award tokens, then decide whether the match is over,
 * has entered sudden death, or simply awaits the next deal.
 */
function concludeRound(match: MatchState, round: RoundState, outcome: RoundResult): MatchState {
    const finishedRound: RoundState = {
        ...round,
        phase: 'round-over',
        roundResult: outcome,
        publicLog: [
            ...round.publicLog,
            {
                kind: 'ROUND_END',
                turn: round.turnNumber,
                reason: outcome.reason,
                winners: outcome.winnerIds
            }
        ]
    };

    const players: MatchPlayer[] = match.players.map(player =>
        outcome.winnerIds.includes(player.id) ? { ...player, tokens: player.tokens + 1 } : player
    );

    const settled: MatchState = { ...match, players, round: finishedRound };

    // In sudden death a clean round win takes the match; token totals no longer decide it.
    if (match.mode === 'sudden-death') {
        return outcome.winnerIds.length === 1
            ? { ...settled, matchWinnerId: outcome.winnerIds[0] }
            : { ...settled, suddenDeathPlayers: [...outcome.winnerIds] };
    }

    const atTarget = players.filter(player => player.tokens >= match.tokensToWin);

    if (atTarget.length === 1) {
        return { ...settled, matchWinnerId: atTarget[0].id };
    }

    // Two or more crossing the line together play on until one wins a round outright.
    if (atTarget.length > 1) {
        return { ...settled, mode: 'sudden-death', suddenDeathPlayers: atTarget.map(p => p.id) };
    }

    return settled;
}

/**
 * Deals the round after a finished one.
 *
 * The previous round's winner leads. A co-win breaks toward whichever tied player
 * most recently led a round — equivalently, whoever most recently won a token,
 * since leading is what winning earns. When no co-winner has ever led, the tie
 * falls back to turn order in the round just finished.
 *
 * In sudden death only the tied leaders are dealt in, using the ordinary setup for
 * that participant count.
 */
export function startNextRound(match: MatchState): MatchState {
    if (match.round.phase !== 'round-over') {
        throw new Error('The current round is still in progress');
    }
    if (match.matchWinnerId !== null) {
        throw new Error('The match is already decided');
    }

    const participants =
        match.mode === 'sudden-death' ? match.suddenDeathPlayers : match.players.map(p => p.id);

    const winners = match.round.roundResult?.winnerIds ?? [];
    const starterId = chooseStarter(
        match,
        winners.filter(id => participants.includes(id)),
        participants
    );

    const { round, rng } = dealRound(
        participants,
        starterId,
        match.round.roundNumber + 1,
        match.rng
    );

    return {
        ...match,
        rng,
        players: match.players.map(player =>
            player.id === starterId ? { ...player, lastStartedRound: round.roundNumber } : player
        ),
        round
    };
}

function chooseStarter(
    match: MatchState,
    winnerIds: readonly PlayerId[],
    participants: readonly PlayerId[]
): PlayerId {
    if (winnerIds.length === 1) return winnerIds[0];
    if (winnerIds.length === 0) return participants[0];

    const lastStarted = (id: PlayerId) => match.players.find(p => p.id === id)?.lastStartedRound ?? 0;
    const mostRecent = Math.max(...winnerIds.map(lastStarted));

    if (mostRecent > 0) {
        return winnerIds.find(id => lastStarted(id) === mostRecent)!;
    }

    // Nobody tied has ever led. Fall back to turn order in the finished round.
    return match.round.seatOrder.find(id => winnerIds.includes(id)) ?? winnerIds[0];
}
