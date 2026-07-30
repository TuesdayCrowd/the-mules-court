/**
 * Real match states to test against, rather than hand-built fixtures.
 *
 * A `RedactedView` has thirteen top-level fields and several of them are
 * derived, so a literal written by hand is a guess about what the engine emits
 * and drifts the moment the engine changes. These walk actual matches instead,
 * so every state a test sees is one the engine really produced — including the
 * awkward ones nobody thinks to write down: a protected seat, a hand of two
 * Informants, a round where the deck ran out.
 */

import type { MatchState, PlayerId, RedactedView } from '../../engine';
import { createMatch, reduce, startNextRound, view } from '../../engine';
import { randomPolicy } from '../randomPolicy';
import { makeRng } from '../rng';

export const FOUR_SEATS: readonly PlayerId[] = ['p1', 'p2', 'p3', 'p4'];

export interface DecisionState {
    readonly match: MatchState;
    /** The seat holding the turn, and therefore the viewer whose view is decidable. */
    readonly actorId: PlayerId;
}

export const seeds = (count: number, prefix = 'walk'): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

/**
 * Every state at which some seat must choose, across matches played out by
 * `randomPolicy`.
 *
 * Yields before playing, so a consumer sees the state the acting seat actually
 * decides from. Lazy, so a test that wants twenty states does not play a
 * thousand matches to get them.
 */
export function* decisionStates(
    matchSeeds: readonly string[],
    seats: readonly PlayerId[] = FOUR_SEATS
): Generator<DecisionState> {
    for (const seed of matchSeeds) {
        const rng = makeRng(`walk:${seed}`);
        let match = createMatch(seats, seed, 'walk');

        while (match.matchWinnerId === null) {
            if (match.round.phase === 'round-over') {
                match = startNextRound(match);
                continue;
            }

            const actorId = match.round.seatOrder[match.round.currentPlayerIndex];
            yield { match, actorId };

            const decision = randomPolicy.decide(view(match, actorId), rng);
            if (decision === null) throw new Error(`No legal play for ${actorId}`);

            const result = reduce(match, { type: 'PLAY_CARD', playerId: actorId, ...decision });
            if (!result.ok) throw new Error(`Walk produced an illegal action: ${result.error.code}`);
            match = result.state;
        }
    }
}

/** The first `count` decision states, as an array. */
export function takeStates(count: number, prefix = 'walk'): DecisionState[] {
    const states: DecisionState[] = [];
    for (const state of decisionStates(seeds(count, prefix))) {
        states.push(state);
        if (states.length === count) break;
    }
    return states;
}

/**
 * The first decision state whose view satisfies `predicate`, or `undefined`.
 *
 * For testing a judgement call that only arises in a particular spot — holding a
 * Baron next to an Informant, say. Searching real play for the position beats
 * hand-writing a `RedactedView`, which is a guess about the engine's output that
 * goes stale silently. A caller that finds nothing should fail rather than skip:
 * a search that quietly returns `undefined` is a test that stopped testing.
 */
export function findState(
    predicate: (seat: RedactedView) => boolean,
    matchBudget = 400,
    prefix = 'find'
): (DecisionState & { seat: RedactedView }) | undefined {
    for (const state of decisionStates(seeds(matchBudget, prefix))) {
        const seat = view(state.match, state.actorId);
        if (predicate(seat)) return { ...state, seat };
    }
    return undefined;
}
