import { describe, expect, test } from 'vitest';
import { rotatingWinRate } from './arena';
import { baselineHeuristicPolicy, createHeuristicPolicy } from './heuristic';
import { FOUR_SEATS, seeds } from './__fixtures__/decisionStates';
import { DEFAULT_WEIGHTS, FIXED_KEYS, TRAINABLE_KEYS, fromVector, toVector } from './weights';
import { TRAINED_WEIGHTS } from './weights.generated';

/**
 * A simulation budget, for the same reason `discardCapacity.test.ts` carries one.
 *
 * These tests play thousands of real matches through the engine. That is under a
 * second alone on a fast machine and several on a busy one — and the suite runs
 * its files in parallel, so the default 5s timeout measures how loaded the runner
 * is rather than whether the claim holds. It tripped for real: the v1.2.1 release
 * build failed here, on hardware slower than a laptop, with two timeouts and no
 * assertion failures.
 *
 * An explicit budget keeps a real result from depending on the machine. It is
 * generous on purpose — this is a ceiling that catches a hang, not a performance
 * assertion.
 */
const SIM_TIMEOUT_MS = 60_000;


describe('the weight vector', () => {
    test('round-trips a weight set unchanged', () => {
        expect(fromVector(toVector(DEFAULT_WEIGHTS))).toEqual(DEFAULT_WEIGHTS);
    });

    test('carries one entry per trainable weight', () => {
        expect(toVector(DEFAULT_WEIGHTS)).toHaveLength(TRAINABLE_KEYS.length);
    });

    test('leaves the fixed weights out of the search', () => {
        // Two weights are deliberately not trained. `selfDestruct` is a hard
        // constraint rather than a trade-off, and `guardHit` anchors the scale —
        // a linear score's argmax is invariant to multiplying every weight, so
        // without an anchor the search wanders along a direction that changes
        // nothing.
        for (const key of FIXED_KEYS) {
            expect(TRAINABLE_KEYS).not.toContain(key);
        }
    });

    test('pins the fixed weights however the vector moves', () => {
        const wild = toVector(DEFAULT_WEIGHTS).map(() => 999);
        const rebuilt = fromVector(wild);

        for (const key of FIXED_KEYS) {
            expect(rebuilt[key]).toBe(DEFAULT_WEIGHTS[key]);
        }
    });

    test('covers every weight between the two lists', () => {
        const named = new Set<string>([...TRAINABLE_KEYS, ...FIXED_KEYS]);
        expect(named).toEqual(new Set(Object.keys(DEFAULT_WEIGHTS)));
    });
});

describe('the shipped weights', () => {
    test('beat the hand-set baseline on seeds no training run ever scored on', () => {
        // Gate 3 of Computer Opponent Design §10, and the whole point of stage 4.
        // The candidate plays every chair against three baseline seats, so 25% is
        // break-even and the claim is that the interval clears it — not that a
        // number looks bigger.
        //
        // The prefix matters: `trainAi.ts` scores on `<run>-g<n>-*` and validates
        // on `<run>-holdout-*`. Nothing here collides with either, so this really
        // is unseen data rather than a re-run of the trainer's own check.
        const report = rotatingWinRate({
            seats: FOUR_SEATS,
            candidate: createHeuristicPolicy(TRAINED_WEIGHTS, 'trained'),
            field: baselineHeuristicPolicy,
            seeds: seeds(250, 'gate-holdout')
        });

        expect(report.low).toBeGreaterThan(0.25);
    }, SIM_TIMEOUT_MS);
});
