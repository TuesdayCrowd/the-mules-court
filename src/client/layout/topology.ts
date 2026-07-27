/**
 * Which of the three table compositions a viewport gets (UIX §2.2).
 *
 * The class boundaries are the layout's only discrete jumps. Within a class
 * every position is a fraction of the live viewport, so this function is
 * consulted once per resize and never interpolated between.
 */

export type Topology = 'portrait' | 'landscape-narrow' | 'wide';

/** Below 0.9 the viewport is taller than it is usefully wide. */
const PORTRAIT_MAX_ASPECT = 0.9;

/** Above 1.45 there is room for the deck and the removed card side by side. */
const WIDE_MIN_ASPECT = 1.45;

/**
 * A viewport shorter than this cannot afford `wide`'s generous seat panels,
 * whatever its aspect.
 *
 * UIX §2.2 states the rule by aspect alone, and UIX §6.1 calls a rotated phone
 * `landscape-narrow` — but a rotated phone is 844×390, an aspect of 2.16, which
 * the aspect rule sends straight to `wide`. Height is the second dimension that
 * tells a desktop window from a phone on its side, and the design needs it to
 * mean what §6.1 says.
 */
export const MIN_WIDE_HEIGHT = 560;

export function classifyTopology(w: number, h: number): Topology {
    const aspect = w / h;
    if (aspect < PORTRAIT_MAX_ASPECT) return 'portrait';
    if (aspect > WIDE_MIN_ASPECT && h >= MIN_WIDE_HEIGHT) return 'wide';
    return 'landscape-narrow';
}
