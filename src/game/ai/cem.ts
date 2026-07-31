/**
 * The cross-entropy method, over a real-valued vector (Design §6).
 *
 * Sample a population around the current mean, keep the best fraction, refit
 * the mean and spread to those elites, repeat. That is the whole algorithm, and
 * choosing it over gradient methods or a neural approach is a judgement about
 * this problem rather than a general preference: the objective here is a win
 * rate measured by playing games, so it has no gradient, it is *noisy*, and it
 * costs milliseconds to evaluate. CEM is the method that wants exactly those
 * properties, and it has no learning rate to get wrong.
 *
 * **The mean is the answer, not the best sample.** With a noisy objective the
 * top-scoring candidate of a generation is partly lucky, and taking it is a
 * well-known way to overfit the seeds it was scored on. `bestScore` is reported
 * for monitoring; `mean` is what a caller should ship, and should still be
 * checked against a held-out sample.
 *
 * Nothing here knows what a weight means. It optimises numbers, which keeps it
 * testable against an objective whose maximum is known rather than only against
 * the game.
 */

import type { Rng } from './rng';

export interface GenerationReport {
    readonly generation: number;
    /** The best score seen in this generation — noisy, for monitoring only. */
    readonly bestScore: number;
    /** Mean score across the elites. The more honest progress signal. */
    readonly eliteMeanScore: number;
    readonly mean: readonly number[];
    readonly std: readonly number[];
}

export interface CemOptions {
    readonly initialMean: readonly number[];
    readonly initialStd: readonly number[];
    readonly populationSize: number;
    readonly eliteCount: number;
    readonly generations: number;
    /** Higher is better. May be noisy; may re-evaluate differently per call. */
    readonly score: (candidate: readonly number[], generation: number) => number;
    readonly rng: Rng;
    /**
     * A floor on the search width, per dimension.
     *
     * Without one, an early generation whose elites happen to agree collapses
     * the spread to near zero and the search stops exploring — the classic CEM
     * failure, and it looks like convergence rather than like a bug.
     */
    readonly minStd?: readonly number[];
    readonly onGeneration?: (report: GenerationReport) => void;
}

export interface CemResult {
    /** The refitted mean after the final generation. Ship this. */
    readonly mean: readonly number[];
    /** The single best-scoring sample seen. Monitoring, not a deliverable. */
    readonly best: readonly number[];
    readonly bestScore: number;
}

/** One standard normal draw, Box-Muller. */
function gaussian(rng: Rng): number {
    // `1 - next()` moves the half-open interval off zero, where log() diverges.
    const u = 1 - rng.next();
    const v = rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const mean = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;

function stdDev(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const centre = mean(values);
    return Math.sqrt(mean(values.map(value => (value - centre) ** 2)));
}

export function runCem(options: CemOptions): CemResult {
    const dimensions = options.initialMean.length;
    let centre = [...options.initialMean];
    let spread = [...options.initialStd];

    let best = [...options.initialMean];
    let bestScore = -Infinity;

    for (let generation = 0; generation < options.generations; generation++) {
        const scored = Array.from({ length: options.populationSize }, () => {
            const candidate = centre.map((value, i) => value + spread[i] * gaussian(options.rng));
            return { candidate, score: options.score(candidate, generation) };
        });

        scored.sort((a, b) => b.score - a.score);
        const elites = scored.slice(0, options.eliteCount);

        if (elites[0].score > bestScore) {
            bestScore = elites[0].score;
            best = elites[0].candidate;
        }

        centre = Array.from({ length: dimensions }, (_, i) =>
            mean(elites.map(entry => entry.candidate[i]))
        );
        spread = Array.from({ length: dimensions }, (_, i) =>
            Math.max(options.minStd?.[i] ?? 0, stdDev(elites.map(entry => entry.candidate[i])))
        );

        options.onGeneration?.({
            generation,
            bestScore: elites[0].score,
            eliteMeanScore: mean(elites.map(entry => entry.score)),
            mean: [...centre],
            std: [...spread]
        });
    }

    return { mean: centre, best, bestScore };
}
