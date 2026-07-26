/**
 * The one shape every DOM surface takes.
 *
 * No surface reads the store: `update(state)` is pushed by the single subscriber
 * in `main.ts`, and nothing here reaches for `location`, `localStorage`, or a
 * timer — those arrive through the surface's own `deps`. That is what keeps
 * these testable under jsdom without a live socket or a real clock.
 */

import type { ClientState } from '../store/types';

export interface Surface {
    /** Appends exactly one element to `parent`. The pointer-events rule keys on it being a direct child. */
    mount(parent: HTMLElement): void;
    update(state: ClientState): void;
    destroy(): void;
}

/** Injected timers, so a test can fire a timeout instead of waiting for one. */
export interface Timers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** The real ones, for `main.ts`. */
export const REAL_TIMERS: Timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};
