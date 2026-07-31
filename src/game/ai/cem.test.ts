import { describe, expect, test } from 'vitest';
import { runCem } from './cem';
import { makeRng } from './rng';

/** A smooth objective with a known maximum, so convergence is checkable. */
const towards = (target: readonly number[]) => (candidate: readonly number[]) =>
    -candidate.reduce((sum, value, i) => sum + (value - target[i]) ** 2, 0);

describe('runCem', () => {
    test('converges on the maximum of a smooth objective', () => {
        const target = [3, -7, 0.5];

        const result = runCem({
            initialMean: [0, 0, 0],
            initialStd: [6, 6, 6],
            populationSize: 40,
            eliteCount: 8,
            generations: 40,
            score: towards(target),
            rng: makeRng('converge')
        });

        for (let i = 0; i < target.length; i++) {
            expect(result.mean[i]).toBeCloseTo(target[i], 1);
        }
    });

    test('narrows its search as it closes in', () => {
        const spreads: number[] = [];

        runCem({
            initialMean: [0, 0],
            initialStd: [10, 10],
            populationSize: 30,
            eliteCount: 6,
            generations: 25,
            score: towards([1, 1]),
            rng: makeRng('narrow'),
            onGeneration: report => spreads.push(report.std[0])
        });

        expect(spreads[spreads.length - 1]).toBeLessThan(spreads[0]);
    });

    test('honours a floor on the search width, so it cannot collapse early', () => {
        const spreads: number[] = [];

        runCem({
            initialMean: [0],
            initialStd: [4],
            populationSize: 20,
            eliteCount: 4,
            generations: 20,
            minStd: [0.75],
            score: towards([1]),
            rng: makeRng('floor'),
            onGeneration: report => spreads.push(report.std[0])
        });

        expect(Math.min(...spreads)).toBeGreaterThanOrEqual(0.75);
    });

    test('reports once per generation', () => {
        const seen: number[] = [];

        runCem({
            initialMean: [0],
            initialStd: [1],
            populationSize: 10,
            eliteCount: 3,
            generations: 7,
            score: towards([0]),
            rng: makeRng('report'),
            onGeneration: report => seen.push(report.generation)
        });

        expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    test('returns the best candidate it actually saw', () => {
        const target = [2];
        const seen: number[] = [];

        const result = runCem({
            initialMean: [0],
            initialStd: [3],
            populationSize: 20,
            eliteCount: 5,
            generations: 10,
            score: candidate => {
                const value = towards(target)(candidate);
                seen.push(value);
                return value;
            },
            rng: makeRng('best')
        });

        expect(result.bestScore).toBe(Math.max(...seen));
    });

    test('replays exactly from the same seed', () => {
        const run = () =>
            runCem({
                initialMean: [0, 0],
                initialStd: [2, 2],
                populationSize: 16,
                eliteCount: 4,
                generations: 8,
                score: towards([1, -1]),
                rng: makeRng('replay')
            });

        expect(run()).toEqual(run());
    });
});
