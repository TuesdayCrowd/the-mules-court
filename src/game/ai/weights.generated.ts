/**
 * Trained heuristic weights — GENERATED. Do not hand-edit.
 *
 * Regenerate with `bun scripts/trainAi.ts`. Committed rather than built, for
 * the reason `src/server/embeddedAssets.generated.ts` is: `heuristic.ts`
 * imports it, so a fresh clone without it fails `bunx tsc --noEmit`.
 *
 * Provenance: cross-entropy method, run "king-leak-1" against the baseline field —
 * 30 generations, population 32, 8 elites,
 * 192 matches per candidate per generation. `guardHit` and
 * `selfDestruct` are held fixed; see `weights.ts` for why.
 */

import type { Weights } from './weights';

export const TRAINED_WEIGHTS: Weights = {
    guardHit: 100,
    fizzle: 0.2296,
    priestInfo: 3.067,
    baronWin: 73.6941,
    baronLose: -119.7903,
    handmaidBase: 16.8943,
    handmaidThreat: 34.3946,
    princeMuleKill: 41.4407,
    princeDisrupt: 6.1824,
    princeCycle: 2.5018,
    kingGain: 6.5385,
    kingLeak: -114.4097,
    countessBase: 3.0045,
    selfDestruct: -1000,
    keepValue: 6.4149
};
