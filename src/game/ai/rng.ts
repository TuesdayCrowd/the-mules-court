/**
 * The AI layer's randomness, as a cursor over the engine's generator.
 *
 * This does not implement a generator. It wraps `../engine/rng`, whose
 * mulberry32 is pure — state in, new state out — behind a small mutable cursor,
 * because threading `RngState` through a policy's decision tree by hand is
 * noise at every call site and one forgotten reassignment away from a stream
 * that silently repeats.
 *
 * Reaching past the engine barrel is deliberate and narrow. `rng.ts` is not
 * exported from `../engine/index.ts`, since a client has no business drawing
 * from the match's generator. `src/game/ai/` is a sibling inside the same
 * subsystem rather than a client, and the alternative is a second copy of
 * mulberry32 in this repo — which is the fork the AI design exists to avoid.
 *
 * Nothing here touches the match's own `RngState`. A policy's randomness and
 * the shuffle's randomness are separate streams on purpose: a bot that consumed
 * the match generator would change the deck by thinking harder.
 */

import { nextRng, seedRng } from '../engine/rng';
import type { RngState } from '../engine/types';

/** A stream of values in [0, 1). Injected, never ambient, so every run replays. */
export interface Rng {
    next(): number;
}

export function makeRng(seed: string): Rng {
    let state: RngState = seedRng(seed);

    return {
        next(): number {
            const step = nextRng(state);
            state = step.rng;
            return step.value;
        }
    };
}

/**
 * One member of `items`, uniformly. `undefined` for an empty array.
 *
 * Empty is a real case rather than a defensive one: `legalTargets` is empty for
 * every card that takes no target, and the caller distinguishes those by asking
 * the card, not by treating the absence as a failure.
 */
export function pick<T>(items: readonly T[], rng: Rng): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(rng.next() * items.length)];
}
