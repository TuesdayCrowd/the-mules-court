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

/**
 * The line between a phone on its side and a window with room to breathe.
 *
 * UIX §2.2 states the rule by aspect alone — `landscape-narrow` is 0.9–1.45,
 * `wide` is above 1.45 — but §6.1 names the classes by *device*:
 * `landscape-narrow` is "rotated phone, small tablet", `wide` is "desktop,
 * large tablet". Aspect turns out to be a poor proxy for that intent, and it
 * fails in both directions:
 *
 * - A rotated phone is 844×390, an aspect of 2.16, which the aspect rule sends
 *   straight to `wide` — the case this constant was first added to catch.
 * - A 4:3 desktop window is an aspect of 1.34, which the aspect rule sends to
 *   `landscape-narrow` — so an ordinary monitor inherited a rotated phone's
 *   proportions: cramped seat chips, a small deck, the burn panel stacked
 *   under it, and a hand spread to both thumbs that were never there.
 *
 * Height is what actually separates the two devices, so it decides the
 * landscape split outright rather than qualifying an aspect test. Aspect still
 * picks portrait, where it genuinely describes the shape of the composition.
 */
export const MIN_WIDE_HEIGHT = 560;

export function classifyTopology(w: number, h: number): Topology {
    if (w / h < PORTRAIT_MAX_ASPECT) return 'portrait';
    return h < MIN_WIDE_HEIGHT ? 'landscape-narrow' : 'wide';
}

/**
 * The long edge of a phone lying on its side.
 *
 * The largest phone worth designing for is about 956 CSS px across in
 * landscape, and a small tablet in landscape is taller than `MIN_WIDE_HEIGHT`
 * anyway. Past this the viewport is a short desktop window.
 */
export const MAX_HANDHELD_WIDTH = 1000;

/**
 * Whether the viewer is plausibly *holding* the viewport in two hands.
 *
 * Distinct from `classifyTopology`, and deliberately so. The class answers
 * "which composition", which height alone decides. This answers "are there
 * thumbs at the left and right edges", which needs both dimensions: a
 * 1400×559 window is short enough to be `landscape-narrow` and far too wide
 * to be held, and sending the hand to its corners put one card under the
 * quick-reference button and 1100px of nothing between the two.
 *
 * Only the hand spread asks this. Every other proportion in the class is
 * about height, and height is all the class needs to know.
 */
export function isHandheldLandscape(w: number, h: number): boolean {
    return h < MIN_WIDE_HEIGHT && w <= MAX_HANDHELD_WIDTH;
}
