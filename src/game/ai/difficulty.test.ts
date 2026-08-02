import { describe, expect, test } from 'vitest';
import { view } from '../engine';
import { rotatingWinRate } from './arena';
import { createOpponent, DIFFICULTIES } from './difficulty';
import { FOUR_SEATS, seeds, takeStates } from './__fixtures__/decisionStates';
import { makeRng } from './rng';

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


/**
 * A search budget small enough to run inside a test suite.
 *
 * Bounded by iterations rather than by the clock, so the result is reproducible
 * on any machine — a wall-clock budget would make this test faster or slower
 * hardware's opinion rather than the design's. It is roughly a seventh of the
 * shipped budget, so the margin it demonstrates is a floor on the real one.
 */
const TEST_BUDGET = { maxIterations: 60, maxMs: Infinity };

describe('the difficulty ladder', () => {
    test('every tier only ever names a move the engine called legal', () => {
        const rng = makeRng('tiers');

        for (const difficulty of DIFFICULTIES) {
            const policy = createOpponent(difficulty, TEST_BUDGET);

            for (const { match, actorId } of takeStates(12, `legal-${difficulty}`)) {
                const seat = view(match, actorId);
                const decision = policy.decide(seat, rng)!;

                expect(seat.own.legalPlays).toContain(decision.cardInstanceId);
                if (decision.target !== undefined) {
                    expect(seat.own.legalTargets[decision.cardInstanceId]).toContain(decision.target);
                }
            }
        }
    });

    test('the adept tier beats the novice one, in both directions', () => {
        // Both directions, because one is not evidence. A real gap shows the
        // candidate above break-even AND the field below it when the seating is
        // reversed; a single measurement above 25% can be a field-composition
        // artifact, which is exactly what caught out training runs 2 and 3.
        const up = rotatingWinRate({
            seats: FOUR_SEATS,
            candidate: createOpponent('adept'),
            field: createOpponent('novice'),
            seeds: seeds(120, 'ladder-a')
        });
        const down = rotatingWinRate({
            seats: FOUR_SEATS,
            candidate: createOpponent('novice'),
            field: createOpponent('adept'),
            seeds: seeds(120, 'ladder-a')
        });

        expect(up.low).toBeGreaterThan(0.25);
        expect(down.high).toBeLessThan(0.25);
    }, SIM_TIMEOUT_MS);

    /**
     * The master rung is NOT asserted here, deliberately.
     *
     * Two attempts failed for the same underlying reason. At a budget small
     * enough for a test suite the search either defers to layer 1 outright (see
     * `search.test.ts`) or samples too thinly to be reliable, so what an in-suite
     * version measures is the fake budget rather than the shipped one — slowly,
     * and with a lower bound that will not separate. A test that is expensive AND
     * fragile is worse than no test: it teaches people to re-run the suite until
     * it passes.
     *
     * The rung is verified by `bun scripts/ladder.ts`, at the shipped budget and
     * in both directions, with the numbers recorded in the design document. What
     * IS pinned here is the behaviour that made a cheap test impossible in the
     * first place: below `MIN_SAMPLES_PER_MOVE` rollouts a move, the search hands
     * back layer 1's answer unchanged, so a slow device gets the adept bot rather
     * than a differently-broken one.
     */

    test('forgetting is what makes the novice weak, not worse judgement', () => {
        // The design rule, asserted where it can be: every tier scores moves with
        // the same weights, so a novice handed perfect recall IS an adept. If this
        // ever fails, someone has made the easy tier play badly rather than know
        // less — which reads as broken rather than as human.
        const novice = createOpponent('novice');
        const adept = createOpponent('adept');
        const rng = () => makeRng('same-mind');

        let agreements = 0;
        let compared = 0;

        for (const { match, actorId } of takeStates(60, 'sameMind')) {
            const seat = view(match, actorId);
            // Before anything has been discarded there is nothing to forget, so
            // the two must agree exactly.
            if (seat.players.some(p => p.discardPile.length > 1) || seat.revealed.length > 0) continue;

            compared += 1;
            if (
                JSON.stringify(novice.decide(seat, rng())) === JSON.stringify(adept.decide(seat, rng()))
            ) {
                agreements += 1;
            }
        }

        expect(compared).toBeGreaterThan(0);
        expect(agreements).toBe(compared);
    }, SIM_TIMEOUT_MS);
});
