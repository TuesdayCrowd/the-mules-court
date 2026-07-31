/**
 * Layer 2: sampling the worlds a seat could be in, and playing them out.
 *
 * For each iteration: sample a world consistent with what this seat can see
 * (`determinize`), pick a root move by PUCT, play it with the real `reduce()`,
 * and roll the rest of the round out with the layer-1 heuristic. Average the
 * results per move; play the most-sampled one.
 *
 * ## What this is, precisely
 *
 * A **one-ply root search** — Perfect-Information Monte Carlo with a PUCT
 * allocation over root moves — not the full ISMCTS the design sketched. That is
 * a deliberate concession to the measured budget rather than a shortcut:
 * `reduce()` clones the round on every action and runs at ~60,000 calls per
 * second, so a 50 ms turn buys roughly 3,000 of them. A round takes eight to
 * sixteen plies, so the whole budget is a few hundred rollouts — and a tree
 * spread over several plies of that would hold nodes with one or two visits
 * each, which is noise wearing the costume of a search. Spending the same
 * budget deepening the *statistics* on the moves actually available now is
 * worth more than spreading it thin over a tree.
 *
 * The honest cost is **strategy fusion**: inside a rollout the world is fully
 * known, so the search cannot value a move for the information it reveals — it
 * plays as though it will always know what it currently only guesses. That is
 * exactly why the base policy is the trained heuristic rather than a random
 * one: layer 1 prices information directly from the belief marginals
 * (`priestInfo` came out of training as the single most undervalued weight), so
 * the two layers cover each other's blind spot. A deeper tree that shares
 * statistics across determinizations is the next increment, not a rewrite.
 *
 * ## The rule it does not restate
 *
 * Every move here is applied with the engine's own `reduce()`, against a
 * `MatchState` the engine's own `view()` cannot tell from the real one. Nothing
 * in this file knows a rule. That is the same discipline `staticAssets.ts`
 * records for hosting policy — *do not fork the policy* — and the failure mode
 * is identical in shape: a second copy of a rule drifts, and the drift shows up
 * as a bot playing a game subtly different from the one on screen.
 */

import type { MatchState, PlayerId, RedactedView } from '../engine';
import { reduce, view } from '../engine';
import { PERFECT_RECALL } from './census';
import { determinize } from './determinize';
import { createHeuristicPolicy, scoreMoves } from './heuristic';
import type { Policy, PolicyDecision } from './policy';
import type { Rng } from './rng';
import type { Weights } from './weights';
import { TRAINED_WEIGHTS } from './weights.generated';

export interface SearchBudget {
    /** Bounded runs are reproducible; the clock is not. Tests use this alone. */
    readonly maxIterations: number;
    /** Wall clock, checked between iterations. `Infinity` to disable. */
    readonly maxMs: number;
}

export interface SearchOptions {
    readonly budget: SearchBudget;
    /** Weights for the rollout policy. Defaults to the shipped trained set. */
    readonly weights?: Weights;
    /**
     * PUCT's exploration constant. Scales how far the prior can pull sampling
     * away from the moves that are already scoring well.
     */
    readonly explore?: number;
}

/** A hard stop on a rollout. Rounds end on their own; this is a runaway guard. */
const MAX_ROLLOUT_PLIES = 64;

interface MoveStats {
    readonly decision: PolicyDecision;
    /** The base policy's opinion, as a probability. Drives which moves get sampled. */
    readonly prior: number;
    visits: number;
    total: number;
}

/**
 * Score units per unit of prior probability, for the softmax over layer 1.
 *
 * Roughly the score gap that should make one move twice as likely to be tried
 * as another. Wide enough that ordinary differences between reasonable moves
 * stay in contention, which is the point — the prior is meant to steer the
 * search, not to decide for it.
 */
const PRIOR_TEMPERATURE = 25;

/** PUCT's exploration weight. */
const DEFAULT_EXPLORE = 1.5;

/**
 * Rollouts per available move below which the search does not trust itself.
 *
 * Measured, not guessed. A round-position typically offers around twenty moves;
 * at sixty iterations that is three samples each, and a single rollout scores 0
 * or 1 — so one lucky win gives a move a mean of 1.0 and it captures the
 * allocation. A search that thin does not merely add nothing, it plays WORSE
 * than the heuristic it is built on: at that budget the master tier lost to the
 * adept tier outright.
 *
 * So the search defers rather than degrades. Below this threshold it returns
 * layer 1's own choice, which means a slow device quietly gets the adept bot
 * instead of a bad one — a failure that costs strength rather than sense.
 */
const MIN_SAMPLES_PER_MOVE = 8;

const keyOf = (decision: PolicyDecision): string =>
    `${decision.cardInstanceId}|${decision.target ?? ''}|${decision.guess ?? ''}`;

/**
 * Plays the rest of the round out and scores it for one seat.
 *
 * Rounds, not matches: a round is short enough to finish inside the budget, and
 * winning rounds is what accumulates devotion tokens. Playing to a match winner
 * would spend the entire budget on a single sample.
 */
function rollout(start: MatchState, rootId: PlayerId, base: Policy, rng: Rng): number {
    let match = start;

    for (let ply = 0; ply < MAX_ROLLOUT_PLIES; ply++) {
        const result = match.round.roundResult;
        if (result !== null) return result.winnerIds.includes(rootId) ? 1 : 0;

        const actorId = match.round.seatOrder[match.round.currentPlayerIndex];
        const decision = base.decide(view(match, actorId), rng);
        if (decision === null) return 0.5;

        const next = reduce(match, { type: 'PLAY_CARD', playerId: actorId, ...decision });
        // Unreachable while the base policy only names moves the engine offered.
        // Scoring it a draw beats throwing out of a search a player is waiting on.
        if (!next.ok) return 0.5;

        match = next.state;
    }

    return 0.5;
}

/**
 * PUCT, not UCB1, and the difference is load-bearing.
 *
 * UCB1 insists on sampling every move once before sampling any move twice, then
 * rewards whichever has been sampled least. With twenty-odd root moves and a few
 * hundred rollouts that is close to uniform allocation — and worse, it keeps
 * returning to moves that lost every time, because a low visit count IS the
 * exploration bonus. The first version of this file played the Mule for exactly
 * that reason: one sample, a score of zero, and then the largest bonus of any
 * move on the board.
 *
 * PUCT weights exploration by the base policy's prior instead. A move layer 1
 * scores as self-destructive gets a prior near zero and is never tried, without
 * this module knowing what the Mule is or that discarding it loses.
 */
function selectByPuct(moves: MoveStats[], totalVisits: number, explore: number, rng: Rng): MoveStats {
    const exploration = Math.sqrt(Math.max(totalVisits, 1));

    let best = moves[0];
    let bestScore = -Infinity;
    let ties = 1;

    for (const move of moves) {
        const value = move.visits === 0 ? 0 : move.total / move.visits;
        const score = value + explore * move.prior * (exploration / (1 + move.visits));

        if (score > bestScore) {
            bestScore = score;
            best = move;
            ties = 1;
        } else if (score === bestScore) {
            // Reservoir sampling over the tied moves, so the first-listed one is
            // not systematically favoured on the opening iterations where every
            // value is still zero.
            ties += 1;
            if (rng.next() * ties < 1) best = move;
        }
    }

    return best;
}

/** Layer 1's ranking as a distribution: a softmax over its scores. */
function priorsFrom(scores: readonly number[]): number[] {
    const top = Math.max(...scores);
    const weights = scores.map(score => Math.exp((score - top) / PRIOR_TEMPERATURE));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map(weight => weight / total);
}

export function createSearchPolicy(options: SearchOptions, id: string): Policy {
    const weights = options.weights ?? TRAINED_WEIGHTS;
    const explore = options.explore ?? DEFAULT_EXPLORE;
    // The rollout policy always reasons with perfect recall. Difficulty lives in
    // what the SEAT is allowed to remember, not in how well it simulates.
    const base = createHeuristicPolicy(weights, `${id}-rollout`, PERFECT_RECALL);

    return {
        id,

        decide(seat: RedactedView, rng: Rng): PolicyDecision | null {
            const scored = scoreMoves(seat, weights, PERFECT_RECALL);
            if (scored.length === 0) return null;
            // Searching a forced move is pure cost, and at an unbounded budget it
            // would never return.
            if (scored.length === 1) return scored[0].decision;

            const candidates = scored.map(move => move.decision);
            const priorBest = scored.reduce((top, move) => (move.score > top.score ? move : top)).decision;
            const priors = priorsFrom(scored.map(move => move.score));
            // Enough rollouts to have an opinion at all. Checked BEFORE the loop
            // when the budget is bounded by iterations, so deferring costs no
            // random draws and the answer is byte-identical to layer 1's own —
            // a slow device gets the adept bot, not a differently-broken one.
            const minIterations = scored.length * MIN_SAMPLES_PER_MOVE;
            if (options.budget.maxIterations < minIterations) return base.decide(seat, rng);

            const moves: MoveStats[] = scored.map((move, i) => ({
                decision: move.decision,
                prior: priors[i],
                visits: 0,
                total: 0
            }));
            const byKey = new Map(moves.map(move => [keyOf(move.decision), move]));
            const started = performance.now();
            let iterations = 0;

            while (iterations < options.budget.maxIterations) {
                if (options.budget.maxMs !== Infinity && performance.now() - started >= options.budget.maxMs) {
                    break;
                }

                const world = determinize(seat, rng);
                const chosen = selectByPuct(moves, iterations, explore, rng);

                const applied = reduce(world, {
                    type: 'PLAY_CARD',
                    playerId: seat.own.playerId,
                    ...chosen.decision
                });
                if (!applied.ok) {
                    // The engine refused a move it had itself offered, which means
                    // the sampled world is inconsistent. Retire the move rather
                    // than loop on it.
                    byKey.delete(keyOf(chosen.decision));
                    moves.splice(moves.indexOf(chosen), 1);
                    if (moves.length === 0) return candidates[0];
                    continue;
                }

                chosen.visits += 1;
                chosen.total += rollout(applied.state, seat.own.playerId, base, rng);
                iterations += 1;
            }

            // The same shortfall, reached the other way: a wall-clock budget
            // cannot be checked in advance, so a slow machine lands here instead.
            if (iterations < minIterations) return priorBest;

            // Most-sampled, not best-average: PUCT spends its samples on the
            // moves it believes in, so the visit count is the estimate with the
            // least variance behind it. A move that scored 1.0 once is not a
            // finding.
            return moves.reduce((top, move) => (move.visits > top.visits ? move : top)).decision;
        }
    };
}
