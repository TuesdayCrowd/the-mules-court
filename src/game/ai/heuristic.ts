/**
 * Layer 1 of the computer opponent: a belief-driven scoring policy (Design §5).
 *
 * Enumerate every move the engine offered — each card, each legal target, and
 * for the Informant each guessable value — score them all, and play the best.
 * The scores come from the census marginals rather than from card values, so
 * the same Informant is a strong play against a peeked seat and a shrug against
 * an unread one.
 *
 * Three things the rules do not say out loud, which the scoring exists to
 * capture:
 *
 * **A Baron stakes the card you keep, not the one you play.** `reduce` discards
 * the played card before resolving, so playing a 3 next to a 1 compares the
 * *1*. It reads like a strong play and is very close to a concession.
 *
 * **A deck-out is decided on `discardValueTotal` after the highest card.**
 * `checkRoundEnd` breaks the tie that way, so shedding high cards has late-round
 * value that never appears in the card text.
 *
 * **The Mule is a countdown, not a prize.** It cannot be discarded, so every
 * card drawn beside it must be spent, and the only real defence is protection.
 *
 * The weights are hand-set here and are the thing stage 4 replaces with a
 * trained vector. The *structure* is the part meant to survive training: a
 * linear score over interpretable terms stays reviewable in a diff, which a
 * tensor does not.
 */

import type { CardValue, GuessValue, PlayerId, RedactedView } from '../engine';
import { CARD_CATALOG, cardTypeOf, EFFECT_DEFS, INFORMANT_VALUE } from '../engine';
import { PERFECT_RECALL, takeCensus, type Census, type Recall } from './census';
import { DEFAULT_WEIGHTS, type Weights } from './weights';
import { TRAINED_WEIGHTS } from './weights.generated';
import type { Policy, PolicyDecision } from './policy';
import { pick, type Rng } from './rng';

const MULE_VALUE: CardValue = 8;

const VALUES: readonly CardValue[] = [
    ...new Set(Object.values(CARD_CATALOG).map(card => card.value))
].sort((a, b) => a - b);

const GUESSABLE_VALUES: readonly GuessValue[] = VALUES.filter(
    (value): value is GuessValue => value !== INFORMANT_VALUE
);

interface Beliefs {
    readonly census: Census;
    readonly unseenByValue: ReadonlyMap<CardValue, number>;
    readonly unseenTotal: number;
    readonly unseenMean: number;
}

export interface ScoredMove {
    readonly decision: PolicyDecision;
    readonly score: number;
}

function buildBeliefs(seat: RedactedView, recall: Recall): Beliefs {
    const census = takeCensus(seat, recall);
    const unseenByValue = new Map<CardValue, number>();
    let total = 0;
    let sum = 0;

    for (const type of census.unseen) {
        const value = CARD_CATALOG[type].value;
        unseenByValue.set(value, (unseenByValue.get(value) ?? 0) + 1);
        total += 1;
        sum += value;
    }

    return { census, unseenByValue, unseenTotal: total, unseenMean: total === 0 ? 0 : sum / total };
}

/**
 * P(this seat holds a card of that value).
 *
 * A live peek is certainty in both directions: knowing an opponent holds a 6 is
 * equally a proof that they do not hold anything else.
 */
function pHolds(beliefs: Beliefs, playerId: PlayerId, value: CardValue): number {
    const known = beliefs.census.knownHands[playerId];
    if (known !== undefined && known.length > 0) {
        return known.some(type => CARD_CATALOG[type].value === value) ? 1 : 0;
    }
    if (beliefs.unseenTotal === 0) return 0;
    return (beliefs.unseenByValue.get(value) ?? 0) / beliefs.unseenTotal;
}

function expectedValue(beliefs: Beliefs, playerId: PlayerId): number {
    const known = beliefs.census.knownHands[playerId];
    if (known !== undefined && known.length > 0) return CARD_CATALOG[known[0]].value;
    return beliefs.unseenMean;
}

const pBelow = (beliefs: Beliefs, playerId: PlayerId, mine: number): number =>
    VALUES.filter(value => value < mine).reduce(
        (sum, value) => sum + pHolds(beliefs, playerId, value),
        0
    );

const pAbove = (beliefs: Beliefs, playerId: PlayerId, mine: number): number =>
    VALUES.filter(value => value > mine).reduce(
        (sum, value) => sum + pHolds(beliefs, playerId, value),
        0
    );

/**
 * How exposed this seat is right now.
 *
 * Holding the Mule dominates it, because that seat has no defensive play at all
 * and every card it draws must be spent. A `COMPARE` naming this seat is the
 * other big term: it proves another player knows something about this hand.
 *
 * `PEEKED` names a reader too, and proves strictly more — the exact card, not a
 * comparison — so it is a term this function could take and deliberately does
 * not yet, because weighting it is a change to how hard the opponents play
 * rather than to what the log records.
 */
function threatLevel(seat: RedactedView, holdingMule: boolean): number {
    const me = seat.own.playerId;
    const opponents = seat.players.filter(player => player.alive && player.id !== me).length;
    const compared = seat.publicLog.some(
        entry => entry.kind === 'COMPARE' && (entry.actorId === me || entry.targetId === me)
    );

    return (holdingMule ? 1 : 0) + opponents * 0.15 + (compared ? 0.4 : 0);
}

/** Every legal move, scored. Exported so training and tests can read the ranking. */
export function scoreMoves(
    seat: RedactedView,
    weights: Weights = DEFAULT_WEIGHTS,
    recall: Recall = PERFECT_RECALL
): ScoredMove[] {
    const beliefs = buildBeliefs(seat, recall);
    const me = seat.own.playerId;

    // How much the card kept matters, rising as the deck empties toward the
    // showdown where the highest card simply wins.
    const showdown = 1 / (1 + seat.deckCount);
    const holdingMule = seat.own.hand.some(
        card => CARD_CATALOG[cardTypeOf(card)].value === MULE_VALUE
    );
    const threat = threatLevel(seat, holdingMule);

    const moves: ScoredMove[] = [];

    for (const cardInstanceId of seat.own.legalPlays) {
        const played = CARD_CATALOG[cardTypeOf(cardInstanceId)];
        const effect = EFFECT_DEFS[played.effectType];
        const targets = seat.own.legalTargets[cardInstanceId] ?? [];

        const retained = seat.own.hand.find(card => card !== cardInstanceId);
        const keptValue = retained === undefined ? 0 : CARD_CATALOG[cardTypeOf(retained)].value;
        const retention = weights.keepValue * keptValue * showdown;

        const add = (score: number, target?: PlayerId, guess?: GuessValue): void => {
            moves.push({
                decision: {
                    cardInstanceId,
                    ...(target === undefined ? {} : { target }),
                    ...(guess === undefined ? {} : { guess })
                },
                score: score + retention
            });
        };

        if (effect.eliminatesOnDiscard) {
            add(weights.selfDestruct);
            continue;
        }

        if (effect.requiresTarget && targets.length === 0) {
            add(weights.fizzle);
            continue;
        }

        switch (played.effectType) {
            case 'GUARD':
                for (const target of targets) {
                    for (const guess of GUESSABLE_VALUES) {
                        add(weights.guardHit * pHolds(beliefs, target, guess), target, guess);
                    }
                }
                break;

            case 'PRIEST':
                for (const target of targets) {
                    const alreadyKnown = (beliefs.census.knownHands[target] ?? []).length > 0;
                    add(weights.priestInfo * (alreadyKnown ? 0.1 : 1), target);
                }
                break;

            case 'BARON':
                for (const target of targets) {
                    add(
                        weights.baronWin * pBelow(beliefs, target, keptValue) +
                            weights.baronLose * pAbove(beliefs, target, keptValue),
                        target
                    );
                }
                break;

            case 'HANDMAID':
                add(weights.handmaidBase + weights.handmaidThreat * threat);
                break;

            case 'PRINCE':
                for (const target of targets) {
                    if (target === me) {
                        // Aimed at oneself this discards the RETAINED card, so
                        // doing it while holding the Mule is simply suicide.
                        add(
                            keptValue === MULE_VALUE
                                ? weights.selfDestruct
                                : weights.princeCycle * (beliefs.unseenMean - keptValue),
                            target
                        );
                        continue;
                    }
                    add(
                        weights.princeMuleKill * pHolds(beliefs, target, MULE_VALUE) +
                            weights.princeDisrupt * expectedValue(beliefs, target),
                        target
                    );
                }
                break;

            case 'KING':
                for (const target of targets) {
                    // A trade hands over whatever is kept. Handing over the Mule
                    // gives away the round.
                    add(
                        keptValue === MULE_VALUE
                            ? weights.selfDestruct
                            : weights.kingGain * (expectedValue(beliefs, target) - keptValue),
                        target
                    );
                }
                break;

            default:
                // COUNTESS, and anything later that resolves to nothing.
                add(weights.countessBase);
        }
    }

    return moves;
}

/**
 * Picks the highest-scoring move.
 *
 * Ties are broken at random rather than by enumeration order, so the bot never
 * develops a systematic preference for whichever seat or card the engine
 * happened to list first — and two equally-weighted seats at one table do not
 * play in lockstep.
 */
function chooseBest(moves: readonly ScoredMove[], rng: Rng): PolicyDecision | null {
    if (moves.length === 0) return null;

    const best = moves.reduce((top, move) => (move.score > top.score ? move : top));
    const tied = moves.filter(move => move.score === best.score);

    return pick(tied, rng)!.decision;
}

/**
 * A policy over one weight set.
 *
 * A factory rather than a single export, because training has to seat two
 * differently-weighted opponents at the same table and compare them — and
 * because a policy's `id` is what an arena report labels its seats with.
 */
export function createHeuristicPolicy(
    weights: Weights,
    id: string,
    recall: Recall = PERFECT_RECALL
): Policy {
    return {
        id,
        decide: (seat, rng) => chooseBest(scoreMoves(seat, weights, recall), rng)
    };
}

/** The shipped opponent: trained weights, replaced wholesale by a training run. */
export const heuristicPolicy: Policy = createHeuristicPolicy(TRAINED_WEIGHTS, 'heuristic');

/** The hand-set control, kept seatable so a trained vector can be measured against it. */
export const baselineHeuristicPolicy: Policy = createHeuristicPolicy(DEFAULT_WEIGHTS, 'baseline');
