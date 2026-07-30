/**
 * Trains the heuristic's weights by self-play, and rewrites
 * `src/game/ai/weights.generated.ts` (Computer Opponent Design §6).
 *
 *     bun scripts/trainAi.ts [--generations 30] [--population 32]
 *                            [--elites 8] [--seeds 48] [--seed run-1]
 *
 * Offline tooling. Nothing under `src/` imports this file, and it is not part
 * of any build — the only thing it leaves behind is the generated weights.
 *
 * ## What is being optimised
 *
 * One candidate seat against three seats playing the hand-set baseline, played
 * from every chair on every seed (`rotatingWinRate`), so 1/4 is the honest
 * break-even and turn order cancels exactly.
 *
 * `--field` chooses the opponent. `baseline` is the hand-set control and keeps
 * the objective perfectly stationary, which is what CEM wants. `trained` is the
 * current shipped incumbent, which makes successive runs co-evolutionary: each
 * pass must beat the one before it.
 *
 * Co-evolution buys strength and costs a guarantee. A stationary objective can
 * only be climbed; a moving one can CYCLE, the way rock beats scissors beats
 * paper — pass 3 can beat pass 2 while quietly losing to pass 1. Two things
 * answer that. Every pass must clear a held-out bar against BOTH its training
 * opponent and the original baseline, so no pass can ship a regression against
 * the fixed control. And the passes are compared head to head afterwards rather
 * than assumed to improve in order.
 *
 * ## Why the seeds move every generation
 *
 * Within a generation every candidate is scored on the SAME seeds — common
 * random numbers, so the ranking compares policies rather than shuffles. Across
 * generations the seeds change, so the search cannot climb a particular set of
 * deals. The final answer is then re-measured on seeds it has never seen.
 */

import { rotatingWinRate } from '../src/game/ai/arena';
import { runCem } from '../src/game/ai/cem';
import { baselineHeuristicPolicy, createHeuristicPolicy, heuristicPolicy } from '../src/game/ai/heuristic';
import { makeRng } from '../src/game/ai/rng';
import { DEFAULT_WEIGHTS, TRAINABLE_KEYS, fromVector, toVector } from '../src/game/ai/weights';
import { TRAINED_WEIGHTS } from '../src/game/ai/weights.generated';
import type { PlayerId } from '../src/game/engine';

const SEATS: readonly PlayerId[] = ['p1', 'p2', 'p3', 'p4'];
const OUTPUT = 'src/game/ai/weights.generated.ts';

function flag(name: string, fallback: number): number {
    const at = process.argv.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const value = Number(process.argv[at + 1]);
    return Number.isFinite(value) ? value : fallback;
}

function stringFlag(name: string, fallback: string): string {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const GENERATIONS = flag('generations', 30);
const POPULATION = flag('population', 32);
const ELITES = flag('elites', 8);
const EVAL_SEEDS = flag('seeds', 48);
const RUN = stringFlag('seed', 'run-1');
const FIELD_NAME = stringFlag('field', 'baseline');

if (FIELD_NAME !== 'baseline' && FIELD_NAME !== 'trained') {
    throw new Error(`--field must be 'baseline' or 'trained', not '${FIELD_NAME}'`);
}

/** Who the candidate is scored against. `trained` is whatever is shipped right now. */
const FIELD = FIELD_NAME === 'trained' ? heuristicPolicy : baselineHeuristicPolicy;

const seeds = (count: number, prefix: string): string[] =>
    Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

const scoreOf = (vector: readonly number[], seedList: readonly string[]): number =>
    rotatingWinRate({
        seats: SEATS,
        candidate: createHeuristicPolicy(fromVector(vector), 'candidate'),
        field: FIELD,
        seeds: seedList
    }).rate;

function render(vector: readonly number[]): string {
    const weights = fromVector(vector);
    const body = (Object.keys(weights) as (keyof typeof weights)[])
        .map(key => `    ${key}: ${Number(weights[key].toFixed(4))}`)
        .join(',\n');

    return `/**
 * Trained heuristic weights — GENERATED. Do not hand-edit.
 *
 * Regenerate with \`bun scripts/trainAi.ts\`. Committed rather than built, for
 * the reason \`src/server/embeddedAssets.generated.ts\` is: \`heuristic.ts\`
 * imports it, so a fresh clone without it fails \`bunx tsc --noEmit\`.
 *
 * Provenance: cross-entropy method, run "${RUN}" against the ${FIELD_NAME} field —
 * ${GENERATIONS} generations, population ${POPULATION}, ${ELITES} elites,
 * ${EVAL_SEEDS * SEATS.length} matches per candidate per generation. \`guardHit\` and
 * \`selfDestruct\` are held fixed; see \`weights.ts\` for why.
 */

import type { Weights } from './weights';

export const TRAINED_WEIGHTS: Weights = {
${body}
};
`;
}

async function main(): Promise<void> {
    const start = Date.now();

    // A co-evolutionary pass starts from the incumbent rather than from the
    // hand-set point: the incumbent is the best known vector, and centring the
    // population on it makes the run a refinement rather than a fresh search
    // that happens to face a stronger opponent. Against the baseline field there
    // is no incumbent to refine, so it starts where the design did.
    const initialMean = toVector(FIELD_NAME === 'trained' ? TRAINED_WEIGHTS : DEFAULT_WEIGHTS);

    // Proportional to each weight's own magnitude, since they differ by two
    // orders of magnitude — one absolute spread would freeze the small
    // coordinates and randomise the large ones.
    const initialStd = initialMean.map(value => Math.abs(value) * 0.6 + 1);
    const minStd = initialMean.map(value => Math.abs(value) * 0.08 + 0.25);

    console.log(
        `training: ${GENERATIONS} generations x ${POPULATION} candidates x ` +
            `${EVAL_SEEDS * SEATS.length} matches = ` +
            `${GENERATIONS * POPULATION * EVAL_SEEDS * SEATS.length} matches\n`
    );

    const result = runCem({
        initialMean,
        initialStd,
        minStd,
        populationSize: POPULATION,
        eliteCount: ELITES,
        generations: GENERATIONS,
        rng: makeRng(`cem:${RUN}`),
        score: (candidate, generation) => scoreOf(candidate, seeds(EVAL_SEEDS, `${RUN}-g${generation}`)),
        onGeneration: report => {
            const elapsed = ((Date.now() - start) / 1000).toFixed(0);
            console.log(
                `gen ${String(report.generation).padStart(2)}  ` +
                    `elite mean ${(report.eliteMeanScore * 100).toFixed(1)}%  ` +
                    `best ${(report.bestScore * 100).toFixed(1)}%  ` +
                    `${elapsed}s`
            );
        }
    });

    // Held out: seeds no generation ever scored on, and more of them, because
    // these are the numbers that decide whether the run is kept.
    const holdout = seeds(400, `${RUN}-holdout`);
    const candidate = createHeuristicPolicy(fromVector(result.mean), 'trained');

    const vsField = rotatingWinRate({ seats: SEATS, candidate, field: FIELD, seeds: holdout });
    // Always measured, even when the field IS the baseline, because a
    // co-evolutionary pass must not regress against the fixed control.
    const vsBaseline = rotatingWinRate({
        seats: SEATS,
        candidate,
        field: baselineHeuristicPolicy,
        seeds: holdout
    });

    const line = (label: string, r: { rate: number; low: number; high: number; matches: number }) =>
        console.log(
            `  vs ${label.padEnd(9)} ${(r.rate * 100).toFixed(1).padStart(5)}%  ` +
                `[${(r.low * 100).toFixed(1)} .. ${(r.high * 100).toFixed(1)}]  of ${r.matches}`
        );

    console.log('\nheld-out (break-even 25.0%):');
    line(FIELD_NAME, vsField);
    line('baseline', vsBaseline);
    console.log('');

    TRAINABLE_KEYS.forEach((key, i) => {
        console.log(`  ${key.padEnd(16)} ${initialMean[i].toFixed(2).padStart(9)} -> ${result.mean[i].toFixed(2).padStart(9)}`);
    });

    // Both bars, not either. Beating the incumbent while losing to the original
    // control is exactly the cycle co-evolution is prone to, and shipping it
    // would be a regression dressed as progress.
    if (vsField.low <= 0.25) {
        console.log(`\nNOT written to ${OUTPUT}: does not clear break-even against ${FIELD_NAME}.`);
        return;
    }
    if (vsBaseline.low <= 0.25) {
        console.log(`\nNOT written to ${OUTPUT}: beats ${FIELD_NAME} but not the hand-set baseline.`);
        return;
    }

    await Bun.write(OUTPUT, render(result.mean));
    console.log(`\nwrote ${OUTPUT}`);
}

await main();
