/**
 * Trained heuristic weights — GENERATED. Do not hand-edit.
 *
 * Regenerate with `bun scripts/trainAi.ts`. Committed rather than built, for
 * the reason `src/server/embeddedAssets.generated.ts` is: `heuristic.ts`
 * imports it, so a fresh clone without it fails `bunx tsc --noEmit`.
 *
 * Provenance: cross-entropy method, run "run-1" — 25 generations,
 * population 40, 10 elites, 512 matches per
 * candidate per generation. `guardHit` and `selfDestruct` are held fixed; see
 * `weights.ts` for why.
 */

import type { Weights } from './weights';

export const TRAINED_WEIGHTS: Weights = {
    guardHit: 100,
    fizzle: -1.019,
    priestInfo: 25.7431,
    baronWin: 38.3258,
    baronLose: -160.7281,
    handmaidBase: 22.3702,
    handmaidThreat: 29.9214,
    princeMuleKill: 134.249,
    princeDisrupt: 2.7683,
    princeCycle: 3.7044,
    kingGain: 9.1836,
    countessBase: 3.32,
    selfDestruct: -1000,
    keepValue: 3.4184
};
