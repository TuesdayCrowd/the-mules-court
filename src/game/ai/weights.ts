/**
 * The heuristic's parameters, and the flat vector a trainer optimises.
 *
 * Split out of `heuristic.ts` so that `weights.generated.ts` — which the
 * trainer overwrites — can import the type without importing the scorer, and
 * the scorer can import the trained values without a cycle.
 *
 * Two weights are deliberately **not** trained:
 *
 * - `selfDestruct` is a hard constraint, not a trade-off. Discarding the Mule
 *   or trading it away loses the round outright; there is no win rate at which
 *   a smaller penalty is correct, and leaving it in the search only invites a
 *   run that discovers the Mule is "worth" playing sometimes.
 * - `guardHit` anchors the scale. A linear score's argmax is invariant to
 *   multiplying every weight by a constant, so without one fixed coordinate the
 *   search has a whole direction along which nothing changes — it wanders,
 *   spends population on it, and produces vectors that are harder to compare
 *   between runs for no gain.
 */

export interface Weights {
    /** × P(the named value is held). A certain elimination should dominate. */
    readonly guardHit: number;
    /** A targeted card played with no legal target: it still discards. */
    readonly fizzle: number;
    /** Looking at a hand this seat cannot already name. */
    readonly priestInfo: number;
    /** × P(my retained card outranks theirs) and × P(it loses). */
    readonly baronWin: number;
    readonly baronLose: number;
    /** Protection, and how much more it is worth while exposed. */
    readonly handmaidBase: number;
    readonly handmaidThreat: number;
    /** × P(the target holds the Mule): a forced discard eliminates them. */
    readonly princeMuleKill: number;
    /** × the target's expected value: stripping a good card is worth something. */
    readonly princeDisrupt: number;
    /** × the improvement from replacing my own retained card. */
    readonly princeCycle: number;
    /** × (their expected value − mine). */
    readonly kingGain: number;
    /** A free discard that keeps the other card. */
    readonly countessBase: number;
    /** Discarding the Mule, or trading it away. Not a trade-off. */
    readonly selfDestruct: number;
    /** × retained value × how close the showdown is. */
    readonly keepValue: number;
}

/**
 * The hand-set baseline, and the reference every trained vector must beat.
 *
 * Kept even after training replaces it in play: it is the control in
 * `weights.test.ts`'s comparison, and a trained vector that cannot clear a
 * thoughtful hand-set one is a result worth seeing rather than hiding.
 */
export const DEFAULT_WEIGHTS: Weights = {
    guardHit: 100,
    fizzle: -1,
    priestInfo: 8,
    baronWin: 60,
    baronLose: -120,
    handmaidBase: 10,
    handmaidThreat: 18,
    princeMuleKill: 100,
    princeDisrupt: 2,
    princeCycle: 3,
    kingGain: 6,
    countessBase: 4,
    selfDestruct: -1000,
    keepValue: 6
};

export type WeightKey = keyof Weights;

/** Held constant through training. See the header for why each one. */
export const FIXED_KEYS: readonly WeightKey[] = ['guardHit', 'selfDestruct'];

/** The search space, in the order `toVector`/`fromVector` use. */
export const TRAINABLE_KEYS: readonly WeightKey[] = (
    Object.keys(DEFAULT_WEIGHTS) as WeightKey[]
).filter(key => !FIXED_KEYS.includes(key));

export function toVector(weights: Weights): number[] {
    return TRAINABLE_KEYS.map(key => weights[key]);
}

export function fromVector(vector: readonly number[]): Weights {
    const weights: Record<string, number> = { ...DEFAULT_WEIGHTS };
    TRAINABLE_KEYS.forEach((key, index) => {
        weights[key] = vector[index];
    });
    // Re-pinned after the spread, so a vector longer than the trainable list
    // still cannot reach a fixed weight.
    for (const key of FIXED_KEYS) weights[key] = DEFAULT_WEIGHTS[key];
    return weights as unknown as Weights;
}
