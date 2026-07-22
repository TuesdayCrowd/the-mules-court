import type { RngState } from './types';

/**
 * The engine's entire source of randomness.
 *
 * A mulberry32 generator carried as plain, immutable data: one 32-bit number,
 * JSON-serializable, with no closure or generator object. Every function here is
 * pure — state goes in, new state comes out — so a match replays exactly from its
 * seed and action log.
 *
 * Only shuffling consumes randomness. No card resolver ever draws from this.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UINT32_RANGE = 4294967296;

/** Folds a seed string into an initial 32-bit state with FNV-1a. */
export function seedRng(seed: string): RngState {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME);
    }
    return { s: hash >>> 0 };
}

/** Draws one value in [0, 1) and returns the advanced state alongside it. */
export function nextRng(rng: RngState): { rng: RngState; value: number } {
    let t = (rng.s + 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const value = ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    return { rng: { s: t >>> 0 }, value };
}

/**
 * Fisher-Yates shuffle over a copy, returning the advanced rng state.
 *
 * The input array is never touched, so callers may shuffle a frozen catalog deck.
 */
export function shuffle<T>(items: readonly T[], rng: RngState): { shuffled: T[]; rng: RngState } {
    const shuffled = items.slice();
    let current = rng;
    for (let i = shuffled.length - 1; i > 0; i--) {
        const step = nextRng(current);
        current = step.rng;
        const j = Math.floor(step.value * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return { shuffled, rng: current };
}
