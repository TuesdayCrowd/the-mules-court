/**
 * Verifies the difficulty ladder at the shipped budget (Design §7).
 *
 *     bun scripts/ladder.ts [seeds]
 *
 * Kept out of the test suite on purpose. The master rung needs the real search
 * budget and a few hundred matches to separate cleanly, which is minutes rather
 * than seconds — an in-suite version was tried, took 45 seconds, and still
 * produced a marginal lower bound. Slow and fragile is the worst combination a
 * gate can have, so this runs on demand and its results are recorded in the
 * design document instead.
 *
 * Both directions every time. A candidate above break-even is only half the
 * evidence; the field has to drop below it when the seating is reversed. Two
 * training runs looked like improvements under the one-directional read and
 * turned out to be nothing.
 */

import { rotatingWinRate } from '../src/game/ai/arena';
import { createOpponent, type Difficulty } from '../src/game/ai/difficulty';
import type { PlayerId } from '../src/game/engine';

const SEATS: readonly PlayerId[] = ['p1', 'p2', 'p3', 'p4'];
const COUNT = Number(process.argv[2] ?? 150);
const seeds = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

function rung(stronger: Difficulty, weaker: Difficulty): void {
    const list = seeds(COUNT, `${stronger}-${weaker}`);
    const up = rotatingWinRate({
        seats: SEATS,
        candidate: createOpponent(stronger),
        field: createOpponent(weaker),
        seeds: list
    });
    const down = rotatingWinRate({
        seats: SEATS,
        candidate: createOpponent(weaker),
        field: createOpponent(stronger),
        seeds: list
    });

    const show = (label: string, r: typeof up) =>
        console.log(
            `  ${label.padEnd(34)} ${(r.rate * 100).toFixed(1).padStart(5)}%  ` +
                `[${(r.low * 100).toFixed(1)} .. ${(r.high * 100).toFixed(1)}]  n=${r.matches}`
        );

    console.log(`\n${stronger} vs ${weaker} (break-even 25.0%):`);
    show(`${stronger} vs three ${weaker}`, up);
    show(`${weaker} vs three ${stronger}`, down);
    console.log(
        up.low > 0.25 && down.high < 0.25
            ? '  VERDICT: the rung holds in both directions.'
            : '  VERDICT: NOT separated — do not claim this rung.'
    );
}

rung('adept', 'novice');
rung('master', 'adept');
