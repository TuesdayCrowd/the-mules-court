/**
 * The shape of a laid-out table (UIX §2.2, §6.1).
 *
 * Geometry is data. `computeLayout` returns one of these and the `Court` scene
 * consumes it; nothing in this directory has heard of Phaser, which is what lets
 * Vitest hold the design's spatial promises without booting a WebGL context.
 */

import type { Topology } from './topology';

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface LayoutInput {
    readonly w: number;
    readonly h: number;
    readonly opponentCount: 1 | 2 | 3;
    readonly handCount: 1 | 2;
    /** True in a two-player round: the face-up burn gets its own panel (UIX §6.1). */
    readonly showsRemovedCard: boolean;
    /** Worst-case discard count across all seats — drives pip sizing. */
    readonly maxDiscards: number;
}

/**
 * How the discard pips fit inside a seat chip (UIX §6.2).
 *
 * `perRow` is how many fit across at `size`; the renderer wraps at that count.
 * Between them they always account for every value in the pile — interface rule
 * 7 makes truncation a design failure, not a fallback.
 */
export interface PipSpec {
    readonly size: number;
    readonly perRow: number;
    readonly rows: number;
}

export interface LayoutSpec {
    readonly topology: Topology;
    readonly viewport: Rect;
    readonly statusStrip: Rect;
    readonly opponents: readonly Rect[];
    readonly deck: Rect;
    readonly removedCard: Rect | null;
    readonly banner: Rect;
    readonly toastZone: Rect;
    readonly ownStatus: Rect;
    readonly hand: readonly Rect[];
    /**
     * Multiplier for a card sprite, relative to the 768×1024 art in
     * `public/assets/card-front/`. `sprite.setScale(cardScale)` renders a hand
     * card at `hand[i]`'s size.
     */
    readonly cardScale: number;
    readonly pip: PipSpec;
}
